import { useState } from 'react';
import { api, type ChunkOptions, type SegmentResult } from '../api/client';
import { ChunkControls, DEFAULT_CHUNKING } from '../components/ChunkControls';
import { Badge, Card, Check, Empty, ErrorNotice, Field } from '../components/ui';

const SAMPLE = [
    '# Retrieval basics',
    '',
    'Chunking decides what a retriever can find. A chunk is the unit that gets embedded,',
    'stored and returned, so its boundaries determine whether an answer survives retrieval',
    'intact.',
    '',
    'Too large and the vector averages several topics into something that matches nothing',
    'precisely. Too small and a chunk loses the context that made it meaningful.',
    '',
    '## Overlap',
    '',
    'Overlap repeats the tail of one chunk at the head of the next. A fact that straddles a',
    'boundary would otherwise be missing from both sides. The cost is storage and duplicate',
    'hits at query time.',
    '',
    '## Strategies',
    '',
    'Fixed token windows are predictable and structure-blind. Sentence and paragraph',
    'splitting respect prose. Heading-aware splitting suits documents that have sections.',
    '',
    '# Evaluation',
    '',
    'Measure retrieval, not chunk aesthetics. The only question that matters is whether the',
    'passage containing the answer is returned for a realistic query.',
].join('\n');

export function SegmentPanel() {
    const [content, setContent] = useState(SAMPLE);
    const [chunking, setChunking] = useState<ChunkOptions>({ ...DEFAULT_CHUNKING, max_chunk_length: 60 });
    const [result, setResult] = useState<SegmentResult | null>(null);
    const [segmented, setSegmented] = useState('');
    const [showTokens, setShowTokens] = useState(false);
    const [error, setError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);

    const run = async () => {
        setBusy(true);
        setError(null);
        try {
            setResult(await api.segment({
                ...chunking, content, return_chunks: true, return_tokens: showTokens,
            }));
            // Kept so the round-trip check compares against what was actually sent, not
            // whatever has been typed since.
            setSegmented(content);
        } catch (err) {
            setError(err);
            setResult(null);
        } finally {
            setBusy(false);
        }
    };

    const sizes = result?.chunk_tokens ?? [];
    // Only a partition when there is no overlap; with overlap the chunks are windows.
    const partitions = result?.chunks ? result.chunks.join('') === segmented : null;

    return (
        <>
            <p className="panel-intro">
                <code>/v1/segment</code> counts tokens and splits text into token-bounded chunks. Six
                strategies, because the right cut depends on the document — and every one of them is
                also available inside <code>/v1/embeddings</code>, so you can chunk and embed in one call.
            </p>

            <div className="split">
                <div>
                    <Card title="Input">
                        <Field label="Content">
                            <textarea value={content} rows={10} onChange={(e) => setContent(e.target.value)} />
                        </Field>
                        <div className="checks" style={{ marginBottom: 14 }}>
                            <Check label="Also return every token" checked={showTokens}
                                onChange={setShowTokens} />
                        </div>
                        <button className="primary" onClick={run} disabled={busy || !content.trim()}>
                            {busy ? 'Segmenting…' : 'Segment'}
                        </button>
                    </Card>

                    <Card title="Chunking">
                        <ChunkControls value={chunking} onChange={setChunking} />
                    </Card>
                </div>

                <div>
                    {error ? <ErrorNotice error={error} /> : null}
                    {!error && !result ? <Card><Empty>Segment some text to see the chunks.</Empty></Card> : null}

                    {result ? (
                        <Card title="Chunks">
                            <div className="badges">
                                <Badge tone="accent">{result.strategy}</Badge>
                                <Badge>{result.num_tokens.toLocaleString()} tokens</Badge>
                                <Badge>{result.num_chunks ?? 0} chunks</Badge>
                                {sizes.length ? (
                                    <Badge tone={Math.max(...sizes) <= chunking.max_chunk_length ? 'ok' : 'err'}>
                                        {Math.min(...sizes)}–{Math.max(...sizes)} tokens
                                    </Badge>
                                ) : null}
                                {chunking.overlap > 0
                                    ? <Badge tone="warn">overlapping windows</Badge>
                                    : partitions !== null
                                        ? <Badge tone={partitions ? 'ok' : 'err'}>
                                            {partitions ? 'round-trips exactly' : 'round-trip mismatch'}
                                        </Badge>
                                        : null}
                            </div>

                            {result.degraded_from ? (
                                <div className="notice warn" style={{ marginBottom: 14 }}>
                                    <strong>{result.degraded_from}</strong> could not run — the embedding
                                    service is needed for it. Fell back to <strong>{result.strategy}</strong>.
                                    Start it with <code>docker compose --profile ai up</code>.
                                </div>
                            ) : null}

                            <div className="chunks">
                                {(result.chunks ?? []).map((chunk, i) => (
                                    <div className="chunk" key={i}>
                                        <div className="meta">{i + 1}</div>
                                        <div className="body">
                                            {chunk}
                                            <span className="span">
                                                {result.chunk_tokens?.[i] !== undefined
                                                    ? `${result.chunk_tokens[i]} tokens · ` : ''}
                                                {result.chunk_positions?.[i]
                                                    ? `chars ${result.chunk_positions[i][0]}–${result.chunk_positions[i][1]}`
                                                    : ''}
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    ) : null}

                    {result?.tokens?.length ? (
                        <Card title={`Tokens (${result.tokens.length.toLocaleString()})`}>
                            <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-dim)' }}>
                                What the tokenizer actually sees — the unit every limit here is
                                counted in.
                            </p>
                            <pre className="output" style={{ maxHeight: '30vh' }}>
                                {result.tokens.slice(0, 2000).map((t) => JSON.stringify(t)).join(' ')}
                            </pre>
                        </Card>
                    ) : null}
                </div>
            </div>
        </>
    );
}
