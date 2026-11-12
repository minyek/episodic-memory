import { type AcquireOptions, type FileLockHandle } from './file-lock.js';
/** Set by the parent of `sync --background` in the environment of the detached child. */
export declare const BACKGROUND_CHILD_ENV = "EPISODIC_MEMORY_BACKGROUND_CHILD";
export declare const DEFAULT_SYNC_DEADLINE_MS: number;
export declare const BACKGROUND_NICE = 10;
export declare const SYNC_DEADLINE_EXIT_CODE = 124;
/**
 * Wall-clock limit for a background sync, in milliseconds; 0 means no limit.
 * Only the exact string "0" disables it, so an empty or malformed value cannot
 * remove the limit by accident.
 */
export declare function resolveSyncDeadlineMs(raw: string | undefined, warn: (message: string) => void): number;
/**
 * Calls onExpire once after ms milliseconds. The timer does not keep the
 * process alive, so a sync that finishes early exits at once.
 */
export declare function startSyncDeadline(ms: number, onExpire: () => void): void;
/**
 * Lower this process's CPU priority. On Linux the value applies per thread and
 * only to threads created afterwards, so call it before the embedding session
 * exists. A failure never stops the sync.
 */
export declare function lowerBackgroundPriority(setPriority?: (pid: number, priority: number) => void): void;
/**
 * Location of the per-user lock that limits background syncs across every
 * HOME, config dir and TMPDIR: the runtime dir when it is a directory, else the
 * temp dir. The user id is in the name so accounts sharing a directory never
 * share or squat the file.
 */
export declare function resolveUserSyncLockPath(env: NodeJS.ProcessEnv, userId?: number | string, tempDir?: string): string;
export type UserSyncSlot = {
    kind: 'held';
    handle: FileLockHandle;
} | {
    kind: 'busy';
    holderPid: number | null;
} | {
    kind: 'unavailable';
    reason: string;
};
/**
 * Take the per-user sync lock. Contention is reported as 'busy'; any other
 * failure (an unwritable directory) is 'unavailable', and the caller carries on
 * under its per-config-dir lock.
 */
export declare function acquireUserSyncSlot(env: NodeJS.ProcessEnv, options?: AcquireOptions): UserSyncSlot;
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
export declare function startBackgroundSyncLimits(env: NodeJS.ProcessEnv, hooks: BackgroundSyncHooks): FileLockHandle | null;
