"""Connection-string normalization.

Two traps, both of which surface as an opaque driver error rather than a useful one:

  * SQLAlchemy 2 rejects the `postgres://` scheme outright, and vecs does no rewriting
    of its own. Plenty of tooling still emits that form.
  * Prisma-style URLs carry query parameters libpq has never heard of -- `schema`,
    `connection_limit`, `pgbouncer` -- and libpq rejects unknown options rather than
    ignoring them. The same DATABASE_URL that works for the backend fails here.
"""

from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Everything libpq actually accepts that anyone realistically puts in a URL.
_LIBPQ_SAFE = {
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "application_name",
    "connect_timeout",
    "options",
    "target_session_attrs",
}


def normalize_dsn(raw: str) -> str:
    """Returns a DSN SQLAlchemy and libpq will both accept."""
    parts = urlsplit(raw)

    scheme = "postgresql" if parts.scheme in ("postgres", "postgresql") else parts.scheme
    query = urlencode(
        [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k in _LIBPQ_SAFE]
    )

    return urlunsplit((scheme, parts.netloc, parts.path, query, ""))
