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
//
// CORS: build-time server-to-server fetches are unaffected. The /news
// page's Refresh button calls this from the browser, so we whitelist
// the site origins via ALLOWED_ORIGINS.

interface Env {
  ALLOWED_ORIGINS: string;
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

      items.push({
        id: `${source.id}::${url}`,
        title,
        url,
        source: source.label,
        domain: source.domain,
        date: parsed.toISOString(),
        timestamp: parsed.getTime(),
        excerpt,
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
      const cache = caches.default;
      const cacheUrl = new URL(request.url);
      // Normalize: drop any future tracking params, keep only `domain`.
      const norm = new URL(cacheUrl.origin + cacheUrl.pathname);
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

    return jsonResponse({ error: 'Not found' }, { status: 404, cors });
  },
};
