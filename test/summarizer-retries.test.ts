import { describe, it, expect, afterEach, vi } from 'vitest';
import { getApiEnv, resetApiRetriesWarningForTests } from '../src/summarizer.js';

// Behaviour (spec AC 1): the summarizer's subprocess retries a failing API a
// small, bounded number of times and never in the SDK's watchdog mode, whatever
// the parent environment (an agent session carries 100 retries and the watchdog).
describe('getApiEnv retry settings', () => {
  const keys = ['CLAUDE_CODE_MAX_RETRIES', 'CLAUDE_CODE_RETRY_WATCHDOG', 'EPISODIC_MEMORY_API_MAX_RETRIES'] as const;
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    resetApiRetriesWarningForTests();
    vi.restoreAllMocks();
  });

  function envWith(overrides: Record<string, string | undefined>) {
    process.env.CLAUDE_CODE_MAX_RETRIES = '100';
    process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1';
    delete process.env.EPISODIC_MEMORY_API_MAX_RETRIES;
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return getApiEnv()!;
  }

  it('replaces an inherited retry count and watchdog with 2 and off', () => {
    const env = envWith({});
    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe('2');
    expect(env.CLAUDE_CODE_RETRY_WATCHDOG).toBe('0');
  });

  it.each(['0', '5'])('honors the override %s', (value) => {
    const env = envWith({ EPISODIC_MEMORY_API_MAX_RETRIES: value });
    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe(value);
    expect(env.CLAUDE_CODE_RETRY_WATCHDOG).toBe('0');
  });

  it.each(['', 'x', '-1', '1.5'])('keeps 2 and warns once for the invalid override %j', (value) => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = envWith({ EPISODIC_MEMORY_API_MAX_RETRIES: value });
    const second = getApiEnv()!;
    expect(first.CLAUDE_CODE_MAX_RETRIES).toBe('2');
    expect(second.CLAUDE_CODE_MAX_RETRIES).toBe('2');
    expect(first.CLAUDE_CODE_RETRY_WATCHDOG).toBe('0');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
