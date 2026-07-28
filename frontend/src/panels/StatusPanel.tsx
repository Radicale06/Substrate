import { useEffect, useState } from 'react';
import { api, type StatusReport } from '../api/client';
import { Badge, Card, Empty, ErrorNotice } from '../components/ui';

const TONE = {
    ready: 'ok',
    unreachable: 'err',
    'not-configured': 'warn',
} as const;

export function StatusPanel() {
    const [report, setReport] = useState<StatusReport | null>(null);
    const [error, setError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);

    const load = async () => {
        setBusy(true);
        setError(null);
        try {
            setReport(await api.status());
        } catch (err) {
            setError(err);
        } finally {
            setBusy(false);
        }
    };

    useEffect(() => { void load(); }, []);

    const ready = report?.capabilities.filter((c) => c.state === 'ready').length ?? 0;

    return (
        <>
            <p className="panel-intro">
                What this installation can actually do right now. Every capability is optional — an
                absent service disables its endpoint and nothing else, so a partial stack is a normal
                way to run this rather than a broken one.
            </p>

            <Card title="Capabilities">
                <div className="badges">
                    <button className="ghost" onClick={load} disabled={busy}>
                        {busy ? 'Checking…' : 'Re-check'}
                    </button>
                    {report ? (
                        <>
                            <Badge tone={ready === report.capabilities.length ? 'ok' : undefined}>
                                {ready}/{report.capabilities.length} ready
                            </Badge>
                            <Badge>checked {new Date(report.checkedAt).toLocaleTimeString()}</Badge>
                        </>
                    ) : null}
                </div>

                {error ? <ErrorNotice error={error} /> : null}
                {!error && !report ? <Empty>Checking services…</Empty> : null}

                {report ? (
                    <div style={{ overflowX: 'auto' }}>
                        <table className="matrix">
                            <thead>
                                <tr>
                                    <th>Capability</th>
                                    <th>Endpoint</th>
                                    <th>Service</th>
                                    <th>State</th>
                                </tr>
                            </thead>
                            <tbody>
                                {report.capabilities.map((capability) => (
                                    <tr key={capability.name}>
                                        <th>{capability.name}</th>
                                        <td><code style={{ fontSize: 12 }}>{capability.endpoint}</code></td>
                                        <td style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                                            {capability.service ?? 'in-process'}
                                        </td>
                                        <td>
                                            <Badge tone={TONE[capability.state]}>{capability.state}</Badge>
                                        </td>
                                    </tr>
                                ))}
                                <tr>
                                    <th>crawl cache</th>
                                    <td><code style={{ fontSize: 12 }}>X-Cache</code></td>
                                    <td style={{ fontSize: 12, color: 'var(--text-dim)' }}>Postgres</td>
                                    <td>
                                        <Badge tone={report.cache.state === 'connected' ? 'ok'
                                            : report.cache.state === 'disabled' ? 'warn' : 'err'}>
                                            {report.cache.state}
                                        </Badge>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                ) : null}
            </Card>

            {report ? (
                <Card title="What to do about the rest">
                    {[...report.capabilities.filter((c) => c.hint), ...(report.cache.hint
                        ? [{ name: 'crawl cache', hint: report.cache.hint }] : [])].length === 0 ? (
                        <Empty>Everything is running.</Empty>
                    ) : (
                        <div className="rows">
                            {report.capabilities.filter((c) => c.hint).map((c) => (
                                <div className="row" key={c.name}>
                                    <span className="k">{c.name}</span>
                                    <span className="v">{c.hint}</span>
                                </div>
                            ))}
                            {report.cache.hint ? (
                                <div className="row">
                                    <span className="k">crawl cache</span>
                                    <span className="v">{report.cache.hint}</span>
                                </div>
                            ) : null}
                        </div>
                    )}
                </Card>
            ) : null}
        </>
    );
}
