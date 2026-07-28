import { Injectable, Logger } from '@nestjs/common';
import { EMBEDDINGS_TIMEOUT_MS } from '../config/constants';
import { env } from '../config/env';

interface EmbeddingsResponse {
    data: Array<{ index: number; embedding: number[]; }>;
}

/**
 * Minimal client for the embedding service, used only by the `semantic` strategy.
 *
 * Returns null rather than throwing on every failure. Chunking is the one capability here
 * that needs no model, so an unreachable embedding service must degrade the strategy — not
 * fail the request.
 */
@Injectable()
export class EmbeddingsClient {
    private readonly logger = new Logger(EmbeddingsClient.name);

    get configured(): boolean {
        return Boolean(env.embeddingsUrl);
    }

    /** Embeddings for each text, in the order given, or null if they cannot be had. */
    async embed(texts: string[]): Promise<number[][] | null> {
        if (!env.embeddingsUrl) {
            return null;
        }

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), EMBEDDINGS_TIMEOUT_MS);

        try {
            const response = await fetch(`${env.embeddingsUrl}/v1/embeddings`, {
                method: 'POST',
                signal: abort.signal,
                headers: {
                    'content-type': 'application/json',
                    ...(env.inferenceApiKey ? { authorization: `Bearer ${env.inferenceApiKey}` } : {}),
                },
                body: JSON.stringify({
                    input: texts,
                    // Documents, not queries: the instruction prefix a query carries shifts
                    // every vector the same way, distorting the similarities the semantic
                    // strategy exists to measure.
                    task: 'retrieval.passage',
                }),
            });

            if (!response.ok) {
                this.logger.warn(`Embedding service returned ${response.status} for semantic chunking`);
                return null;
            }

            const payload = await response.json() as EmbeddingsResponse;
            const ordered = [...payload.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);

            return ordered.length === texts.length ? ordered : null;
        } catch (err: any) {
            this.logger.warn(`Embedding service unreachable for semantic chunking: ${err?.message}`);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }
}
