import { Controller, Get } from '@nestjs/common';
import { env, isEmbeddingsConfigured } from '../config/env';

/** Liveness probe, used by the container healthcheck. */
@Controller('health')
export class HealthController {

    /**
     * Always 200 while the process is serving. The embedding service is optional — only
     * the semantic strategy needs it — so its absence is reported, never asserted.
     */
    @Get()
    check() {
        return {
            status: 'ok',
            semantic: isEmbeddingsConfigured() ? 'available' : 'unavailable',
            embeddingsUrl: env.embeddingsUrl ?? null,
        };
    }
}
