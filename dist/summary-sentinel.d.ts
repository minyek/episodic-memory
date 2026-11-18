/**
 * States of `<archive>/<project>/<session>-summary.txt`:
 *
 * - Missing: never summarized; queue it.
 * - Empty: permanent skip for a conversation with no exchanges.
 * - `__ERRORED__\n{"attempts":n,"lastAttempt":epochMs}\n<message>`: the last
 *   automatic attempt failed or was skipped. Retried once the retry interval
 *   has passed, until `attempts` reaches the attempt limit. The stored time is
 *   authoritative because copying an archive resets the file's mtime. Older
 *   sentinels carry an ISO timestamp on line two and read as zero attempts.
 * - Anything else: a real summary, never overwritten by failure recording.
 */
export declare const ERROR_MARKER = "__ERRORED__";
export interface FailureState {
    attempts: number;
    lastAttempt: number;
}
export declare function formatErrorSentinel(error: unknown, failure: FailureState): string;
export declare function isErroredSentinel(content: string): boolean;
export declare function parseErrorSentinel(content: string): FailureState;
export declare function isSummaryRetryExhausted(failure: FailureState): boolean;
/**
 * True when the sentinel at `summaryPath` represents a real summary —
 * a non-empty file that is not an error marker. Empty zero-exchange
 * sentinels and error sentinels both return false. Use this for callers
 * that care about "is this conversation summarized and useful" (stats,
 * verify, search).
 */
export declare function hasRealSummary(summaryPath: string): boolean;
/**
 * True when the conversation at `summaryPath` should be (re-)summarized:
 * no sentinel yet, or an error marker that is due for retry.
 */
export declare function shouldQueueForSummary(summaryPath: string): boolean;
export declare function recordSummaryFailure(summaryPath: string, error: unknown): void;
export declare function recordSummarySkip(summaryPath: string, error: unknown): void;
export declare function orderFreshBeforeRetry<T extends {
    summaryPath: string;
}>(files: T[]): T[];
