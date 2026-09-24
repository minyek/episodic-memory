export interface SummaryRetryPolicy {
    retryMs: number;
    maxAttempts: number;
}
export declare function getSummaryRetryPolicy(): SummaryRetryPolicy;
