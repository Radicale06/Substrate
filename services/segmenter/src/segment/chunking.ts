import { BadRequestError } from '../common/errors';
import {
    SEGMENT_DEFAULT_MAX_CHUNK_TOKENS,
    SEGMENT_MAX_CHUNK_TOKENS,
    SEMANTIC_DEFAULT_SIMILARITY,
} from '../config/constants';
import { DEFAULT_TOKENIZER, isTokenizerName, type TokenizerName } from './tokenizer';

/**
 * How the text is cut up.
 *
 * These are genuinely different trade-offs, not presets of one algorithm — which is why
 * the caller picks rather than the server guessing:
 *
 * - `recursive`  paragraphs, falling back to sentences, then hard token windows. The
 *                safe default: respects structure but never exceeds the budget.
 * - `paragraph`  paragraphs only. Keeps arguments whole; produces uneven chunks.
 * - `sentence`   sentences packed to the budget. Even chunks, splits arguments.
 * - `token`      fixed token windows, ignoring structure. Predictable cost per chunk,
 *                and the only one that behaves on text with no boundaries at all.
 * - `markdown`   cuts at headings, so each chunk is a section. Made for the reader's
 *                output, where the heading is most of what gives a chunk its meaning.
 * - `semantic`   cuts where the topic changes, measured by embedding adjacent sentences
 *                and watching the similarity drop. Best chunks, slowest and needs the
 *                embedding service.
 */
export type ChunkStrategy = 'recursive' | 'paragraph' | 'sentence' | 'token' | 'markdown' | 'semantic';

export const CHUNK_STRATEGIES: readonly ChunkStrategy[] = [
    'recursive', 'paragraph', 'sentence', 'token', 'markdown', 'semantic',
];

export interface ChunkOptions {
    strategy: ChunkStrategy;
    tokenizer: TokenizerName;
    maxTokens: number;
    /**
     * Tokens of the previous chunk repeated at the start of the next.
     *
     * Overlap exists because a retrieved chunk is read without its neighbours, so a fact
     * split across a boundary is lost to both. It deliberately breaks the property that
     * chunks concatenate back to the input — with overlap they are windows, not a
     * partition.
     */
    overlapTokens: number;
    /** Chunks below this are merged into their neighbour, to suppress stray fragments. */
    minTokens: number;
    /** `markdown`: cut at headings of this level or shallower (1 = only `#`). */
    headingLevel: number;
    /** `semantic`: cut when adjacent similarity falls below this. 0–1. */
    similarityThreshold: number;
}

/** The wire shape, snake_case to match the rest of the /v1 surface. */
export interface ChunkOptionsInput {
    strategy?: string;
    tokenizer?: string;
    max_chunk_length?: number;
    overlap?: number;
    min_chunk_length?: number;
    heading_level?: number;
    similarity_threshold?: number;
}

function positiveInt(value: unknown, field: string, max: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        throw new BadRequestError(`"${field}" must be a non-negative integer`);
    }
    if (parsed > max) {
        throw new BadRequestError(`"${field}" must be at most ${max}`);
    }

    return parsed;
}

/**
 * Validates and fills in a chunking request.
 *
 * Rejects rather than clamps: a caller who asked for 90% overlap has misunderstood
 * something, and silently giving them 50% would hide it until their index was built.
 */
export function normalizeChunkOptions(input: ChunkOptionsInput = {}): ChunkOptions {
    const strategy = (input.strategy ?? 'recursive') as ChunkStrategy;
    if (!CHUNK_STRATEGIES.includes(strategy)) {
        throw new BadRequestError(
            `"strategy" must be one of: ${CHUNK_STRATEGIES.join(', ')}`,
        );
    }

    const tokenizer = (input.tokenizer ?? DEFAULT_TOKENIZER) as TokenizerName;
    if (!isTokenizerName(tokenizer)) {
        throw new BadRequestError(`Unknown tokenizer: ${input.tokenizer}`);
    }

    const maxTokens = input.max_chunk_length === undefined
        ? SEGMENT_DEFAULT_MAX_CHUNK_TOKENS
        : positiveInt(input.max_chunk_length, 'max_chunk_length', SEGMENT_MAX_CHUNK_TOKENS);
    if (maxTokens < 1) {
        throw new BadRequestError('"max_chunk_length" must be at least 1');
    }

    const overlapTokens = input.overlap === undefined
        ? 0
        : positiveInt(input.overlap, 'overlap', SEGMENT_MAX_CHUNK_TOKENS);
    // Half is already generous. At or above the chunk size, every chunk would restate
    // the whole of the previous one and the segmentation would never advance.
    if (overlapTokens >= maxTokens) {
        throw new BadRequestError('"overlap" must be smaller than "max_chunk_length"');
    }

    const minTokens = input.min_chunk_length === undefined
        ? 0
        : positiveInt(input.min_chunk_length, 'min_chunk_length', SEGMENT_MAX_CHUNK_TOKENS);
    if (minTokens > maxTokens) {
        throw new BadRequestError('"min_chunk_length" cannot exceed "max_chunk_length"');
    }

    const headingLevel = input.heading_level === undefined
        ? 2
        : positiveInt(input.heading_level, 'heading_level', 6);
    if (strategy === 'markdown' && headingLevel < 1) {
        throw new BadRequestError('"heading_level" must be between 1 and 6');
    }

    let similarityThreshold = SEMANTIC_DEFAULT_SIMILARITY;
    if (input.similarity_threshold !== undefined) {
        const parsed = Number(input.similarity_threshold);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
            throw new BadRequestError('"similarity_threshold" must be between 0 and 1');
        }
        similarityThreshold = parsed;
    }

    return {
        strategy, tokenizer, maxTokens, overlapTokens, minTokens, headingLevel, similarityThreshold,
    };
}
