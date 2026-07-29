import { Controller, Get } from '@nestjs/common';
import { STATUS_CACHE_MS, STATUS_PROBE_TIMEOUT_MS } from '../config/constants';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

type State = 'ready' | 'unreachable' | 'not-configured';

interface Capability {
    name: string;
    endpoint: string;
    /** The service behind it, or null when the capability runs in this process. */
    service: string | null;
    state: State;
    /** What to do about it, when it is not ready. */
    hint?: string;
}

/**
 * One probe per service. SearXNG is the odd one out — it serves `/healthz`, not `/health`
 * — which is exactly the kind of detail that makes a hand-rolled status page wrong.
 */
const PROBES: Array<{
    name: string;
    endpoint: string;
    url: () => string | undefined;
    path: string;
    hint: string;
}> = [
    {
        name: 'reader', endpoint: 'GET /<url>', path: '/health',
        url: () => env.readerUrl,
        hint: 'Start it with `docker compose up reader`, or set READER_URL.',
    },
    {
        name: 'search', endpoint: 'GET|POST /v1/search', path: '/healthz',
        url: () => env.searxngUrl,
        hint: 'Start it with `docker compose up searxng`, or set SEARXNG_URL.',
    },
    {
        name: 'segmenter', endpoint: 'POST /v1/segment', path: '/health',
        url: () => env.segmenterUrl,
        hint: 'Start it with `docker compose up segmenter`, or set SEGMENTER_URL.',
    },
    {
        name: 'vectors', endpoint: 'POST /v1/vectors/*', path: '/health',
        url: () => env.vectorsUrl,
        hint: 'Start it with `docker compose up vectors`, or set VECTORS_URL. It also needs '
            + 'a Postgres with pgvector.',
    },
    {
        name: 'embeddings', endpoint: 'POST /v1/embeddings', path: '/health',
        url: () => env.embeddingsUrl,
        hint: 'Start it with `docker compose --profile ai up`, or set EMBEDDINGS_URL.',
    },
    {
        name: 'reranker', endpoint: 'POST /v1/rerank', path: '/health',
        url: () => env.rerankerUrl,
        hint: 'Start it with `docker compose --profile ai up`, or set RERANKER_URL.',
    },
];

/**
 * `GET /v1/status` — what this installation can actually do right now.
 *
 * Separate from `/health`, which is the container's liveness probe and must stay cheap.
 * This one reaches out to every service, so it is briefly cached: a status page that is
 * polled should not turn into a traffic source of its own.
 */
@Controller('v1/status')
export class StatusController {
    private cached?: { at: number; payload: unknown; };

    constructor(private readonly prisma: PrismaService) { }

    @Get()
    async status() {
        if (this.cached && Date.now() - this.cached.at < STATUS_CACHE_MS) {
            return this.cached.payload;
        }

        const [capabilities, cache] = await Promise.all([
            Promise.all(PROBES.map((probe) => this.probe(probe))),
            this.cacheState(),
        ]);

        const payload = {
            capabilities: [
                // Runs in this process, so it has nothing to be unreachable behind.
                { name: 'health', endpoint: 'GET /health', service: null, state: 'ready' as State },
                ...capabilities,
            ],
            cache,
            checkedAt: new Date().toISOString(),
        };
        this.cached = { at: Date.now(), payload };

        return payload;
    }

    private async probe(probe: typeof PROBES[number]): Promise<Capability> {
        const base = probe.url();
        if (!base) {
            return {
                name: probe.name, endpoint: probe.endpoint, service: null,
                state: 'not-configured', hint: probe.hint,
            };
        }

        try {
            const response = await fetch(`${base}${probe.path}`, {
                signal: AbortSignal.timeout(STATUS_PROBE_TIMEOUT_MS),
            });

            return {
                name: probe.name, endpoint: probe.endpoint, service: base,
                state: response.ok ? 'ready' : 'unreachable',
                ...(response.ok ? {} : { hint: probe.hint }),
            };
        } catch (_err) {
            return {
                name: probe.name, endpoint: probe.endpoint, service: base,
                state: 'unreachable', hint: probe.hint,
            };
        }
    }

    /** The crawl cache is optional, so "disabled" is a normal state rather than a fault. */
    private async cacheState(): Promise<{ state: string; hint?: string; }> {
        if (!this.prisma.available) {
            return {
                state: 'disabled',
                hint: 'Set DATABASE_URL to cache crawls. Everything works without it.',
            };
        }

        return { state: await this.prisma.healthy() ? 'connected' : 'unreachable' };
    }
}
