/**
 * File-based exclusive locks. Thin wrapper around the `proper-lockfile`
 * package, which uses an atomic mkdir + mtime-heartbeat protocol that is
 * race-free under concurrent stale-stealers — the failure mode that pure
 * "openSync(wx) + PID file" implementations cannot fully close without
 * advisory locking (flock/fcntl).
 *
 * Used by long-running background work that must not run more than once at a
 * time on a given machine: the embedding migration (#73) and
 * `sync --background` (#97).
 *
 * On disk for a held lock at `<lockPath>`:
 *   <lockPath>             — diagnostic file containing the holder's PID
 *   <lockPath>.lock/       — proper-lockfile's mutex directory (mkdir-atomic)
 *
 * Stale recovery is mtime-based with a 10-minute threshold: if the holder
 * crashed without releasing, the .lock/ directory's mtime stops advancing,
 * and a contender past the threshold steals it atomically. The protocol's
 * atomicity guarantee is the package's contract — see proper-lockfile's
 * README for the underlying analysis (the same approach used by npm itself).
 *
 * Error policy:
 *   - `null` means lock contention.
 *   - Unexpected I/O errors (EACCES, ENOSPC, EMFILE, etc.) are thrown so
 *     callers can surface disk problems rather than mask them as "locked".
 */
export interface FileLockHandle {
    path: string;
    release: () => void;
}
/**
 * Why a held lock stopped being ours: another process took the directory over
 * ('taken-over'), or the directory disappeared ('vanished').
 */
export type CompromiseKind = 'taken-over' | 'vanished';
export interface AcquireOptions {
    /**
     * Called from the heartbeat timer when the lock is no longer ours. The
     * library's own default throws from the timer; this wrapper's default does
     * nothing, so a lost lock never crashes the holder.
     */
    onCompromised?: (kind: CompromiseKind, holderPid: number | null) => void;
    /** Filesystem used by the lock library; tests inject one to pause between calls. */
    fs?: object;
    /** Milliseconds after which an unrefreshed lock may be taken over. */
    stale?: number;
    /** Milliseconds between heartbeats. */
    update?: number;
}
export declare function acquireFileLock(lockPath: string, options?: AcquireOptions): FileLockHandle | null;
export declare function releaseFileLock(handle: FileLockHandle): void;
/**
 * Read the recorded holder PID from a lock file's diagnostic content.
 * Returns null if the file doesn't exist or doesn't contain a valid PID.
 * The PID is informational only — the real mutex lives in `<lockPath>.lock/`.
 */
export declare function readLockHolder(lockPath: string): number | null;
