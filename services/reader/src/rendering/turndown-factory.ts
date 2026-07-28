import { createHash } from 'crypto';
import TurndownService from 'turndown';
import { cleanAttribute } from '../common/html';

/** Short, stable identifier for an inline data: image, used to build pseudo blob URLs. */
export const md5Hasher = {
    hash: (value: string) => createHash('md5').update(value).digest('hex'),
};

export interface TurndownFactoryOptions {
    /**
     * Skip the element-stripping rules. Used when converting Readability output,
     * which has already been cleaned.
     */
    noRules?: boolean | string;
    /** Base URL used to resolve relative links. */
    url?: string | URL;
    /** Replace inline `data:` image payloads with short pseudo `blob:` URLs. */
    imgDataUrlToObjectUrl?: boolean;
}

/** Builds a Turndown instance configured for LLM-friendly markdown output. */
export function createTurndownService(options?: TurndownFactoryOptions): TurndownService {
    const turndownService = new TurndownService({
        codeBlockStyle: 'fenced',
        preformattedCode: true,
    } as any);

    if (!options?.noRules) {
        turndownService.addRule('remove-irrelevant', {
            filter: ['meta', 'style', 'script', 'noscript', 'link', 'textarea', 'select'],
            replacement: () => ''
        });
        turndownService.addRule('truncate-svg', {
            filter: 'svg' as any,
            replacement: () => ''
        });
        turndownService.addRule('title-as-h1', {
            filter: ['title'],
            replacement: (innerText) => `${innerText}\n===============\n`
        });
    }

    if (options?.imgDataUrlToObjectUrl) {
        turndownService.addRule('data-url-to-pseudo-object-url', {
            filter: (node) => Boolean(node.tagName === 'IMG' && node.getAttribute('src')?.startsWith('data:')),
            replacement: (_content, node: any) => {
                const src = (node.getAttribute('src') || '').trim();
                const alt = cleanAttribute(node.getAttribute('alt')) || '';

                if (options.url) {
                    const refUrl = new URL(options.url);
                    const mappedUrl = new URL(`blob:${refUrl.origin}/${md5Hasher.hash(src)}`);

                    return `![${alt}](${mappedUrl})`;
                }

                return `![${alt}](blob:${md5Hasher.hash(src)})`;
            }
        });
    }

    turndownService.addRule('improved-paragraph', {
        filter: 'p',
        replacement: (innerText) => {
            const trimmed = innerText.trim();
            if (!trimmed) {
                return '';
            }

            return `${trimmed.replace(/\n{3,}/g, '\n\n')}\n\n`;
        }
    });

    turndownService.addRule('improved-inline-link', {
        filter: function (node, turndownOptions) {
            return Boolean(
                turndownOptions.linkStyle === 'inlined' &&
                node.nodeName === 'A' &&
                node.getAttribute('href')
            );
        },
        replacement: function (content, node: any) {
            let href = node.getAttribute('href');
            if (href) {
                href = href.replace(/([()])/g, '\\$1');
            }
            let title = cleanAttribute(node.getAttribute('title'));
            if (title) {
                title = ' "' + title.replace(/"/g, '\\"') + '"';
            }

            const fixedContent = content.replace(/\s+/g, ' ').trim();
            let fixedHref = href.replace(/\s+/g, '').trim();
            if (options?.url) {
                try {
                    fixedHref = new URL(fixedHref, options.url).toString();
                } catch (_err) {
                    void 0;
                }
            }

            return `[${fixedContent}](${fixedHref}${title || ''})`;
        }
    });

    turndownService.addRule('improved-code', {
        filter: function (node: any) {
            const hasSiblings = node.previousSibling || node.nextSibling;
            const isCodeBlock = node.parentNode.nodeName === 'PRE' && !hasSiblings;

            return node.nodeName === 'CODE' && !isCodeBlock;
        },
        replacement: function (inputContent: any) {
            if (!inputContent) {
                return '';
            }
            const content = inputContent;

            let delimiter = '`';
            const matches = content.match(/`+/gm) || [];
            while (matches.indexOf(delimiter) !== -1) {
                delimiter = delimiter + '`';
            }
            if (content.includes('\n')) {
                delimiter = '```';
            }

            const extraSpace = delimiter === '```' ? '\n' : /^`|^ .*?[^ ].* $|`$/.test(content) ? ' ' : '';

            return delimiter + extraSpace + content +
                (delimiter === '```' && !content.endsWith(extraSpace) ? extraSpace : '') + delimiter;
        }
    });

    return turndownService;
}

