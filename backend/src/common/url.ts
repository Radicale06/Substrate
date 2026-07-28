/**
 * Turn the path portion of an incoming request into an absolute URL string.
 *
 * A real `http:`/`https:` scheme is preserved regardless of slash count, since
 * proxies and CDNs may collapse `//`. Anything else is treated as a bare host,
 * so hostnames that merely start with "http" (e.g. httpbin.org) still work.
 */
export function toAbsoluteUrl(rawTarget: string): string {
    return /^https?:/i.test(rawTarget) ? rawTarget : `http://${rawTarget}`;
}

/**
 * Whether a hostname is well-formed enough to attempt a crawl: a valid IP literal,
 * or a dotted name whose TLD is at least two characters.
 */
export function isValidHostname(hostname: string): boolean {
    const bare = hostname.replace(/^\[|\]$/g, '');
    if (bare.includes(':')) {
        return true; // IPv6 literal; private ranges are rejected by the SSRF guard
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
        return bare.split('.').every((octet) => Number(octet) <= 255);
    }
    const labels = bare.split('.');
    return labels.length > 1 && labels[labels.length - 1].length >= 2;
}

/** Remove any userinfo, so a URL can be echoed back to the caller safely. */
export function stripCredentials(url: URL): string {
    const clean = new URL(url.toString());
    clean.username = '';
    clean.password = '';

    return clean.toString();
}

/** Strip embedded credentials so a URL can safely be logged. */
export function redactUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) {
            parsed.username = '***';
            parsed.password = '***';
        }
        return parsed.toString();
    } catch (_err) {
        return '<unparsable url>';
    }
}
