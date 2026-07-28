import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
    EMBED_BATCH_SIZE,
    EMBED_MAX_CHUNKS,
    EMBED_TOTAL_TIMEOUT_MS,
    EMBEDDINGS_MAX_INPUTS,
    INFERENCE_TIMEOUT_MS,
    RERANK_MAX_DOCUMENTS,
} from '../config/constants';
import { env } from '../config/env';
import { BadRequestError, ServiceCrashedError, UpstreamFailureError } from '../common/errors';
import { ReaderClient } from '../reader/reader.client';
import { SegmenterClient } from '../segment/segmenter.client';
import { InferenceClient } from './inference.client';

interface EmbeddingsBody {
    input?: string | string[];
    /** Read this page and embed its text instead of `input`. */
    url?: string;
    model?: string;
    task?: string;
    dimensions?: number;
    instruction?: string;
    /** When present, each input is chunked first and every chunk is embedded. */
    chunking?: Record<string, unknown>;
}

interface RerankBody {
    query?: string;
    documents?: string[];
    model?: string;
    top_n?: number;
    return_documents?: boolean;
    instruction?: string;
}

/** One chunk, and where it came from. */
interface ChunkRecord {
    index: number;
    source_index: number;
    text: string;
    start: number;
    end: number;
    tokens?: number;
}

/**
 * `/v1/embeddings` and `/v1/rerank`.
 *
 * Embeddings is where the platform composes: given text it behaves exactly like the
 * hosted API, and given `chunking` — optionally with a `url` instead of text — it reads
 * the page, splits it, and returns a vector per chunk. That is the whole indexing
 * pipeline in one call, without the caller orchestrating three services by hand.
 */
@Controller('v1')
export class InferenceController {

    constructor(
        private readonly client: InferenceClient,
        private readonly segmenter: SegmenterClient,
        private readonly reader: ReaderClient,
    ) { }

    @Post('embeddings')
    @HttpCode(HttpStatus.OK)
    async embeddings(@Body() body: EmbeddingsBody) {
        if (!this.client.embeddingsConfigured) {
            throw new ServiceCrashedError(
                'Embeddings are not configured. Set EMBEDDINGS_URL, or start the stack with --profile ai.',
            );
        }
        if (body?.dimensions !== undefined && (!Number.isInteger(body.dimensions) || body.dimensions < 1)) {
            throw new BadRequestError('"dimensions" must be a positive integer');
        }

        const sources = await this.resolveSources(body);

        // Without `chunking` this stays a plain proxy and the response is exactly what the
        // model service returned — OpenAI-shaped, as any existing client expects.
        if (!body.chunking) {
            if (sources.length > EMBEDDINGS_MAX_INPUTS) {
                throw new BadRequestError(`At most ${EMBEDDINGS_MAX_INPUTS} inputs per request`);
            }

            return this.client.post('embeddings', env.embeddingsUrl!, '/v1/embeddings', {
                ...passThroughFields(body),
                input: sources,
            });
        }

        const chunks = await this.chunkAll(sources, body.chunking);
        if (!chunks.length) {
            throw new BadRequestError('Chunking produced no chunks; check the content and strategy');
        }
        if (chunks.length > EMBED_MAX_CHUNKS) {
            throw new BadRequestError(
                `Chunking produced ${chunks.length} chunks, over the ${EMBED_MAX_CHUNKS} limit. `
                + 'Raise max_chunk_length, or send fewer inputs per request.',
            );
        }

        const embedded = await this.embedInBatches(chunks.map((chunk) => chunk.text), body);

        // The data array keeps its OpenAI shape; each entry gains the provenance a caller
        // needs to store the vector against the right piece of text.
        return {
            ...embedded,
            data: embedded.data.map((entry) => {
                const chunk = chunks[Number(entry.index)];

                return chunk
                    ? { ...entry, chunk_index: chunk.index, source_index: chunk.source_index }
                    : entry;
            }),
            chunks,
        };
    }

    /**
     * Embeds in batches, presenting the result as though it were one call.
     *
     * The model service embeds an entire request before responding, so a page's worth of
     * chunks in a single call runs for minutes on CPU and hits the inference timeout.
     * Batching bounds each call; the whole request is bounded separately, because the
     * total genuinely is slow on CPU and pretending otherwise would just move the
     * timeout somewhere less obvious.
     */
    private async embedInBatches(
        texts: string[],
        body: EmbeddingsBody,
    ): Promise<{ model?: unknown; data: Array<Record<string, unknown>>; usage?: { total_tokens: number; }; }> {
        const deadline = Date.now() + EMBED_TOTAL_TIMEOUT_MS;
        const data: Array<Record<string, unknown>> = [];
        let model: unknown;
        let totalTokens = 0;

        for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new UpstreamFailureError(
                    `Embedding did not finish within ${EMBED_TOTAL_TIMEOUT_MS}ms. `
                    + 'Reduce the number of chunks, or run the model on a GPU.',
                );
            }

            const batch = texts.slice(offset, offset + EMBED_BATCH_SIZE);
            const response = await this.client.post<{
                model?: unknown;
                data?: Array<Record<string, unknown>>;
                usage?: { total_tokens?: number; };
            }>(
                'embeddings', env.embeddingsUrl!, '/v1/embeddings',
                { ...passThroughFields(body), input: batch },
                Math.min(INFERENCE_TIMEOUT_MS, remaining),
            );

            model ??= response.model;
            totalTokens += response.usage?.total_tokens ?? 0;
            // Indices are per-batch; re-base them so the caller sees one sequence.
            for (const entry of response.data ?? []) {
                data.push({ ...entry, index: offset + Number(entry.index ?? 0) });
            }
        }

        return { model, data, usage: { total_tokens: totalTokens } };
    }

    /**
     * The text to embed: either what the caller supplied, or a page read for them.
     *
     * `url` is what makes this a pipeline rather than a proxy — one call turns a web page
     * into vectors instead of the caller wiring reader, segmenter and model together.
     */
    private async resolveSources(body: EmbeddingsBody): Promise<string[]> {
        if (body?.url !== undefined) {
            if (body.input !== undefined) {
                throw new BadRequestError('Provide either "input" or "url", not both');
            }
            if (typeof body.url !== 'string' || !body.url.trim()) {
                throw new BadRequestError('"url" must be a non-empty string');
            }

            const page = await this.reader.crawl({ url: body.url.trim(), format: 'default' });
            const content = page.content?.trim();
            if (!content) {
                throw new BadRequestError(`No readable text was extracted from ${body.url}`);
            }

            return [content];
        }

        const input = typeof body?.input === 'string' ? [body.input] : body?.input;
        if (!Array.isArray(input) || !input.length) {
            throw new BadRequestError('"input" is required and must be a string or a non-empty array');
        }
        if (input.some((text) => typeof text !== 'string' || !text.trim())) {
            throw new BadRequestError('Every input must be a non-empty string');
        }

        return input;
    }

    /** Chunks every source, recording which input each chunk came from. */
    private async chunkAll(sources: string[], chunking: Record<string, unknown>): Promise<ChunkRecord[]> {
        const records: ChunkRecord[] = [];

        for (const [sourceIndex, content] of sources.entries()) {
            const segmented = await this.segmenter.segment({
                ...chunking,
                content,
                return_chunks: true,
            });

            (segmented.chunks ?? []).forEach((text, i) => {
                const position = segmented.chunk_positions?.[i];
                records.push({
                    index: records.length,
                    source_index: sourceIndex,
                    text,
                    start: position?.[0] ?? 0,
                    end: position?.[1] ?? text.length,
                    tokens: segmented.chunk_tokens?.[i],
                });
            });
        }

        return records;
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

/**
 * The fields the model service understands, with this API's own additions removed.
 *
 * Forwarding `chunking` or `url` would have the model service reject the request for a
 * field it never defined.
 */
function passThroughFields(body: EmbeddingsBody): Record<string, unknown> {
    const { chunking: _chunking, url: _url, input: _input, ...rest } = body ?? {};

    return rest;
}
