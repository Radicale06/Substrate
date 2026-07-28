import { Injectable, Logger } from '@nestjs/common';
import { SEGMENTER_TIMEOUT_MS } from '../config/constants';
import { env } from '../config/env';
import {
    BadRequestError,
    isDomainError,
    NotFoundError,
    SecurityCompromiseError,
    ServiceCrashedError,
    UpstreamFailureError,
} from '../common/errors';

/** The `POST /segment` response, snake_case as the service emits it. */
export interface SegmentResponse {
    num_tokens: number;
    tokenizer: string;
    strategy: string;
    degraded_from?: string;
    num_chunks?: number;
    chunks?: string[];
    chunk_positions?: [number, number][];
    chunk_tokens?: number[];
    tokens?: string[];
}

/**
 * Client for the segmenter service.
 *
 * Chunking is CPU-bound and synchronous — a large document blocks its event loop for
 * seconds — so it runs in its own container where that stall cannot freeze this API.
 */
@Injectable()
export class SegmenterClient {
    private readonly logger = new Logger(SegmenterClient.name);

    get configured(): boolean {
        return Boolean(env.segmenterUrl);
    }

    async segment(body: Record<string, unknown>): Promise<SegmentResponse> {
        if (!env.segmenterUrl) {
            throw new ServiceCrashedError(
                'The segmenter service is not configured. Set SEGMENTER_URL, or start the '
                + 'stack with `docker compose up`, which wires it up automatically.',
            );
        }

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), SEGMENTER_TIMEOUT_MS);

        try {
            const response = await fetch(`${env.segmenterUrl}/segment`, {
                method: 'POST',
                signal: abort.signal,
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json',
                    ...(env.segmenterApiKey ? { authorization: `Bearer ${env.segmenterApiKey}` } : {}),
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                throw this.toDomainError(response.status, await this.readError(response));
            }

            return await response.json() as SegmentResponse;
        } catch (err: any) {
            if (isDomainError(err)) {
                throw err;
            }
            if (err?.name === 'AbortError') {
                throw new UpstreamFailureError(
                    `The segmenter service timed out after ${SEGMENTER_TIMEOUT_MS}ms`,
                );
            }
            this.logger.error(`Segmenter service at ${env.segmenterUrl} is unreachable: ${err?.message}`);
            throw new ServiceCrashedError(
                `The segmenter service at ${env.segmenterUrl} is not reachable. Start it with `
                + '`docker compose up segmenter`, or point SEGMENTER_URL at a running instance.',
            );
        } finally {
            clearTimeout(timer);
        }
    }

    /** Keeps the service's status semantics, so a 400 there is still a 400 here. */
    private toDomainError(status: number, message: string): Error {
        switch (status) {
            case 400:
                return new BadRequestError(message);
            case 401:
                return new ServiceCrashedError(
                    'The segmenter service rejected our API key. SEGMENTER_API_KEY must '
                    + 'match the key the service was started with.',
                );
            case 403:
                return new SecurityCompromiseError(message);
            case 404:
                return new NotFoundError(message);
            case 503:
                return new ServiceCrashedError(message);
            default:
                return new UpstreamFailureError(message);
        }
    }

    private async readError(response: Response): Promise<string> {
        try {
            const payload = await response.json() as { message?: unknown; };
            return typeof payload?.message === 'string' ? payload.message : JSON.stringify(payload);
        } catch {
            return response.statusText || `Segmenter service returned ${response.status}`;
        }
    }
}
