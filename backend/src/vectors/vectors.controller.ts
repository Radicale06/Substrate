import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { BadRequestError } from '../common/errors';
import { VectorsClient } from './vectors.client';

/**
 * Collection names reach a SQL identifier, so they are constrained rather than escaped.
 *
 * The store enforces this too, and independently — it is reachable on the compose network
 * without going through here, and it is the process that hands the name to a driver that
 * interpolates it into raw SQL.
 */
const COLLECTION_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/;

function assertName(name: unknown): string {
    if (typeof name !== 'string' || !COLLECTION_NAME.test(name)) {
        throw new BadRequestError(
            'A collection name must start with a letter and contain only letters, digits '
            + 'and underscores, up to 63 characters.',
        );
    }

    return name;
}

/**
 * `/v1/vectors/*` — storage and nearest-neighbour search over pgvector.
 *
 * A pass-through, like /v1/segment: the store owns validation, so duplicating it here
 * would mean two places to keep in step and two different messages for one mistake.
 *
 * This deliberately does not embed. Callers embed with /v1/embeddings and bring the
 * vectors here, which is what keeps the store usable with any model — including one this
 * project does not ship.
 */
@Controller('v1/vectors')
export class VectorsController {

    constructor(private readonly vectors: VectorsClient) { }

    @Get('collections')
    async listCollections() {
        return this.vectors.request('GET', '/v1/collections');
    }

    /**
     * The name arrives in the body here rather than the path, which is exactly how it
     * escaped the check every other route applies — and this is the route that turns it
     * into a Postgres identifier, so it was the one that most needed it.
     */
    @Post('collections')
    @HttpCode(HttpStatus.OK)
    async createCollection(@Body() body: any) {
        assertName(body?.name);

        return this.vectors.request('POST', '/v1/collections', body);
    }

    @Delete('collections/:name')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deleteCollection(@Param('name') name: string) {
        await this.vectors.request('DELETE', `/v1/collections/${assertName(name)}`);
    }

    @Post('collections/:name/upsert')
    @HttpCode(HttpStatus.OK)
    async upsert(@Param('name') name: string, @Body() body: any) {
        return this.vectors.request('POST', `/v1/collections/${assertName(name)}/upsert`, body ?? {});
    }

    @Post('collections/:name/query')
    @HttpCode(HttpStatus.OK)
    async query(@Param('name') name: string, @Body() body: any) {
        return this.vectors.request('POST', `/v1/collections/${assertName(name)}/query`, body ?? {});
    }

    @Post('collections/:name/fetch')
    @HttpCode(HttpStatus.OK)
    async fetch(@Param('name') name: string, @Body() body: any) {
        return this.vectors.request('POST', `/v1/collections/${assertName(name)}/fetch`, body ?? {});
    }

    @Post('collections/:name/delete')
    @HttpCode(HttpStatus.OK)
    async remove(@Param('name') name: string, @Body() body: any) {
        return this.vectors.request('POST', `/v1/collections/${assertName(name)}/delete`, body ?? {});
    }

    @Post('collections/:name/index')
    @HttpCode(HttpStatus.NO_CONTENT)
    async index(@Param('name') name: string, @Body() body: any) {
        await this.vectors.request('POST', `/v1/collections/${assertName(name)}/index`, body ?? {});
    }
}
