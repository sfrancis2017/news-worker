# news-worker

Cloudflare Worker that aggregates curated RSS/Atom feeds for the news
page at sajivfrancis.com/news.

```bash
npm install
wrangler dev          # local
wrangler deploy       # production
```

Endpoint:
- `GET /feeds` — returns merged JSON of all sources, newest-first.
- `GET /feeds?domain=AI` — filter to one domain (SAP|Architecture|AI|Engineering).
- `GET /health` — sanity check.
