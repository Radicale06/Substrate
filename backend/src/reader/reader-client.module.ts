import { Module } from '@nestjs/common';
import { ReaderClient } from './reader.client';

/**
 * The reader service client, with no controllers of its own.
 *
 * Separate from ReaderModule on purpose: that one declares the catch-all route and so
 * must be imported last, which would make it unusable as a dependency. Anything that
 * needs to crawl — search reading its results, for one — imports this instead.
 */
@Module({
    providers: [ReaderClient],
    exports: [ReaderClient],
})
export class ReaderClientModule { }
