/**
 * Parse the legacy inet_aton IPv4 forms a URL parser would otherwise accept:
 * decimal (2130706433), hex (0x7f000001), octal (0177.0.0.1) and short forms
 * (127.1). Returns canonical dotted-quad, or null when this is not a numeric host.
 */
function parseLegacyIPv4(host: string): string | null {
    const parts = host.split('.');
    if (parts.length > 4 || parts.some((p) => p === '')) {
        return null;
    }

    const numbers: number[] = [];
    for (const part of parts) {
        let value: number;
        if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
            value = parseInt(part, 16);
        } else if (/^0[0-7]+$/.test(part)) {
            value = parseInt(part, 8);
        } else if (/^\d+$/.test(part)) {
            value = parseInt(part, 10);
        } else {
            return null; // contains letters: a real hostname, not a numeric literal
        }
        if (!Number.isFinite(value)) {
            return null;
        }
        numbers.push(value);
    }

    // Every part but the last is one octet; the last fills the remaining octets.
    const last = numbers.pop()!;
    if (numbers.some((n) => n > 255) || last >= 2 ** (8 * (4 - numbers.length))) {
        return null;
    }
    const octets = [...numbers];
    const remaining = 4 - numbers.length;
    for (let i = remaining - 1; i >= 0; i--) {
        octets.push((last >>> (8 * i)) & 0xff);
    }

    return octets.join('.');
}

function isPrivateIPv4(ip: string): boolean {
    const canonical = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : parseLegacyIPv4(ip);
    if (canonical === null) {
        return false; // a genuine hostname; DNS resolution is out of scope here
    }
    const octets = canonical.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
        return false;
    }
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 ||          // 0.0.0.0/8, private, loopback
        (a === 100 && b >= 64 && b <= 127) ||          // CGNAT 100.64.0.0/10
        (a === 169 && b === 254) ||                     // link-local 169.254.0.0/16
        (a === 172 && b >= 16 && b <= 31) ||           // 172.16.0.0/12
        (a === 192 && b === 168);                       // 192.168.0.0/16
}

/**
 * Expand an IPv6 literal (brackets stripped, lowercased) into its eight 16-bit
 * groups, handling `::` compression and a trailing dotted-quad.
 * Returns null when the input is not a valid IPv6 address.
 */
function parseIPv6(input: string): number[] | null {
    const withoutZone = input.split('%')[0];
    if (!withoutZone.includes(':')) {
        return null;
    }
    let head = withoutZone;
    const dottedTail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(withoutZone);
    if (dottedTail) {
        const quad = dottedTail[1].split('.').map(Number);
        if (quad.some((n) => n > 255)) {
            return null;
        }
        head = withoutZone.slice(0, dottedTail.index) +
            [((quad[0] << 8) | quad[1]).toString(16), ((quad[2] << 8) | quad[3]).toString(16)].join(':');
    }
    const halves = head.split('::');
    if (halves.length > 2) {
        return null;
    }
    const toGroups = (s: string) => s ? s.split(':').map((g) => parseInt(g, 16)) : [];
    const left = toGroups(halves[0]);
    const right = halves.length === 2 ? toGroups(halves[1]) : null;

    let groups: number[];
    if (right === null) {
        groups = left;
    } else {
        const elided = 8 - left.length - right.length;
        if (elided < 0) {
            return null;
        }
        groups = [...left, ...Array(elided).fill(0), ...right];
    }
    if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) {
        return null;
    }
    return groups;
}

/**
 * Whether a URL hostname points at loopback, link-local, or private address space.
 *
 * Covers IPv4, IPv6 (`::1`, unique-local, link-local, and IPv4-mapped forms in both
 * dotted and normalized hex notation) and the trailing-dot FQDN form. Unparseable
 * IPv6 literals fail closed.
 *
 * NOTE: this inspects the literal hostname only. A public DNS name that resolves to
 * a private address (DNS rebinding) is not caught here.
 */
export function isLoopbackOrPrivateHostname(hostname: string): boolean {
    let host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host.endsWith('.')) {
        host = host.slice(0, -1); // 'localhost.' is still loopback
    }
    if (host === 'localhost' || host.endsWith('.localhost')) {
        return true;
    }

    if (host.includes(':')) {
        const groups = parseIPv6(host);
        if (!groups) {
            return true;
        }
        // :: (unspecified) and ::1 (loopback)
        if (groups.slice(0, 7).every((g) => g === 0) && (groups[7] === 0 || groups[7] === 1)) {
            return true;
        }
        // IPv4-mapped ::ffff:0:0/96 and deprecated IPv4-compatible ::/96
        if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
            const mapped = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
            return isPrivateIPv4(mapped);
        }
        if ((groups[0] & 0xffc0) === 0xfe80) {
            return true; // link-local fe80::/10
        }
        if ((groups[0] & 0xfe00) === 0xfc00) {
            return true; // unique-local fc00::/7
        }
        return false;
    }

    return isPrivateIPv4(host); // 0.0.0.0/8 covers 0.0.0.0
}

const ALLOWED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks5:']);

/**
 * Whether a caller-supplied proxy URL is safe to route a crawl through.
 *
 * This matters as much as the target check: the page-proxy plugin dials the proxy from
 * Node, so it never passes through Chrome's request interception. An unvalidated proxy
 * host would be a straight SSRF primitive into the host's private network.
 */
export function isAllowedProxyUrl(raw: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch (_err) {
        return false;
    }
    if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol)) {
        return false;
    }
    if (!parsed.hostname) {
        return false;
    }

    return !isLoopbackOrPrivateHostname(parsed.hostname);
}
