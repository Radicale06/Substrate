import { useState } from 'react';
import { api, type SearchHit } from '../api/client';
import { Badge, Card, Check, Empty, ErrorNotice, Field } from '../components/ui';

export function SearchPanel() {
    const [query, setQuery] = useState('open source web crawler');
    const [num, setNum] = useState(5);
    const [read, setRead] = useState(true);
    const [hits, setHits] = useState<SearchHit[] | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const [error, setError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);

    const run = async () => {
        setBusy(true);
        setError(null);
        const startedAt = performance.now();
        try {
            setHits(await api.search(query.trim(), num, read));
            setElapsed(Math.round(performance.now() - startedAt));
        } catch (err) {
            setError(err);
            setHits(null);
        } finally {
            setBusy(false);
        }
    };

    const withContent = hits?.filter((h) => h.content).length ?? 0;

    return (
        <>
            <p className="panel-intro">
                <code>/v1/search</code> queries a self-hosted SearXNG, then reads every result through the
                reader — so you get page content, not snippets. Turn reading off for a much faster,
                snippet-only answer.
            </p>

            <div className="split">
                <div>
                    <Card title="Query">
                        <Field label="Search for">
                            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && !busy && run()} />
                        </Field>
                        <Field label="Results (1–20)">
                            <input type="number" min={1} max={20} value={num}
                                onChange={(e) => setNum(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
                        </Field>
                        <div className="checks" style={{ marginBottom: 14 }}>
                            <Check label="Read each result's page" checked={read} onChange={setRead} />
                        </div>
                        <button className="primary" onClick={run} disabled={busy || !query.trim()}>
                            {busy ? (read ? 'Searching and reading…' : 'Searching…') : 'Search'}
                        </button>
                        {read ? (
                            <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--text-dim)' }}>
                                Reading fetches every result with a real browser, so this takes seconds rather
                                than milliseconds.
                            </p>
                        ) : null}
                    </Card>
                </div>

                <div>
                    {error ? <ErrorNotice error={error} /> : null}
                    {!error && !hits ? <Card><Empty>Run a search to see results.</Empty></Card> : null}

                    {hits ? (
                        <Card title={`${hits.length} result${hits.length === 1 ? '' : 's'}`}>
                            <div className="badges">
                                <Badge>{elapsed} ms</Badge>
                                {read ? (
                                    <Badge tone={withContent === hits.length ? 'ok' : 'warn'}>
                                        {withContent}/{hits.length} pages read
                                    </Badge>
                                ) : <Badge>snippets only</Badge>}
                            </div>
                            {hits.length === 0 ? <Empty>No results.</Empty> : null}
                            <div className="hits">
                                {hits.map((hit) => (
                                    <article className="hit" key={hit.url}>
                                        <a href={hit.url} target="_blank" rel="noreferrer noopener">{hit.title}</a>
                                        <div className="url">{hit.url}</div>
                                        {hit.description ? <p>{hit.description}</p> : null}
                                        {hit.content ? (
                                            <details style={{ marginTop: 9 }}>
                                                <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--accent)' }}>
                                                    Page content ({hit.content.length.toLocaleString()} chars)
                                                </summary>
                                                <pre className="output" style={{ marginTop: 8, maxHeight: '26vh' }}>
                                                    {hit.content}
                                                </pre>
                                            </details>
                                        ) : read ? (
                                            <p style={{ marginTop: 8, color: 'var(--warn)', fontSize: 12.5 }}>
                                                Could not be read — keeping the provider's summary.
                                            </p>
                                        ) : null}
                                    </article>
                                ))}
                            </div>
                        </Card>
                    ) : null}
                </div>
            </div>
        </>
    );
}
