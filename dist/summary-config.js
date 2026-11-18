const MS_PER_HOUR = 3_600_000;
const summaryRetryDefaults = {
    retryHours: 1,
    maxAttempts: 5,
};
export function getSummaryRetryPolicy() {
    const retryMs = Number(process.env.EPISODIC_MEMORY_SUMMARY_ERROR_RETRY_HOURS) * MS_PER_HOUR;
    const maxAttempts = Number(process.env.EPISODIC_MEMORY_SUMMARY_MAX_ATTEMPTS);
    return {
        retryMs: Number.isFinite(retryMs) && retryMs > 0
            ? retryMs
            : summaryRetryDefaults.retryHours * MS_PER_HOUR,
        maxAttempts: Number.isSafeInteger(maxAttempts) && maxAttempts > 0
            ? maxAttempts
            : summaryRetryDefaults.maxAttempts,
    };
}
