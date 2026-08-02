# Substrate — reranker service

FastAPI over a [transformers](https://huggingface.co/docs/transformers) reranking model,
exposing a Jina/Cohere-shaped endpoint that the backend proxies at `/v1/rerank`.

## API

```
GET  /health      model, kind, device
POST /v1/rerank
```

```bash
curl -X POST http://localhost:8000/v1/rerank \
  -H 'Content-Type: application/json' \
  -d '{"query":"What is the capital of France?",
       "documents":["Paris is the capital of France.","Bananas are a fruit."],
       "top_n":2,"return_documents":true}'
```

Results come back sorted by `relevance_score`, with `index` pointing at the position in
the request's `documents` array.

## Run it from the published image

```bash
docker pull ghcr.io/radicale06/substrate-reranker:latest

docker run --rm -p 8000:8000 \
  -v substrate-models:/models \
  ghcr.io/radicale06/substrate-reranker:latest
```

Same shape as the embedding service: mount `/models` to keep the weights across restarts,
`-e MODEL_DEVICE=cuda --gpus all` for a GPU. Switching model means switching `MODEL_KIND`
with it — see below, because the wrong pairing scores wrongly rather than erroring.

## Two model families, one API

`MODEL_KIND` selects how scores are produced:

| Kind | For | How it scores |
|---|---|---|
| `causal` *(default)* | `Qwen/Qwen3-Reranker-0.6B` | Asks the model "yes" or "no", scores the probability of "yes" |
| `cross-encoder` | `BAAI/bge-reranker-v2-m3` and similar | Sequence-classification logit, squashed to 0–1 |

Both are **Apache-2.0**. Qwen3-Reranker scores better on retrieval benchmarks; the BGE
cross-encoder is the conservative, longer-established option. Avoid
`mxbai-rerank-large-v2` with `causal`: it is Apache-2.0 and looks ideal, but it is a
Qwen2 architecture and will not score correctly under the Qwen3 prompt.

## Why the scoring code looks the way it does

- **The prompt wording is not decorative.** Qwen3-Reranker was fine-tuned to answer that
  exact question, so changing the template degrades scores rather than erroring.
- **Padding is left-side for `causal`.** The score is read from the final token position,
  which must be the real last token and not padding.
- **Scores are softmaxed over just the yes/no pair**, so the number reflects confidence in
  "yes" *relative to "no"* rather than against the whole vocabulary.
- **Cross-encoder logits are squashed with a sigmoid.** These models emit raw logits that
  can be negative; sigmoid is monotonic, so ranking is unchanged and callers always see a
  comparable 0–1 score.
- **A sanity check runs at startup**, scoring one relevant and one irrelevant document and
  logging a warning if the ordering is wrong. A mis-configured reranker does not raise —
  it silently returns meaningless numbers — so it is worth catching at boot.

## Configuration

See [.env.example](.env.example) for the full annotated list. Compose maps a prefixed
host variable onto the unprefixed one the app reads, so the two columns differ:

| In `.env` (Compose) | Read by the app | Default | Purpose |
|---|---|---|---|
| `RERANKER_MODEL_ID` | `MODEL_ID` | `Qwen/Qwen3-Reranker-0.6B` | Any supported reranking model |
| `RERANKER_MODEL_KIND` | `MODEL_KIND` | `causal` | `causal` or `cross-encoder` |
| `RERANKER_DEVICE` | `MODEL_DEVICE` | `cpu` | `cuda` if you have a GPU |
| `RERANKER_BATCH_SIZE` | `MAX_BATCH_SIZE` | `8` | Pairs scored per forward pass |
| `RERANKER_MAX_DOCUMENTS` | `MAX_DOCUMENTS` | `200` | Documents accepted in one request |
| `RERANKER_MAX_LENGTH` | `MAX_LENGTH` | `4096` | Token budget per query/document pair |
| `RERANKER_INSTRUCTION` | `DEFAULT_INSTRUCTION` | *(built-in)* | Overrides the scoring instruction |
| `INFERENCE_API_KEY` | *(same)* | *(unset)* | When set, requires `Authorization: Bearer <key>` |
