export declare const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
/**
 * Resolve the intra-op thread cap for the embedding session, or null to leave
 * onnxruntime at its default (one worker per core).
 *
 * Embedding runs one exchange at a time (batch=1) through indexing, sync and
 * the re-embed migration. At that size the default pool fans each tiny int8
 * matmul across every core and its idle workers spin: measured on a 32-core
 * Linux host, 100 embeddings used 50 CPU-seconds with 32 threads busy, against
 * 2.4-2.6 CPU-seconds for 300 embeddings capped at 2. Vectors are
 * bit-identical, so no re-index follows.
 *
 * Override with EPISODIC_MEMORY_EMBED_THREADS: a positive integer sets the cap,
 * and exactly "0" restores onnxruntime's default. Any other value keeps the cap
 * of 2 and says so.
 */
export declare function resolveIntraOpThreads(): number | null;
/**
 * Session options for the embedding pipeline. Spin-waiting is always off, so
 * idle workers sleep instead of burning a core; the value is a string because
 * the native binding rejects other types.
 */
export declare function buildEmbeddingSessionOptions(intraOpThreads: number | null): {
    extra: {
        'session.intra_op.allow_spinning': string;
    };
    intraOpNumThreads?: number | undefined;
    interOpNumThreads?: number | undefined;
};
/**
 * Thrown when the embedding backend can't be loaded. The most common cause is
 * that `@huggingface/transformers` eagerly requires `sharp`, whose native
 * binding fails to `dlopen` libvips on some hosts (#135) — even though sharp is
 * only needed for image inputs, not the text feature-extraction this package
 * uses. Callers that can proceed without semantic features (e.g. background
 * sync indexing) should catch this and degrade gracefully rather than crash.
 */
export declare class EmbeddingsUnavailableError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export declare function initEmbeddings(): Promise<void>;
export declare function generateEmbedding(text: string): Promise<number[]>;
/**
 * Prepend the BGE retrieval prefix to a query string. Idempotent: returns
 * the input unchanged if the prefix is already present.
 */
export declare function withQueryPrefix(query: string): string;
/**
 * Generate an embedding for a search QUERY. Adds the model-specific prefix
 * before embedding, which gives a small but consistent recall lift on
 * retrieval tasks. Document/passage embeddings (`generateExchangeEmbedding`)
 * stay unmodified — that's the asymmetric pattern BGE models are trained for.
 */
export declare function generateQueryEmbedding(query: string): Promise<number[]>;
export declare function generateExchangeEmbedding(userMessage: string, assistantMessage: string, toolNames?: string[]): Promise<number[]>;
