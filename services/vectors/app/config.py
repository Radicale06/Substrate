"""Environment-driven configuration for the vector store."""

import os


def _int_from_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


class Settings:
    """Read once at import; every value has a working default."""

    # Postgres with the pgvector extension. Any Postgres will do -- vecs is Supabase's
    # client but has no dependency on the Supabase platform.
    #
    # Prefer a direct (non-pooled) URL: vecs issues DDL (CREATE SCHEMA, CREATE EXTENSION,
    # CREATE TABLE, CREATE INDEX), which a transaction pooler will refuse or mangle.
    database_url: str | None = (
        os.getenv("VECTORS_DATABASE_URL") or os.getenv("DIRECT_URL") or os.getenv("DATABASE_URL") or None
    )

    # Optional shared secret. When set, callers must send `Authorization: Bearer <key>`.
    api_key: str | None = os.getenv("VECTORS_API_KEY") or None

    # Records accepted in one upsert call.
    max_batch_size: int = _int_from_env("VECTORS_MAX_BATCH", 500)

    # Rows returned by one query.
    max_limit: int = _int_from_env("VECTORS_MAX_LIMIT", 100)

    # pgvector cannot index beyond 2000 dimensions with `vector`, so a collection wider
    # than this can be created and queried but never indexed -- every search becomes a
    # sequential scan. Refused at creation rather than discovered at scale.
    max_dimension: int = _int_from_env("VECTORS_MAX_DIMENSION", 2000)


settings = Settings()
