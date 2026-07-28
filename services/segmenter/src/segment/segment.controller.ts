import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../common/api-key.guard';
import { BadRequestError } from '../common/errors';
import { SEGMENT_MAX_CONTENT_CHARS } from '../config/constants';
import { normalizeChunkOptions } from './chunking';
import { SegmenterService } from './segmenter.service';

function requireString(body: any, field: string): string {
    const value = body?.[field];
    if (typeof value !== 'string' || !value.length) {
        throw new BadRequestError(`"${field}" is required and must be a non-empty string`);
    }
    if (value.length > SEGMENT_MAX_CONTENT_CHARS) {
        throw new BadRequestError(`"${field}" exceeds the ${SEGMENT_MAX_CONTENT_CHARS} character limit`);
    }

    return value;
}

function optionalCount(body: any, field: string, max: number): number | undefined {
    const value = body?.[field];
    if (value === undefined || value === null) {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
        throw new BadRequestError(`"${field}" must be an integer between 1 and ${max}`);
    }

    return parsed;
}

/**
 * `POST /segment` — tokenize text and split it into token-bounded chunks.
 *
 * The response is snake_case because it is passed through by the backend unchanged; this
 * is the shape a caller of `/v1/segment` sees.
 */
@Controller('segment')
@UseGuards(ApiKeyGuard)
export class SegmentController {

    constructor(private readonly segmenter: SegmenterService) { }

    @Post()
    @HttpCode(HttpStatus.OK)
    async handle(@Body() body: any) {
        const result = await this.segmenter.segment({
            content: requireString(body, 'content'),
            // Throws BadRequestError with a readable message for anything unusable.
            chunking: normalizeChunkOptions(body),
            returnChunks: Boolean(body.return_chunks),
            returnTokens: Boolean(body.return_tokens),
            head: optionalCount(body, 'head', Number.MAX_SAFE_INTEGER),
            tail: optionalCount(body, 'tail', Number.MAX_SAFE_INTEGER),
        });

        return {
            num_tokens: result.numTokens,
            tokenizer: result.tokenizer,
            strategy: result.strategy,
            ...(result.degradedFrom ? { degraded_from: result.degradedFrom } : {}),
            ...(result.numChunks !== undefined ? { num_chunks: result.numChunks } : {}),
            ...(result.chunks ? { chunks: result.chunks } : {}),
            ...(result.chunkPositions ? { chunk_positions: result.chunkPositions } : {}),
            ...(result.chunkTokens ? { chunk_tokens: result.chunkTokens } : {}),
            ...(result.tokens ? { tokens: result.tokens } : {}),
        };
    }
}
