# Substrate — vector service

Vector storage and nearest-neighbour search, on Postgres via
[pgvector](https://github.com/pgvector/pgvector). The backend proxies it at
`/v1/vectors/*`.

Built on Supabase's [`vecs`](https://github.com/supabase/vecs), which is a client for
pgvector — **not** a dependency on the Supabase platform. It runs against any Postgres
with the extension available.

## API

```
GET    /health
GET    /v1/collections
POST   /v1/collections                    {name, dimension, index}
DELETE /v1/collections/{name}
POST   /v1/collections/{name}/upsert      {records: [{id, vector, metadata}]}
POST   /v1/collections/{name}/query       {vector, limit, filters, ef_search}
POST   /v1/collections/{name}/fetch       {ids}
POST   /v1/collections/{name}/delete      {ids} | {filters}
POST   /v1/collections/{name}/index       {replace}
```

```bash
curl -X POST http://localhost:8000/v1/collections \
  -H 'Content-Type: application/json' \
  -d '{"name": "docs", "dimension": 1024}'

curl -X POST http://localhost:8000/v1/collections/docs/query \
  -H 'Content-Type: application/json' \
  -d '{"vector": [0.1, 0.2, ...], "limit": 5}'
```

A query returns both the raw `distance` and the `similarity` (`1 - distance`), so neither
side has to remember which way round cosine distance runs.

## It does not embed

Vectors come in, ids and distances go out. That is the whole boundary, and it is
deliberate: the embedding service stays stateless, this store stays model-agnostic, and
swapping the embedding model needs no change here.

The pipeline is yours to compose — `/v1/segment` to chunk, `/v1/embeddings` to embed,
then upsert here. Each step is separately useful, and you keep the chunk text, which is
what you actually want to store next to the vector.

## Things worth knowing before you use it

**A collection's width is fixed at creation.** `get_or_create_collection` raises on a
mismatch rather than adapting. Changing embedding model therefore means a new collection,
not a migration — naming them `docs_1024` rather than `docs` makes that additive instead
of fatal.

**Index building blocks writes.** `CREATE INDEX` is issued without `CONCURRENTLY`, so it
takes an exclusive lock for as long as the build takes. That is instant on an empty
collection and an outage on a large one, which is why it is a separate endpoint you call
when you choose to — creation only indexes because the collection is empty at that moment.

**Cosine everywhere.** The measure used to build the index and the measure used to query
must match, or pgvector ignores the index and sequentially scans the table while `vecs`
emits a warning nobody reads. Both are pinned to cosine here.

**Dimensions above 2000 cannot be indexed at all** — a pgvector limit. A wider collection
would work and would scan every row, so creation is refused past `VECTORS_MAX_DIMENSION`
rather than letting you discover it under load.

**Use a direct database URL.** The service issues DDL on startup (`CREATE SCHEMA`,
`CREATE EXTENSION`) and when indexing, which a transaction pooler will not run. That is
why `DIRECT_URL` is preferred over `DATABASE_URL`.

**Its tables live in a `vecs` schema of their own**, so they coexist with the backend's
Prisma-managed tables in the same database without either touching the other's objects.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `VECTORS_DATABASE_URL` | falls back to `DIRECT_URL`, then `DATABASE_URL` | Postgres with pgvector |
| `VECTORS_API_KEY` | *(unset)* | When set, requires `Authorization: Bearer <key>` |
| `VECTORS_MAX_BATCH` | `500` | Records per upsert |
| `VECTORS_MAX_LIMIT` | `100` | Rows per query |
| `VECTORS_MAX_DIMENSION` | `2000` | Refuse collections too wide to index |

With no database configured the service still starts, reports `unconfigured` on `/health`
and answers 503 — the same pattern every other optional dependency in this stack uses.
