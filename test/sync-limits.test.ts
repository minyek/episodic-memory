import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  DEFAULT_SYNC_DEADLINE_MS,
  BACKGROUND_NICE,
  resolveSyncDeadlineMs,
  startSyncDeadline,
  lowerBackgroundPriority,
  resolveUserSyncLockPath,
} from '../src/sync-limits.js';

// Behaviour: a background sync has a wall-clock deadline. Only the exact value
// "0" disables it; a malformed value keeps the default instead of disabling.
describe('resolveSyncDeadlineMs', () => {
  it('defaults to 30 minutes when unset', () => {
    expect(resolveSyncDeadlineMs(undefined, () => {})).toBe(DEFAULT_SYNC_DEADLINE_MS);
    expect(DEFAULT_SYNC_DEADLINE_MS).toBe(30 * 60 * 1000);
  });

  it('honors a positive integer', () => {
    expect(resolveSyncDeadlineMs('5000', () => {})).toBe(5000);
  });

  it('disables the deadline only for the exact value "0"', () => {
    expect(resolveSyncDeadlineMs('0', () => {})).toBe(0);
  });

  it.each(['', 'abc', '-5', '1.5', ' '])('keeps the default for the malformed value %j and warns', (value) => {
    const warn = vi.fn();
    expect(resolveSyncDeadlineMs(value, warn)).toBe(DEFAULT_SYNC_DEADLINE_MS);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('startSyncDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('calls onExpire once the deadline passes and not before', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    startSyncDeadline(1000, onExpire);
    vi.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('does not fire after cancel', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const deadline = startSyncDeadline(1000, onExpire);
    deadline.cancel();
    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('arms nothing for 0 (disabled)', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    startSyncDeadline(0, onExpire);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  // A sync that finishes before the deadline must exit at once; a timer that
  // keeps the event loop alive would hold both locks until it fired.
  it('uses a timer that does not keep the process alive', () => {
    const real = globalThis.setTimeout;
    let created: NodeJS.Timeout | undefined;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      created = real(fn, ms);
      return created;
    }) as typeof setTimeout);
    const deadline = startSyncDeadline(60_000, () => {});
    expect(created).toBeDefined();
    expect(created!.hasRef()).toBe(false);
    deadline.cancel();
  });
});

// Behaviour: the background child runs at a lower priority; a failure to set
// it (no permission, unsupported platform) never stops the sync.
describe('lowerBackgroundPriority', () => {
  it('sets the current process to the background nice value', () => {
    const setPriority = vi.fn();
    lowerBackgroundPriority(setPriority);
    expect(setPriority).toHaveBeenCalledWith(0, BACKGROUND_NICE);
    expect(BACKGROUND_NICE).toBe(10);
  });

  it('swallows a failure to set the priority', () => {
    const setPriority = vi.fn(() => { throw new Error('EPERM'); });
    expect(() => lowerBackgroundPriority(setPriority)).not.toThrow();
  });
});

// Behaviour: the per-user lock location does not depend on HOME or on a
// per-job TMPDIR: it prefers XDG_RUNTIME_DIR when that is a directory, falls
// back to the temp dir, and carries the uid so accounts sharing a temp dir
// never share it.
describe('resolveUserSyncLockPath', () => {
  const dirs: string[] = [];
  const makeDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'episodic-memory-user-lock-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('uses XDG_RUNTIME_DIR when it is a directory, with the uid in the name', () => {
    const xdg = makeDir();
    const other = makeDir();
    expect(resolveUserSyncLockPath({ XDG_RUNTIME_DIR: xdg, TMPDIR: other }, 1234, other))
      .toBe(join(xdg, 'episodic-memory-sync-1234.lock'));
  });

  it('falls back to the temp dir when XDG_RUNTIME_DIR is unset', () => {
    const tmp = makeDir();
    expect(resolveUserSyncLockPath({}, 7, tmp)).toBe(join(tmp, 'episodic-memory-sync-7.lock'));
  });

  it('falls back to the temp dir when XDG_RUNTIME_DIR is missing or not a directory', () => {
    const tmp = makeDir();
    const file = join(makeDir(), 'a-file');
    writeFileSync(file, '');
    expect(resolveUserSyncLockPath({ XDG_RUNTIME_DIR: join(tmp, 'missing') }, 7, tmp))
      .toBe(join(tmp, 'episodic-memory-sync-7.lock'));
    expect(resolveUserSyncLockPath({ XDG_RUNTIME_DIR: file }, 7, tmp))
      .toBe(join(tmp, 'episodic-memory-sync-7.lock'));
  });

  it('gives different uids different lock files in the same directory', () => {
    const xdg = makeDir();
    mkdirSync(xdg, { recursive: true });
    expect(resolveUserSyncLockPath({ XDG_RUNTIME_DIR: xdg }, 1, xdg))
      .not.toBe(resolveUserSyncLockPath({ XDG_RUNTIME_DIR: xdg }, 2, xdg));
  });
});
