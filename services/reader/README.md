# Substrate — reader service

A headless Chrome behind an HTTP endpoint. Give it a URL, get back the page as markdown,
HTML, plain text or a PNG. The backend proxies it at `GET /<url>`.

## API

```
GET  /health      browser state
POST /crawl
```

```bash
curl -X POST http://localhost:3001/crawl \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "format": "default"}'
```

```jsonc
{
  "format": "default",
  "title": "Example Domain",
  "description": "…",
  "url": "https://example.com/",
  "content": "…markdown…",
  "rendered": "Title: Example Domain\n\nURL Source: …\n\nMarkdown Content:\n…"
}
```

| Field | Default | Meaning |
|---|---|---|
| `url` | *(required)* | Absolute `http`/`https` URL |
| `format` | `default` | `default`, `markdown`, `html`, `text`, `screenshot`, `pageshot` |
| `html` | — | Convert this markup instead of fetching; `url` is still the link base |
| `targetSelector` / `removeSelector` | — | Narrow the DOM before conversion |
| `waitForSelector` | — | Wait for this element, then drain the snapshot stream |
| `withLinksSummary` / `withImagesSummary` | `false` | Append page inventories |
| `withImagesDownload` | `false` | Store the article's images and rewrite links to local copies |
| `withIframe` | `false` | Include child frames; implies draining the stream |
| `keepImgDataUrl` | `false` | Keep `data:` image sources instead of `blob:` placeholders |
| `setCookies`, `proxyUrl`, `userAgent` | — | Passed to the browser |
| `timeout` | — | Seconds to keep collecting snapshots before answering |
| `navigationTimeoutMs` | `30000` | Caps the fetch **without** waiting out the full duration |
| `selfHostname` | — | A host the crawled page must not be able to call back into |

Failures come back as `{ code, status, message }` with a status that says what went
wrong — `400` unusable input, `403` blocked target, `404` nothing rendered, `502` the
fetch failed, `503` the browser crashed. The backend forwards them unchanged.

## Two timeouts, on purpose

`timeout` and `navigationTimeoutMs` sound like the same knob and are not.

`timeout` means *"keep watching this page for N seconds and give me the best snapshot"* —
it suppresses the early answer, so the call always takes the full N. That is what a caller
who set `X-Timeout` asked for. `navigationTimeoutMs` only bounds the fetch; the response
still comes back the moment the page has usable content. Search reads its results with the
second one, because waiting out a timeout per result would make every search take minutes.

## Run it from the published image

```bash
docker pull ghcr.io/radicale06/substrate-reader:latest

docker run --rm -p 3001:3001 \
  --shm-size=1g \
  -v substrate-screenshots:/app/local-storage \
  ghcr.io/radicale06/substrate-reader:latest
```

`--shm-size` is not optional in spirit. Chrome's default 64MB of `/dev/shm` in a container
is not enough for real pages, and the image works around it with `--disable-dev-shm-usage`
— which trades the crash for slower rendering. Giving it real shared memory is the better
half of that trade.

The volume is what the backend serves screenshots and downloaded images from, so both
containers must mount the same one at the same path. Nothing else is required: with no
configuration the service crawls, converts and stores locally.

## Why this is a separate service

Chrome is the largest and least stable dependency in the stack. Running it here means the
API image carries no browser, a crash loop cannot take the API down with it, and crawling
capacity can be scaled without scaling anything else.

The trade is that the browser is now behind a network hop — so this service is the one
that enforces the fetch-time rules (SSRF, proxy allowlists, selector validation), because
it is the process that actually opens the connection.

## Downloading images

`withImagesDownload` mirrors **every image the page carries** — not only the ones the
extracted article links to — and rewrites the markdown links to stored copies under
`IMAGE_ROUTE`, alongside a per-image `imageAssets` report. Referenced images are queued
first, because the per-crawl cap dropping a navigation icon costs nothing while dropping
an article image leaves a body link pointing at the origin. Bytes come from the cheapest source that has them: an inline `data:` payload needs
no network, an image the render already downloaded is harvested from the browser, and only
what neither covers is fetched.

Harvesting is why this is affordable. Images are not blocked during render — only `media`
is — so they are downloaded and discarded anyway; reusing them costs nothing and inherits
the browser's cookies and Referer, which is often the difference between a stored image
and a 403. It is a **passive** `requestfinished` observer, never a second `page.on(
'request')` handler: puppeteer turns request handlers into interception votes, so adding
one would silently break the cooperative protocol the SSRF guard, `block-resources` and
`page-proxy` all rely on.

The fetch path treats every URL as hostile, because they come from the page: SSRF checks
per redirect hop including a DNS pre-resolution, no cookies (they may be caller-supplied
while the URL is page-supplied), credentials stripped, a streaming size cap, and a
per-host concurrency limit so a gallery page cannot turn this service into a DoS client.
It is disabled entirely when the crawl used a proxy, since re-fetching would leak the
service's own egress IP.

Stored bytes are identified by magic number, never by Content-Type or extension, so the
stored filename can only ever carry a whitelisted extension. SVG fails that check by
construction, which is deliberate: these files are served back from an origin of yours.

### Where the bytes go

Supabase Storage when it is configured, `STORAGE_DIR/instant-images` otherwise.
`IMAGE_STORAGE` makes that a decision rather than an inference — `supabase`, `local`, or
`auto` (the default). In `supabase` mode there is no local fallback: an upload that fails
leaves the original remote URL in the markdown, because falling back would write to a
volume the backend may not be serving, producing links that 404 rather than links that
merely point elsewhere.

Object names are a content hash, sharded two levels (`3f/a7/3fa7….jpg`), so the same image
is stored once across every crawl. They are uploaded with `upsert` and a one-year
`Cache-Control`: a name collision *is* the same bytes, so overwriting is a semantic no-op —
and it removes the need to recognise an "already exists" error, whose shape is not stable
across Storage versions and whose misclassification silently sent every repeat image to
local disk.

`SUPABASE_URL` and `SUPABASE_PUBLIC_URL` are a pair. Storage builds links from the URL it
was constructed with, which inside Compose is an internal hostname no browser can resolve,
so Storage is refused outright rather than enabled into handing out links that are broken
before they are returned.

## Screenshots

`screenshot` and `pageshot` are saved, not inlined, and the response carries a URL. By
default they go to `STORAGE_DIR/instant-screenshots` and the backend serves them from the
same volume — so the two containers must mount it at the same path. Configure Supabase
Storage instead and the URLs become absolute and outlive the container.

Local files are pruned by age and count, so an unattended instance cannot fill its disk.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP port |
| `STORAGE_DIR` | `/app/local-storage` | Root for saved screenshots |
| `PUPPETEER_EXECUTABLE_PATH` | *(puppeteer's own)* | Chrome binary to drive |
| `CHROME_ARGS` | see below | Chrome launch flags |
| `READER_API_KEY` | *(unset)* | When set, requires `Authorization: Bearer <key>` |
| `PUBLIC_BASE_URL` | *(unset)* | Makes stored-image links absolute rather than host-relative |
| `IMAGE_MAX_PER_CRAWL` | `150` | Images downloaded per crawl |
| `IMAGE_TOTAL_BYTES_PER_CRAWL` | `64MB` | Byte budget per crawl |
| `IMAGE_DOWNLOAD_BUDGET_MS` | `45000` | Whole-batch deadline |
| `IMAGE_STORAGE` | `auto` | `supabase`, `local`, or `auto` (Storage if credentials exist) |
| `SUPABASE_IMAGE_BUCKET` | `substrate-images` | Bucket for downloaded images |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLIC_URL` | *(unset)* | Send screenshots and images to Storage |

`CHROME_ARGS` defaults to `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage
--single-process`, which suits a small Linux container. **`--single-process` crashes
Chrome on Windows and macOS**, so override it when running outside Docker:

```bash
CHROME_ARGS="--no-sandbox,--disable-dev-shm-usage" npm run start:dev
```

## Running it alone

```bash
npm install
npm run build && npm start
```

No port is published in the compose file. This service fetches whatever URL it is handed,
so it is meant to sit on an internal network; publish it only behind `READER_API_KEY`.
