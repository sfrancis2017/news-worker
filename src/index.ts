// news-worker
// Aggregates curated RSS/Atom feeds across SAP, Architecture, AI, and
// Engineering. Fetches in parallel with per-feed timeouts, parses with a
// minimal regex-based extractor (no DOMParser — Workers runtime safe),
// merges newest-first, and returns JSON with a Cache-Control header so
// Cloudflare's edge cache does the heavy lifting.
//
// Endpoints:
//   GET /health                — { ok: true, sources: <count> }
//   GET /feeds                 — all sources merged
//   GET /feeds?domain=AI       — filter to one domain
//   POST /compose              — owner-only Anthropic-backed draft
//                                generation for the /admin/share tool
//                                on sajivfrancis.com
//
// CORS: build-time server-to-server fetches are unaffected. The /news
// page's Refresh button calls this from the browser, so we whitelist
// the site origins via ALLOWED_ORIGINS.

interface Env {
  ALLOWED_ORIGINS: string;
  // Owner-only bearer token gating /compose. Set via:
  //   wrangler secret put COMPOSE_TOKEN
  COMPOSE_TOKEN?: string;
  // Anthropic API key for /compose calls. Set via:
  //   wrangler secret put ANTHROPIC_API_KEY
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
}

// Constant-time string compare for token check (avoids timing attacks)
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function isAuthorized(req: Request, env: Env): boolean {
  if (!env.COMPOSE_TOKEN) return false;
  const auth = req.headers.get('Authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  return m ? timingSafeEqual(m[1], env.COMPOSE_TOKEN) : false;
}

type FeedDomain = 'SAP' | 'Architecture' | 'AI' | 'Engineering';

interface FeedSource {
  id: string;
  label: string;
  url: string;
  domain: FeedDomain;
}

interface FeedItem {
  id: string;
  title: string;
  url: string;
  source: string;
  domain: FeedDomain;
  date: string;
  timestamp: number;
  excerpt?: string;
  image?: string;
}

const VALID_DOMAINS: FeedDomain[] = ['SAP', 'Architecture', 'AI', 'Engineering'];

// Curated source registry. Each URL was verified live before encoding.
const FEED_SOURCES: FeedSource[] = [
  // SAP
  { id: 'sap-news', label: 'SAP News', url: 'https://news.sap.com/feed/', domain: 'SAP' },
  { id: 'sap-community', label: 'SAP Community', url: 'https://community.sap.com/khhcw49343/rss/Community', domain: 'SAP' },

  // Enterprise Architecture
  { id: 'martin-fowler', label: 'Martin Fowler', url: 'https://martinfowler.com/feed.atom', domain: 'Architecture' },
  { id: 'open-group', label: 'The Open Group', url: 'https://blog.opengroup.org/feed/', domain: 'Architecture' },
  { id: 'infoq-arch', label: 'InfoQ Architecture', url: 'https://feed.infoq.com/architecture-design/', domain: 'Architecture' },

  // AI
  { id: 'simon-willison', label: "Simon Willison's Weblog", url: 'https://simonwillison.net/atom/everything/', domain: 'AI' },
  { id: 'tldr-ai', label: 'TLDR AI', url: 'https://tldr.tech/api/rss/ai', domain: 'AI' },
  { id: 'infoq-ai', label: 'InfoQ AI/ML', url: 'https://feed.infoq.com/ai-ml-data-eng/', domain: 'AI' },

  // Software Engineering
  { id: 'pragmatic-engineer', label: 'The Pragmatic Engineer', url: 'https://newsletter.pragmaticengineer.com/feed', domain: 'Engineering' },
  { id: 'hacker-news', label: 'Hacker News', url: 'https://hnrss.org/frontpage?count=15', domain: 'Engineering' },
  { id: 'infoq-engineering', label: 'InfoQ Engineering', url: 'https://feed.infoq.com/development/', domain: 'Engineering' },
];

// ─── XML helpers (no DOMParser; Workers-safe) ────────────────────────────────

function extractText(xml: string, tag: string): string {
  const cdata = xml.match(
    new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'),
  );
  if (cdata) return cdata[1].trim();
  const plain = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (plain) return plain[1].replace(/<[^>]+>/g, '').trim();
  return '';
}

function extractLinkHref(xml: string): string {
  // Atom: <link href="…" rel="alternate" />
  const attr = xml.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i);
  if (attr) return attr[1];
  // RSS: <link>…</link>
  const inner = xml.match(/<link[^>]*>([^<]+)<\/link>/i);
  if (inner) return inner[1].trim();
  return '';
}

// Try several common patterns for a feed item's image URL. RSS and Atom
// don't have a single canonical "thumbnail" element, so we probe in order
// of typical reliability. Returns undefined if nothing usable found.
function extractImage(chunk: string): string | undefined {
  // Media RSS: <media:thumbnail url="..."> or <media:content url="..." medium="image">
  const mediaThumb = chunk.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i);
  if (mediaThumb) return mediaThumb[1];
  const mediaContent = chunk.match(
    /<media:content[^>]+url=["']([^"']+)["'][^>]*medium=["']image["']/i,
  );
  if (mediaContent) return mediaContent[1];
  const mediaContentAlt = chunk.match(
    /<media:content[^>]+medium=["']image["'][^>]*url=["']([^"']+)["']/i,
  );
  if (mediaContentAlt) return mediaContentAlt[1];

  // Enclosure: <enclosure url="..." type="image/...">
  const enclosure = chunk.match(
    /<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image\//i,
  );
  if (enclosure) return enclosure[1];

  // Inline <img src="..."> in description / content / summary
  const img = chunk.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (img) return img[1];

  return undefined;
}

function decodeEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ─── Per-feed parser ─────────────────────────────────────────────────────────

async function parseFeed(source: FeedSource): Promise<FeedItem[]> {
  try {
    const res = await fetch(source.url, {
      headers: {
        'User-Agent': 'sajivfrancis.com/newsfeed (+https://sajivfrancis.com)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];

    const xml = await res.text();
    const items: FeedItem[] = [];
    const isAtom = /<feed[\s>]/i.test(xml);

    const entryPattern = isAtom
      ? /<entry[\s\S]*?<\/entry>/gi
      : /<item[\s\S]*?<\/item>/gi;

    const chunks = xml.match(entryPattern) ?? [];

    for (const chunk of chunks.slice(0, 10)) {
      const title = decodeEntities(extractText(chunk, 'title'));
      const url = isAtom
        ? extractLinkHref(chunk)
        : extractText(chunk, 'link') || extractLinkHref(chunk);
      if (!title || !url) continue;

      const rawDate = isAtom
        ? extractText(chunk, 'published') || extractText(chunk, 'updated')
        : extractText(chunk, 'pubDate') || extractText(chunk, 'dc:date');
      const parsed = rawDate ? new Date(rawDate) : new Date();
      if (isNaN(parsed.getTime())) continue;

      const rawExcerpt = isAtom
        ? extractText(chunk, 'summary') || extractText(chunk, 'content')
        : extractText(chunk, 'description');
      const excerpt = rawExcerpt
        ? decodeEntities(rawExcerpt).replace(/\s+/g, ' ').slice(0, 220).trimEnd() + '…'
        : undefined;

      const image = extractImage(chunk);

      items.push({
        id: `${source.id}::${url}`,
        title,
        url,
        source: source.label,
        domain: source.domain,
        date: parsed.toISOString(),
        timestamp: parsed.getTime(),
        excerpt,
        image,
      });
    }

    return items;
  } catch (err) {
    console.warn(`[feeds] "${source.label}" failed:`, err);
    return [];
  }
}

async function aggregate(domain?: FeedDomain): Promise<FeedItem[]> {
  const sources = domain
    ? FEED_SOURCES.filter((s) => s.domain === domain)
    : FEED_SOURCES;
  const settled = await Promise.allSettled(sources.map(parseFeed));
  return settled
    .filter((r): r is PromiseFulfilledResult<FeedItem[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value)
    .sort((a, b) => b.timestamp - a.timestamp);
}

// ─── HTTP plumbing ───────────────────────────────────────────────────────────

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  const allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(
  body: unknown,
  init: ResponseInit & { cors: Record<string, string>; cache?: boolean } = {
    cors: {},
  },
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...init.cors,
  };
  if (init.cache) {
    // Edge cache: 1h fresh, 2h stale-while-revalidate. Browser cache: no
    // (so the Refresh button isn't fooled by a stale browser copy).
    headers['Cache-Control'] = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=7200';
  }
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, sources: FEED_SOURCES.length }, { cors });
    }

    if (url.pathname === '/feeds') {
      if (request.method !== 'GET') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, cors });
      }
      const domainParam = url.searchParams.get('domain');
      const domain =
        domainParam && (VALID_DOMAINS as string[]).includes(domainParam)
          ? (domainParam as FeedDomain)
          : undefined;

      // Edge cache via the explicit Cache API. Workers do NOT auto-cache
      // based on Cache-Control headers alone — we have to write/read the
      // cache ourselves. Cache key is the request URL (so domain= filter
      // gets its own entry). On cache hit, response is <50ms.
      //
      // We strip CORS+Vary from the cached body and re-attach per-request
      // (so a request from sajivfrancis.com doesn't get a cached response
      // pinned to localhost or vice-versa).
      //
      // CACHE_VERSION baked into the cache key lets us bust all cached
      // responses by bumping it whenever the response shape changes
      // (e.g. when adding new fields like `image`).
      const CACHE_VERSION = 'v2';
      const cache = caches.default;
      const cacheUrl = new URL(request.url);
      const norm = new URL(cacheUrl.origin + cacheUrl.pathname);
      norm.searchParams.set('_v', CACHE_VERSION);
      if (domain) norm.searchParams.set('domain', domain);
      const cacheKey = new Request(norm.toString(), { method: 'GET' });

      const cached = await cache.match(cacheKey);
      if (cached) {
        // Re-clothe the cached response with the live request's CORS headers
        const body = await cached.text();
        return new Response(body, {
          status: cached.status,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': cached.headers.get('Cache-Control') ?? '',
            'X-Cache': 'HIT',
            ...cors,
          },
        });
      }

      const items = await aggregate(domain);
      const payload = JSON.stringify({
        items,
        fetchedAt: new Date().toISOString(),
        domain: domain ?? 'all',
      });

      // Cacheable copy: no CORS headers (re-added per-request above)
      const cacheable = new Response(payload, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control':
            'public, max-age=0, s-maxage=3600, stale-while-revalidate=7200',
        },
      });
      // Fire-and-forget cache write (don't block the live response)
      ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));

      return new Response(payload, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control':
            'public, max-age=0, s-maxage=3600, stale-while-revalidate=7200',
          'X-Cache': 'MISS',
          ...cors,
        },
      });
    }

    if (url.pathname === '/compose') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405, cors });
      }
      if (!isAuthorized(request, env)) {
        return jsonResponse({ error: 'Owner-only endpoint' }, { status: 401, cors });
      }
      if (!env.ANTHROPIC_API_KEY) {
        return jsonResponse({ error: 'Anthropic key not configured' }, { status: 500, cors });
      }

      let body: {
        url?: string;
        title?: string;
        source?: string;
        commentary?: string;
      };
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON' }, { status: 400, cors });
      }
      if (!body.url || !body.title) {
        return jsonResponse(
          { error: 'url and title are required' },
          { status: 400, cors },
        );
      }
      // Cap input sizes
      if (body.url.length > 1000 || body.title.length > 500 || (body.commentary ?? '').length > 4000) {
        return jsonResponse({ error: 'Request payload too large' }, { status: 400, cors });
      }

      const prompt = `You are helping Sajiv Francis (Enterprise Architect at a Fortune 50 technology company) compose social media posts about an article he wants to share. Sajiv writes as a credible practitioner — thoughtful, honest, opinionated. Not corporate-speak.

Article to share:
- Title: ${body.title}
- Source: ${body.source ?? 'unknown'}
- URL: ${body.url}

Sajiv's commentary (incorporate as the lead/POV — this is the value he adds beyond just sharing the link):
${body.commentary?.trim() || '(none — write a thoughtful summary instead)'}

Generate two posts. Return ONLY valid JSON with no markdown fences and no preamble:
{
  "x": "...",
  "linkedin": "..."
}

Rules:
- "x": X / Twitter post. MAX 280 chars total INCLUDING the URL. Lead with the take. Plain text. URL at the end. No hashtag spam.
- "linkedin": LinkedIn post. 800-1500 chars. Professional but human. Lead with the take, expand briefly, link at the end. Allow paragraph breaks (use \\n\\n). At most one short hashtag block at the end if it actually fits the topic; usually skip.
- NEVER name a specific employer. Use "Fortune 50 technology company" if referring to current role.
- No "Excited to share..." or "Thrilled to..." openings — they read as performative.
- The commentary IS the post's value. Don't bury it under summary boilerplate.
- One sparingly used emoji is fine; none is also fine. No emoji rows.`;

      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
            max_tokens: 2000,
            system:
              'You always respond with pure valid JSON only — no markdown fences, no preamble, no trailing text. Just the JSON object.',
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        if (!res.ok) {
          const errText = await res.text();
          return jsonResponse(
            { error: `Anthropic ${res.status}`, detail: errText.slice(0, 300) },
            { status: 502, cors },
          );
        }
        const data = (await res.json()) as { content?: { text?: string }[] };
        const text = (data?.content?.[0]?.text ?? '').replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(text) as { x?: string; linkedin?: string };
        if (!parsed.x || !parsed.linkedin) {
          throw new Error('Model output missing x or linkedin field');
        }
        return jsonResponse({ x: parsed.x, linkedin: parsed.linkedin }, { cors });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return jsonResponse(
          { error: 'Generation failed', detail: message },
          { status: 502, cors },
        );
      }
    }

    return jsonResponse({ error: 'Not found' }, { status: 404, cors });
  },
};
