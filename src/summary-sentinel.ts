import * as fs from 'fs';
import { getSummaryRetryPolicy } from './summary-config.js';

export const ERROR_MARKER = '__ERRORED__';
const ERROR_MARKER_PREFIX = `${ERROR_MARKER}\n`;

export interface FailureState {
  attempts: number;
  lastAttempt: number;
}

export function formatErrorSentinel(
  error: unknown,
  failure: FailureState = { attempts: 1, lastAttempt: Date.now() },
): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${ERROR_MARKER}\n${JSON.stringify(failure)}\n${message}\n`;
}

export function isErroredSentinel(content: string): boolean {
  return content.startsWith(ERROR_MARKER_PREFIX);
}

export function parseErrorSentinel(content: string): FailureState {
  const secondLine = content.split('\n', 2)[1] ?? '';
  try {
    const parsed = JSON.parse(secondLine);
    if (parsed && Number.isSafeInteger(parsed.attempts) && parsed.attempts >= 0 &&
        Number.isFinite(parsed.lastAttempt) && parsed.lastAttempt >= 0) {
      return { attempts: parsed.attempts, lastAttempt: parsed.lastAttempt };
    }
  } catch {}
  const legacyTime = /^\d{4}-\d{2}-\d{2}T/.test(secondLine) ? Date.parse(secondLine) : NaN;
  return { attempts: 0, lastAttempt: Number.isNaN(legacyTime) ? 0 : legacyTime };
}

function readSummary(summaryPath: string): string | undefined {
  try {
    return fs.readFileSync(summaryPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function hasRealSummary(summaryPath: string): boolean {
  try {
    const content = readSummary(summaryPath);
    return !!content && !isErroredSentinel(content);
  } catch {
    return false;
  }
}

export function isSummaryRetryExhausted(failure: FailureState): boolean {
  return failure.attempts >= getSummaryRetryPolicy().maxAttempts;
}

export function shouldQueueForSummary(summaryPath: string): boolean {
  try {
    const content = readSummary(summaryPath);
    if (content === undefined) return true;
    if (!isErroredSentinel(content)) return false;
    const failure = parseErrorSentinel(content);
    return !isSummaryRetryExhausted(failure) &&
      Date.now() - failure.lastAttempt >= getSummaryRetryPolicy().retryMs;
  } catch {
    return false;
  }
}

function recordSummaryAttempt(summaryPath: string, error: unknown, failedAttempts: number): void {
  try {
    const content = readSummary(summaryPath);
    if (content !== undefined && !isErroredSentinel(content)) return;
    const attempts = (content ? parseErrorSentinel(content).attempts : 0) + failedAttempts;
    fs.writeFileSync(summaryPath, formatErrorSentinel(error, { attempts, lastAttempt: Date.now() }), 'utf-8');
  } catch {}
}

export function recordSummaryFailure(summaryPath: string, error: unknown): void {
  recordSummaryAttempt(summaryPath, error, 1);
}

export function recordSummarySkip(summaryPath: string, error: unknown): void {
  recordSummaryAttempt(summaryPath, error, 0);
}

export function orderFreshBeforeRetry<T extends { path: string }>(files: T[]): T[] {
  const fresh: T[] = [];
  const retries: T[] = [];
  for (const file of files) {
    try {
      const content = readSummary(file.path.replace('.jsonl', '-summary.txt'));
      if (content === undefined || (isErroredSentinel(content) && parseErrorSentinel(content).attempts === 0)) {
        fresh.push(file);
      } else {
        retries.push(file);
      }
    } catch {
      retries.push(file);
    }
  }
  return [...fresh, ...retries];
}
