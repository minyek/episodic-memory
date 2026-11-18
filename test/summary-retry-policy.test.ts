import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as sentinel from '../src/summary-sentinel.js';

describe('summary retry state', () => {
  let directory: string;
  let summaryPath: string;
  const now = Date.parse('2026-09-10T12:00:00Z');
  const HOUR_MS = 3_600_000;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'summary-retry-policy-'));
    summaryPath = join(directory, 'summary.txt');
    vi.stubEnv('EPISODIC_MEMORY_SUMMARY_MAX_ATTEMPTS', '5');
    vi.stubEnv('EPISODIC_MEMORY_SUMMARY_ERROR_RETRY_HOURS', '1');
    vi.spyOn(Date, 'now').mockReturnValue(now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  function writeState(state: unknown): void {
    writeFileSync(summaryPath, `__ERRORED__\n${JSON.stringify(state)}\nFailure\n`);
  }

  it.each([
    { attempts: 4, age: HOUR_MS - 1, queue: false },
    { attempts: 4, age: HOUR_MS, queue: true },
    { attempts: 5, age: 2 * HOUR_MS, queue: false },
    { attempts: 6, age: 2 * HOUR_MS, queue: false },
    { attempts: 0, age: HOUR_MS - 1, queue: false },
    { attempts: 0, age: HOUR_MS, queue: true },
    { attempts: 1, age: -HOUR_MS, queue: true },
    { attempts: 1, age: -(HOUR_MS - 1), queue: false },
  ])('queues=$queue for attempts=$attempts and age=$age', ({ attempts, age, queue }) => {
    writeState({ attempts, lastAttempt: now - age });
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(queue);
  });

  it.each(['0', '-1', '2.5', '5garbage', 'NaN', 'Infinity', '', String(Number.MAX_SAFE_INTEGER + 1)])('falls back to the attempt cap for invalid config %j', value => {
    vi.stubEnv('EPISODIC_MEMORY_SUMMARY_MAX_ATTEMPTS', value);
    writeState({ attempts: 4, lastAttempt: now - 2 * HOUR_MS });
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(true);
    writeState({ attempts: 5, lastAttempt: now - 2 * HOUR_MS });
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(false);
  });

  it.each(['0', '-1', '1garbage', 'NaN', 'Infinity', '', '1e308'])('falls back to the retry interval for invalid config %j', value => {
    vi.stubEnv('EPISODIC_MEMORY_SUMMARY_ERROR_RETRY_HOURS', value);
    writeState({ attempts: 1, lastAttempt: now - (HOUR_MS - 1) });
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(false);
    writeState({ attempts: 1, lastAttempt: now - HOUR_MS });
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(true);
  });

  it.each([
    { age: 35999, queue: false },
    { age: 36000, queue: true },
  ])('honors a fractional-hour retry interval: queues=$queue at age=$age', ({ age, queue }) => {
    vi.stubEnv('EPISODIC_MEMORY_SUMMARY_ERROR_RETRY_HOURS', '0.01');
    writeState({ attempts: 1, lastAttempt: now - age });
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(queue);
  });

  it('uses the legacy ISO timestamp even when the sentinel has just been copied', () => {
    writeFileSync(summaryPath, '__ERRORED__\n2026-09-10T10:00:00.000Z\nLegacy failure\n');
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(true);
  });

  it('counts the first failure after a legacy ISO sentinel as attempt one', () => {
    writeFileSync(summaryPath, '__ERRORED__\n2026-09-10T10:00:00.000Z\nLegacy failure\n');
    sentinel.recordSummaryFailure(summaryPath, new Error('Next failure'));
    expect(sentinel.parseErrorSentinel(readFileSync(summaryPath, 'utf8'))).toEqual({ attempts: 1, lastAttempt: now });
  });

  it('backs off from a recent legacy ISO timestamp', () => {
    writeFileSync(summaryPath, '__ERRORED__\n2026-09-10T11:30:00.000Z\nLegacy failure\n');
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(false);
  });

  it.each([
    { attempts: -1, lastAttempt: now },
    { attempts: 0.5, lastAttempt: now },
    { attempts: 5, lastAttempt: -1 },
    { attempts: 5, lastAttempt: 'invalid' },
    { attempts: Number.MAX_SAFE_INTEGER + 1, lastAttempt: now },
    null,
  ])('allows recovery from malformed failure state %j', state => {
    writeState(state);
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(true);
  });

  it('records skipped work without incrementing or resetting prior failures', () => {
    writeState({ attempts: 3, lastAttempt: now - 2 * HOUR_MS });
    sentinel.recordSummarySkip(summaryPath, 'Batch stopped');
    expect(sentinel.parseErrorSentinel(readFileSync(summaryPath, 'utf8'))).toEqual({ attempts: 3, lastAttempt: now });
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(false);
  });

  it.each(['A useful summary.\n', ''])('preserves a real summary or empty sentinel %j during skipped or failed work', body => {
    writeFileSync(summaryPath, body);
    sentinel.recordSummarySkip(summaryPath, 'Batch stopped');
    expect(readFileSync(summaryPath, 'utf8')).toBe(body);
    sentinel.recordSummaryFailure(summaryPath, 'Failure');
    expect(readFileSync(summaryPath, 'utf8')).toBe(body);
  });

  it('increments existing failures and keeps the diagnostic message', () => {
    writeState({ attempts: 3, lastAttempt: now - 2 * HOUR_MS });
    sentinel.recordSummaryFailure(summaryPath, new Error('New diagnostic'));
    const content = readFileSync(summaryPath, 'utf8');
    expect(sentinel.parseErrorSentinel(content)).toEqual({ attempts: 4, lastAttempt: now });
    expect(content).toContain('New diagnostic');
  });
});
