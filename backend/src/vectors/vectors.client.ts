import { Injectable, Logger } from '@nestjs/common';
import { VECTORS_TIMEOUT_MS } from '../config/constants';
import { env } from '../config/env';
import {
    BadRequestError,
    ConflictError,
    isDomainError,
    NotFoundError,
    ServiceCrashedError,
    UpstreamFailureError,
} from '../common/errors';

/**
 * Client for the vector store.
 *
 * A thin forwarder: the store owns validation and its status codes carry meaning, so
 * they are translated rather than reinterpreted. A 409 there is a dimension mismatch,
 * which is not something a retry can fix.
 */
@Injectable()
export class VectorsClient {
    private readonly logger = new Logger(VectorsClient.name);

    get configured(): boolean {
        return Boolean(env.vectorsUrl);
    }

    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        if (!env.vectorsUrl) {
            throw new ServiceCrashedError(
                'The vector store is not configured. Set VECTORS_URL, or start the stack '
                + 'with `docker compose up`, which wires it up automatically.',
            );
        }

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), VECTORS_TIMEOUT_MS);

        try {
            const response = await fetch(`${env.vectorsUrl}${path}`, {
                method,
                signal: abort.signal,
                headers: {
                    accept: 'application/json',
                    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                    ...(env.vectorsApiKey ? { authorization: `Bearer ${env.vectorsApiKey}` } : {}),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });

            if (!response.ok) {
                throw this.toDomainError(response.status, await this.readError(response));
            }
            // 204 on delete and index; there is no body to parse.
            if (response.status === 204) {
                return undefined as T;
            }

            return await response.json() as T;
        } catch (err: any) {
            if (isDomainError(err)) {
                throw err;
            }
            if (err?.name === 'AbortError') {
                throw new UpstreamFailureError(`The vector store timed out after ${VECTORS_TIMEOUT_MS}ms`);
            }
            this.logger.error(`Vector store at ${env.vectorsUrl} is unreachable: ${err?.message}`);
            throw new ServiceCrashedError(
                `The vector store at ${env.vectorsUrl} is not reachable. Start it with `
                + '`docker compose up vectors`, or point VECTORS_URL at a running instance.',
            );
        } finally {
            clearTimeout(timer);
        }
    }

    private toDomainError(status: number, message: string): Error {
        switch (status) {
            case 400:
            case 413:
                return new BadRequestError(message);
            case 401:
                return new ServiceCrashedError(
                    'The vector store rejected our API key. VECTORS_API_KEY must match the '
                    + 'key the service was started with.',
                );
            case 404:
                return new NotFoundError(message);
            case 409:
                return new ConflictError(message);
            case 503:
                return new ServiceCrashedError(message);
            default:
                return new UpstreamFailureError(message);
        }
    }

    private async readError(response: Response): Promise<string> {
        try {
            const payload = await response.json() as { detail?: unknown; message?: unknown; };
            const detail = payload?.detail ?? payload?.message;

            return typeof detail === 'string' ? detail : JSON.stringify(payload);
        } catch {
            return response.statusText || `Vector store returned ${response.status}`;
        }
    }
}
