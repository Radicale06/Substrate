import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './common/domain-exception.filter';
import { env } from './config/env';

/**
 * Last line of defence for failures that no application `try`/`catch` can reach.
 *
 * This process drives a real browser against arbitrary hostile pages, and puppeteer
 * dispatches CDP events from its own WebSocket handlers — a throw there arrives with no
 * caller to catch it. Node's default is to kill the process on an unhandled rejection,
 * which would turn one malformed page into a dropped container and lose every crawl that
 * happened to be in flight.
 *
 * A rejection means one operation failed, not that the process is unsound, so it is
 * logged and survived. An uncaught exception has no such guarantee: the stack was
 * abandoned mid-way and any invariant may be half-updated, so it is fatal by design —
 * exiting lets the container restart clean rather than serving from a corrupted state.
 */
function installProcessGuards(logger: Logger) {
    process.on('unhandledRejection', (reason: unknown) => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        logger.error(`Unhandled rejection (surviving): ${err.message}`, err.stack);
    });

    process.on('uncaughtException', (err: Error) => {
        logger.error(`Uncaught exception, exiting: ${err.message}`, err.stack);
        // Give the log a tick to flush before the runtime tears the process down.
        setTimeout(() => process.exit(1), 100).unref();
    });
}

async function bootstrap() {
    const logger = new Logger('Bootstrap');
    installProcessGuards(new Logger('Process'));
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        // Lets the process exit promptly on SIGTERM instead of waiting on keep-alives.
        forceCloseConnections: true,
    });

    app.disable('x-powered-by');
    // Inline HTML bodies are page-sized, and the 100kB default silently rejected them.
    app.useBodyParser('json', { limit: '8mb' });

    app.useGlobalFilters(new DomainExceptionFilter());

    // Runs onApplicationShutdown hooks on SIGTERM, which is how Chrome gets closed.
    app.enableShutdownHooks();

    await app.listen(env.port, '0.0.0.0');
    logger.log(`Substrate reader service listening on port ${env.port}`);
}

void bootstrap();
