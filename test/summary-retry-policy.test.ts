import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as sentinel from '../src/summary-sentinel.js';

describe('summary retry state', () => {
  let directory: string;
  let summaryPath: string;
  const now = Date.parse('2026-09-10T12:00:00Z');

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
    { attempts: 4, age: 3599999, queue: false },
    { attempts: 4, age: 3600000, queue: true },
    { attempts: 5, age: 7200000, queue: false },
    { attempts: 6, age: 7200000, queue: false },
    { attempts: 0, age: 3599999, queue: false },
    { attempts: 0, age: 3600000, queue: true },
  ])('queues=$queue for attempts=$attempts and age=$age', ({ attempts, age, queue }) => {
    writeState({ attempts, lastAttempt: now - age });
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(queue);
  });

  it.each(['0', '-1', '2.5', '5garbage', 'NaN', 'Infinity', '', '9007199254740992'])('falls back to the attempt cap for invalid config %j', value => {
    vi.stubEnv('EPISODIC_MEMORY_SUMMARY_MAX_ATTEMPTS', value);
    writeState({ attempts: 4, lastAttempt: now - 7200000 });
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(true);
    writeState({ attempts: 5, lastAttempt: now - 7200000 });
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(false);
  });

  it.each(['0', '-1', '1garbage', 'NaN', 'Infinity', '', '1e308'])('falls back to the retry interval for invalid config %j', value => {
    vi.stubEnv('EPISODIC_MEMORY_SUMMARY_ERROR_RETRY_HOURS', value);
    writeState({ attempts: 1, lastAttempt: now - 3599999 });
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(false);
    writeState({ attempts: 1, lastAttempt: now - 3600000 });
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(true);
  });

  it.each([35999, 36000])('honors a fractional-hour retry interval at age %i', age => {
    vi.stubEnv('EPISODIC_MEMORY_SUMMARY_ERROR_RETRY_HOURS', '0.01');
    writeState({ attempts: 1, lastAttempt: now - age });
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(age === 36000);
  });

  it('uses the legacy ISO timestamp even when the sentinel has just been copied', () => {
    writeFileSync(summaryPath, '__ERRORED__\n2026-09-10T10:00:00.000Z\nLegacy failure\n');
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(true);
    sentinel.recordSummaryFailure(summaryPath, new Error('Next failure'));
    expect(sentinel.parseErrorSentinel(readFileSync(summaryPath, 'utf8'))).toEqual({ attempts: 1, lastAttempt: now });
  });

  it.each([
    { attempts: -1, lastAttempt: now },
    { attempts: 0.5, lastAttempt: now },
    { attempts: 5, lastAttempt: -1 },
    { attempts: 5, lastAttempt: 'invalid' },
    { attempts: 9007199254740992, lastAttempt: now },
    null,
  ])('allows recovery from malformed failure state %j', state => {
    writeState(state);
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(true);
  });

  it('records skipped work without incrementing or resetting prior failures', () => {
    writeState({ attempts: 3, lastAttempt: now - 7200000 });
    sentinel.recordSummarySkip(summaryPath, 'Batch stopped');
    expect(sentinel.parseErrorSentinel(readFileSync(summaryPath, 'utf8'))).toEqual({ attempts: 3, lastAttempt: now });
    expect(sentinel.shouldQueueForSummary(summaryPath)).toBe(false);
  });

  it.each(['A useful summary.\n', '__COVERAGE__ {"bytes":500,"schema":1,"resummary":{"attempts":2,"lastAttempt":1}}\nA useful summary.\n'])('preserves existing summary bytes during skipped or failed work', body => {
    writeFileSync(summaryPath, body);
    sentinel.recordSummarySkip(summaryPath, 'Batch stopped');
    expect(readFileSync(summaryPath, 'utf8')).toBe(body);
    sentinel.recordSummaryFailure(summaryPath, 'Failure');
    expect(readFileSync(summaryPath, 'utf8')).toBe(body);
  });

  it('increments existing failures and keeps the diagnostic message', () => {
    writeState({ attempts: 3, lastAttempt: now - 7200000 });
    sentinel.recordSummaryFailure(summaryPath, new Error('New diagnostic'));
    const content = readFileSync(summaryPath, 'utf8');
    expect(sentinel.parseErrorSentinel(content)).toEqual({ attempts: 4, lastAttempt: now });
    expect(content).toContain('New diagnostic');
  });
});
