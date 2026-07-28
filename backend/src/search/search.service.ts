import { Injectable, Logger } from '@nestjs/common';
import {
    SEARCH_PAGE_TIMEOUT_MS,
    SEARCH_READ_CONCURRENCY,
    SEARCH_TOTAL_READ_BUDGET_MS,
} from '../config/constants';
import { ReaderClient } from '../reader/reader.client';
import { SearxngProvider, type SearchHit } from './searxng.provider';

export interface SearchResult extends SearchHit {
    /** Page content, present only when the caller asked for the results to be read. */
    content?: string;
}

export interface SearchOptions {
    limit: number;
    readContent: boolean;
}

/** Searches the web and optionally reads each result through the reader service. */
@Injectable()
export class SearchService {
    private readonly logger = new Logger(SearchService.name);

    constructor(
        private readonly provider: SearxngProvider,
        private readonly readerClient: ReaderClient,
    ) { }

    get configured(): boolean {
        return this.provider.configured;
    }

    async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
        const hits = await this.provider.search(query, options.limit);
        this.logger.log(`Search for "${query}" returned ${hits.length} result(s)`);

        if (!options.readContent || !hits.length) {
            return hits;
        }

        return this.readAll(hits);
    }

    /**
     * Reads the result pages a few at a time. A page that fails or is unreachable keeps
     * its search-provided title and description rather than dropping out of the results.
     */
    private async readAll(hits: SearchHit[]): Promise<SearchResult[]> {
        const results: SearchResult[] = hits.map((hit) => ({ ...hit }));
        let next = 0;

        // One overall budget for the whole fan-out. Without it, 20 results that each take
        // the full per-page timeout would hold the connection for minutes and be cut off
        // by whatever proxy sits in front of us — after doing all the work.
        const deadline = Date.now() + SEARCH_TOTAL_READ_BUDGET_MS;

        const worker = async () => {
            while (true) {
                const index = next++;
                if (index >= hits.length) {
                    return;
                }
                if (Date.now() >= deadline) {
                    // Out of budget: the remaining hits keep their provider summary,
                    // which is what an unreadable page gets anyway.
                    this.logger.warn(`Read budget exhausted; ${hits.length - index} result(s) left unread`);
                    return;
                }
                results[index].content = await this.readOne(hits[index].url);
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(SEARCH_READ_CONCURRENCY, hits.length) }, worker),
        );

        return results;
    }

    private async readOne(url: string): Promise<string | undefined> {
        try {
            const page = await this.readerClient.crawl({
                url,
                format: 'default',
                // navigationTimeoutMs, not timeout: this caps the fetch without also
                // asking the service to keep watching the page for the full duration.
                navigationTimeoutMs: SEARCH_PAGE_TIMEOUT_MS,
            });

            return page.content || undefined;
        } catch (err: any) {
            // Result URLs come from an external service, so a rejected or unreadable one
            // is routine. The hit keeps its provider-supplied summary.
            this.logger.warn(`Could not read search result ${url}`, { err: err?.message });

            return undefined;
        }
    }
}
