import { useEffect, useState } from 'react';
import { api, vectors as store, type VectorCollection, type VectorMatch } from '../api/client';
import { VectorView } from '../components/VectorView';
import { Badge, Card, Empty, ErrorNotice, Field } from '../components/ui';

const SAMPLE_DOCS = [
    'Paris is the capital and most populous city of France.',
    'Berlin is the capital of Germany and its largest city.',
    'Bananas are a tropical fruit grown in over 130 countries.',
    'The Seine flows through Paris on its way to the English Channel.',
].join('\n');

export function VectorsPanel() {
    const [collections, setCollections] = useState<VectorCollection[] | null>(null);
    const [name, setName] = useState('substrate_demo');
    const [docs, setDocs] = useState(SAMPLE_DOCS);
    const [question, setQuestion] = useState('What is the capital of France?');
    const [matches, setMatches] = useState<VectorMatch[] | null>(null);
    const [queryVector, setQueryVector] = useState<number[] | null>(null);
    const [status, setStatus] = useState('');
    const [error, setError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);

    const refresh = async () => {
        try {
            setCollections(await store.collections());
            setError(null);
        } catch (err) {
            setError(err);
            setCollections(null);
        }
    };

    useEffect(() => { void refresh(); }, []);

    /**
     * The pipeline, end to end, in the open: embed, create a collection sized to whatever
     * the model returned, upsert. Nothing here is hidden behind one endpoint, because
     * that is the point of keeping them separate.
     */
    const index = async () => {
        const texts = docs.split('\n').map((line) => line.trim()).filter(Boolean);
        if (!texts.length) {
            return;
        }
        setBusy(true);
        setError(null);
        try {
            setStatus('Embedding…');
            const embedded = await api.embed({ input: texts, task: 'retrieval.passage' });
            const dimension = embedded.data[0]?.embedding.length ?? 0;

            setStatus(`Creating collection (${dimension} dims)…`);
            await store.createCollection(name, dimension);

            setStatus(`Storing ${texts.length} vectors…`);
            const { upserted } = await store.upsert(name, embedded.data.map((entry, i) => ({
                id: `demo-${i}`,
                vector: entry.embedding,
                metadata: { text: texts[i], position: i },
            })));

            setStatus(`Stored ${upserted} vectors in "${name}".`);
            await refresh();
        } catch (err) {
            setError(err);
            setStatus('');
        } finally {
            setBusy(false);
        }
    };

    const search = async () => {
        setBusy(true);
        setError(null);
        setStatus('');
        try {
            // A query is embedded with the query task, which applies the instruction
            // prefix. Embedding it as a passage instead is the classic way to make
            // retrieval quietly worse.
            const embedded = await api.embed({ input: [question], task: 'retrieval.query' });
            const vector = embedded.data[0].embedding;
            setQueryVector(vector);
            setMatches((await store.query(name, vector, 5)).matches);
        } catch (err) {
            setError(err);
            setMatches(null);
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <p className="panel-intro">
                <code>/v1/vectors</code> stores vectors in Postgres through pgvector and answers
                nearest-neighbour queries. It never embeds anything — you bring the vectors — which
                is what keeps it usable with any model, including one this project does not ship.
            </p>

            <div className="split">
                <div>
                    <Card title="Collection">
                        <Field label="Name">
                            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
                        </Field>
                        <p style={{ margin: '-8px 0 14px', fontSize: 12.5, color: 'var(--text-dim)' }}>
                            A collection's width is fixed when it is created, so changing embedding
                            model means a new collection rather than a migration.
                        </p>
                        <Field label="Documents (one per line)">
                            <textarea value={docs} rows={7} onChange={(e) => setDocs(e.target.value)} />
                        </Field>
                        <button className="primary" onClick={index} disabled={busy || !docs.trim()}>
                            {busy ? 'Working…' : 'Embed and store'}
                        </button>
                        {status ? (
                            <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--text-dim)' }}>
                                {status}
                            </p>
                        ) : null}
                    </Card>

                    <Card title="Search">
                        <Field label="Question">
                            <input type="text" value={question}
                                onChange={(e) => setQuestion(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && !busy && search()} />
                        </Field>
                        <button className="primary" onClick={search} disabled={busy || !question.trim()}>
                            {busy ? 'Searching…' : 'Search'}
                        </button>
                    </Card>

                    {collections ? (
                        <Card title={`Collections (${collections.length})`}>
                            {collections.length === 0 ? (
                                <Empty>None yet.</Empty>
                            ) : (
                                <div className="rows">
                                    {collections.map((c) => (
                                        <div className="row" key={c.name}>
                                            <span className="k">{c.name}</span>
                                            <span className="v">{c.dimension} dims</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </Card>
                    ) : null}
                </div>

                <div>
                    {error ? <ErrorNotice error={error} /> : null}
                    {!error && !matches ? (
                        <Card><Empty>Store some documents, then search them.</Empty></Card>
                    ) : null}

                    {queryVector ? (
                        <Card title="Query vector">
                            <VectorView vector={queryVector} height={52} />
                        </Card>
                    ) : null}

                    {matches ? (
                        <Card title={`${matches.length} nearest`}>
                            {matches.length === 0 ? <Empty>Nothing stored in this collection yet.</Empty> : null}
                            <div className="scores">
                                {matches.map((match, rank) => (
                                    <div className="score" key={match.id}>
                                        <div className="head">
                                            <span className="rank">#{rank + 1}</span>
                                            <Badge>{match.id}</Badge>
                                            <span className="value">{match.similarity.toFixed(4)}</span>
                                        </div>
                                        <div className="body">{String(match.metadata.text ?? '')}</div>
                                        <div className="bar">
                                            <i style={{ width: `${Math.max(0, Math.min(1, match.similarity)) * 100}%` }} />
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--text-dim)' }}>
                                Scored by cosine similarity, which is 1 − the distance pgvector
                                returns. The store reports both so neither side has to remember the
                                conversion.
                            </p>
                        </Card>
                    ) : null}
                </div>
            </div>
        </>
    );
}
