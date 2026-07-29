import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { EMBEDDINGS_MAX_INPUTS, RERANK_MAX_DOCUMENTS } from '../config/constants';
import { env } from '../config/env';
import { BadRequestError, ServiceCrashedError } from '../common/errors';
import { InferenceClient } from './inference.client';

interface EmbeddingsBody {
    input?: string | string[];
    model?: string;
    task?: string;
    dimensions?: number;
    instruction?: string;
}

interface RerankBody {
    query?: string;
    documents?: string[];
    model?: string;
    top_n?: number;
    return_documents?: boolean;
    instruction?: string;
}

/**
 * `/v1/embeddings` and `/v1/rerank`.
 *
 * Both are thin proxies over the model services, which run as separate containers so
 * their CPU-bound work never blocks this process.
 *
 * Embeddings deliberately does NOT chunk. Splitting text is the segmenter's job and it
 * does it better than a flag here could — six strategies, overlap, and exact character
 * offsets. Folding a reduced version of that into this endpoint would have meant two
 * implementations to keep in step, and would have hidden a step the caller needs to see:
 * in a real pipeline you keep the chunks, because the chunk text is what you store next
 * to the vector. Call `/v1/segment`, then pass its chunks here.
 */
@Controller('v1')
export class InferenceController {

    constructor(private readonly client: InferenceClient) { }

    @Post('embeddings')
    @HttpCode(HttpStatus.OK)
    async embeddings(@Body() body: EmbeddingsBody) {
        if (!this.client.embeddingsConfigured) {
            throw new ServiceCrashedError(
                'Embeddings are not configured. Set EMBEDDINGS_URL, or start the stack with --profile ai.',
            );
        }

        const input = typeof body?.input === 'string' ? [body.input] : body?.input;
        if (!Array.isArray(input) || !input.length) {
            throw new BadRequestError('"input" is required and must be a string or a non-empty array');
        }
        if (input.length > EMBEDDINGS_MAX_INPUTS) {
            throw new BadRequestError(
                `At most ${EMBEDDINGS_MAX_INPUTS} inputs per request. Segment first, then embed `
                + 'the chunks in batches of this size.',
            );
        }
        if (input.some((text) => typeof text !== 'string' || !text.trim())) {
            throw new BadRequestError('Every input must be a non-empty string');
        }
        if (body.dimensions !== undefined && (!Number.isInteger(body.dimensions) || body.dimensions < 1)) {
            throw new BadRequestError('"dimensions" must be a positive integer');
        }

        return this.client.post('embeddings', env.embeddingsUrl!, '/v1/embeddings', { ...body, input });
    }

    @Post('rerank')
    @HttpCode(HttpStatus.OK)
    async rerank(@Body() body: RerankBody) {
        if (!this.client.rerankerConfigured) {
            throw new ServiceCrashedError(
                'Reranking is not configured. Set RERANKER_URL, or start the stack with --profile ai.',
            );
        }

        if (typeof body?.query !== 'string' || !body.query.trim()) {
            throw new BadRequestError('"query" is required and must be a non-empty string');
        }
        if (!Array.isArray(body?.documents) || !body.documents.length) {
            throw new BadRequestError('"documents" is required and must be a non-empty array');
        }
        if (body.documents.length > RERANK_MAX_DOCUMENTS) {
            throw new BadRequestError(`At most ${RERANK_MAX_DOCUMENTS} documents per request`);
        }
        if (body.documents.some((doc) => typeof doc !== 'string' || !doc.trim())) {
            throw new BadRequestError('Every document must be a non-empty string');
        }
        if (body.top_n !== undefined && (!Number.isInteger(body.top_n) || body.top_n < 1)) {
            throw new BadRequestError('"top_n" must be a positive integer');
        }

        return this.client.post('reranker', env.rerankerUrl!, '/v1/rerank', body);
    }
}
