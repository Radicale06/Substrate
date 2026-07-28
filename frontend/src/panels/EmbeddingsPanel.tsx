import { useState } from 'react';
import { api, cosineSimilarity, type ChunkOptions, type EmbeddingsResult } from '../api/client';
import { ChunkControls, DEFAULT_CHUNKING } from '../components/ChunkControls';
import { Badge, Card, Check, Empty, ErrorNotice, Field } from '../components/ui';

type Source = 'text' | 'url';

const SAMPLE = [
    'A cat sat on the mat.',
    'The feline rested on the rug.',
    'Kubernetes orchestrates containers across a cluster.',
].join('\n');

export function EmbeddingsPanel() {
    const [source, setSource] = useState<Source>('text');
    const [raw, setRaw] = useState(SAMPLE);
    const [url, setUrl] = useState('https://en.wikipedia.org/wiki/Vector_database');
    const [task, setTask] = useState('retrieval.passage');
    const [dimensions, setDimensions] = useState('');
    const [instruction, setInstruction] = useState('');
    const [chunk, setChunk] = useState(false);
    const [chunking, setChunking] = useState<ChunkOptions>({ ...DEFAULT_CHUNKING, max_chunk_length: 256 });
    const [result, setResult] = useState<EmbeddingsResult | null>(null);
    const [labels, setLabels] = useState<string[]>([]);
    const [error, setError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);

    // A URL has nothing to embed until it is chunked; forcing it on avoids a request that
    // would embed an entire article as one vector and mean very little.
    const chunkingOn = chunk || source === 'url';

    const run = async () => {
        const input = raw.split('\n').map((line) => line.trim()).filter(Boolean);
        if (source === 'text' && !input.length) {
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const response = await api.embed({
                ...(source === 'url' ? { url: url.trim() } : { input }),
                task,
                dimensions: dimensions ? Number(dimensions) : undefined,
                instruction: instruction || undefined,
                chunking: chunkingOn ? chunking : undefined,
            });
            setResult(response);
            setLabels(response.chunks?.map((c) => c.text) ?? input);
        } catch (err) {
            setError(err);
            setResult(null);
        } finally {
            setBusy(false);
        }
    };

    const vectors = result?.data?.map((d) => d.embedding) ?? [];
    // Comparing 40 chunks pairwise is a wall of numbers; the matrix earns its place only
    // for a handful of inputs.
    const showMatrix = vectors.length > 1 && vectors.length <= 8;

    return (
        <>
            <p className="panel-intro">
                <code>/v1/embeddings</code> turns text into vectors. Add <code>chunking</code> and it splits
                first, returning a vector per chunk; give it a <code>url</code> instead of text and it reads
                the page too — the whole indexing pipeline in one call.
            </p>

            <div className="split">
                <div>
                    <Card title="Input">
                        <Field label="Source">
                            <select value={source} onChange={(e) => setSource(e.target.value as Source)}>
                                <option value="text">Text</option>
                                <option value="url">A web page (read, then chunk, then embed)</option>
                            </select>
                        </Field>

                        {source === 'text' ? (
                            <Field label="Texts (one per line)">
                                <textarea value={raw} rows={7} onChange={(e) => setRaw(e.target.value)} />
                            </Field>
                        ) : (
                            <Field label="URL">
                                <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} />
                            </Field>
                        )}

                        <Field label="Task">
                            <select value={task} onChange={(e) => setTask(e.target.value)}>
                                <option value="retrieval.passage">retrieval.passage (documents)</option>
                                <option value="retrieval.query">retrieval.query (questions)</option>
                            </select>
                        </Field>
                        <p style={{ margin: '-8px 0 14px', fontSize: 12.5, color: 'var(--text-dim)' }}>
                            The instruction prefix belongs on queries only. Applying it to documents
                            quietly costs retrieval quality, which is why this is explicit.
                        </p>

                        <Field label="Dimensions (Matryoshka truncation, optional)">
                            <input type="number" min={32} placeholder="model default (1024)"
                                value={dimensions} onChange={(e) => setDimensions(e.target.value)} />
                        </Field>

                        <Field label="Instruction (overrides the built-in, queries only)">
                            <input type="text" placeholder="model default"
                                value={instruction} onChange={(e) => setInstruction(e.target.value)} />
                        </Field>

                        <button className="primary" onClick={run}
                            disabled={busy || (source === 'text' ? !raw.trim() : !url.trim())}>
                            {busy ? 'Embedding…' : chunkingOn ? 'Chunk and embed' : 'Embed'}
                        </button>
                    </Card>

                    <Card title="Chunking">
                        {source === 'url' ? (
                            <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--text-dim)' }}>
                                Always on for a page: embedding a whole article as one vector would
                                average every topic in it together.
                            </p>
                        ) : (
                            <div className="checks" style={{ marginBottom: 14 }}>
                                <Check label="Chunk before embedding" checked={chunk} onChange={setChunk} />
                            </div>
                        )}
                        {chunkingOn ? <ChunkControls value={chunking} onChange={setChunking} /> : null}
                    </Card>
                </div>

                <div>
                    {error ? <ErrorNotice error={error} /> : null}
                    {!error && !result ? <Card><Empty>Embed something to see the vectors.</Empty></Card> : null}

                    {result ? (
                        <>
                            <Card title="Vectors">
                                <div className="badges">
                                    <Badge tone="accent">{result.model}</Badge>
                                    <Badge>{vectors.length} vectors</Badge>
                                    <Badge>{vectors[0]?.length ?? 0} dimensions</Badge>
                                    {result.chunks ? <Badge tone="ok">{result.chunks.length} chunks</Badge> : null}
                                    {result.usage ? <Badge>{result.usage.total_tokens} tokens</Badge> : null}
                                </div>
                                <div className="rows">
                                    {labels.slice(0, 40).map((text, i) => (
                                        <div className="row" key={i}>
                                            <span className="k">
                                                {result.chunks
                                                    ? `chunk ${i}`
                                                    : `[${i}]`}
                                            </span>
                                            <span className="v">
                                                {text.length > 220 ? `${text.slice(0, 220)}…` : text}
                                                <br />
                                                <code style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                                                    {result.chunks?.[i]?.tokens !== undefined
                                                        ? `${result.chunks[i].tokens} tokens · ` : ''}
                                                    [{vectors[i]?.slice(0, 4).map((n) => n.toFixed(4)).join(', ')}, …]
                                                </code>
                                            </span>
                                        </div>
                                    ))}
                                </div>
                                {labels.length > 40 ? (
                                    <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--text-dim)' }}>
                                        Showing the first 40 of {labels.length}.
                                    </p>
                                ) : null}
                            </Card>

                            {showMatrix ? (
                                <Card title="Cosine similarity">
                                    <div style={{ overflowX: 'auto' }}>
                                        <table className="matrix">
                                            <thead>
                                                <tr>
                                                    <th />
                                                    {labels.map((_, i) => <th key={i}>{`[${i}]`}</th>)}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {labels.map((text, i) => (
                                                    <tr key={i}>
                                                        <th title={text}>
                                                            {`[${i}] ${text.slice(0, 26)}${text.length > 26 ? '…' : ''}`}
                                                        </th>
                                                        {labels.map((_, j) => {
                                                            const score = cosineSimilarity(vectors[i], vectors[j]);
                                                            return (
                                                                <td className="num" key={j} style={{
                                                                    color: i === j ? 'var(--text-dim)'
                                                                        : score > 0.6 ? 'var(--ok)' : undefined,
                                                                }}>
                                                                    {score.toFixed(3)}
                                                                </td>
                                                            );
                                                        })}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </Card>
                            ) : null}
                        </>
                    ) : null}
                </div>
            </div>
        </>
    );
}
