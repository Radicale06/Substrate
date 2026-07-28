import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { DATABASE_QUERY_TIMEOUT_MS } from '../config/constants';

/**
 * Prisma wrapper that treats the database as OPTIONAL.
 *
 * With no DATABASE_URL the client is never constructed — Prisma 7 throws if you build one
 * without a driver adapter — `available` stays false, and callers disable themselves. A
 * database that is configured but unreachable is equally non-fatal.
 */
@Injectable()
export class PrismaService implements OnApplicationShutdown {
    private readonly logger = new Logger(PrismaService.name);
    private readonly client: PrismaClient | null = null;

    constructor() {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            this.logger.log('No DATABASE_URL set; crawl caching is disabled');
            return;
        }

        const adapter = new PrismaPg({
            connectionString,
            // Prisma 7 ignores ?connection_limit= in the URL, so the pool is sized here.
            max: 10,
            idleTimeoutMillis: 30_000,
            // pg's default is 0, i.e. wait forever.
            connectionTimeoutMillis: 5_000,
            // Bounds the query itself, which connectionTimeoutMillis does not: a database
            // that accepts the connection and then stops answering — a network partition
            // rather than a refused port — would otherwise hang /health past the container
            // healthcheck and restart a service whose only unavailable feature is a cache.
            query_timeout: DATABASE_QUERY_TIMEOUT_MS,
            statement_timeout: DATABASE_QUERY_TIMEOUT_MS,
        });

        this.client = new PrismaClient({ adapter, log: ['warn', 'error'] });

        // Deliberately not awaited: boot must never block or fail because of the cache.
        void this.client.$connect().catch((err: Error) => {
            this.logger.warn(`Database unreachable at boot, continuing: ${err.message}`);
        });
    }

    /** Whether queries can be issued. Check before touching {@link db}. */
    get available(): boolean {
        return this.client !== null;
    }

    /** The client, or null when no database is configured. */
    get db(): PrismaClient | null {
        return this.client;
    }

    /** $connect() succeeding does not prove the database is reachable; a query does. */
    async healthy(): Promise<boolean> {
        if (!this.client) {
            return false;
        }
        try {
            await this.client.$queryRaw`SELECT 1`;
            return true;
        } catch {
            return false;
        }
    }

    async onApplicationShutdown(): Promise<void> {
        await this.client?.$disconnect().catch(() => undefined);
    }
}
