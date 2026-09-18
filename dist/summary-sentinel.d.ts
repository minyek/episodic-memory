export declare const ERROR_MARKER = "__ERRORED__";
export interface FailureState {
    attempts: number;
    lastAttempt: number;
}
export declare function formatErrorSentinel(error: unknown, failure?: FailureState): string;
export declare function isErroredSentinel(content: string): boolean;
export declare function parseErrorSentinel(content: string): FailureState;
export declare function hasRealSummary(summaryPath: string): boolean;
export declare function isSummaryRetryExhausted(failure: FailureState): boolean;
export declare function shouldQueueForSummary(summaryPath: string): boolean;
export declare function recordSummaryFailure(summaryPath: string, error: unknown): void;
export declare function recordSummarySkip(summaryPath: string, error: unknown): void;
export declare function orderFreshBeforeRetry<T extends {
    path: string;
}>(files: T[]): T[];
