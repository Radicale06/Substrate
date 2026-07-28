import { useState } from 'react';
import { api, type ReaderOptions, type ReaderResult, type ResponseFormat } from '../api/client';
import { Badge, bytes, Card, Check, Empty, ErrorNotice, Field } from '../components/ui';

const FORMATS: Array<{ value: ResponseFormat; hint: string; }> = [
    { value: 'default', hint: 'Title, source URL and Readability-extracted markdown' },
    { value: 'markdown', hint: 'Raw markdown of the whole page, bypassing Readability' },
    { value: 'html', hint: 'documentElement.outerHTML' },
    { value: 'text', hint: 'body.innerText' },
    { value: 'screenshot', hint: 'Viewport PNG' },
    { value: 'pageshot', hint: 'Full-page PNG' },
];

const SAMPLES = [
    'https://en.wikipedia.org/wiki/Web_crawler',
    'https://news.ycombinator.com',
    'https://arxiv.org/pdf/1706.03762',
];

export function ReaderPanel() {
    const [target, setTarget] = useState('https://en.wikipedia.org/wiki/Cat');
    const [options, setOptions] = useState<ReaderOptions>({ format: 'default' });
    const [result, setResult] = useState<ReaderResult | null>(null);
    const [error, setError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);

    const set = <K extends keyof ReaderOptions>(key: K, value: ReaderOptions[K]) =>
        setOptions((prev) => ({ ...prev, [key]: value }));

    const run = async () => {
        setBusy(true);
        setError(null);
        try {
            setResult(await api.read(target.trim(), options));
        } catch (err) {
            setError(err);
            setResult(null);
        } finally {
            setBusy(false);
        }
    };

    const isShot = options.format === 'screenshot' || options.format === 'pageshot';
    const shotUrl = result?.screenshotUrl ?? result?.pageshotUrl;

    return (
        <>
            <p className="panel-intro">
                <code>GET /&lt;url&gt;</code> turns any page into LLM-ready text. Every option below is an
                <code> X-*</code> request header, so anything you can do here you can do with one curl.
            </p>

            <div className="split">
                <div>
                    <Card title="Target">
                        <Field label="URL">
                            <input
                                type="text"
                                value={target}
                                onChange={(e) => setTarget(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && !busy && run()}
                                placeholder="https://example.com"
                            />
                        </Field>
                        <div className="badges">
                            {SAMPLES.map((url) => (
                                <button key={url} className="ghost" onClick={() => setTarget(url)}>
                                    {new URL(url).hostname.replace('www.', '')}
                                </button>
                            ))}
                        </div>
                        <Field label="Response format">
                            <select
                                value={options.format}
                                onChange={(e) => set('format', e.target.value as ResponseFormat)}
                            >
                                {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.value}</option>)}
                            </select>
                        </Field>
                        <p style={{ margin: '-8px 0 14px', fontSize: 12.5, color: 'var(--text-dim)' }}>
                            {FORMATS.find((f) => f.value === options.format)?.hint}
                        </p>
                        <button className="primary" onClick={run} disabled={busy || !target.trim()}>
                            {busy ? 'Reading…' : 'Read page'}
                        </button>
                    </Card>

                    <Card title="Extraction">
                        <div className="checks">
                            <Check label="Links summary" checked={!!options.withLinksSummary}
                                onChange={(v) => set('withLinksSummary', v)} />
                            <Check label="Images summary" checked={!!options.withImagesSummary}
                                onChange={(v) => set('withImagesSummary', v)} />
                            <Check label="Download images" checked={!!options.withImagesDownload}
                                onChange={(v) => set('withImagesDownload', v)} />
                            <Check label="Inline child frames" checked={!!options.withIframe}
                                onChange={(v) => set('withIframe', v)} />
                            <Check label="Keep data: image URLs" checked={!!options.keepImgDataUrl}
                                onChange={(v) => set('keepImgDataUrl', v)} />
                            <Check label="Bypass cache" checked={!!options.noCache}
                                onChange={(v) => set('noCache', v)} />
                        </div>
                    </Card>

                    <Card title="Request">
                        <Field label="User agent">
                            <input type="text" placeholder="the browser's own"
                                value={options.userAgent ?? ''}
                                onChange={(e) => set('userAgent', e.target.value)} />
                        </Field>
                        <Field label="Set-Cookie">
                            <input type="text" placeholder="sid=abc; Domain=.example.com; Path=/"
                                value={options.setCookie ?? ''}
                                onChange={(e) => set('setCookie', e.target.value)} />
                        </Field>
                        <Field label="Proxy URL">
                            <input type="text" placeholder="http://user:pass@proxy:8080"
                                value={options.proxyUrl ?? ''}
                                onChange={(e) => set('proxyUrl', e.target.value)} />
                        </Field>
                        <Field label="Cache tolerance (seconds)">
                            <input type="text" placeholder="server TTL"
                                value={options.cacheTolerance ?? ''}
                                onChange={(e) => set('cacheTolerance', e.target.value)} />
                        </Field>
                        <Field label="Convert this HTML instead of fetching">
                            <textarea rows={4} placeholder="<article>…</article>"
                                value={options.html ?? ''}
                                onChange={(e) => set('html', e.target.value)} />
                        </Field>
                        <p style={{ margin: '-8px 0 0', fontSize: 12.5, color: 'var(--text-dim)' }}>
                            With markup here nothing is fetched — the URL above is used only as the
                            base for relative links, and the request becomes a POST.
                        </p>
                    </Card>

                    <Card title="Narrowing">
                        <Field label="Target selector">
                            <input type="text" placeholder="article, main"
                                value={options.targetSelector ?? ''}
                                onChange={(e) => set('targetSelector', e.target.value)} />
                        </Field>
                        <Field label="Remove selector">
                            <input type="text" placeholder="nav, footer, .ad"
                                value={options.removeSelector ?? ''}
                                onChange={(e) => set('removeSelector', e.target.value)} />
                        </Field>
                        <Field label="Wait for selector">
                            <input type="text" placeholder="#comments"
                                value={options.waitForSelector ?? ''}
                                onChange={(e) => set('waitForSelector', e.target.value)} />
                        </Field>
                        <Field label="Timeout (seconds, 1–180)">
                            <input type="text" placeholder="unset"
                                value={options.timeout ?? ''}
                                onChange={(e) => set('timeout', e.target.value)} />
                        </Field>
                    </Card>
                </div>

                <div>
                    {error ? <ErrorNotice error={error} /> : null}

                    {!error && !result ? (
                        <Card><Empty>Read a page to see the result.</Empty></Card>
                    ) : null}

                    {result ? (
                        <Card title="Result">
                            <div className="badges">
                                <Badge tone="accent">{options.format}</Badge>
                                <Badge>{result.elapsedMs} ms</Badge>
                                {result.cache ? (
                                    <Badge tone={result.cache === 'HIT' ? 'ok' : undefined}>
                                        cache {result.cache}
                                    </Badge>
                                ) : null}
                                {result.publishedTime ? <Badge>{result.publishedTime}</Badge> : null}
                            </div>

                            {result.title ? (
                                <div className="rows" style={{ marginBottom: 14 }}>
                                    <div className="row"><span className="k">Title</span><span className="v">{result.title}</span></div>
                                    {result.description ? (
                                        <div className="row"><span className="k">Description</span><span className="v">{result.description}</span></div>
                                    ) : null}
                                    <div className="row"><span className="k">URL</span><span className="v">{result.url}</span></div>
                                </div>
                            ) : null}

                            {isShot && shotUrl ? (
                                <img className="shot" src={api.assetUrl(shotUrl)} alt={`${options.format} of ${result.url}`} />
                            ) : null}

                            {!isShot ? (
                                <pre className="output">{result.content ?? result.html ?? result.text ?? '(empty)'}</pre>
                            ) : null}
                        </Card>
                    ) : null}

                    {result?.imageAssets?.length ? (
                        <Card title={`Downloaded images (${result.imageAssets.filter((a) => a.status === 'stored').length}/${result.imageAssets.length})`}>
                            <div className="badges">
                                {(['browser', 'fetch', 'inline'] as const).map((source) => {
                                    const n = result.imageAssets!.filter((a) => a.source === source).length;
                                    return n ? <Badge key={source} tone={source === 'browser' ? 'ok' : undefined}>{n} {source}</Badge> : null;
                                })}
                                {result.imageAssets.some((a) => a.status !== 'stored') ? (
                                    <Badge tone="warn">
                                        {result.imageAssets.filter((a) => a.status !== 'stored').length} not stored
                                    </Badge>
                                ) : null}
                            </div>
                            <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--text-dim)' }}>
                                <strong>browser</strong> means the bytes came from the render itself and cost no extra
                                bandwidth. Anything not stored keeps its original URL in the content.
                            </p>
                            <div className="gallery">
                                {result.imageAssets.filter((a) => a.url).slice(0, 24).map((asset) => (
                                    <figure className="tile" key={asset.url} style={{ margin: 0 }}>
                                        <img src={api.assetUrl(asset.url!)} alt="" loading="lazy" />
                                        <figcaption className="meta">{asset.source} · {bytes(asset.bytes)}</figcaption>
                                    </figure>
                                ))}
                            </div>
                        </Card>
                    ) : null}

                    {result?.images && Object.keys(result.images).length ? (
                        <Card title={`Images summary (${Object.keys(result.images).length})`}>
                            <pre className="output" style={{ maxHeight: '30vh' }}>
                                {Object.entries(result.images).map(([label, url]) => `${label}\n  ${url}`).join('\n')}
                            </pre>
                        </Card>
                    ) : null}

                    {result?.links?.length ? (
                        <Card title={`Links (${result.links.length})`}>
                            <pre className="output" style={{ maxHeight: '30vh' }}>
                                {result.links.map((l) => `${l.text}\n  ${l.url}`).join('\n')}
                            </pre>
                        </Card>
                    ) : null}
                </div>
            </div>
        </>
    );
}
