#!/bin/sh
set -e

# Migrations only make sense when a database is configured. Without DATABASE_URL the
# service runs standalone with caching disabled, so this is skipped entirely.
if [ -n "$DATABASE_URL" ]; then
    echo "DATABASE_URL is set, applying migrations..."
    npx prisma migrate deploy || echo "WARNING: migrations failed; continuing with caching degraded"
fi

exec "$@"
