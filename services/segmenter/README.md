# Substrate — segmenter service

Token counting and chunking. The backend proxies it at `/v1/segment`.

This is the only place in the stack that splits text. `/v1/embeddings` deliberately does
not — you segment, then embed the chunks, and keep the chunk text to store beside the
vectors.

## API

```
GET  /health      whether the semantic strategy is available
POST /segment
```

```bash
curl -X POST http://localhost:3002/segment \
  -H 'Content-Type: application/json' \
  -d '{"content": "…", "strategy": "markdown", "max_chunk_length": 512, "return_chunks": true}'
```

| Field | Default | Meaning |
|---|---|---|
| `content` | *(required)* | Text to segment, up to 250k characters |
| `strategy` | `recursive` | See below |
| `max_chunk_length` | `1000` | Maximum tokens per chunk |
| `overlap` | `0` | Tokens of the previous chunk repeated at the start of the next |
| `min_chunk_length` | `0` | Chunks below this are merged into a neighbour |
| `heading_level` | `2` | `markdown`: cut at headings this deep or shallower |
| `similarity_threshold` | `0.82` | `semantic`: cut when adjacent similarity falls below this |
| `tokenizer` | `cl100k_base` | Also `o200k_base`, `p50k_base`, `p50k_edit`, `r50k_base`, `gpt2` |
| `return_chunks` / `return_tokens` | `false` | Include the chunks / every token's text |
| `head` / `tail` | — | Return only the first / last N tokens |

## Run it from the published image

```bash
docker pull ghcr.io/radicale06/substrate-segmenter:latest

docker run --rm -p 3002:3002 ghcr.io/radicale06/substrate-segmenter:latest
```

The only service here that needs neither a browser nor model weights, so it starts
instantly and runs anywhere. Add `-e EMBEDDINGS_URL=http://host.docker.internal:8000` to
enable the `semantic` strategy; without it that strategy degrades to `recursive` and says
so in the response rather than failing.

## Strategies

These are different trade-offs, not presets of one algorithm — which is why the caller
picks rather than the server guessing.

| Strategy | Cuts at | Use when |
|---|---|---|
| `recursive` | paragraphs → sentences → tokens | You are not sure. Respects structure, never exceeds the budget |
| `paragraph` | paragraph breaks | Arguments must stay whole and uneven chunks are fine |
| `sentence` | sentence ends | You want even chunk sizes |
| `token` | fixed token windows | The text has no usable boundaries at all (minified data, CJK) |
| `markdown` | headings | The document has sections — including the reader's own output |
| `semantic` | where the topic changes | Chunk quality matters more than latency |

`semantic` embeds each sentence and starts a new chunk where the similarity to the
previous one drops below the threshold. It is the only strategy that needs a model, so it
degrades to `recursive` — and reports `degraded_from: "semantic"` — when the embedding
service is unavailable or the text runs past the sentence budget. Nothing else here needs
a model at all, which is why this service starts instantly and holds no weights.

## Two guarantees, and when one of them stops applying

**Chunk positions are exact.** `chunk_positions` are character offsets into the input and
each chunk is exactly `content.slice(start, end)`, so the reported positions cannot drift
from the text you receive.

**Chunks partition the input** — they concatenate back to the original with nothing lost
or duplicated. This stops being true the moment you set `overlap`, and deliberately so:
overlapping chunks are windows, not a partition. A fact spanning a boundary would
otherwise be missing from both sides of it.

Overlap is taken **out of** the budget rather than added on top. `max_chunk_length` is
what your embedding model will accept, so a chunk that came back larger than it — because
overlap was appended afterwards — would be rejected downstream.

## Why this is a separate service

Tokenizing is synchronous and CPU-bound: a large document blocks the event loop for
seconds. Running it here means that stall is confined to a process where nothing else is
waiting on it, rather than freezing every in-flight request to the API.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3002` | HTTP port |
| `SEGMENTER_API_KEY` | *(unset)* | When set, requires `Authorization: Bearer <key>` |
| `EMBEDDINGS_URL` | *(unset)* | Only the `semantic` strategy uses it |
| `INFERENCE_API_KEY` | *(unset)* | Shared secret for the embedding service |

## Running it alone

```bash
npm install
npm run build && npm start
```

No port is published in the compose file; the backend reaches it over the compose network.
