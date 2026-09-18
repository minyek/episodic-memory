const summaryRetryDefaults = {
    retryHours: 1,
    maxAttempts: 5,
};
export function getSummaryRetryPolicy() {
    const retryHours = Number(process.env.EPISODIC_MEMORY_SUMMARY_ERROR_RETRY_HOURS);
    const retryMs = retryHours * 3600000;
    const maxAttempts = Number(process.env.EPISODIC_MEMORY_SUMMARY_MAX_ATTEMPTS);
    return {
        retryMs: Number.isFinite(retryMs) && retryMs > 0
            ? retryMs
            : summaryRetryDefaults.retryHours * 3600000,
        maxAttempts: Number.isSafeInteger(maxAttempts) && maxAttempts > 0
            ? maxAttempts
            : summaryRetryDefaults.maxAttempts,
    };
}
