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

## Default model

`Qwen/Qwen3-Embedding-0.6B` — **Apache-2.0**, 32k context, 1024 dimensions with
Matryoshka support down to 32. Swap it with `MODEL_ID`; any sentence-transformers model
works.

Notably *not* used: `jina-embeddings-v3` and the v5 family are CC-BY-NC, so they cannot
be a default for a commercially usable project.

## Two details that matter

- **The instruction prefix goes on queries only, never documents.** That asymmetry is
  what the instruction-tuned models were trained for; applying it to both quietly costs
  retrieval quality. Hence the explicit `task` field rather than a guess.
- **Truncated vectors are re-normalized.** The model returns a unit-length vector; a
  slice of it is not unit length, and skipping the re-normalization makes cosine
  similarity subtly wrong. Store the dimension you chose alongside the vectors — vectors
  of different lengths are not comparable.

## Configuration

See [.env.example](.env.example) for the full annotated list. Compose maps a prefixed
host variable onto the unprefixed one the app reads, so the two columns differ:

| In `.env` (Compose) | Read by the app | Default | Purpose |
|---|---|---|---|
| `EMBEDDINGS_MODEL_ID` | `MODEL_ID` | `Qwen/Qwen3-Embedding-0.6B` | Any sentence-transformers model |
| `EMBEDDINGS_DEVICE` | `MODEL_DEVICE` | `cpu` | `cuda` if you have a GPU |
| `EMBEDDINGS_BATCH_SIZE` | `MAX_BATCH_SIZE` | `32` | Texts encoded per forward pass |
| `EMBEDDINGS_MAX_INPUTS` | `MAX_INPUTS` | `256` | Inputs accepted in one request |
| `EMBEDDINGS_USE_INSTRUCTION` | `USE_INSTRUCTION` | `true` | Set `false` for models that do not want a prefix |
| `EMBEDDINGS_INSTRUCTION` | `DEFAULT_INSTRUCTION` | *(built-in)* | Overrides the retrieval instruction |
| `INFERENCE_API_KEY` | *(same)* | *(unset)* | When set, requires `Authorization: Bearer <key>` |

The first start downloads the weights into `./models`, which is why the healthcheck
allows a long start period.
