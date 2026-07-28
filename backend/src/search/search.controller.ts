import { All, Controller, Logger, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { sendJsonError, sendText, wantsJson } from '../common/http-response';
import { SEARCH_DEFAULT_RESULTS, SEARCH_MAX_RESULTS } from '../config/constants';
import { BadRequestError } from '../common/errors';
import { SearchService, type SearchResult } from './search.service';

/** `GET|POST /v1/search` — search the web and optionally read each result. */
@Controller('v1/search')
export class SearchController {
    private readonly logger = new Logger(SearchController.name);

    constructor(private readonly searchService: SearchService) { }

    @All()
    async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
        const asJson = wantsJson(req);

        if (!this.searchService.configured) {
            const message = 'Search is not configured. Set SEARXNG_URL to a SearXNG instance.';
            return asJson ? sendJsonError(res, message, 503) : sendText(res, message, 503);
        }

        let query: string;
        let limit: number;
        let readContent: boolean;
        try {
            const source = req.method === 'POST' ? (req.body ?? {}) : req.query;
            query = this.requireQuery(source);
            limit = this.parseLimit(source);
            // Reading each result is the expensive part, so it is opt-out rather than
            // silently always-on.
            readContent = String(source.read ?? 'true').toLowerCase() !== 'false';
        } catch (err: any) {
            if (err instanceof BadRequestError) {
                return asJson ? sendJsonError(res, err.message, 400) : sendText(res, err.message, 400);
            }
            throw err;
        }

        let results: SearchResult[];
        try {
            results = await this.searchService.search(query, { limit, readContent });
        } catch (err: any) {
            this.logger.error(`Search failed for "${query}"`, { err: err?.message });
            const message = `Search failed: ${err?.message ?? 'unknown error'}`;
            return asJson ? sendJsonError(res, message, 502) : sendText(res, message, 502);
        }

        if (asJson) {
            res.json({ code: 200, status: 20000, data: results });
            return;
        }

        return sendText(res, this.toText(results));
    };

    private requireQuery(source: any): string {
        const raw = source.q ?? source.query;
        const query = typeof raw === 'string' ? raw.trim() : '';
        if (!query) {
            throw new BadRequestError('A search query is required, e.g. /v1/search?q=your+query');
        }

        return query;
    }

    private parseLimit(source: any): number {
        const raw = source.num ?? source.limit;
        if (raw === undefined || raw === null || raw === '') {
            return SEARCH_DEFAULT_RESULTS;
        }
        const limit = Number(raw);
        if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_RESULTS) {
            throw new BadRequestError(`"num" must be an integer between 1 and ${SEARCH_MAX_RESULTS}`);
        }

        return limit;
    }

    /** Numbered blocks, mirroring the layout the crawl endpoint uses for a single page. */
    private toText(results: SearchResult[]): string {
        if (!results.length) {
            return 'No results found.';
        }

        return results
            .map((result, index) => {
                const position = index + 1;
                const lines = [
                    `[${position}] Title: ${result.title}`,
                    `[${position}] URL Source: ${result.url}`,
                ];
                if (result.description) {
                    lines.push(`[${position}] Description: ${result.description}`);
                }
                if (result.content) {
                    lines.push(`[${position}] Content: ${result.content}`);
                }

                return lines.join('\n');
            })
            .join('\n\n');
    }
}
