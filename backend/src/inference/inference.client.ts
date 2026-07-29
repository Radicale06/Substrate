import { Injectable, Logger } from '@nestjs/common';
import { INFERENCE_TIMEOUT_MS } from '../config/constants';
import { env } from '../config/env';
import {
    BadRequestError,
    isDomainError,
    ServiceCrashedError,
    UpstreamFailureError,
} from '../common/errors';

/**
 * Thin HTTP client for the model services.
 *
 * They are separate processes on purpose — model inference is CPU-heavy and would
 * otherwise block this event loop — so all this layer does is forward, time out, and
 * translate failures into errors the exception filter can map.
 */
@Injectable()
export class InferenceClient {
    private readonly logger = new Logger(InferenceClient.name);

    get embeddingsConfigured(): boolean {
        return Boolean(env.embeddingsUrl);
    }

    get rerankerConfigured(): boolean {
        return Boolean(env.rerankerUrl);
    }

    async post<T>(
        service: 'embeddings' | 'reranker',
        baseUrl: string,
        path: string,
        body: unknown,
        timeoutMs = INFERENCE_TIMEOUT_MS,
    ): Promise<T> {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), timeoutMs);

        try {
            const response = await fetch(`${baseUrl}${path}`, {
                method: 'POST',
                signal: abort.signal,
                headers: {
                    'content-type': 'application/json',
                    ...(env.inferenceApiKey ? { authorization: `Bearer ${env.inferenceApiKey}` } : {}),
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                throw this.toDomainError(service, response.status, await this.readError(response));
            }

            return await response.json() as T;
        } catch (err: any) {
            if (isDomainError(err)) {
                throw err;
            }
            if (err?.name === 'AbortError') {
                throw new UpstreamFailureError(`Model service timed out after ${timeoutMs}ms`);
            }
            // The compose default points at the service even when it was never started,
            // so say how to start it rather than suggesting a pointless retry.
            this.logger.error(`Model service at ${baseUrl} is unreachable: ${err?.message}`);
            throw new ServiceCrashedError(
                `The ${service} service at ${baseUrl} is not reachable. `
                + `Start it with \`docker compose --profile ai up\`, or point `
                + `${service === 'embeddings' ? 'EMBEDDINGS_URL' : 'RERANKER_URL'} at a running instance.`,
            );
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * The model services' status codes carry meaning, so they are translated rather than
     * flattened.
     *
     * Every non-2xx used to become a 502, which said "the upstream failed" about requests
     * the upstream had understood perfectly and correctly refused — `dimensions` against a
     * model without Matryoshka being the one a caller is most likely to hit. A 502 invites
     * a retry; a 400 tells them what to change.
     */
    private toDomainError(service: string, status: number, message: string): Error {
        switch (status) {
            case 400:
            case 413:
            // FastAPI's schema rejections. A caller error either way.
            case 422:
                return new BadRequestError(message);
            case 401:
                return new ServiceCrashedError(
                    `The ${service} service rejected our API key. INFERENCE_API_KEY must match `
                    + 'the key that service was started with.',
                );
            case 503:
                // Reported by the model services while the weights are still loading.
                return new ServiceCrashedError(message);
            default:
                return new UpstreamFailureError(`Model service returned ${status}: ${message}`);
        }
    }

    private async readError(response: Response): Promise<string> {
        try {
            const payload = await response.json() as { detail?: unknown; };
            return typeof payload?.detail === 'string' ? payload.detail : JSON.stringify(payload);
        } catch {
            return response.statusText;
        }
    }
}
