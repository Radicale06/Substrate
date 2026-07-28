import 'dotenv/config'; // Prisma 7 no longer auto-loads .env
import { defineConfig } from 'prisma/config';

/**
 * CLI-only configuration: `prisma generate` and `prisma migrate` read this, the running
 * application never does (it builds a driver adapter itself).
 *
 * The URL is read via `process.env` rather than Prisma's `env()` helper on purpose. With
 * `env()`, an unset DATABASE_URL makes `prisma generate` fail outright — which would break
 * both the Docker build and any no-database install, the exact case we support.
 */
export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: { path: 'prisma/migrations' },
    datasource: {
        // DIRECT_URL when present: migrations must not run through a connection pooler.
        // `||` and not `??`: compose passes unset variables through as empty strings,
        // which `??` would happily accept and then fail with "Connection url is empty".
        url: process.env.DIRECT_URL || process.env.DATABASE_URL || '',
    },
});
