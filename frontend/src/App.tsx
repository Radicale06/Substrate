import { useEffect, useState } from 'react';
import { api } from './api/client';
import { Badge } from './components/ui';
import { EmbeddingsPanel } from './panels/EmbeddingsPanel';
import { ReaderPanel } from './panels/ReaderPanel';
import { RerankPanel } from './panels/RerankPanel';
import { SearchPanel } from './panels/SearchPanel';
import { SegmentPanel } from './panels/SegmentPanel';
import { StatusPanel } from './panels/StatusPanel';

const TABS = [
    { id: 'reader', label: 'Reader', render: () => <ReaderPanel /> },
    { id: 'search', label: 'Search', render: () => <SearchPanel /> },
    { id: 'segment', label: 'Segmenter', render: () => <SegmentPanel /> },
    { id: 'embeddings', label: 'Embeddings', render: () => <EmbeddingsPanel /> },
    { id: 'rerank', label: 'Reranker', render: () => <RerankPanel /> },
    { id: 'status', label: 'Status', render: () => <StatusPanel /> },
] as const;

type Theme = 'light' | 'dark';

/** Follows the OS by default; the toggle stamps data-theme, which the CSS lets win. */
function useTheme(): [Theme, () => void] {
    const [theme, setTheme] = useState<Theme>(() =>
        (localStorage.getItem('substrate-theme') as Theme | null)
        ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('substrate-theme', theme);
    }, [theme]);

    return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

export function App() {
    const [active, setActive] = useState<string>(TABS[0].id);
    const [theme, toggleTheme] = useTheme();
    const [health, setHealth] = useState<{ status: string; cache: string; } | null>(null);
    const [offline, setOffline] = useState(false);

    useEffect(() => {
        api.health().then(setHealth).catch(() => setOffline(true));
    }, []);

    const panel = TABS.find((t) => t.id === active) ?? TABS[0];

    return (
        <div className="shell">
            <header className="masthead">
                <div>
                    <h1>Substrate Console</h1>
                    <p>The layer between the open web and your model.</p>
                </div>
                <div className="spacer" />
                <div className="badges" style={{ margin: 0 }}>
                    {offline ? (
                        <Badge tone="err">API unreachable</Badge>
                    ) : health ? (
                        <>
                            <Badge tone="ok">API {health.status}</Badge>
                            <Badge tone={health.cache === 'connected' ? 'ok' : undefined}>
                                cache {health.cache}
                            </Badge>
                        </>
                    ) : (
                        <Badge>connecting…</Badge>
                    )}
                </div>
                <button className="ghost" onClick={toggleTheme} aria-label="Toggle colour theme">
                    {theme === 'dark' ? 'Light' : 'Dark'}
                </button>
            </header>

            {offline ? (
                <div className="notice err" style={{ marginBottom: 20 }}>
                    Could not reach the API. Start the stack with <code>docker compose up</code>, or set
                    <code> VITE_API_BASE</code> if it is running somewhere other than this origin.
                </div>
            ) : null}

            <nav className="tabs" role="tablist">
                {TABS.map((tab) => (
                    <button
                        key={tab.id}
                        role="tab"
                        aria-selected={tab.id === active}
                        onClick={() => setActive(tab.id)}
                    >
                        {tab.label}
                    </button>
                ))}
            </nav>

            <main role="tabpanel">{panel.render()}</main>
        </div>
    );
}
