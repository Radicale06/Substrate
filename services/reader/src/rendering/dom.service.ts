import { marshalError } from '../common/async';
import { Injectable, Logger } from '@nestjs/common';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService, { Node } from 'turndown';
import { SLOW_OPERATION_WARN_MS } from '../config/constants';
import { BadRequestError } from '../common/errors';
import { ExtendedScrapingOptions, ExtendedSnapshot, PageSnapshot } from './page-snapshot';

const virtualConsole = new VirtualConsole();
virtualConsole.on('error', () => void 0);

/** Empty document reused purely to syntax-check caller-supplied CSS selectors. */
let selectorProbe: any;

/**
 * Server-side DOM work on captured snapshots: narrowing to selected elements,
 * inlining child frames, and inventorying links and images.
 */
@Injectable()
export class DomService {

    private readonly logger = new Logger(DomService.name);

    /**
     * Rejects selectors that are not valid CSS, so a typo becomes a 400 instead of
     * throwing out of querySelectorAll mid-crawl and surfacing as a 500.
     */
    assertValidSelectors(...selectors: (string | string[] | undefined)[]) {
        const candidates = selectors.flat().filter(Boolean) as string[];
        if (!candidates.length) {
            return;
        }
        selectorProbe ??= new JSDOM('', { virtualConsole }).window.document;
        for (const selector of candidates) {
            try {
                selectorProbe.querySelector(selector);
            } catch (_err) {
                throw new BadRequestError(`Invalid CSS selector: ${selector}`);
            }
        }
    }

    /**
     * Re-parses a snapshot to apply target/remove selectors and inline iframes, then
     * re-runs Readability over the result. Returns the snapshot untouched when there is
     * nothing to narrow.
     */
    narrowSnapshot(
        snapshot: PageSnapshot | undefined,
        options?: Pick<ExtendedScrapingOptions, 'targetSelector' | 'removeSelector' | 'withIframe'>,
    ): PageSnapshot | undefined {
        if (snapshot?.parsed && !options?.targetSelector && !options?.removeSelector && !options?.withIframe) {
            return snapshot;
        }
        if (!snapshot?.html) {
            return snapshot;
        }
        const t0 = Date.now();
        const jsdom = new JSDOM(snapshot.html, { url: snapshot.href, virtualConsole });
        // Holds jsdom Elements or the Document itself, which do not share a single type
        // across the jsdom/turndown boundary.
        const allNodes: any[] = [];
        jsdom.window.document.querySelectorAll('svg').forEach((x) => x.innerHTML = '');
        if (options?.withIframe) {
            jsdom.window.document.querySelectorAll('iframe[src],frame[src]').forEach((frameEl) => {
                const src = frameEl.getAttribute('src');
                const frameSnapshot = snapshot.childFrames?.find((f) => f.href === src);
                if (!frameSnapshot?.html) {
                    return;
                }
                // Assigning innerHTML on an <iframe> parses as raw text in jsdom, so
                // sanitising via querySelectorAll on that element matches nothing and the
                // frame's scripts survive into the output. Clean the frame in its own
                // document, then splice the sanitised nodes in.
                const frameDoc = new JSDOM(frameSnapshot.html, {
                    url: src || snapshot.href,
                    virtualConsole,
                }).window.document;

                frameDoc.querySelectorAll('script, style').forEach((s: any) => s.remove());
                for (const attr of ['src', 'href']) {
                    frameDoc.querySelectorAll(`[${attr}]`).forEach((el: any) => {
                        try {
                            el.setAttribute(attr, new URL(el.getAttribute(attr)!, src || snapshot.href).toString());
                        } catch (_err) {
                            void 0; // leave unresolvable references as-is
                        }
                    });
                }

                const container = jsdom.window.document.createElement('div');
                container.innerHTML = frameDoc.body?.innerHTML || '';
                frameEl.replaceWith(container);
            });
        }

        if (Array.isArray(options?.removeSelector)) {
            for (const rl of options!.removeSelector) {
                jsdom.window.document.querySelectorAll(rl).forEach((x) => x.remove());
            }
        } else if (options?.removeSelector) {
            jsdom.window.document.querySelectorAll(options.removeSelector).forEach((x) => x.remove());
        }

        // A selector like 'html' or ':root' removes everything; carry on with the
        // original snapshot rather than dereferencing a document that no longer exists.
        if (!jsdom.window.document.documentElement || !jsdom.window.document.body) {
            this.logger.warn(`Remove selectors emptied the document, keeping the original`, { url: snapshot.href });
            return snapshot;
        }

        if (Array.isArray(options?.targetSelector)) {
            for (const x of options!.targetSelector.map((x) => jsdom.window.document.querySelectorAll(x))) {
                x.forEach((el) => {
                    if (!allNodes.includes(el)) {
                        allNodes.push(el);
                    }
                });
            }
        } else if (options?.targetSelector) {
            jsdom.window.document.querySelectorAll(options.targetSelector).forEach((el) => {
                if (!allNodes.includes(el)) {
                    allNodes.push(el);
                }
            });
        } else {
            allNodes.push(jsdom.window.document);
        }

        if (!allNodes.length) {
            return snapshot;
        }
        const textChunks: string[] = [];
        let rootDoc;
        if (allNodes.length === 1 && allNodes[0].nodeName === '#document') {
            rootDoc = allNodes[0] as any;
            if (rootDoc.body.textContent) {
                textChunks.push(rootDoc.body.textContent);
            }
        } else {
            rootDoc = new JSDOM('', { url: snapshot.href, virtualConsole }).window.document;
            for (const n of allNodes) {
                rootDoc.body.appendChild(n);
                rootDoc.body.appendChild(rootDoc.createTextNode('\n\n'));
                if (n.textContent) {
                    textChunks.push(n.textContent);
                }
            }
        }

        let parsed;
        try {
            parsed = new Readability(rootDoc.cloneNode(true) as any).parse();
        } catch (err: any) {
            this.logger.warn(`Failed to parse selected element`, { err: marshalError(err) });
        }

        // No innerText in jsdom
        // https://github.com/jsdom/jsdom/issues/1245
        const textContent = textChunks.join('\n\n');
        const cleanedText = textContent?.split('\n').map((x: any) => x.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n');

        const imageTags = Array.from(rootDoc.querySelectorAll('img[src],img[data-src]'))
            .map((x: any) => [x.getAttribute('src'), x.getAttribute('data-src')])
            .flat()
            .map((x) => {
                try {
                    return new URL(x, snapshot.rebase || snapshot.href).toString();
                } catch (err) {
                    return null;
                }
            })
            .filter(Boolean);

        const imageSet = new Set(imageTags);

        const r = {
            ...snapshot,
            title: snapshot.title || jsdom.window.document.title,
            parsed,
            html: rootDoc.documentElement.outerHTML,
            text: cleanedText,
            imgs: snapshot.imgs?.filter((x) => imageSet.has(x.src)) || [],
        } as PageSnapshot;

        const dt = Date.now() - t0;
        if (dt > SLOW_OPERATION_WARN_MS) {
            this.logger.warn(`Performance issue: Narrowing snapshot took ${dt}ms`, { url: snapshot.href, dt });
        }

        return r;
    }

    inferSnapshot(snapshot: PageSnapshot): ExtendedSnapshot {
        const t0 = Date.now();
        const extendedSnapshot = { ...snapshot } as ExtendedSnapshot;
        try {
            const jsdom = new JSDOM(snapshot.html, { url: snapshot.href, virtualConsole });
            jsdom.window.document.querySelectorAll('svg').forEach((x) => x.innerHTML = '');
            const links = Array.from(jsdom.window.document.querySelectorAll('a[href]'))
                .map((x: any) => [x.getAttribute('href'), x.textContent.replace(/\s+/g, ' ').trim()])
                .map(([href, text]) => {
                    if (!text) {
                        return undefined;
                    }
                    try {
                        const parsed = new URL(href, snapshot.rebase || snapshot.href);
                        if (parsed.protocol === 'file:' || parsed.protocol === 'javascript:') {
                            return undefined;
                        }
                        return [parsed.toString(), text] as const;
                    } catch (err) {
                        return undefined;
                    }
                })
                .filter(Boolean)
                .reduce((acc, pair) => {
                    acc[pair![0]] = pair![1];
                    return acc;
                }, {} as { [k: string]: string; });

            extendedSnapshot.links = links;

            const imgs = Array.from(jsdom.window.document.querySelectorAll('img[src],img[data-src]'))
                .map((x: any) => {
                    let linkPreferredSrc = (x.getAttribute('src') || '').trim();
                    if (!linkPreferredSrc || linkPreferredSrc.startsWith('data:')) {
                        const dataSrc = (x.getAttribute('data-src') || '').trim();
                        if (dataSrc && !dataSrc.startsWith('data:')) {
                            linkPreferredSrc = dataSrc;
                        }
                    }
                    // `new URL('', base)` returns the base rather than throwing, so an
                    // <img> with no usable source would be inventoried as the page itself
                    // — and, now that this list feeds the downloader, fetched as one.
                    if (!linkPreferredSrc) {
                        return undefined;
                    }

                    let src: string;
                    try {
                        src = new URL(linkPreferredSrc, snapshot.rebase || snapshot.href).toString();
                    } catch (_err) {
                        return undefined;
                    }

                    return {
                        src,
                        width: parseInt(x.getAttribute('width') || '0'),
                        height: parseInt(x.getAttribute('height') || '0'),
                        alt: x.getAttribute('alt') || x.getAttribute('title'),
                    };
                })
                .filter(Boolean);

            extendedSnapshot.imgs = imgs as any;
        } catch (_err) {
            void 0;
        }

        const dt = Date.now() - t0;
        if (dt > SLOW_OPERATION_WARN_MS) {
            this.logger.warn(`Performance issue: Inferring snapshot took ${dt}ms`, { url: snapshot.href, dt });
        }

        return extendedSnapshot;
    }

    snippetToElement(snippet?: string, url?: string) {
        const parsed = new JSDOM(snippet || '', { url, virtualConsole });

        return parsed.window.document.documentElement;
    }

    runTurndown(turndownService: TurndownService, html: TurndownService.Node | string) {
        const t0 = Date.now();

        try {
            return turndownService.turndown(html);
        } finally {
            const dt = Date.now() - t0;
            if (dt > SLOW_OPERATION_WARN_MS) {
                this.logger.warn(`Performance issue: Turndown took ${dt}ms`, { dt });
            }
        }
    }
}
