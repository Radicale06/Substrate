# 🧱 Substrate

**The layer between the open web and your model.** Substrate turns any URL, or any search
query, into clean, chunked, vectorized context — self-hosted, open source, no API keys.

```bash
curl 'http://127.0.0.1:3000/https://example.com'
```

An open-source alternative to [Jina AI](https://jina.ai)'s reader, search, embedding and
reranking APIs, running entirely on your own machine.

| Capability | Endpoint | Status |
|---|---|---|
| Service status | `GET /v1/status` | ✅ |
| Reader | `GET /<url>` | ✅ |
| Web search | `GET\|POST /v1/search` | ✅ |
| Segmenter | `POST /v1/segment` | ✅ |
| Embeddings | `POST /v1/embeddings` | ✅ |
| Reranker | `POST /v1/rerank` | ✅ |
| Vector store | `POST /v1/vectors/*` | ✅ |
| Classifier | `/v1/classify` | planned |
| DeepSearch | `/v1/chat/completions` | planned |

## 🚀 Key features

- 🖥️ A console at `:5173` that exercises every capability, so you can try it before you
  write a line of code
- 🏠 Runs locally in Docker — no accounts, no API keys
- 🧩 Every dependency is its own service, browser included — so a Chrome crash costs you
  one crawl, not the API
- 📝 Markdown, HTML, plain text, or PNG screenshots
- 🖼️ Screenshots saved to a local volume and served back over HTTP
- 📥 Optional image downloading — mirrors a page's images to Supabase Storage or a local
  volume, reusing the bytes the browser already fetched
- 🧮 A pgvector store, so the vectors you produce have somewhere to live
- 🧠 Readability extraction, so you get the article instead of the navigation
- 📄 PDF text extraction, fetched directly instead of through the browser
- 🧾 JSON responses via `Accept: application/json`
- 🔒 Blocks requests to loopback and private address ranges (SSRF protection)

## ⚠️ Limitations
- 🔑 There is no authentication or rate limiting on the API — do not expose it to
  untrusted callers. `CORS_ORIGINS` is empty by default for the same reason
- 🌐 The SSRF guard inspects hostnames and resolved addresses, but a DNS record that
  changes between the check and the connection (rebinding) is not fully closed
- 🐌 Embedding and reranking run on CPU by default and are slow at volume; set
  `EMBEDDINGS_DEVICE=cuda` if you have a GPU

## 🐳 Running it

Everything is orchestrated from the repo root. Each service owns its own compose file, and
the root file pulls them together with Compose's `include`.

```bash
docker compose up --build          # console + backend + reader + search
docker compose --profile ai up     # also the embedding and reranker model servers
```

The console is at **http://localhost:5173** and the API at **http://127.0.0.1:3000**.

Or bring a single service up on its own from its own folder:

```bash
cd frontend         && docker compose up --build
cd backend          && docker compose up --build
cd services/reader  && docker compose up --build
cd services/segmenter && docker compose up --build
cd services/vectors   && docker compose up --build
cd services/searxng && docker compose up
```

The backend answers on `http://127.0.0.1:3000`.

## 📦 Published images

Every component is published to the GitHub Container Registry on each push to `main`, so
you can run any part of this without cloning it or building anything.

| Image | Port | Needs |
|---|---|---|
| `ghcr.io/radicale06/substrate-backend` | 3000 | nothing; every dependency is optional |
| `ghcr.io/radicale06/substrate-frontend` | 80 | a reachable `backend` host |
| `ghcr.io/radicale06/substrate-reader` | 3001 | a volume, and `--shm-size` for Chrome |
| `ghcr.io/radicale06/substrate-segmenter` | 3002 | nothing |
| `ghcr.io/radicale06/substrate-vectors` | 8000 | Postgres with pgvector |
| `ghcr.io/radicale06/substrate-embeddings` | 8000 | a volume for the weights |
| `ghcr.io/radicale06/substrate-reranker` | 8000 | a volume for the weights |

Tagged `latest`, the short commit SHA, and the release version. SearXNG is not in the list
because that service runs the upstream `searxng/searxng` image — this repository only
supplies its `settings.yml`.

Each service's README has its own pull-and-run, including the flags that actually matter
for it. The whole stack, without a checkout:

```bash
docker network create substrate

docker run -d --name reader --network substrate --shm-size=1g \
  -v substrate-storage:/app/local-storage ghcr.io/radicale06/substrate-reader
docker run -d --name segmenter --network substrate ghcr.io/radicale06/substrate-segmenter
docker run -d --name backend --network substrate -p 3000:3000 \
  -e READER_URL=http://reader:3001 -e SEGMENTER_URL=http://segmenter:3002 \
  -e CORS_ORIGINS=http://localhost:5173 \
  -v substrate-storage:/app/local-storage ghcr.io/radicale06/substrate-backend
docker run -d --name frontend --network substrate -p 5173:80 ghcr.io/radicale06/substrate-frontend
```

That is the core: console, API, browser and chunking. Add `vectors`, `embeddings` and
`reranker` the same way and point `VECTORS_URL`, `EMBEDDINGS_URL` and `RERANKER_URL` at
them — unset, each endpoint reports itself as unconfigured and nothing else changes.
`backend` and `reader` share one volume on purpose: the reader writes screenshots and
images, the backend serves them.

Compose does all of this for you, and is still the easier path if you have the repo.

## 🖥️ Usage

The response format is chosen with the `X-Respond-With` header. Omit it to get the default
envelope (title, source URL, and Readability-extracted markdown).

| Header value | Returns |
|---|---|
| *(omitted)* | Title + URL + extracted markdown |
| `markdown` | Raw markdown of the full page, bypassing Readability |
| `html` | `documentElement.outerHTML` |
| `text` | `body.innerText` |
| `screenshot` | Viewport PNG — responds with a 302 to the saved image |
| `pageshot` | Full-page PNG — responds with a 302 to the saved image |

```bash
curl -H "X-Respond-With: markdown" 'http://127.0.0.1:3000/https://example.com'
curl -H "X-Respond-With: text"     'http://127.0.0.1:3000/https://example.com'
curl -L -H "X-Respond-With: screenshot" 'http://127.0.0.1:3000/https://example.com'
```

PDF links are fetched and parsed directly rather than rendered in the browser, so
`GET /https://example.com/paper.pdf` returns the document's text. PDFs served without a
`.pdf` extension are detected from the response content type.

Add `Accept: application/json` to any of the above for a structured response instead of
plain text — `{ code, status, data: { title, description, url, content, ... } }`. In JSON
mode the screenshot formats return the image URL directly rather than a redirect:

```bash
curl -H "Accept: application/json" 'http://127.0.0.1:3000/https://example.com'
```

### Other request headers

| Header | Effect |
|---|---|
| `X-Target-Selector` | Convert only elements matching a CSS selector |
| `X-Remove-Selector` | Strip elements matching a CSS selector |
| `X-Wait-For-Selector` | Wait for a selector to appear before capturing |
| `X-Timeout` | Keep collecting snapshots for N seconds (1–180) |
| `X-No-Cache` | Skip the crawl cache and re-fetch (needs `DATABASE_URL`) |
| `X-Cache-Tolerance` | Accept a cached result up to N seconds old (needs `DATABASE_URL`) |
| `X-With-Links-Summary` | Append a list of the page's links (default format only) |
| `X-With-Images-Summary` | Append a list of the page's images (default format only) |
| `X-With-Images-Download` | Download the page's images and link to stored copies |
| `X-With-Iframe` | Inline child frame content before conversion |
| `X-Keep-Img-Data-Url` | Keep inline `data:` images instead of shortening them |
| `X-Set-Cookie` | Set cookies for the crawl (standard `Set-Cookie` syntax) |
| `X-Proxy-Url` | Route the crawl through a proxy |
| `X-User-Agent` | Override the browser User-Agent |

Boolean headers are enabled by their presence; pass `false`, `0`, `no`, or `off` to
disable one explicitly. The two summary headers only apply to the default envelope, since
the other formats return the page verbatim (or, for screenshots, a redirect with no body).

Saved screenshots are pruned after an hour, and capped at 1000 files, so an unattended
instance cannot fill its volume.

You can also POST a JSON body with the same options, plus `url` and `html` (to convert
HTML you already have):

```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","respondWith":"markdown"}' \
  'http://127.0.0.1:3000/'
```

## 📥 Downloading images

By default the reader gives you image **references**: `![Image 1: alt](https://origin/…)`.
Add `X-With-Images-Download` and it fetches those images, stores them, and rewrites the
links to your own copies — so the markdown keeps working after the origin rate-limits you,
rotates its CDN URLs, or disappears.

```bash
curl -H 'X-With-Images-Download: true' 'http://127.0.0.1:3000/https://en.wikipedia.org/wiki/Cat'
```

```
![Image 1](/instant-images/8c/df/8cdfa1a2bfb2908fb82952c56039464b.jpg)
```

**Every image on the page** is downloaded, not just the ones the extracted article links
to — so a gallery, a product grid or a page whose article happens to reference one image
all come back complete. Duplicates collapse to a single stored file. The images the body
links to are fetched first, so if a page exceeds the per-crawl limit it is the navigation
chrome that gets dropped, never an article image. In JSON, `data.imageAssets` reports what
happened to each one:

```jsonc
{
  "sourceUrl": "https://i.guim.co.uk/img/media/…/master/5002.jpg?width=465",
  "url":       "/instant-images/74/f1/74f178462809acc85934e7f0f729c0a6.jpg",
  "contentType": "image/jpeg",
  "bytes":  20094,
  "source": "fetch",        // or "browser" — bytes the render already paid for
  "status": "stored"        // "skipped" / "failed" carry a `reason`
}
```

**Most images cost no extra bandwidth.** Chrome downloads them anyway while rendering, so
they are harvested from the render rather than fetched again — which also inherits the
browser's session, getting past hotlink protection and rate limits that reject a bare
re-fetch. Only what the render missed (lazy-loaded images, `srcset` variants) is fetched.

An image that cannot be stored keeps its original URL and says why, so a partial failure
still leaves a usable document. Because filenames are content hashes, the same image is
stored once across every crawl, and a pruned file regenerates the identical name on the
next crawl.

Since image URLs come from the crawled page, they are treated as hostile: every one is
SSRF-checked on each redirect hop, size-capped, and identified by **magic bytes** rather
than its Content-Type or extension. SVG is refused by that check — it has no magic number,
and these files are served from the API's own origin, so a stored SVG would be stored XSS.
Refused images are reported as `skipped / unsupported-type` and keep their original URL.

Images go to **Supabase Storage** when it is configured, and to the reader's local volume
otherwise. `IMAGE_STORAGE` makes that choice explicit instead of inferred — `supabase`,
`local`, or `auto` (the default, which uses Storage if the credentials are there). In
`supabase` mode a failed upload leaves the original remote URL in the markdown rather than
quietly writing to a volume nothing may be serving.

Objects are content-addressed and sharded two levels deep, uploaded with `upsert` — a name
collision *is* the same bytes — and a one-year `Cache-Control`. The three `SUPABASE_*`
variables are a set, not three options: Storage builds links from `SUPABASE_URL`, which
inside Compose is an internal hostname, so without `SUPABASE_PUBLIC_URL` every stored link
would come back already broken. The service refuses to enable Storage rather than hand
those out.

Locally stored images are pruned after 24 hours, and capped by both file count and total
bytes. Objects in Storage are not pruned — they are content-addressed and cheap, and the
bucket is yours to set a lifecycle policy on.

| Limit | Default | Override |
|---|---|---|
| Images per crawl | 150 | `IMAGE_MAX_PER_CRAWL` |
| Bytes per crawl | 64 MB | `IMAGE_TOTAL_BYTES_PER_CRAWL` |
| Whole-batch deadline | 45 s | `IMAGE_DOWNLOAD_BUDGET_MS` |
| Bytes per image | 8 MB | — |

Raise them on the reader service if you crawl image-heavy pages; the useful ceiling
depends on the sites involved and the disk behind `STORAGE_DIR`.

Set `PUBLIC_BASE_URL` on the reader service to get absolute links, which matter as soon as
the markdown is stored or passed to another system.

## ⚙️ Configuration

All configuration is environment variables, and every service ships an annotated
`.env.example`:

| Service | File |
|---|---|
| Console | [frontend/.env.example](frontend/.env.example) |
| Backend | [backend/.env.example](backend/.env.example) |
| Reader | [services/reader/.env.example](services/reader/.env.example) |
| Segmenter | [services/segmenter/.env.example](services/segmenter/.env.example) |
| Vector store | [services/vectors/.env.example](services/vectors/.env.example) |
| Embeddings | [services/embeddings/.env.example](services/embeddings/.env.example) |
| Reranker | [services/reranker/.env.example](services/reranker/.env.example) |
| SearXNG | [services/searxng/.env.example](services/searxng/.env.example) |

Compose reads the `.env` sitting next to the file it was invoked with — so a service's own
`.env` applies when you run `docker compose up` **from that folder**, and a single `.env`
at the repo root applies when you run the whole stack. The variable names are the same
either way. Everything optional is genuinely optional: with nothing set, the backend runs
standalone.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `STORAGE_DIR` | `/app/local-storage` | Where screenshots are read from |
| `READER_URL` | *(unset)* | Enables `GET /<url>` and search's page reading |
| `READER_API_KEY` | *(unset)* | Shared secret for the reader service |
| `CORS_ORIGINS` | *(unset)* | Browser origins allowed to call the API; empty disables CORS |
| `SEGMENTER_URL` | *(unset)* | Enables `/v1/segment` |
| `SEGMENTER_API_KEY` | *(unset)* | Shared secret for the segmenter service |
| `VECTORS_URL` | *(unset)* | Enables `/v1/vectors/*` |
| `VECTORS_API_KEY` | *(unset)* | Shared secret for the vector service |
| `SEARXNG_URL` | *(unset)* | Enables `/v1/search` |
| `EMBEDDINGS_URL` | *(unset)* | Enables `/v1/embeddings` |
| `RERANKER_URL` | *(unset)* | Enables `/v1/rerank` |
| `INFERENCE_API_KEY` | *(unset)* | Shared secret for the model services |
| `DATABASE_URL` | *(unset)* | Enables the crawl cache (Prisma/Postgres) |
| `DIRECT_URL` | *(unset)* | Non-pooled URL, used only for migrations |

Browser settings — `PUPPETEER_EXECUTABLE_PATH`, `CHROME_ARGS` — belong to the reader
service now; see [services/reader/README.md](services/reader/README.md). Compose wires
`READER_URL` up automatically, so the table above only matters when running the backend
outside the stack.

## 🔎 Web search

`GET /v1/search?q=...` searches the web and, by default, reads every result through the
reader service — so you get the actual page content, not just snippets.

```bash
curl 'http://127.0.0.1:3000/v1/search?q=open+source+web+crawler'
curl 'http://127.0.0.1:3000/v1/search?q=...&read=false'      # snippets only, much faster
curl -H 'Accept: application/json' 'http://127.0.0.1:3000/v1/search?q=...'
```

| Parameter | Default | Meaning |
|---|---|---|
| `q` | *(required)* | The search query |
| `num` | `5` | Results to return, up to 20 |
| `read` | `true` | Read each result's page. Set `false` for titles and snippets only |

Search uses [SearXNG](https://github.com/searxng/searxng), self-hosted, so no API key is
involved. It starts with the root stack (`docker compose up`), or on its own from
[services/searxng/](services/searxng/).

Pointing at your own instance instead only needs `SEARXNG_URL`. One caveat worth knowing:
SearXNG ships with its JSON API **disabled**, and returns 403 without it — the bundled
[services/searxng/settings.yml](services/searxng/settings.yml) enables it by listing `json`
under `search.formats`. Result URLs go through the reader service, which SSRF-checks every
target, so a search backend cannot induce Substrate to fetch private addresses. A result
that cannot be read keeps its provider-supplied title and snippet rather than disappearing.

## ✂️ Segmenter

`POST /v1/segment` counts tokens and splits text into token-bounded chunks — the piece
you need between the reader and an embedding model.

```bash
curl -X POST 'http://127.0.0.1:3000/v1/segment' \
  -H 'Content-Type: application/json' \
  -d '{"content":"Your long document...","strategy":"markdown","max_chunk_length":512,"return_chunks":true}'
```

### Six strategies

The right cut depends on the document, so the caller picks rather than the server guessing.

| Strategy | Cuts at | Use when |
|---|---|---|
| `recursive` *(default)* | paragraphs → sentences → tokens | You are not sure. Respects structure, never exceeds the budget |
| `paragraph` | paragraph breaks | Arguments must stay whole and uneven chunks are fine |
| `sentence` | sentence ends | You want even chunk sizes |
| `token` | fixed token windows | The text has no usable boundaries (minified data, CJK) |
| `markdown` | headings | The document has sections — including the reader's own output |
| `semantic` | where the topic changes | Chunk quality matters more than latency |

`semantic` embeds each sentence and cuts where similarity to the previous one drops. It is
the only strategy that needs a model, and it degrades to `recursive` — reporting
`degraded_from` — when the embedding service is not running.

| Field | Default | Meaning |
|---|---|---|
| `content` | *(required)* | Text to segment, up to 250k characters |
| `strategy` | `recursive` | One of the six above |
| `max_chunk_length` | `1000` | Maximum tokens per chunk |
| `overlap` | `0` | Tokens of the previous chunk repeated at the start of the next |
| `min_chunk_length` | `0` | Chunks below this are merged into a neighbour |
| `heading_level` | `2` | `markdown`: cut at headings this deep or shallower |
| `similarity_threshold` | `0.82` | `semantic`: cut below this cosine similarity |
| `tokenizer` | `cl100k_base` | Also `o200k_base`, `p50k_base`, `p50k_edit`, `r50k_base`, `gpt2` |
| `return_chunks` / `return_tokens` | `false` | Include the chunks / every token's text |
| `head` / `tail` | — | Return only the first / last N tokens |

`chunk_positions` are character offsets into the input, and each chunk is exactly
`content.slice(start, end)` — so the chunks always concatenate back to the original with
nothing lost or duplicated. **Setting `overlap` deliberately ends that**: overlapping
chunks are windows, not a partition, which is the entire point of asking for them. Overlap
is taken out of the budget rather than added on top, so a chunk never exceeds
`max_chunk_length` — the size your embedding model actually enforces.

## 🧠 Embeddings and reranking

Two endpoints backed by model servers that run as their own containers, so their
CPU-bound work never blocks the API's event loop.

```bash
docker compose --profile ai up --build      # downloads the models on first start
```

### `POST /v1/embeddings`

```bash
curl -X POST 'http://127.0.0.1:3000/v1/embeddings'   -H 'Content-Type: application/json'   -d '{"input":["hello world"],"task":"retrieval.query"}'
```

| Field | Default | Meaning |
|---|---|---|
| `input` | *(required)* | A string, or a list of strings |
| `task` | `retrieval.passage` | `retrieval.query` applies the instruction prefix |
| `dimensions` | *(model default)* | Truncate the vector, then re-normalize — Matryoshka models only |
| `instruction` | *(configured)* | Overrides the default instruction for queries |

The response is exactly what the model service returned, in OpenAI's shape, so any
OpenAI-compatible client works against it unchanged.

### Composing the pipeline

Embeddings does not chunk, and does not fetch. Splitting a document is the segmenter's job
and storing vectors is the vector store's, so indexing a page is a few calls you make in
order:

```bash
# 1. read the page
curl 'http://127.0.0.1:3000/https://en.wikipedia.org/wiki/Vector_database'

# 2. split it
curl -X POST 'http://127.0.0.1:3000/v1/segment' -H 'Content-Type: application/json' \
  -d '{"content":"…","strategy":"markdown","max_chunk_length":300,"return_chunks":true}'

# 3. embed the chunks
curl -X POST 'http://127.0.0.1:3000/v1/embeddings' -H 'Content-Type: application/json' \
  -d '{"input":["…chunk one…","…chunk two…"],"task":"retrieval.passage"}'

# 4. store them
curl -X POST 'http://127.0.0.1:3000/v1/vectors/collections/docs_1024/upsert' \
  -H 'Content-Type: application/json' \
  -d '{"records":[{"id":"doc-0","vector":[…],"metadata":{"text":"…chunk one…"}}]}'
```

That is deliberately not one endpoint. Folding chunking into embeddings meant a second,
worse implementation of the segmenter to keep in step with the real one — and it hid the
step you most need to see, because the chunk *text* is what you store beside the vector.
Keeping them apart is also what lets you replace any single stage with something this
project does not ship.

Embedding is slow on CPU — a page's worth of chunks takes minutes — so batch the chunks
yourself in sizes that fit your timeout, and use a GPU (`EMBEDDINGS_DEVICE=cuda`) if you
intend to index at any volume.

The `task` distinction is not cosmetic: instruction-tuned embedding models expect the
prefix on **queries only**, and applying it to documents quietly costs retrieval quality.

`dimensions` is only accepted when the model was trained for truncation. Slicing any
embedding "works" arithmetically and re-normalizing keeps it unit length, so a model
without Matryoshka training would answer with a perfectly plausible short vector whose
retrieval quality has quietly collapsed — a failure nothing downstream can detect. That is
refused instead, and `EMBEDDINGS_SUPPORTS_MRL` is how a model declares otherwise. When it
is accepted, the truncated vector is re-normalized so cosine similarity stays correct;
store the dimension you chose, since vectors of different lengths are not comparable.

### `POST /v1/rerank`

```bash
curl -X POST 'http://127.0.0.1:3000/v1/rerank'   -H 'Content-Type: application/json'   -d '{"query":"capital of France",
       "documents":["Bananas are a fruit.","Paris is the capital of France."],
       "top_n":2,"return_documents":true}'
```

Results are sorted by `relevance_score`, and `index` refers to the position in the
request's `documents` array.

### Models

| | Default | License | Dims |
|---|---|---|---|
| Embeddings | `microsoft/harrier-oss-v1-0.6b` | MIT | 1024 |
| Reranker | `Qwen/Qwen3-Reranker-0.6B` | Apache-2.0 | — |

Both are swappable via `EMBEDDINGS_MODEL_ID` / `RERANKER_MODEL_ID`. The reranker supports
two architectures through `RERANKER_MODEL_KIND`: `causal` (Qwen3-style yes/no scoring) and
`cross-encoder` (BGE-style classifiers).

The embedding default is a near drop-in for the Qwen3 embedder it replaced — same family
of backbone, same 1024 dimensions, same instruction-prefix convention — under a more
permissive license. It costs exactly one thing: it does not document Matryoshka, so
`dimensions` is refused unless you say otherwise. Going back is one pair of variables:

```bash
EMBEDDINGS_MODEL_ID=Qwen/Qwen3-Embedding-0.6B
EMBEDDINGS_SUPPORTS_MRL=true
```

The reranker default is unchanged, and that is a decision rather than neglect. Several
rerankers now score better and every one of them is disqualified here: `jina-reranker-v3`
and `ctxl-rerank-v2` are non-commercial despite being described as open, and the
permissively licensed ones need `trust_remote_code` and a third scoring path in the
service. Set `RERANKER_MODEL_ID` if that trade is yours to make differently.

Jina's own `jina-embeddings-v3` and the v5 family are CC-BY-NC — despite being widely
described otherwise — so they are deliberately not defaults here. An open-source project
should not ship non-commercial weights.

With neither service running, both endpoints return 503 explaining how to enable them;
nothing else is affected. Implementation lives in
[services/embeddings/](services/embeddings/) and [services/reranker/](services/reranker/).

## 🧮 Vector store

`/v1/vectors/*` keeps vectors in Postgres through
[pgvector](https://github.com/pgvector/pgvector) and answers nearest-neighbour queries —
the last stage of the pipeline above, so what you embed has somewhere to go.

It is built on Supabase's [`vecs`](https://github.com/supabase/vecs), which is a client
for pgvector, **not** a dependency on the Supabase platform: any Postgres with the
extension available works, including the one already holding the crawl cache.

```bash
curl -X POST 'http://127.0.0.1:3000/v1/vectors/collections' \
  -H 'Content-Type: application/json' -d '{"name":"docs_1024","dimension":1024}'

curl -X POST 'http://127.0.0.1:3000/v1/vectors/collections/docs_1024/upsert' \
  -H 'Content-Type: application/json' \
  -d '{"records":[{"id":"doc-0","vector":[…],"metadata":{"url":"https://…"}}]}'

curl -X POST 'http://127.0.0.1:3000/v1/vectors/collections/docs_1024/query' \
  -H 'Content-Type: application/json' -d '{"vector":[…],"limit":5}'
```

A query returns both the raw `distance` and the `similarity` (`1 - distance`), so neither
side has to remember which way round cosine distance runs. Metadata comes back with each
match and can be filtered on, which is how you store the chunk text next to its vector.

It never embeds anything — you bring the vectors — and that is what keeps it usable with
any model, including one this project does not ship. Three behaviours are worth knowing
before you build on it: a collection's width is **fixed at creation**, so changing model
means a new collection rather than a migration (hence naming them `docs_1024`); building
an index **blocks writes**, so it is a separate endpoint you call when you choose to; and
pgvector cannot index past **2000 dimensions**, so wider collections are refused up front
instead of silently scanning every row later.

It needs a direct (non-pooled) database URL, because it issues DDL, and its tables live
in a `vecs` schema of their own so they never collide with the backend's Prisma-managed
ones. With nothing configured it answers 503, like every other optional dependency here.
See [services/vectors/README.md](services/vectors/README.md).

## 🗄️ Optional database

The backend runs standalone by default. Give it a Postgres connection and crawl results
are cached there, so a repeat request for the same URL never reaches the browser.
Responses carry `X-Cache: HIT` or `MISS`.

```bash
DATABASE_URL=postgresql://user:pass@host:5432/reader docker compose up --build
```

Migrations run automatically at container start when `DATABASE_URL` is set. Requests using
cookies, a proxy, or an inline `html` body are never cached, and screenshots are not
cached. If the database is unreachable the backend logs a warning and crawls live — a
missing cache never fails a request.

Access is through [Prisma](https://www.prisma.io/); the schema lives in
[backend/prisma/schema.prisma](backend/prisma/schema.prisma). To change it:

```bash
cd backend
npx prisma migrate dev --name your_change   # creates a migration and applies it
```

**Any** Postgres works — nothing here is Supabase-specific except the optional object
storage below. If you want Postgres plus a dashboard, the self-hosted
[Supabase](https://supabase.com/docs/guides/self-hosting) stack drops into
`services/supabase/`. It is not committed to this repository, because it is a large
independent project with its own release cycle:

```bash
git clone --depth 1 https://github.com/supabase/supabase services/supabase-src
cp -r services/supabase-src/docker services/supabase
cd services/supabase && cp .env.example .env && docker compose up -d
```

It has its own lifecycle, so start it separately and then point `DATABASE_URL` at it.

Supabase Storage can also hold screenshots and downloaded images instead of the local
volume — set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_PUBLIC_URL` **on
the reader service**, which is what writes them. That is independent of the database
setting above, and of the vector store, which needs only pgvector.

The service-role key bypasses row-level security, so it belongs to the reader service and
nothing else — never to the console, and never to a browser.

## 🛠️ Local development

Four Node apps — the backend and two [NestJS](https://nestjs.com/) services, plus the
console — all requiring Node.js 22+. Each is independent: same scripts, separate
`node_modules`. The Python services under `services/` are built by Docker only.

```bash
cd backend            # or services/reader, services/segmenter, frontend
npm install
npm run start:dev     # watch mode
npm run build         # backend: prisma generate + nest build
npm run start         # run the compiled app
npm run typecheck
```

Run the reader service first, then point the backend at it. Outside Docker the browser
also needs Chrome-compatible flags — **`--single-process` crashes Chrome on Windows and
macOS**, which is why the container default has to be overridden:

```bash
# terminal 1
cd services/reader
CHROME_ARGS="--no-sandbox,--disable-dev-shm-usage" STORAGE_DIR=../../backend/screenshots npm run start:dev

# terminal 2
cd backend
READER_URL=http://127.0.0.1:3001 STORAGE_DIR=./screenshots npm run start:dev
```

Both need the same `STORAGE_DIR`: the reader writes screenshots there and the backend
serves them.

## 🏗️ Project layout

A monorepo. `backend/` is the API everything is called through; each thing it depends on
— the browser included — is a separate service with its own Dockerfile and compose file.

```
├── docker-compose.yaml       root stack; includes the files below
├── frontend/                 the console — React + Vite, served by nginx
│   ├── Dockerfile
│   ├── nginx.conf            serves the bundle and proxies /api to the backend
│   └── src/panels/           one panel per capability
├── backend/                  the API
│   ├── Dockerfile            no browser: small, and immune to Chrome crashes
│   ├── docker-compose.yaml
│   ├── prisma/               schema and migrations
│   └── src/
│       ├── main.ts           bootstrap: static assets, pipes, shutdown hooks
│       ├── app.module.ts     module order matters — reader is last
│       ├── common/           errors, helpers, exception filter
│       ├── config/           env-driven configuration and tuning constants
│       ├── prisma/           PrismaService (database optional)
│       ├── health/           GET /health
│       ├── reader/           GET /<url>  — catch-all endpoint + reader service client
│       ├── search/           GET|POST /v1/search
│       ├── segment/          POST /v1/segment — client for the segmenter service
│       ├── inference/        POST /v1/embeddings, /v1/rerank
│       ├── vectors/          POST /v1/vectors/* — client for the vector service
│       └── cache/            Postgres-backed crawl cache
└── services/
    ├── reader/               headless Chrome behind POST /crawl
    │   └── src/
    │       ├── crawl/        the endpoint and its request/result contract
    │       ├── crawler/      crawl orchestration
    │       ├── rendering/    browser, DOM, PDF and output formatting
    │       ├── storage/      screenshot and image persistence (Supabase or local)
    │       └── security/     SSRF guard
    ├── segmenter/            token counting and chunking strategies
    ├── vectors/              pgvector storage and search, via Supabase's vecs
    ├── searxng/              search backend
    ├── embeddings/           FastAPI + sentence-transformers (profile: ai)
    ├── reranker/             FastAPI + transformers (profile: ai)
    └── supabase/             vendored self-hosted Supabase stack
```

Each part documents itself, and those are the files to read before changing one:

| | |
|---|---|
| [frontend/README.md](frontend/README.md) | The console, and why the API is proxied rather than called directly |
| [services/reader/README.md](services/reader/README.md) | The browser, the two timeouts, and image downloading |
| [services/segmenter/README.md](services/segmenter/README.md) | The six chunking strategies and what each is for |
| [services/vectors/README.md](services/vectors/README.md) | The vector store, and what to know before you build on it |
| [services/embeddings/README.md](services/embeddings/README.md) | The embedding model, and the query/document asymmetry |
| [services/reranker/README.md](services/reranker/README.md) | The two scoring architectures, and how to avoid picking the wrong one |

Two conventions are load-bearing:

- **The reader's catch-all is registered last.** It claims every unmatched path, so
  `ReaderModule` is imported last in `app.module.ts` and static assets are registered in
  `main.ts` before it. `ReaderClient` lives in its own controller-free module so search
  can depend on it without dragging that route registration forward.
- **Fetch-time rules live in the reader service.** SSRF checks, proxy allowlists and
  selector validation are enforced by the process that actually opens the connection, not
  by the caller. The backend only rejects input it can reject without a network hop, and
  forwards the service's status codes unchanged.

## 📜 License

[Apache-2.0](LICENSE), the same license as the Jina AI Reader project this derives from.

Both copyright notices are retained, as that license requires, and [NOTICE](NOTICE)
records where the project came from and what changed. If you redistribute Substrate or a
work based on it, ship both files.

A few things that run *alongside* Substrate carry their own licenses and are not
redistributed by it — SearXNG is AGPL-3.0 and is used over HTTP as a separate service, and
the model weights are downloaded at runtime. [NOTICE](NOTICE) lists them.
