import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseEnvCount } from './env-count.js';
import {
  acquireFileLock,
  describeLockHolder,
  readLockHolder,
  type AcquireOptions,
  type FileLockHandle,
} from './file-lock.js';

/** Set by the parent of `sync --background` in the environment of the detached child. */
export const BACKGROUND_CHILD_ENV = 'EPISODIC_MEMORY_BACKGROUND_CHILD';

export const DEFAULT_SYNC_DEADLINE_MS = 30 * 60 * 1000;
export const BACKGROUND_NICE = 10;

export const SYNC_DEADLINE_EXIT_CODE = 124;

// setTimeout's largest delay; Node fires a longer one after 1 ms.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Wall-clock limit for a background sync, in milliseconds; 0 means no limit.
 * Only the exact string "0" disables it, so an empty or malformed value cannot
 * remove the limit by accident.
 */
export function resolveSyncDeadlineMs(raw: string | undefined, warn: (message: string) => void): number {
  const ms = parseEnvCount(raw, { name: 'EPISODIC_MEMORY_SYNC_TIMEOUT_MS', fallback: DEFAULT_SYNC_DEADLINE_MS, unit: 'ms' }, warn);
  if (ms <= MAX_TIMER_MS) return ms;
  warn(`episodic-memory: clamping EPISODIC_MEMORY_SYNC_TIMEOUT_MS=${JSON.stringify(raw)} to the timer limit; using ${MAX_TIMER_MS} ms`);
  return MAX_TIMER_MS;
}

/**
 * Calls onExpire once after ms milliseconds. The timer does not keep the
 * process alive, so a sync that finishes early exits at once.
 */
export function startSyncDeadline(ms: number, onExpire: () => void): void {
  if (ms <= 0) return;
  setTimeout(onExpire, ms).unref();
}

/**
 * Lower this process's CPU priority. On Linux the value applies per thread and
 * only to threads created afterwards, so call it before the embedding session
 * exists. A failure never stops the sync.
 */
export function lowerBackgroundPriority(
  setPriority: (pid: number, priority: number) => void = os.setPriority,
): void {
  try {
    setPriority(0, BACKGROUND_NICE);
  } catch {}
}

function isDirectory(dir: string | undefined): dir is string {
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function currentUserId(): string {
  return typeof process.getuid === 'function' ? String(process.getuid()) : os.userInfo().username;
}

/**
 * Location of the per-user lock that limits background syncs across every
 * HOME, config dir and TMPDIR: the runtime dir when it is a directory, else the
 * temp dir. The user id is in the name so accounts sharing a directory never
 * share or squat the file.
 */
export function resolveUserSyncLockPath(
  env: NodeJS.ProcessEnv,
  userId: number | string = currentUserId(),
  tempDir: string = os.tmpdir(),
): string {
  const dir = isDirectory(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : tempDir;
  return path.join(dir, `episodic-memory-sync-${userId}.lock`);
}

export type UserSyncSlot =
  | { kind: 'held'; handle: FileLockHandle }
  | { kind: 'busy'; holderPid: number | null }
  | { kind: 'unavailable'; reason: string };

/**
 * Take the per-user sync lock. Contention is reported as 'busy'; any other
 * failure (an unwritable directory) is 'unavailable', and the caller carries on
 * under its per-config-dir lock.
 */
export function acquireUserSyncSlot(
  env: NodeJS.ProcessEnv,
  options: AcquireOptions = {},
): UserSyncSlot {
  const lockPath = resolveUserSyncLockPath(env);
  try {
    const handle = acquireFileLock(lockPath, options);
    if (handle) return { kind: 'held', handle };
    return { kind: 'busy', holderPid: readLockHolder(lockPath) };
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface BackgroundSyncHooks {
  lowerPriority: () => void;
  acquireSlot: (options: AcquireOptions) => UserSyncSlot;
  startDeadline: (ms: number, onExpire: () => void) => void;
  log: (message: string) => void;
  exit: (code: number) => void;
}

/**
 * Limits for the detached child of `sync --background`: lower priority before
 * any embedding session exists, take the per-user lock, arm the deadline.
 * Returns the per-user lock to release on exit, or null; a foreground sync
 * (no child marker) gets none of them.
 */
export function startBackgroundSyncLimits(env: NodeJS.ProcessEnv, hooks: BackgroundSyncHooks): FileLockHandle | null {
  if (env[BACKGROUND_CHILD_ENV] !== '1') return null;
  hooks.lowerPriority();
  const slot = hooks.acquireSlot({
    onCompromised: (kind, holderPid) => {
      if (kind === 'taken-over') {
        hooks.log(`episodic-memory: per-user sync lock taken over by ${describeLockHolder(holderPid)}; stopping`);
        hooks.exit(0);
        return;
      }
      hooks.log('episodic-memory: per-user sync lock directory vanished; continuing under the config-dir lock');
    },
  });
  if (slot.kind === 'busy') {
    hooks.log(`episodic-memory: another background sync is running for this user (${describeLockHolder(slot.holderPid)}); skipping`);
    hooks.exit(0);
    return null;
  }
  if (slot.kind === 'unavailable') {
    hooks.log(`episodic-memory: per-user sync lock unavailable (${slot.reason}); continuing under the config-dir lock`);
  }
  const deadlineMs = resolveSyncDeadlineMs(env.EPISODIC_MEMORY_SYNC_TIMEOUT_MS, hooks.log);
  hooks.startDeadline(deadlineMs, () => {
    hooks.log(`episodic-memory: sync deadline of ${deadlineMs} ms reached; stopping (progress is kept and the next sync resumes)`);
    hooks.exit(SYNC_DEADLINE_EXIT_CODE);
  });
  return slot.kind === 'held' ? slot.handle : null;
}
