import { CHUNK_STRATEGIES, type ChunkOptions, type ChunkStrategy } from '../api/client';
import { Field } from './ui';

const TOKENIZERS = ['cl100k_base', 'o200k_base', 'p50k_base', 'p50k_edit', 'r50k_base', 'gpt2'];

/** What each strategy is actually for, in one line, shown under the picker. */
const STRATEGY_HINT: Record<ChunkStrategy, string> = {
    recursive: 'Paragraphs, then sentences, then hard token cuts. The safe default.',
    paragraph: 'Paragraphs only. Keeps arguments whole; chunk sizes vary a lot.',
    sentence: 'Sentences packed to the budget. Even sizes, splits arguments.',
    token: 'Fixed token windows, ignoring structure. Predictable cost per chunk.',
    markdown: 'One chunk per heading section. Made for the reader’s own output.',
    semantic: 'Cuts where the topic changes, measured by embedding sentences. Slowest, needs the embedding service.',
};

export const DEFAULT_CHUNKING: ChunkOptions = {
    strategy: 'recursive',
    tokenizer: 'cl100k_base',
    max_chunk_length: 256,
    overlap: 0,
    min_chunk_length: 0,
    heading_level: 2,
    similarity_threshold: 0.82,
};

/**
 * The chunking knobs, shared by the Segmenter and Embeddings panels so the two cannot
 * drift apart — they drive the same API fields.
 */
export function ChunkControls(
    { value, onChange }: { value: ChunkOptions; onChange: (next: ChunkOptions) => void; },
) {
    const set = <K extends keyof ChunkOptions>(key: K, next: ChunkOptions[K]) =>
        onChange({ ...value, [key]: next });

    const number = (key: keyof ChunkOptions, raw: string, min: number) =>
        set(key, Math.max(min, Number(raw) || 0) as never);

    return (
        <>
            <Field label="Strategy">
                <select
                    value={value.strategy}
                    onChange={(e) => set('strategy', e.target.value as ChunkStrategy)}
                >
                    {CHUNK_STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
            </Field>
            <p style={{ margin: '-8px 0 14px', fontSize: 12.5, color: 'var(--text-dim)' }}>
                {STRATEGY_HINT[value.strategy]}
            </p>

            <Field label="Max tokens per chunk">
                <input type="number" min={1} max={8192} value={value.max_chunk_length}
                    onChange={(e) => number('max_chunk_length', e.target.value, 1)} />
            </Field>

            <Field label="Overlap (tokens)">
                <input type="number" min={0} max={value.max_chunk_length - 1} value={value.overlap}
                    onChange={(e) => number('overlap', e.target.value, 0)} />
            </Field>
            {value.overlap > 0 ? (
                <p style={{ margin: '-8px 0 14px', fontSize: 12.5, color: 'var(--text-dim)' }}>
                    Overlap comes out of the budget, so chunks stay within the limit — and
                    they stop being a clean partition of the input, which is the point.
                </p>
            ) : null}

            <Field label="Minimum tokens per chunk">
                <input type="number" min={0} max={value.max_chunk_length} value={value.min_chunk_length}
                    onChange={(e) => number('min_chunk_length', e.target.value, 0)} />
            </Field>

            {value.strategy === 'markdown' ? (
                <Field label="Cut at headings down to level">
                    <select value={value.heading_level}
                        onChange={(e) => set('heading_level', Number(e.target.value))}>
                        {[1, 2, 3, 4, 5, 6].map((n) => (
                            <option key={n} value={n}>{'#'.repeat(n)} (h{n})</option>
                        ))}
                    </select>
                </Field>
            ) : null}

            {value.strategy === 'semantic' ? (
                <Field label={`Similarity threshold (${value.similarity_threshold.toFixed(2)})`}>
                    <input type="range" min={0.5} max={0.99} step={0.01}
                        style={{ width: '100%', accentColor: 'var(--accent)' }}
                        value={value.similarity_threshold}
                        onChange={(e) => set('similarity_threshold', Number(e.target.value))} />
                </Field>
            ) : null}

            <Field label="Tokenizer">
                <select value={value.tokenizer} onChange={(e) => set('tokenizer', e.target.value)}>
                    {TOKENIZERS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
            </Field>
        </>
    );
}
