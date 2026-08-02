# Substrate — embedding service

FastAPI over a [sentence-transformers](https://sbert.net/) model, exposing an
OpenAI-compatible embeddings endpoint that the backend proxies at `/v1/embeddings`.

## API

```
GET  /health          model, dimensions, device
POST /v1/embeddings
```

```bash
curl -X POST http://localhost:8000/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"input": ["hello world"], "task": "retrieval.query", "dimensions": 256}'
```

| Field | Default | Meaning |
|---|---|---|
| `input` | *(required)* | A string, or a list of strings |
| `task` | `retrieval.passage` | `retrieval.query` applies the instruction prefix |
| `dimensions` | *(model default)* | Truncate the vector (Matryoshka), then re-normalize |
| `instruction` | *(configured)* | Overrides the default instruction for queries |

## Run it from the published image

```bash
docker pull ghcr.io/radicale06/substrate-embeddings:latest

docker run --rm -p 8000:8000 \
  -v substrate-models:/models \
  ghcr.io/radicale06/substrate-embeddings:latest
```

Mount `/models` or the weights download again on every start — about 1.2GB for the
default. The first start is slow for that reason; `/health` answers 200 with the model
still loading and `/v1/embeddings` returns 503 until it is ready, so wait on the latter.

Add `-e MODEL_DEVICE=cuda --gpus all` if you have a GPU. On CPU this works and is slow,
which is fine for trying it and not for indexing at volume.

## Default model

`microsoft/harrier-oss-v1-0.6b` — **MIT**, 1024 dimensions. Swap it with `MODEL_ID`; any
sentence-transformers model works.

It does not document Matryoshka, so `SUPPORTS_MRL` defaults to false and `dimensions` is
**rejected with a 400** rather than answered. `Qwen/Qwen3-Embedding-0.6B` (Apache-2.0,
32k context, MRL down to 32) remains a one-variable swap if you need truncation:

```bash
EMBEDDINGS_MODEL_ID=Qwen/Qwen3-Embedding-0.6B EMBEDDINGS_SUPPORTS_MRL=true
```

Notably *not* used: `jina-embeddings-v3` and the v5 family are CC-BY-NC — whatever the
blog posts say — so they cannot be a default for a commercially usable project.

## Two details that matter

- **The instruction prefix goes on queries only, never documents.** That asymmetry is
  what the instruction-tuned models were trained for; applying it to both quietly costs
  retrieval quality. Hence the explicit `task` field rather than a guess.
- **Truncated vectors are re-normalized.** The model returns a unit-length vector; a
  slice of it is not unit length, and skipping the re-normalization makes cosine
  similarity subtly wrong. Store the dimension you chose alongside the vectors — vectors
  of different lengths are not comparable.
- **Truncation is refused unless the model was trained for it.** This is why `SUPPORTS_MRL`
  exists rather than being inferred: slicing *any* embedding works arithmetically, and
  re-normalizing gives back a unit vector of exactly the requested size, so a non-Matryoshka
  model fails by returning a plausible answer whose retrieval quality has collapsed. There
  is no way to detect that from the model files, and a wrong guess is invisible until
  recall is bad in production — so it is declared, not detected.
- **It does not chunk.** Text in, vectors out. Splitting is `/v1/segment` and storing is
  `/v1/vectors`; each stays separately useful, and you keep the chunk text — which is what
  you actually want beside the vector.

## Configuration

See [.env.example](.env.example) for the full annotated list. Compose maps a prefixed
host variable onto the unprefixed one the app reads, so the two columns differ:

| In `.env` (Compose) | Read by the app | Default | Purpose |
|---|---|---|---|
| `EMBEDDINGS_MODEL_ID` | `MODEL_ID` | `microsoft/harrier-oss-v1-0.6b` | Any sentence-transformers model |
| `EMBEDDINGS_DEVICE` | `MODEL_DEVICE` | `cpu` | `cuda` if you have a GPU |
| `EMBEDDINGS_BATCH_SIZE` | `MAX_BATCH_SIZE` | `32` | Texts encoded per forward pass |
| `EMBEDDINGS_MAX_INPUTS` | `MAX_INPUTS` | `256` | Inputs accepted in one request |
| `EMBEDDINGS_USE_INSTRUCTION` | `USE_INSTRUCTION` | `true` | Set `false` for models that do not want a prefix |
| `EMBEDDINGS_SUPPORTS_MRL` | `SUPPORTS_MRL` | `false` | Set `true` only for models documenting Matryoshka |
| `EMBEDDINGS_INSTRUCTION` | `DEFAULT_INSTRUCTION` | *(built-in)* | Overrides the retrieval instruction |
| `INFERENCE_API_KEY` | *(same)* | *(unset)* | When set, requires `Authorization: Bearer <key>` |

The first start downloads the weights into `./models`, which is why the healthcheck
allows a long start period.
