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

import fs from 'fs';
import path from 'path';
import * as lockfile from 'proper-lockfile';

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
   * Called from the heartbeat timer when the lock is no longer ours. Without a
   * handler the library's default applies: it throws from the timer, which
   * stops the holder.
   */
  onCompromised?: (kind: CompromiseKind, holderPid: number | null) => void;
  /** Filesystem the lock library calls through; a replacement can observe or pause each call. */
  fs?: object;
  /** Milliseconds after which an unrefreshed lock may be taken over. */
  stale?: number;
  /** Milliseconds between heartbeats. */
  update?: number;
}

/**
 * Default stale threshold for the underlying proper-lockfile mtime heartbeat,
 * which refreshes the lock every half threshold. Only a holder whose event loop
 * stops for 10 minutes (a crash, a hang, a long host suspend) leaves a lock
 * others may take.
 */
const DEFAULT_STALE_MS = 10 * 60 * 1000;

export function acquireFileLock(lockPath: string, options: AcquireOptions = {}): FileLockHandle | null {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // proper-lockfile expects the target path to exist. Touch it if missing —
  // 'a' (append, create if missing) leaves any existing PID intact.
  try {
    fs.closeSync(fs.openSync(lockPath, 'a'));
  } catch (err: any) {
    throw err;
  }

  const onLost = options.onCompromised;
  let release: () => void;
  try {
    release = lockfile.lockSync(lockPath, {
      realpath: false,
      retries: 0,
      stale: options.stale ?? DEFAULT_STALE_MS,
      ...(options.update !== undefined && { update: options.update }),
      ...(options.fs !== undefined && { fs: options.fs as any }),
      ...(onLost && {
        onCompromised: () => {
          const kind: CompromiseKind = fs.existsSync(`${lockPath}.lock`) ? 'taken-over' : 'vanished';
          onLost(kind, readLockHolder(lockPath));
        },
      }),
    });
  } catch (err: any) {
    if (err.code === 'ELOCKED') return null;
    throw err;
  }

  // Hold acquired. Record our PID for diagnostics ("which process holds the
  // lock right now?"). Best-effort — the mutex itself lives in .lock/.
  try {
    fs.writeFileSync(lockPath, String(process.pid), 'utf-8');
  } catch {}

  return { path: lockPath, release };
}

export function releaseFileLock(handle: FileLockHandle): void {
  // Remove our diagnostic file before the lock directory: once the directory
  // is gone a successor can acquire and write its own PID file, which this
  // release must not delete.
  try {
    if (readLockHolder(handle.path) === process.pid) fs.unlinkSync(handle.path);
  } catch {}
  try { handle.release(); } catch {}
}

/**
 * Read the recorded holder PID from a lock file's diagnostic content.
 * Returns null if the file doesn't exist or doesn't contain a valid PID.
 * The PID is informational only — the real mutex lives in `<lockPath>.lock/`.
 */
export function readLockHolder(lockPath: string): number | null {
  try {
    const pid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Names a lock's holder in a diagnostic line: its PID, or "another process" when no PID was recorded. */
export function describeLockHolder(pid: number | null): string {
  return pid !== null ? `pid ${pid}` : 'another process';
}
