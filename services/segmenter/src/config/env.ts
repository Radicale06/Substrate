function positiveIntFromEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const env = {
    port: positiveIntFromEnv('PORT', 3002),

    /**
     * The embedding service, used only by the `semantic` strategy.
     *
     * Optional on purpose: chunking is the one capability in this stack that needs no
     * model, and requiring one to start would defeat that. Unset simply means `semantic`
     * degrades to `recursive` and says so in the response.
     */
    embeddingsUrl: process.env.EMBEDDINGS_URL?.replace(/\/$/, '') || undefined,
    /** Shared secret for the embedding service, when it requires one. */
    inferenceApiKey: process.env.INFERENCE_API_KEY || undefined,

    /**
     * Shared secret. When set, every /segment call must present it as a bearer token.
     */
    apiKey: process.env.SEGMENTER_API_KEY || undefined,
};

/** Whether the semantic strategy can run at all. */
export function isEmbeddingsConfigured(): boolean {
    return Boolean(env.embeddingsUrl);
}
