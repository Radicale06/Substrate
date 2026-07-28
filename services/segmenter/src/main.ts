import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './common/domain-exception.filter';
import { env } from './config/env';

/**
 * Tokenizing is synchronous and CPU-bound, so a large document blocks this event loop for
 * seconds. That is precisely why it runs here rather than in the API: the stall is
 * confined to this process, where nothing else is waiting on it.
 */
function installProcessGuards(logger: Logger) {
    process.on('unhandledRejection', (reason: unknown) => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        logger.error(`Unhandled rejection (surviving): ${err.message}`, err.stack);
    });

    process.on('uncaughtException', (err: Error) => {
        logger.error(`Uncaught exception, exiting: ${err.message}`, err.stack);
        setTimeout(() => process.exit(1), 100).unref();
    });
}

async function bootstrap() {
    const logger = new Logger('Bootstrap');
    installProcessGuards(new Logger('Process'));

    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        forceCloseConnections: true,
    });

    app.disable('x-powered-by');
    // Documents are page-sized; the 100kB default silently rejected them.
    app.useBodyParser('json', { limit: '8mb' });
    app.useGlobalFilters(new DomainExceptionFilter());
    app.enableShutdownHooks();

    await app.listen(env.port, '0.0.0.0');
    logger.log(`Substrate segmenter service listening on port ${env.port}`);
}

void bootstrap();
