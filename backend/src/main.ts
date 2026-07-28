// Before every other import: config/env.ts snapshots process.env at module load, and
// AppModule pulls it in transitively. ConfigModule.forRoot() runs after that, too late.
import 'dotenv/config';
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './common/domain-exception.filter';
import { IMAGE_ROUTE, SCREENSHOT_ROUTE, env, imageDir, screenshotDir } from './config/env';

async function bootstrap() {
    const logger = new Logger('Bootstrap');
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        // Lets the process exit promptly on SIGTERM instead of waiting on keep-alives.
        forceCloseConnections: true,
    });

    // Correct req.protocol/req.host behind a reverse proxy.
    app.set('trust proxy', true);
    app.disable('x-powered-by');
    // Matches the reader service's limit. Inline `html` bodies and /v1/segment payloads
    // are page-sized, and Express's 100kB default rejected them at the gateway.
    app.useBodyParser('json', { limit: '8mb' });

    /**
     * Registered here rather than through ServeStaticModule: that module installs its
     * middleware in onModuleInit, which Nest runs *after* controller routes, so the
     * reader's catch-all would shadow it and screenshots would never be served.
     */
    app.useStaticAssets(screenshotDir, {
        prefix: SCREENSHOT_ROUTE,
        // A missing image is a 404, not a URL to crawl.
        fallthrough: false,
    });

    /**
     * Downloaded page images, written by the reader onto the same volume.
     *
     * Hardened beyond the screenshot mount because these bytes came from a crawled page
     * and are served from this API's own origin: `nosniff` plus a locked-down CSP stop a
     * file that slipped past the reader's magic-byte check from being treated as script.
     * Content-addressed names make the long cache lifetime safe.
     */
    app.useStaticAssets(imageDir, {
        prefix: IMAGE_ROUTE,
        fallthrough: false,
        setHeaders: (res) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
    });

    /**
     * Off unless CORS_ORIGINS is set. The reader's options all arrive as X-* headers,
     * which are not CORS-safelisted, so they have to be allowed explicitly — and
     * X-Cache is exposed because the UI reports whether a result was cached.
     */
    if (env.corsOrigins.length) {
        app.enableCors({
            origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
            allowedHeaders: [
                'content-type', 'accept', 'authorization',
                'x-respond-with', 'x-return-format', 'x-target-selector', 'x-remove-selector',
                'x-wait-for-selector', 'x-timeout', 'x-no-cache', 'x-cache-tolerance',
                'x-with-links-summary', 'x-with-images-summary', 'x-with-images-download',
                'x-with-iframe', 'x-keep-img-data-url', 'x-set-cookie', 'x-proxy-url',
                'x-user-agent',
            ],
            exposedHeaders: ['x-cache'],
        });
        logger.log(`CORS enabled for ${env.corsOrigins.join(', ')}`);
    }

    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.useGlobalFilters(new DomainExceptionFilter());

    // Runs onApplicationShutdown hooks on SIGTERM, which is how Chrome gets closed.
    app.enableShutdownHooks();

    await app.listen(env.port, '0.0.0.0');
    logger.log(`Substrate backend listening on port ${env.port}`);
}

void bootstrap();
