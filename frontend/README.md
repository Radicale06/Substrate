# Substrate — console

A browser UI that exercises every capability the API exposes. React + Vite, no UI
framework, no state library — the whole thing is seven panels over one typed API client.

It looks like a terminal, because the thing it is a console *for* is an API you drive from
a shell. Monospace throughout, near-black, one accent, rules instead of cards. No
scanlines or phosphor glow: those read as nostalgia and cost real legibility on the long
markdown this app exists to display. The look lives entirely in
[src/index.css](src/index.css) — the panels are plain markup and none of them know about
it, so restyling again means editing one file.

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
| Embeddings | `POST /v1/embeddings` | Each vector drawn as signed bars, plus a cosine-similarity matrix over them |
| Vectors | `POST /v1/vectors/*` | Embed → create a collection → upsert → search, with every step visible |
| Reranker | `POST /v1/rerank` | Documents scored against a query and reordered |
| Status | `GET /v1/status` | Which services are actually up, and what to run for the ones that are not |

Every option the API accepts has a control here — including the ones that are easy to
forget exist: `X-Set-Cookie`, `X-Proxy-Url`, `X-Cache-Tolerance`, `X-User-Agent`, and the
POST path that converts HTML you already have instead of fetching a page.

The Reader panel is the one worth opening first. Turning on **Download images** shows the
`imageAssets` report with each image tagged `browser`, `fetch` or `inline` — `browser`
meaning the bytes came from the render itself and cost no extra bandwidth.

The Vectors panel is the one that shows how the pieces fit. It does not call a
chunk-and-embed-and-store endpoint, because there isn't one — it embeds, creates a
collection sized to whatever dimension the model returned, upserts, and then embeds the
question separately with `retrieval.query`. That is the pipeline you would write, run in
front of you.

Panels whose service is not running report that rather than erroring: with the `ai`
profile down, Embeddings and Reranker say so and tell you the command to start them.

## Run it from the published image

```bash
docker pull ghcr.io/radicale06/substrate-frontend:latest

docker run --rm -p 5173:80 \
  --network substrate \
  ghcr.io/radicale06/substrate-frontend:latest
```

The container's nginx proxies `/api` to a host called `backend` on port 3000, so the
console needs to be on a network where that name resolves — which is what `--network`
above is for, and what compose does for you. On its own network it will load and report
the API as unreachable.

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
