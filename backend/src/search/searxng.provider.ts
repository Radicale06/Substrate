import { Injectable, Logger } from '@nestjs/common';
import { SEARCH_PROVIDER_TIMEOUT_MS } from '../config/constants';
import { env } from '../config/env';

/** One hit as returned by the search backend, before any page is read. */
export interface SearchHit {
    title: string;
    url: string;
    description: string;
}

interface SearxngResponse {
    results?: Array<{ url?: string; title?: string; content?: string; }>;
}

/**
 * Queries a self-hosted SearXNG instance.
 *
 * SearXNG ships with the JSON API disabled, so the instance must have `json` listed
 * under `search.formats` in its settings — see searxng/settings.yml in this repo.
 */
@Injectable()
export class SearxngProvider {
    private readonly logger = new Logger(SearxngProvider.name);

    get configured(): boolean {
        return Boolean(env.searxngUrl);
    }

    async search(query: string, limit: number): Promise<SearchHit[]> {
        const endpoint = new URL(`${env.searxngUrl}/search`);
        endpoint.searchParams.set('q', query);
        endpoint.searchParams.set('format', 'json');

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), SEARCH_PROVIDER_TIMEOUT_MS);
        try {
            const response = await fetch(endpoint, {
                signal: abort.signal,
                headers: { accept: 'application/json' },
            });
            if (!response.ok) {
                throw new Error(
                    response.status === 403
                        ? `SearXNG refused the JSON API (403). Enable "json" under search.formats in its settings.`
                        : `SearXNG returned ${response.status}`,
                );
            }

            const payload = await response.json() as SearxngResponse;

            return (payload.results ?? [])
                .filter((hit) => hit.url)
                .slice(0, limit)
                .map((hit) => ({
                    title: (hit.title || '').trim(),
                    url: hit.url!,
                    description: (hit.content || '').trim(),
                }));
        } finally {
            clearTimeout(timer);
        }
    }
}
