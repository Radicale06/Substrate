import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import _ from 'lodash';
import {
    MARKDOWN_MAX_DOM_DEPTH,
    MARKDOWN_MAX_DOM_ELEMENTS,
    READABILITY_MIN_CONTENT_RATIO,
} from '../config/constants';
import { ScreenshotStore } from '../storage/screenshot-store';
import { ImageService, type StoredImage } from '../images/image.service';
import type { HarvestHandle } from './image-harvester';
import { cleanAttribute } from '../common/html';
import { DomService } from './dom.service';
import { FormattedPage, PageSnapshot, ResponseFormat } from './page-snapshot';
import { createTurndownService, md5Hasher } from './turndown-factory';

export interface FormatOptions {
    /** The URL the caller asked for, used as the base for relative links. */
    nominalUrl?: URL;
    withImagesSummary?: boolean;
    withLinksSummary?: boolean;
    keepImgDataUrl?: boolean;
    /** Download the images this page references and rewrite the links to stored copies. */
    storeImages?: boolean;
    /** Bodies the browser already downloaded for this crawl. */
    harvest?: HarvestHandle;
    userAgent?: string;
    /** True when the crawl went through a caller-supplied proxy; disables re-fetching. */
    proxied?: boolean;
}

/** Shared state threaded through the Turndown image rule. */
interface ImageRuleContext {
    baseUrl?: string | URL;
    nominalUrl?: URL;
    imgDataUrlToObjectUrl: boolean;
    /** Real source URL -> alt text. These are the URLs that get downloaded. */
    altByUrl: Record<string, string>;
    imageIndices: Map<string, number[]>;
    /** Real source URL -> the URL a caller should see when nothing is stored. */
    displayByUrl: Map<string, string>;
    /** Set only when storing; returns the placeholder to emit in place of the link. */
    storeToken?: (serial: number, src: string) => string;
}

/** Renders a captured snapshot into the response format the caller asked for. */
@Injectable()
export class SnapshotFormatter {
    private readonly logger = new Logger(SnapshotFormatter.name);

    private readonly turndownPlugins = [require('turndown-plugin-gfm').tables];

    constructor(
        private readonly domService: DomService,
        private readonly screenshotStore: ScreenshotStore,
        private readonly imageService: ImageService,
    ) { }

    /**
     * Only the default envelope has anywhere to put the Images:/Links: sections. The raw
     * modes return the page verbatim, and the shot modes answer with a redirect and no
     * body at all, so the summaries are not computed for them.
     */
    async format(mode: ResponseFormat, snapshot: PageSnapshot, options: FormatOptions = {}): Promise<FormattedPage> {
        // Carried by every format so the JSON envelope can identify the page, even
        // though the plain-text rendering of these modes is just the raw content.
        const identity = {
            title: (snapshot.parsed?.title || snapshot.title || '').trim(),
            description: snapshot.parsed?.excerpt?.trim() || undefined,
            url: options.nominalUrl?.toString() || snapshot.href?.trim(),
        };

        switch (mode) {
            case 'screenshot':
            case 'pageshot':
                return this.formatShot(mode, snapshot, identity);
            case 'html':
                return {
                    ...identity,
                    html: snapshot.html,
                    toString() { return this.html ?? ''; },
                } as FormattedPage;
            case 'text':
                return {
                    ...identity,
                    text: snapshot.text,
                    toString() { return this.text ?? ''; },
                } as FormattedPage;
            default:
                return this.formatMarkdown(mode, snapshot, options);
        }
    }

    private async formatShot(
        mode: 'screenshot' | 'pageshot',
        snapshot: PageSnapshot,
        identity: Partial<FormattedPage>,
    ): Promise<FormattedPage> {
        const image = mode === 'screenshot' ? snapshot.screenshot : snapshot.pageshot;
        const url = image ? await this.screenshotStore.save(mode, image) : undefined;

        if (mode === 'pageshot') {
            // No `html`: a pageshot answers with the image URL, and no caller reads the
            // markup — but it used to be serialized into the response anyway, sending a
            // few hundred kilobytes of outerHTML over the wire per full-page screenshot.
            return {
                ...identity,
                pageshotUrl: url,
                toString() { return this.pageshotUrl ?? ''; },
            } as FormattedPage;
        }

        return {
            ...identity,
            screenshotUrl: url,
            toString() { return this.screenshotUrl ?? ''; },
        } as FormattedPage;
    }

    /**
     * Every image the page carries, ordered so the ones the body links to come first.
     *
     * The order is load-bearing. The per-crawl cap can bite before the list is exhausted,
     * and the two kinds of image are not equally worth the budget: an article image that
     * misses the cut leaves a body link still pointing at the origin, while a navigation
     * icon that misses it costs nothing at all.
     */
    private downloadableImages(snapshot: PageSnapshot, altByUrl: Record<string, string>): string[] {
        const referenced = Object.keys(altByUrl);

        let pageWide: string[] = [];
        try {
            pageWide = this.domService.inferSnapshot(snapshot).imgs
                .map((img) => img.src)
                .filter((src): src is string => Boolean(src) && !src.startsWith('blob:'));
        } catch (err) {
            // The inventory is a bonus; losing it must not cost us the referenced images.
            this.logger.warn('Could not inventory page images', { err });
        }

        return [...new Set([...referenced, ...pageWide])];
    }

    /** Whole-page image inventory, used when the markdown pass produced no images. */
    private inventoryImages(snapshot: PageSnapshot): Record<string, string> {
        const imageIndices = new Map<string, number[]>();
        const altByUrl: Record<string, string> = {};
        let imgIndex = 0;
        for (const img of this.domService.inferSnapshot(snapshot).imgs) {
            const indices = imageIndices.get(img.src) ?? [];
            indices.push(++imgIndex);
            imageIndices.set(img.src, indices);
            altByUrl[img.src] = img.alt || '';
        }

        return this.labelImages(altByUrl, imageIndices);
    }

    /**
     * `displayByUrl` maps each real source to what the caller should see — a stored copy,
     * or the `blob:` placeholder for an inline image. Publishing the raw key instead put
     * the entire base64 payload back into the summary that the placeholder exists to keep
     * out of it, which on a page with inline images multiplied the response size.
     */
    private labelImages(
        altByUrl: Record<string, string>,
        imageIndices: Map<string, number[]>,
        displayByUrl?: Map<string, string>,
    ) {
        return _(altByUrl)
            .toPairs()
            .map(([url, alt], i) => {
                const label = (imageIndices.get(url) || [i + 1]).join(',');
                return [`Image ${label}${alt ? `: ${alt}` : ''}`, displayByUrl?.get(url) ?? url];
            })
            .fromPairs()
            .value();
    }

    private async formatMarkdown(
        mode: ResponseFormat,
        snapshot: PageSnapshot,
        options: FormatOptions,
    ): Promise<FormattedPage> {
        const { nominalUrl } = options;
        const imgDataUrlToObjectUrl = !options.keepImgDataUrl;
        const baseUrl = snapshot.rebase || nominalUrl;

        const altByUrl: Record<string, string> = {};
        const imageIndices = new Map<string, number[]>();
        const displayByUrl = new Map<string, string>();

        // Placeholders, resolved after conversion. See ImageRuleContext.storeToken.
        const nonce = randomUUID();
        const tokenSources = new Map<string, string>();
        const storeToken = options.storeImages
            ? (serial: number, src: string) => {
                const token = `substrate-img:${nonce}:${serial}`;
                tokenSources.set(token, src);
                return token;
            }
            : undefined;

        let content = this.snapshotToMarkdown(snapshot, {
            mode,
            baseUrl,
            nominalUrl,
            imgDataUrlToObjectUrl,
            altByUrl,
            imageIndices,
            displayByUrl,
            storeToken,
        });

        let imageAssets: StoredImage[] | undefined;
        if (options.storeImages) {
            const { replacements, assets } = await this.imageService.resolve(this.downloadableImages(snapshot, altByUrl), {
                pageUrl: nominalUrl?.toString(),
                userAgent: options.userAgent,
                harvest: options.harvest,
                proxied: options.proxied,
            });
            imageAssets = assets;

            for (const [src, stored] of replacements) {
                displayByUrl.set(src, stored);
            }
            // One pass over the body. A token whose download failed falls back to the
            // display URL, so a partial failure still yields a usable document.
            // `\\d` and not `\d`: inside a template literal `\d` is just `d`, which would
            // silently leave every placeholder in the document.
            content = content.replace(
                new RegExp(`substrate-img:${nonce}:\\d+`, 'g'),
                (token) => {
                    const src = tokenSources.get(token);
                    return (src && (displayByUrl.get(src) ?? src)) || '';
                },
            );
        }

        const formatted: FormattedPage = {
            title: (snapshot.parsed?.title || snapshot.title || '').trim(),
            description: snapshot.parsed?.excerpt?.trim() || undefined,
            url: nominalUrl?.toString() || snapshot.href?.trim(),
            content: (content || '').trim(),
            publishedTime: snapshot.parsed?.publishedTime || undefined,

            toString() {
                if (mode === 'markdown') {
                    return this.content ?? '';
                }

                const header: string[] = [];
                if (this.publishedTime) {
                    header.push(`Published Time: ${this.publishedTime}`);
                }

                const footer: string[] = [];
                if (this.images) {
                    const lines = ['Images:'];
                    for (const [label, url] of Object.entries(this.images)) {
                        lines.push(`- ![${label}](${url})`);
                    }
                    if (lines.length === 1) {
                        lines.push('This page does not seem to contain any images.');
                    }
                    footer.push(lines.join('\n'));
                }
                if (this.links) {
                    const lines = ['Links/Buttons:'];
                    for (const { text, url } of this.links) {
                        lines.push(`- [${text}](${url})`);
                    }
                    if (lines.length === 1) {
                        lines.push('This page does not seem to contain any buttons/links.');
                    }
                    footer.push(lines.join('\n'));
                }

                return `Title: ${this.title}

URL Source: ${this.url}
${header.length ? `\n${header.join('\n\n')}\n` : ''}
Markdown Content:
${this.content}
${footer.length ? `\n${footer.join('\n\n')}\n` : ''}`;
            }
        };

        if (imageAssets?.length) {
            formatted.imageAssets = imageAssets;
        }

        // Both summaries are rendered by the default envelope only; `markdown` returns
        // bare content, so computing them there would be wasted work.
        if (mode !== 'markdown') {
            if (options.withImagesSummary) {
                // The markdown pass fills these in as it converts <img> tags. When it
                // degraded to plain text it never ran, so fall back to a page-wide scan.
                formatted.images = Object.keys(altByUrl).length
                    ? this.labelImages(altByUrl, imageIndices, displayByUrl)
                    : this.inventoryImages(snapshot);
            }
            if (options.withLinksSummary) {
                // Kept as ordered pairs: inverting url->text into text->url silently
                // dropped every link sharing anchor text with another ("Read more").
                const links = this.domService.inferSnapshot(snapshot).links || {};
                formatted.links = Object.entries(links).map(([url, text]) => ({ text, url }));
            }
        }

        return formatted;
    }

    private snapshotToMarkdown(snapshot: PageSnapshot, ctx: ImageRuleContext & {
        mode: ResponseFormat;
    }): string {
        if (snapshot.maxElemDepth! > MARKDOWN_MAX_DOM_DEPTH || snapshot.elemCount! > MARKDOWN_MAX_DOM_ELEMENTS) {
            this.logger.warn('Degrading to text to protect the server', { url: snapshot.href });
            return snapshot.text;
        }

        const fullPageElement = this.domService.snippetToElement(snapshot.html, snapshot.href);
        let sourceElement = fullPageElement;
        let turndownService = createTurndownService({
            url: ctx.baseUrl,
            imgDataUrlToObjectUrl: ctx.imgDataUrlToObjectUrl,
        });

        // In the default mode, prefer Readability's extraction — but only when it kept
        // enough of the page that it clearly did not over-trim. Explicit `markdown` mode
        // deliberately bypasses Readability and converts the full document.
        if (ctx.mode !== 'markdown' && snapshot.parsed?.content) {
            const readabilityElement = this.domService.snippetToElement(snapshot.parsed.content, snapshot.href);
            const fullPageMarkdown = this.domService.runTurndown(turndownService, fullPageElement);
            const readabilityMarkdown = this.domService.runTurndown(turndownService, readabilityElement);

            if (readabilityMarkdown.length >= READABILITY_MIN_CONTENT_RATIO * fullPageMarkdown.length) {
                turndownService = createTurndownService({
                    noRules: true,
                    url: ctx.baseUrl,
                    imgDataUrlToObjectUrl: ctx.imgDataUrlToObjectUrl,
                });
                sourceElement = readabilityElement;
            }
        }

        for (const plugin of this.turndownPlugins) {
            turndownService = turndownService.use(plugin);
        }
        turndownService.addRule('img-with-index', this.imageRule(ctx));

        let content = this.tryTurndown(turndownService, sourceElement, ctx);

        // If converting the narrowed element yielded nothing usable, retry on the raw HTML.
        if ((!content || (content.startsWith('<') && content.endsWith('>'))) && sourceElement !== fullPageElement) {
            content = this.tryTurndown(turndownService, snapshot.html, ctx);
        }
        if (!content || (content.startsWith('<') && content.endsWith('>'))) {
            return snapshot.text;
        }

        return content;
    }

    /** Numbers each image and rewrites its src to an absolute (or pseudo `blob:`) URL. */
    private imageRule(ctx: ImageRuleContext) {
        let imgIndex = 0;

        return {
            filter: 'img' as const,
            replacement: (_content: string, node: any) => {
                let preferredSrc = (node.getAttribute('src') || '').trim();
                if (!preferredSrc || preferredSrc.startsWith('data:')) {
                    const dataSrc = (node.getAttribute('data-src') || '').trim();
                    if (dataSrc && !dataSrc.startsWith('data:')) {
                        preferredSrc = dataSrc;
                    }
                }
                // `new URL('', base)` returns the base rather than throwing, so an <img>
                // with no usable source would otherwise be emitted as a picture of the
                // page itself.
                if (!preferredSrc) {
                    return '';
                }

                let src: string | undefined;
                try {
                    src = new URL(preferredSrc, ctx.baseUrl).toString();
                } catch (_err) {
                    void 0;
                }
                if (!src) {
                    return '';
                }

                const alt = cleanAttribute(node.getAttribute('alt'));
                const serial = ++imgIndex;
                const indices = ctx.imageIndices.get(src) ?? [];
                indices.push(serial);
                ctx.imageIndices.set(src, indices);
                ctx.altByUrl[src] = alt || '';

                // What the caller should SEE, which is not always the real source: an
                // inline data: payload is replaced by a short pseudo-URL. Tracked apart
                // from `src` because `src` is what we would download, and because the
                // summary used to publish the raw base64 the substitution exists to hide.
                let display = src;
                if (src.startsWith('data:') && ctx.imgDataUrlToObjectUrl) {
                    display = new URL(`blob:${ctx.nominalUrl?.origin || ''}/${md5Hasher.hash(src)}`).toString();
                }
                ctx.displayByUrl.set(src, display);

                // Downloads are async and Turndown is not, so when images are being
                // stored the link is a placeholder that a later pass resolves. A nonce
                // keeps a page from forging one, and keeps the substitution from
                // corrupting a URL that merely looks similar inside a code block.
                const href = ctx.storeToken ? ctx.storeToken(serial, src) : display;

                return alt ? `![Image ${serial}: ${alt}](${href})` : `![Image ${serial}](${href})`;
            }
        };
    }

    /** Turndown can throw on hostile DOMs; fall back to a plugin-free instance. */
    private tryTurndown(
        turndownService: ReturnType<typeof createTurndownService>,
        source: any,
        ctx: { baseUrl?: string | URL; imgDataUrlToObjectUrl: boolean; },
    ): string {
        try {
            return this.domService.runTurndown(turndownService, source).trim();
        } catch (err) {
            this.logger.warn(`Turndown failed, retrying without plugins`, { err });
        }
        try {
            const vanilla = createTurndownService({
                url: ctx.baseUrl,
                imgDataUrlToObjectUrl: ctx.imgDataUrlToObjectUrl,
            });
            return this.domService.runTurndown(vanilla, source).trim();
        } catch (err) {
            this.logger.warn(`Turndown failed, giving up`, { err });
            return '';
        }
    }
}
