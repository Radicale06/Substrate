/**
 * Image format detection by magic bytes.
 *
 * The Content-Type header and the URL's extension are both attacker-controlled — the
 * image URLs come from the crawled page — so neither decides what we store or what
 * extension we give it. Sniffing the bytes makes the stored filename structurally safe:
 * the extension can only ever be one of the constants below, so there is no path to
 * traverse and no sanitiser to get wrong.
 *
 * SVG is absent on purpose and its absence is load-bearing. It has no magic number, so it
 * cannot pass this check — which is what we want, because the backend serves stored files
 * from its own origin and a stored SVG is stored XSS.
 */

export interface ImageType {
    extension: string;
    contentType: string;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF87 = Buffer.from('GIF87a', 'latin1');
const GIF89 = Buffer.from('GIF89a', 'latin1');
const BMP = Buffer.from('BM', 'latin1');
const RIFF = Buffer.from('RIFF', 'latin1');
const WEBP = Buffer.from('WEBP', 'latin1');
const FTYP = Buffer.from('ftyp', 'latin1');
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00]);

/** ISO-BMFF brands that mean "still image", not video. */
const IMAGE_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'heim', 'heis', 'mif1', 'msf1']);

/** The smallest prefix that can decide any of the formats below. */
export const IMAGE_SNIFF_BYTES = 16;

function startsWith(bytes: Buffer, prefix: Buffer, offset = 0): boolean {
    return bytes.length >= offset + prefix.length
        && bytes.subarray(offset, offset + prefix.length).equals(prefix);
}

/**
 * The image type these bytes actually are, or null when they are not a supported image.
 *
 * Null is the reject: anything unrecognized is refused rather than stored under a guessed
 * extension. That covers SVG, HTML error pages served with a 200, and video containers
 * whose ISO-BMFF brand says it is a movie rather than a still.
 */
export function sniffImageType(bytes: Buffer): ImageType | null {
    if (startsWith(bytes, PNG)) {
        return { extension: 'png', contentType: 'image/png' };
    }
    // SOI marker. The next byte varies by JPEG flavour, so only the first two are fixed.
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return { extension: 'jpg', contentType: 'image/jpeg' };
    }
    if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) {
        return { extension: 'gif', contentType: 'image/gif' };
    }
    // RIFF is also WAV and AVI; the WEBP tag at byte 8 is what makes it an image.
    if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) {
        return { extension: 'webp', contentType: 'image/webp' };
    }
    if (startsWith(bytes, FTYP, 4)) {
        const brand = bytes.subarray(8, 12).toString('latin1');
        if (IMAGE_BRANDS.has(brand)) {
            const avif = brand === 'avif' || brand === 'avis';
            return avif
                ? { extension: 'avif', contentType: 'image/avif' }
                : { extension: 'heic', contentType: 'image/heic' };
        }
        return null;
    }
    if (startsWith(bytes, BMP)) {
        return { extension: 'bmp', contentType: 'image/bmp' };
    }
    if (startsWith(bytes, ICO)) {
        return { extension: 'ico', contentType: 'image/x-icon' };
    }

    return null;
}
