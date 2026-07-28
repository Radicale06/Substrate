import { useState } from 'react';
import { api, type RerankResult } from '../api/client';
import { Badge, Card, Empty, ErrorNotice, Field } from '../components/ui';

const SAMPLE = [
    'Paris is the capital and most populous city of France.',
    'Bananas are a tropical fruit grown in over 130 countries.',
    'The French government is seated in Paris, along with the National Assembly.',
    'Berlin is the capital of Germany.',
].join('\n');

export function RerankPanel() {
    const [query, setQuery] = useState('What is the capital of France?');
    const [raw, setRaw] = useState(SAMPLE);
    const [topN, setTopN] = useState('');
    const [instruction, setInstruction] = useState('');
    const [result, setResult] = useState<RerankResult | null>(null);
    const [documents, setDocuments] = useState<string[]>([]);
    const [error, setError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);

    const run = async () => {
        const docs = raw.split('\n').map((line) => line.trim()).filter(Boolean);
        if (!docs.length) {
            return;
        }
        setBusy(true);
        setError(null);
        try {
            setResult(await api.rerank(query.trim(), docs, {
                topN: topN ? Number(topN) : undefined,
                instruction: instruction || undefined,
            }));
            setDocuments(docs);
        } catch (err) {
            setError(err);
            setResult(null);
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <p className="panel-intro">
                <code>/v1/rerank</code> scores each document against the query and returns them ordered.
                This is the precision pass you run after retrieval — <code>index</code> points back at the
                position in the request, so you can reorder your own list.
            </p>

            <div className="split">
                <div>
                    <Card title="Input">
                        <Field label="Query">
                            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} />
                        </Field>
                        <Field label="Documents (one per line)">
                            <textarea value={raw} rows={9} onChange={(e) => setRaw(e.target.value)} />
                        </Field>
                        <Field label="Top N (all of them by default)">
                            <input type="number" min={1} placeholder="all"
                                value={topN} onChange={(e) => setTopN(e.target.value)} />
                        </Field>
                        <Field label="Instruction (overrides the built-in)">
                            <input type="text" placeholder="model default"
                                value={instruction} onChange={(e) => setInstruction(e.target.value)} />
                        </Field>

                        <button className="primary" onClick={run} disabled={busy || !query.trim() || !raw.trim()}>
                            {busy ? 'Scoring…' : 'Rerank'}
                        </button>
                    </Card>
                </div>

                <div>
                    {error ? <ErrorNotice error={error} /> : null}
                    {!error && !result ? <Card><Empty>Rerank some documents to see the scores.</Empty></Card> : null}

                    {result ? (
                        <Card title="Ranked">
                            <div className="badges">
                                <Badge tone="accent">{result.model}</Badge>
                                <Badge>{result.results.length} scored</Badge>
                            </div>
                            <div className="scores">
                                {result.results.map((row, rank) => (
                                    <div className="score" key={row.index}>
                                        <div className="head">
                                            <span className="rank">#{rank + 1}</span>
                                            <Badge>input [{row.index}]</Badge>
                                            <span className="value">{row.relevance_score.toFixed(4)}</span>
                                        </div>
                                        <div className="body">
                                            {row.document?.text ?? documents[row.index] ?? ''}
                                        </div>
                                        <div className="bar">
                                            {/* Scores are 0–1 for the default Qwen3 reranker. */}
                                            <i style={{ width: `${Math.max(0, Math.min(1, row.relevance_score)) * 100}%` }} />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    ) : null}
                </div>
            </div>
        </>
    );
}
