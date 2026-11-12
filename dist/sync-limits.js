import fs from 'fs';
import os from 'os';
import path from 'path';
import { acquireFileLock, readLockHolder } from './file-lock.js';
/** Set by the parent of `sync --background` in the environment of the detached child. */
export const BACKGROUND_CHILD_ENV = 'EPISODIC_MEMORY_BACKGROUND_CHILD';
export const DEFAULT_SYNC_DEADLINE_MS = 30 * 60 * 1000;
export const BACKGROUND_NICE = 10;
export const SYNC_DEADLINE_EXIT_CODE = 124;
/**
 * Wall-clock limit for a background sync, in milliseconds; 0 means no limit.
 * Only the exact string "0" disables it, so an empty or malformed value cannot
 * remove the limit by accident.
 */
export function resolveSyncDeadlineMs(raw, warn) {
    if (raw === undefined)
        return DEFAULT_SYNC_DEADLINE_MS;
    if (raw === '0')
        return 0;
    if (/^[1-9][0-9]*$/.test(raw))
        return Number.parseInt(raw, 10);
    warn(`episodic-memory: ignoring invalid EPISODIC_MEMORY_SYNC_TIMEOUT_MS=${JSON.stringify(raw)}; ` +
        `using ${DEFAULT_SYNC_DEADLINE_MS} ms`);
    return DEFAULT_SYNC_DEADLINE_MS;
}
/**
 * Calls onExpire once after ms milliseconds. The timer does not keep the
 * process alive, so a sync that finishes early exits at once.
 */
export function startSyncDeadline(ms, onExpire) {
    if (ms <= 0)
        return { cancel: () => { } };
    const timer = setTimeout(onExpire, ms);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
}
/**
 * Lower this process's CPU priority. On Linux the value applies per thread and
 * only to threads created afterwards, so call it before the embedding session
 * exists. A failure never stops the sync.
 */
export function lowerBackgroundPriority(setPriority = os.setPriority) {
    try {
        setPriority(0, BACKGROUND_NICE);
    }
    catch {
        // Priority is a courtesy to other work, not a requirement for syncing.
    }
}
function isDirectory(dir) {
    if (!dir)
        return false;
    try {
        return fs.statSync(dir).isDirectory();
    }
    catch {
        return false;
    }
}
function currentUserId() {
    return typeof process.getuid === 'function' ? String(process.getuid()) : os.userInfo().username;
}
/**
 * Location of the per-user lock that limits background syncs across every
 * HOME, config dir and TMPDIR: the runtime dir when it is a directory, else the
 * temp dir. The user id is in the name so accounts sharing a directory never
 * share or squat the file.
 */
export function resolveUserSyncLockPath(env, userId = currentUserId(), tempDir = os.tmpdir()) {
    const dir = isDirectory(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : tempDir;
    return path.join(dir, `episodic-memory-sync-${userId}.lock`);
}
/**
 * Take the per-user sync lock. Contention is reported as 'busy'; any other
 * failure (an unwritable directory) is 'unavailable', and the caller carries on
 * under its per-config-dir lock.
 */
export function acquireUserSyncSlot(env, options = {}) {
    const lockPath = resolveUserSyncLockPath(env);
    try {
        const handle = acquireFileLock(lockPath, options);
        if (handle)
            return { kind: 'held', handle };
        return { kind: 'busy', holderPid: readLockHolder(lockPath) };
    }
    catch (error) {
        return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
    }
}
