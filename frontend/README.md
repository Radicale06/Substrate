# Substrate — console

A browser UI that exercises every capability the API exposes. React + Vite, no UI
framework, no state library — the whole thing is five panels over one typed API client.

```bash
docker compose up --build     # from the repo root
```

Then open **http://localhost:5173**.

## What each panel demonstrates

| Panel | Endpoint | What it shows |
|---|---|---|
| Reader | `GET /<url>` | Every response format and `X-*` option, with cache status and timing |
| Search | `POST /v1/search` | SearXNG results, with each page read through the reader |
| Segmenter | `POST /v1/segment` | All six chunking strategies, their parameters, and whether the chunks still partition the input |
| Embeddings | `POST /v1/embeddings` | Vectors, a cosine-similarity matrix, and the chunk-and-embed pipeline — including reading a URL first |
| Reranker | `POST /v1/rerank` | Documents scored against a query and reordered |
| Status | `GET /v1/status` | Which services are actually up, and what to run for the ones that are not |

Every option the API accepts has a control here — including the ones that are easy to
forget exist: `X-Set-Cookie`, `X-Proxy-Url`, `X-Cache-Tolerance`, `X-User-Agent`, and the
POST path that converts HTML you already have instead of fetching a page.

The Reader panel is the one worth opening first. Turning on **Download images** shows the
`imageAssets` report with each image tagged `browser`, `fetch` or `inline` — `browser`
meaning the bytes came from the render itself and cost no extra bandwidth.

Panels whose service is not running report that rather than erroring: with the `ai`
profile down, Embeddings and Reranker say so and tell you the command to start them.

## Why the API is proxied

Requests go to `/api`, which both the Vite dev server and the production nginx forward to
the backend — so the browser only ever makes **same-origin** requests and CORS is never
involved in the default setup.

The prefix is stripped when forwarding, and that detail is load-bearing: the backend's
catch-all route treats any unmatched path as a URL to crawl, so a forwarded
`/api/https://example.com` would otherwise be read as a request to fetch a host called
`api`.

`/instant-screenshots/` and `/instant-images/` are proxied at their real paths too, so the
URLs the API returns work verbatim. Without that, the SPA fallback would answer a missing
image with `index.html` and a `200`, turning a 404 into a broken image box.

Point `VITE_API_BASE` at the backend directly to bypass the proxy — the backend then needs
`CORS_ORIGINS` set to this app's origin, which compose already does for
`http://localhost:5173`.

## Local development

```bash
npm install
npm run dev        # http://localhost:5173, proxying to http://127.0.0.1:3000
npm run build
npm run typecheck
```

`VITE_PROXY_TARGET` moves where the dev server proxies, for running the backend somewhere
other than the default port.

> If the console reports the API as unreachable while `docker compose ps` looks healthy,
> check that nothing else on the host is already bound to port 3000 — a stray
> `node dist/main.js`, or a debugger session, will shadow the container's published port
> and answer requests instead of it.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FRONTEND_PORT` | `5173` | Host port the console is published on |
| `VITE_API_BASE` | `/api` | Where the browser sends API calls (build-time) |
| `VITE_PROXY_TARGET` | `http://127.0.0.1:3000` | Dev-server proxy target |

The two `VITE_*` values are baked into the bundle at build time, not read at runtime.
