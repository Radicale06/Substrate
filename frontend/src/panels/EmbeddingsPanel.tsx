import { useState } from 'react';
import { api, cosineSimilarity, type EmbeddingsResult } from '../api/client';
import { VectorView } from '../components/VectorView';
import { Badge, Card, Empty, ErrorNotice, Field } from '../components/ui';

const SAMPLE = [
    'A cat sat on the mat.',
    'The feline rested on the rug.',
    'Kubernetes orchestrates containers across a cluster.',
].join('\n');

export function EmbeddingsPanel() {
    const [raw, setRaw] = useState(SAMPLE);
    const [task, setTask] = useState('retrieval.passage');
    const [dimensions, setDimensions] = useState('');
    const [instruction, setInstruction] = useState('');
    const [result, setResult] = useState<EmbeddingsResult | null>(null);
    const [texts, setTexts] = useState<string[]>([]);
    const [error, setError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);

    const run = async () => {
        const input = raw.split('\n').map((line) => line.trim()).filter(Boolean);
        if (!input.length) {
            return;
        }
        setBusy(true);
        setError(null);
        try {
            setResult(await api.embed({
                input,
                task,
                dimensions: dimensions ? Number(dimensions) : undefined,
                instruction: instruction || undefined,
            }));
            setTexts(input);
        } catch (err) {
            setError(err);
            setResult(null);
        } finally {
            setBusy(false);
        }
    };

    const vectors = result?.data?.map((d) => d.embedding) ?? [];

    return (
        <>
            <p className="panel-intro">
                <code>/v1/embeddings</code> turns text into vectors. Text in, vectors out — nothing
                else. Splitting a document belongs to <code>/v1/segment</code> and storing the result
                to <code>/v1/vectors</code>, so each stays useful on its own and you compose the
                pipeline you actually want.
            </p>

            <div className="split">
                <div>
                    <Card title="Input">
                        <Field label="Texts (one per line)">
                            <textarea value={raw} rows={8} onChange={(e) => setRaw(e.target.value)} />
                        </Field>
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
                        <Field label="Dimensions (Matryoshka truncation)">
                            <input type="number" min={32} placeholder="model default"
                                value={dimensions} onChange={(e) => setDimensions(e.target.value)} />
                        </Field>
                        <p style={{ margin: '-8px 0 14px', fontSize: 12.5, color: 'var(--text-dim)' }}>
                            Only accepted by models that document Matryoshka. The default model does
                            not, and refuses rather than returning a shorter vector whose quality has
                            quietly collapsed.
                        </p>
                        <Field label="Instruction (overrides the built-in)">
                            <input type="text" placeholder="model default"
                                value={instruction} onChange={(e) => setInstruction(e.target.value)} />
                        </Field>
                        <button className="primary" onClick={run} disabled={busy || !raw.trim()}>
                            {busy ? 'Embedding…' : 'Embed'}
                        </button>
                    </Card>
                </div>

                <div>
                    {error ? <ErrorNotice error={error} /> : null}
                    {!error && !result ? <Card><Empty>Embed some text to see the vectors.</Empty></Card> : null}

                    {result ? (
                        <>
                            <Card title="Vectors">
                                <div className="badges">
                                    <Badge tone="accent">{result.model}</Badge>
                                    <Badge>{vectors.length} vectors</Badge>
                                    <Badge>{vectors[0]?.length ?? 0} dimensions</Badge>
                                    {result.usage ? <Badge>{result.usage.total_tokens} tokens</Badge> : null}
                                </div>
                                <div style={{ display: 'grid', gap: 18 }}>
                                    {texts.map((text, i) => (
                                        <div key={i}>
                                            <div style={{ fontSize: 13.5, marginBottom: 6 }}>
                                                <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                                                    [{i}]{' '}
                                                </span>
                                                {text}
                                            </div>
                                            <VectorView vector={vectors[i] ?? []} />
                                        </div>
                                    ))}
                                </div>
                            </Card>

                            {vectors.length > 1 ? (
                                <Card title="Cosine similarity">
                                    <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--text-dim)' }}>
                                        What the vectors are for. Paraphrases score high; unrelated text
                                        does not — and that is the whole basis of retrieval.
                                    </p>
                                    <div style={{ overflowX: 'auto' }}>
                                        <table className="matrix">
                                            <thead>
                                                <tr>
                                                    <th />
                                                    {texts.map((_, i) => <th key={i}>{`[${i}]`}</th>)}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {texts.map((text, i) => (
                                                    <tr key={i}>
                                                        <th title={text}>
                                                            {`[${i}] ${text.slice(0, 26)}${text.length > 26 ? '…' : ''}`}
                                                        </th>
                                                        {texts.map((_, j) => {
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
