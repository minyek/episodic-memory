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
    const stateLine = content.split('\n', 2)[1] ?? '';
    try {
        const parsed = JSON.parse(stateLine);
        if (parsed && Number.isSafeInteger(parsed.attempts) && parsed.attempts >= 0 &&
            Number.isFinite(parsed.lastAttempt) && parsed.lastAttempt >= 0) {
            return { attempts: parsed.attempts, lastAttempt: parsed.lastAttempt };
        }
    }
    catch { }
    const legacyTime = /^\d{4}-\d{2}-\d{2}T/.test(stateLine) ? Date.parse(stateLine) : NaN;
    return { attempts: 0, lastAttempt: Number.isNaN(legacyTime) ? 0 : legacyTime };
}
export function isSummaryRetryExhausted(failure) {
    return failure.attempts >= getSummaryRetryPolicy().maxAttempts;
}
/**
 * True when the sentinel at `summaryPath` represents a real summary —
 * a non-empty file that is not an error marker. Empty zero-exchange
 * sentinels and error sentinels both return false. Use this for callers
 * that care about "is this conversation summarized and useful" (stats,
 * verify, search).
 */
export function hasRealSummary(summaryPath) {
    if (!fs.existsSync(summaryPath))
        return false;
    let content;
    try {
        content = fs.readFileSync(summaryPath, 'utf-8');
    }
    catch {
        return false;
    }
    if (content.length === 0)
        return false;
    if (isErroredSentinel(content))
        return false;
    return true;
}
/**
 * True when the conversation at `summaryPath` should be (re-)summarized:
 * no sentinel yet, or an error marker that is due for retry.
 */
export function shouldQueueForSummary(summaryPath) {
    if (!fs.existsSync(summaryPath))
        return true;
    let content;
    try {
        content = fs.readFileSync(summaryPath, 'utf-8');
    }
    catch {
        return false;
    }
    if (!isErroredSentinel(content))
        return false;
    const failure = parseErrorSentinel(content);
    const retryDue = Date.now() - failure.lastAttempt >= getSummaryRetryPolicy().retryMs;
    return retryDue && !isSummaryRetryExhausted(failure);
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
function recordSummaryAttempt(summaryPath, error, attemptsSpent) {
    try {
        const content = readSummary(summaryPath);
        if (content !== undefined && !isErroredSentinel(content))
            return;
        const priorAttempts = content === undefined ? 0 : parseErrorSentinel(content).attempts;
        const failure = { attempts: priorAttempts + attemptsSpent, lastAttempt: Date.now() };
        fs.writeFileSync(summaryPath, formatErrorSentinel(error, failure), 'utf-8');
    }
    catch {
        // Best-effort: the caller still reports the original summarization error.
    }
}
export function recordSummaryFailure(summaryPath, error) {
    recordSummaryAttempt(summaryPath, error, 1);
}
export function recordSummarySkip(summaryPath, error) {
    recordSummaryAttempt(summaryPath, error, 0);
}
function isAwaitingFirstAttempt(summaryPath) {
    try {
        const content = readSummary(summaryPath);
        return content === undefined ||
            (isErroredSentinel(content) && parseErrorSentinel(content).attempts === 0);
    }
    catch {
        return false;
    }
}
export function orderFreshBeforeRetry(files) {
    const fresh = [];
    const retries = [];
    for (const file of files) {
        if (isAwaitingFirstAttempt(file.summaryPath))
            fresh.push(file);
        else
            retries.push(file);
    }
    return [...fresh, ...retries];
}
