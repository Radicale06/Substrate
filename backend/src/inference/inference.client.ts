import { Injectable, Logger } from '@nestjs/common';
import { INFERENCE_TIMEOUT_MS } from '../config/constants';
import { env } from '../config/env';
import { ServiceCrashedError, UpstreamFailureError } from '../common/errors';

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
                // The model services report their own validation problems; pass the
                // detail through so a caller can act on it.
                const detail = await this.readError(response);
                throw new UpstreamFailureError(`Model service returned ${response.status}: ${detail}`);
            }

            return await response.json() as T;
        } catch (err: any) {
            if (err instanceof UpstreamFailureError) {
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

    private async readError(response: Response): Promise<string> {
        try {
            const payload = await response.json() as { detail?: unknown; };
            return typeof payload?.detail === 'string' ? payload.detail : JSON.stringify(payload);
        } catch {
            return response.statusText;
        }
    }
}
