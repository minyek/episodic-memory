import * as fs from 'fs';
import { getSummaryRetryPolicy } from './summary-config.js';
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
export const ERROR_MARKER = '__ERRORED__';
const ERROR_MARKER_PREFIX = `${ERROR_MARKER}\n`;
export function formatErrorSentinel(error, failure) {
    const message = error instanceof Error ? error.message : String(error);
    return `${ERROR_MARKER}\n${JSON.stringify(failure)}\n${message}\n`;
}
export function isErroredSentinel(content) {
    return content.startsWith(ERROR_MARKER_PREFIX);
}
export function parseErrorSentinel(content) {
    const secondLine = content.split('\n', 2)[1] ?? '';
    try {
        const parsed = JSON.parse(secondLine);
        if (parsed && Number.isSafeInteger(parsed.attempts) && parsed.attempts >= 0 &&
            Number.isFinite(parsed.lastAttempt) && parsed.lastAttempt >= 0) {
            return { attempts: parsed.attempts, lastAttempt: parsed.lastAttempt };
        }
    }
    catch { }
    const legacyTime = /^\d{4}-\d{2}-\d{2}T/.test(secondLine) ? Date.parse(secondLine) : NaN;
    return { attempts: 0, lastAttempt: Number.isNaN(legacyTime) ? 0 : legacyTime };
}
function readSummary(summaryPath) {
    try {
        return fs.readFileSync(summaryPath, 'utf-8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
export function hasRealSummary(summaryPath) {
    try {
        const content = readSummary(summaryPath);
        return !!content && !isErroredSentinel(content);
    }
    catch {
        return false;
    }
}
export function isSummaryRetryExhausted(failure) {
    return failure.attempts >= getSummaryRetryPolicy().maxAttempts;
}
export function shouldQueueForSummary(summaryPath) {
    try {
        const content = readSummary(summaryPath);
        if (content === undefined)
            return true;
        if (!isErroredSentinel(content))
            return false;
        const failure = parseErrorSentinel(content);
        return !isSummaryRetryExhausted(failure) &&
            Date.now() - failure.lastAttempt >= getSummaryRetryPolicy().retryMs;
    }
    catch {
        return false;
    }
}
function recordSummaryAttempt(summaryPath, error, failedAttempts) {
    try {
        const content = readSummary(summaryPath);
        if (content !== undefined && !isErroredSentinel(content))
            return;
        const attempts = (content ? parseErrorSentinel(content).attempts : 0) + failedAttempts;
        fs.writeFileSync(summaryPath, formatErrorSentinel(error, { attempts, lastAttempt: Date.now() }), 'utf-8');
    }
    catch { }
}
export function recordSummaryFailure(summaryPath, error) {
    recordSummaryAttempt(summaryPath, error, 1);
}
export function recordSummarySkip(summaryPath, error) {
    recordSummaryAttempt(summaryPath, error, 0);
}
export function orderFreshBeforeRetry(files) {
    const fresh = [];
    const retries = [];
    for (const file of files) {
        try {
            const content = readSummary(file.summaryPath);
            if (content === undefined || (isErroredSentinel(content) && parseErrorSentinel(content).attempts === 0)) {
                fresh.push(file);
            }
            else {
                retries.push(file);
            }
        }
        catch {
            retries.push(file);
        }
    }
    return [...fresh, ...retries];
}
