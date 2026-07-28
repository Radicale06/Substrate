import { Injectable, Logger } from '@nestjs/common';
import type { Tiktoken } from 'tiktoken';
import { SEMANTIC_MAX_SENTENCES } from '../config/constants';
import { EmbeddingsClient } from './embeddings.client';
import { decodeTokens, getTokenizer } from './tokenizer';
import { normalizeChunkOptions, type ChunkOptions } from './chunking';

/** A half-open character range into the original content. */
interface Range {
    start: number;
    end: number;
}

export interface SegmentRequest {
    content: string;
    /** Already validated and defaulted; see normalizeChunkOptions. */
    chunking: ChunkOptions;
    returnChunks?: boolean;
    returnTokens?: boolean;
    head?: number;
    tail?: number;
}

export interface SegmentResult {
    numTokens: number;
    tokenizer: string;
    strategy: string;
    numChunks?: number;
    chunkPositions?: [number, number][];
    chunks?: string[];
    chunkTokens?: number[];
    tokens?: string[];
    /**
     * Set when the requested strategy could not be applied and a simpler one was used —
     * reported rather than silently substituted, because the caller's index depends on it.
     */
    degradedFrom?: string;
}

/** Paragraph breaks first, then sentence ends — the natural places to cut prose. */
const PARAGRAPH_BREAK = /\n[ \t]*\n+/g;
const SENTENCE_END = /(?<=[.!?…])[ \t]+(?=\S)|\n+/g;

/**
 * Splits text into token-bounded chunks on natural boundaries.
 *
 * Chunks are described purely as character ranges into the original content, so a
 * chunk's text is always exactly `content.slice(start, end)` — the reported positions
 * cannot drift from the text the caller receives.
 */
@Injectable()
export class SegmenterService {
    private readonly logger = new Logger(SegmenterService.name);

    constructor(private readonly embeddings: EmbeddingsClient) { }

    async segment(request: SegmentRequest): Promise<SegmentResult> {
        const { chunking } = request;
        const encoder = getTokenizer(chunking.tokenizer);
        const content = request.content;

        const allTokens = encoder.encode(content);
        const result: SegmentResult = {
            numTokens: allTokens.length,
            tokenizer: chunking.tokenizer,
            strategy: chunking.strategy,
        };

        if (request.head !== undefined || request.tail !== undefined) {
            const count = request.head ?? request.tail!;
            const slice = request.head !== undefined
                ? allTokens.slice(0, count)
                : allTokens.slice(Math.max(0, allTokens.length - count));
            // Decoded one at a time so each entry is the token's own text.
            result.tokens = Array.from(slice).map((id) => decodeTokens(encoder, new Uint32Array([id])));
        }

        if (request.returnChunks) {
            const { ranges, degradedFrom } = await this.chunk(content, encoder, chunking);

            result.numChunks = ranges.length;
            result.chunkPositions = ranges.map((r) => [r.start, r.end] as [number, number]);
            result.chunks = ranges.map((r) => content.slice(r.start, r.end));
            result.chunkTokens = ranges.map((r) => this.countTokens(content, r, encoder));
            if (degradedFrom) {
                result.degradedFrom = degradedFrom;
            }
        }

        if (request.returnTokens && !result.tokens) {
            result.tokens = Array.from(allTokens).map((id) => decodeTokens(encoder, new Uint32Array([id])));
        }

        return result;
    }

    /**
     * Runs the requested strategy, then applies the shared post-processing.
     *
     * Every strategy produces the same thing — a list of character ranges — so packing,
     * merging undersized chunks and adding overlap happen once here rather than being
     * reimplemented six times.
     */
    private async chunk(
        content: string,
        encoder: Tiktoken,
        options: ChunkOptions,
    ): Promise<{ ranges: Range[]; degradedFrom?: string; }> {
        if (!content.length) {
            return { ranges: [] };
        }

        // Overlap is carved out of the budget, not added on top of it. `max_chunk_length`
        // is what the caller's embedding model will accept, so a chunk that came back
        // larger than it — because overlap was appended afterwards — would be rejected
        // downstream. Everything below is therefore built to `budget`, and overlap grows
        // each chunk back up to at most `maxTokens`.
        const budget = Math.max(1, options.maxTokens - options.overlapTokens);

        // Groups that packing must not merge across. Most strategies produce one group,
        // meaning "pack freely"; markdown produces one per section, because merging two
        // sections into a chunk is precisely what heading-aware chunking exists to avoid.
        let groups: Range[][];
        let degradedFrom: string | undefined;

        switch (options.strategy) {
            case 'token':
                // No boundaries at all: the whole text is one oversized unit to cut up.
                groups = [this.splitByTokens(content, { start: 0, end: content.length }, encoder, budget)];
                break;
            case 'sentence':
                groups = [this.boundedUnits(content, encoder, budget, SENTENCE_END)];
                break;
            case 'paragraph':
                groups = [this.boundedUnits(content, encoder, budget, PARAGRAPH_BREAK)];
                break;
            case 'markdown':
                groups = this.markdownSections(content, encoder, options, budget);
                break;
            case 'semantic': {
                const semantic = await this.semanticUnits(content, encoder, options, budget);
                groups = [semantic.units];
                degradedFrom = semantic.degradedFrom;
                break;
            }
            case 'recursive':
            default:
                groups = [this.recursiveUnits(content, encoder, budget)];
        }

        let ranges = groups.flatMap((units) => this.pack(content, units, encoder, budget));
        if (options.minTokens > 0) {
            ranges = this.mergeUndersized(content, ranges, encoder, options, budget);
        }
        if (options.overlapTokens > 0) {
            ranges = this.applyOverlap(content, ranges, encoder, options.overlapTokens);
        }

        return { ranges, degradedFrom };
    }

    /** Paragraphs, falling back to sentences and then to hard token windows. */
    private recursiveUnits(content: string, encoder: Tiktoken, maxTokens: number): Range[] {
        const units: Range[] = [];
        for (const paragraph of this.split(content, 0, content.length, PARAGRAPH_BREAK)) {
            if (this.countTokens(content, paragraph, encoder) <= maxTokens) {
                units.push(paragraph);
                continue;
            }
            // Too big to keep whole: fall back to sentences, then to hard token windows.
            for (const sentence of this.split(content, paragraph.start, paragraph.end, SENTENCE_END)) {
                if (this.countTokens(content, sentence, encoder) <= maxTokens) {
                    units.push(sentence);
                } else {
                    units.push(...this.splitByTokens(content, sentence, encoder, maxTokens));
                }
            }
        }

        return units;
    }

    /**
     * Splits on one separator, cutting anything still over budget by tokens.
     *
     * The token fallback is not optional even for a "sentence" or "paragraph" strategy: a
     * single sentence can exceed any budget, and a strategy that returned it anyway would
     * hand the caller a chunk their embedding model refuses.
     */
    private boundedUnits(
        content: string,
        encoder: Tiktoken,
        maxTokens: number,
        separator: RegExp,
    ): Range[] {
        const units: Range[] = [];
        for (const unit of this.split(content, 0, content.length, separator)) {
            if (this.countTokens(content, unit, encoder) <= maxTokens) {
                units.push(unit);
            } else {
                units.push(...this.splitByTokens(content, unit, encoder, maxTokens));
            }
        }

        return units;
    }

    /**
     * Cuts at markdown headings, so a chunk is a section.
     *
     * Built for the reader's own output: in a scraped article the heading carries much of
     * what tells you whether a section is relevant, and a chunk starting mid-section loses
     * it. Sections still over budget fall back to a recursive split within the section.
     */
    private markdownSections(
        content: string,
        encoder: Tiktoken,
        options: ChunkOptions,
        budget: number,
    ): Range[][] {
        const heading = new RegExp(`^#{1,${options.headingLevel}} .*$`, 'gm');
        const starts: number[] = [];
        let match: RegExpExecArray | null;
        while ((match = heading.exec(content)) !== null) {
            starts.push(match.index);
            if (heading.lastIndex === match.index) {
                heading.lastIndex++; // guard against a zero-width match
            }
        }

        // A document with no headings is not a markdown document for this purpose.
        if (!starts.length) {
            return [this.recursiveUnits(content, encoder, budget)];
        }
        // Prose before the first heading is a section of its own, not a lost prefix.
        if (starts[0] > 0) {
            starts.unshift(0);
        }

        // One group per section. Returning a flat list instead let packing merge whole
        // sections back together whenever they were small — which silently turned
        // heading-aware chunking back into the recursive strategy.
        const sections: Range[][] = [];
        for (let i = 0; i < starts.length; i++) {
            const section: Range = { start: starts[i], end: starts[i + 1] ?? content.length };
            if (this.countTokens(content, section, encoder) <= budget) {
                sections.push([section]);
                continue;
            }

            const units: Range[] = [];
            for (const paragraph of this.split(content, section.start, section.end, PARAGRAPH_BREAK)) {
                if (this.countTokens(content, paragraph, encoder) <= budget) {
                    units.push(paragraph);
                } else {
                    units.push(...this.splitByTokens(content, paragraph, encoder, budget));
                }
            }
            sections.push(units);
        }

        return sections;
    }

    /**
     * Cuts where the topic changes rather than where the punctuation does.
     *
     * Each sentence is embedded and compared with its neighbour; a similarity below the
     * threshold is treated as a topic boundary. This is the only strategy that costs a
     * model call, so it degrades to `recursive` — and reports that it did — when the
     * embedding service is unavailable or the text runs past the sentence budget.
     */
    private async semanticUnits(
        content: string,
        encoder: Tiktoken,
        options: ChunkOptions,
        budget: number,
    ): Promise<{ units: Range[]; degradedFrom?: string; }> {
        const fallback = () => ({
            units: this.recursiveUnits(content, encoder, budget),
            degradedFrom: 'semantic',
        });

        if (!this.embeddings.configured) {
            this.logger.warn('Semantic chunking needs the embedding service; using recursive');
            return fallback();
        }

        const sentences = this.boundedUnits(content, encoder, budget, SENTENCE_END);
        if (sentences.length < 2) {
            return { units: sentences };
        }
        if (sentences.length > SEMANTIC_MAX_SENTENCES) {
            this.logger.warn(
                `Semantic chunking skipped: ${sentences.length} sentences exceeds the `
                + `${SEMANTIC_MAX_SENTENCES} limit; using recursive`,
            );
            return fallback();
        }

        const vectors = await this.embeddings.embed(
            sentences.map((r) => content.slice(r.start, r.end)),
        );
        if (!vectors) {
            return fallback();
        }

        // Merge forward while consecutive sentences stay on topic. `pack` still enforces
        // the token budget afterwards, so a long uniform passage cannot run away.
        const units: Range[] = [];
        let current = { ...sentences[0] };
        for (let i = 1; i < sentences.length; i++) {
            const onTopic = cosineSimilarity(vectors[i - 1], vectors[i]) >= options.similarityThreshold;
            const merged = { start: current.start, end: sentences[i].end };
            if (onTopic && this.countTokens(content, merged, encoder) <= budget) {
                current = merged;
            } else {
                units.push(current);
                current = { ...sentences[i] };
            }
        }
        units.push(current);

        return { units };
    }

    /**
     * Folds chunks under `minTokens` into their predecessor.
     *
     * A trailing two-word fragment is not a retrievable unit; it is noise that will match
     * queries it cannot answer. Capped by `maxTokens`, so a fragment that cannot be
     * absorbed is kept as-is rather than pushing a chunk over budget.
     */
    private mergeUndersized(
        content: string,
        ranges: Range[],
        encoder: Tiktoken,
        options: ChunkOptions,
        budget: number,
    ): Range[] {
        const merged: Range[] = [];

        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i];
            if (this.countTokens(content, range, encoder) >= options.minTokens) {
                merged.push({ ...range });
                continue;
            }

            // Backwards first, since it keeps reading order intact for the caller.
            const previous = merged[merged.length - 1];
            if (previous) {
                const combined = { start: previous.start, end: range.end };
                if (this.countTokens(content, combined, encoder) <= budget) {
                    merged[merged.length - 1] = combined;
                    continue;
                }
            }

            // Then forwards. Only trying the predecessor left a fragment stranded whenever
            // that neighbour was already near the limit — which is exactly when a chunk
            // ends up small in the first place.
            const next = ranges[i + 1];
            if (next) {
                const combined = { start: range.start, end: next.end };
                if (this.countTokens(content, combined, encoder) <= budget) {
                    merged.push(combined);
                    i++; // absorbed
                    continue;
                }
            }

            // Neither neighbour has room to absorb it, which is the common case: a chunk
            // ends up small precisely because its neighbour was packed to the limit. So
            // move the boundary instead of merging — the predecessor gives up enough text
            // for this chunk to reach the minimum, and both stay within budget. The pair
            // still covers exactly the same span, so chunks keep concatenating back.
            if (previous) {
                const boundary = this.earliestStartWithin(
                    content, previous.start, range.end, encoder, options.minTokens,
                );
                const head = { start: previous.start, end: boundary };
                const tail = { start: boundary, end: range.end };
                const headFits = boundary > previous.start
                    && this.countTokens(content, head, encoder) <= budget;
                const tailGrew = this.countTokens(content, tail, encoder)
                    > this.countTokens(content, range, encoder);

                if (headFits && tailGrew) {
                    merged[merged.length - 1] = head;
                    merged.push(tail);
                    continue;
                }
            }

            // Nothing left to try: a fragment with no room either side is kept as it is,
            // rather than pushed over the budget the caller's model enforces.
            merged.push({ ...range });
        }

        return merged;
    }

    /**
     * Extends each chunk backwards to repeat the tail of its predecessor.
     *
     * This deliberately breaks the property that chunks concatenate back to the input:
     * with overlap they are overlapping windows, not a partition. That is the point — a
     * fact spanning a boundary would otherwise be absent from both sides of it.
     */
    private applyOverlap(
        content: string,
        ranges: Range[],
        encoder: Tiktoken,
        overlapTokens: number,
    ): Range[] {
        return ranges.map((range, i) => {
            if (i === 0) {
                return range;
            }
            const previous = ranges[i - 1];
            const start = this.earliestStartWithin(
                content, previous.start, range.start, encoder, overlapTokens,
            );

            return { start, end: range.end };
        });
    }

    /** Walks back from `end` to the earliest offset still within `maxTokens`. */
    private earliestStartWithin(
        content: string,
        floor: number,
        end: number,
        encoder: Tiktoken,
        maxTokens: number,
    ): number {
        if (this.countTokens(content, { start: floor, end }, encoder) <= maxTokens) {
            return floor;
        }

        let low = floor;
        let high = end;
        while (low < high) {
            const mid = this.avoidSurrogateSplit(content, Math.floor((low + high) / 2), floor);
            if (mid <= low) {
                break;
            }
            if (this.countTokens(content, { start: mid, end }, encoder) <= maxTokens) {
                high = mid;
            } else {
                low = mid + 1;
            }
        }

        return this.avoidSurrogateSplit(content, Math.min(low, end), floor);
    }

    /**
     * Splits a range on a separator, keeping character offsets. Separators are absorbed
     * into the preceding unit so that concatenating the ranges reproduces the input.
     */
    private split(content: string, start: number, end: number, separator: RegExp): Range[] {
        const ranges: Range[] = [];
        const slice = content.slice(start, end);
        const pattern = new RegExp(separator.source, separator.flags.includes('g') ? separator.flags : `${separator.flags}g`);

        let cursor = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(slice)) !== null) {
            const boundary = match.index + match[0].length;
            if (boundary > cursor) {
                ranges.push({ start: start + cursor, end: start + boundary });
                cursor = boundary;
            }
            if (pattern.lastIndex === match.index) {
                pattern.lastIndex++; // guard against zero-width matches
            }
        }
        if (cursor < slice.length) {
            ranges.push({ start: start + cursor, end });
        }

        return ranges.filter((r) => r.end > r.start);
    }

    /**
     * Last resort for a run with no usable boundary (minified data, CJK without spaces).
     *
     * Cut points are found by measuring re-encoded slices rather than by walking the
     * token array: a slice encoded on its own can yield more tokens than the same span
     * did inside the whole text, because BPE merges differently at the boundaries.
     * Measuring the way the caller will keeps chunks honestly within budget.
     */
    private splitByTokens(content: string, range: Range, encoder: Tiktoken, maxTokens: number): Range[] {
        const ranges: Range[] = [];

        let start = range.start;
        while (start < range.end) {
            const end = this.furthestFittingEnd(content, start, range.end, encoder, maxTokens);
            ranges.push({ start, end });
            start = end;
        }

        return ranges.length ? ranges : [range];
    }

    /** Binary-searches the largest slice from `start` that still fits the token budget. */
    private furthestFittingEnd(
        content: string,
        start: number,
        limit: number,
        encoder: Tiktoken,
        maxTokens: number,
    ): number {
        if (this.countTokens(content, { start, end: limit }, encoder) <= maxTokens) {
            return limit;
        }

        let low = start + 1;
        let high = limit;
        while (low < high) {
            const mid = this.avoidSurrogateSplit(content, Math.ceil((low + high) / 2), start);
            if (mid <= low) {
                break;
            }
            if (this.countTokens(content, { start, end: mid }, encoder) <= maxTokens) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }

        // Always advance by at least one character so the loop cannot stall.
        return Math.max(this.avoidSurrogateSplit(content, low, start), start + 1);
    }

    /** Never cut between a surrogate pair, which would corrupt the character. */
    private avoidSurrogateSplit(content: string, index: number, floor: number): number {
        const previous = content.charCodeAt(index - 1);
        const isHighSurrogate = previous >= 0xd800 && previous <= 0xdbff;

        return isHighSurrogate && index - 1 > floor ? index - 1 : index;
    }

    /** Greedily merges adjacent units while they still fit in one chunk. */
    private pack(content: string, units: Range[], encoder: Tiktoken, maxTokens: number): Range[] {
        const chunks: Range[] = [];
        let current: Range | undefined;

        for (const unit of units) {
            if (!current) {
                current = { ...unit };
                continue;
            }
            const merged = { start: current.start, end: unit.end };
            if (this.countTokens(content, merged, encoder) <= maxTokens) {
                current = merged;
            } else {
                chunks.push(current);
                current = { ...unit };
            }
        }
        if (current) {
            chunks.push(current);
        }

        return chunks;
    }

    private countTokens(content: string, range: Range, encoder: Tiktoken): number {
        return encoder.encode(content.slice(range.start, range.end)).length;
    }
}


/** Cosine similarity between two vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}
