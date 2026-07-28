import { get_encoding, type Tiktoken } from 'tiktoken';
import { BadRequestError } from '../common/errors';

/** Encodings tiktoken ships, exposed under the same names the hosted API uses. */
export const SUPPORTED_TOKENIZERS = [
    'cl100k_base',
    'o200k_base',
    'p50k_base',
    'p50k_edit',
    'r50k_base',
    'gpt2',
] as const;

export type TokenizerName = typeof SUPPORTED_TOKENIZERS[number];

export const DEFAULT_TOKENIZER: TokenizerName = 'cl100k_base';

/** Predicate form, for validating a request without throwing. */
export function isTokenizerName(name: string): name is TokenizerName {
    return SUPPORTED_TOKENIZERS.includes(name as TokenizerName);
}

/**
 * Encoders are expensive to build and safe to share, so they are cached for the
 * process lifetime rather than freed after each request.
 */
const encoders = new Map<TokenizerName, Tiktoken>();

export function getTokenizer(name: string = DEFAULT_TOKENIZER): Tiktoken {
    if (!SUPPORTED_TOKENIZERS.includes(name as TokenizerName)) {
        throw new BadRequestError(
            `Unknown tokenizer "${name}". Supported: ${SUPPORTED_TOKENIZERS.join(', ')}`,
        );
    }
    const tokenizerName = name as TokenizerName;

    let encoder = encoders.get(tokenizerName);
    if (!encoder) {
        encoder = get_encoding(tokenizerName);
        encoders.set(tokenizerName, encoder);
    }

    return encoder;
}

/** Decodes token ids back to text. tiktoken returns bytes, not a string. */
export function decodeTokens(encoder: Tiktoken, ids: Uint32Array): string {
    return new TextDecoder().decode(encoder.decode(ids));
}
