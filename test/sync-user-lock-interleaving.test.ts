import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { mkdtempSync, rmSync, mkdirSync, utimesSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { acquireFileLock, releaseFileLock, type FileLockHandle, type CompromiseKind } from '../src/file-lock.js';

// Behaviour: at most one holder of a lock keeps
// running past its next heartbeat; releasing never deletes a successor's PID
// file; a lock taken with a handler never throws from a timer when it
// vanishes or is taken over (one taken without a handler keeps the library's
// throw).
//
// The lock library's stale-steal and heartbeat are several separate
// filesystem calls. Each scenario pauses one party between two of its calls
// (an injected fs runs a hook at that point) and runs the other party to
// completion there, then checks the outcome after the next heartbeat.

type FsHook = (method: string, phase: 'before' | 'after' | 'error') => void;

function hookedFs(hook: FsHook) {
  const wrap = <T extends (...a: any[]) => any>(name: string, fn: T) =>
    ((...args: any[]) => {
      hook(name, 'before');
      let out;
      try {
        out = fn(...args);
      } catch (error) {
        hook(name, 'error');
        throw error;
      }
      hook(name, 'after');
      return out;
    }) as T;
  return {
    ...fs,
    mkdirSync: wrap('mkdirSync', fs.mkdirSync),
    statSync: wrap('statSync', fs.statSync),
    rmdirSync: wrap('rmdirSync', fs.rmdirSync),
    utimesSync: wrap('utimesSync', fs.utimesSync),
  };
}

// The kernel's coarse timestamps can give two directories created in quick
// succession the same mtime, which hides a takeover from the heartbeat.
function letClockAdvance(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}

const FAST = { stale: 2000, update: 1000 };

describe('per-user lock under interleaved acquirers', () => {
  let dir: string;
  let lockPath: string;
  const held: FileLockHandle[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'episodic-memory-lock-interleave-'));
    lockPath = join(dir, 'user.lock');
  });

  afterEach(() => {
    for (const h of held.splice(0)) {
      try { releaseFileLock(h); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function makeStaleLock(): void {
    mkdirSync(`${lockPath}.lock`);
    writeFileSync(lockPath, '999999');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${lockPath}.lock`, old, old);
  }

  // G2: two stealers of a stale lock. The first is paused between noticing the
  // lock is stale and removing it; the second completes its steal there; the
  // first then removes the second's fresh lock and takes its own. Both now
  // believe they hold the lock. The library records lock times to the second,
  // so which of them notices first depends on timer order; either way exactly
  // one must be stopped.
  it('stops exactly one of two stealers that both acquired a stale lock', async () => {
    makeStaleLock();
    const compromised: Record<string, CompromiseKind[]> = { first: [], second: [] };
    let signal!: () => void;
    const someoneStopped = new Promise<void>((resolve) => { signal = resolve; });

    let second: FileLockHandle | null = null;
    let injected = false;
    const first = acquireFileLock(lockPath, {
      ...FAST,
      fs: hookedFs((method, phase) => {
        if (method === 'rmdirSync' && phase === 'before' && !injected) {
          injected = true;
          second = acquireFileLock(lockPath, {
            ...FAST,
            onCompromised: (k) => { compromised.second.push(k); signal(); },
          });
          letClockAdvance();
        }
      }),
      onCompromised: (k) => { compromised.first.push(k); signal(); },
    });
    if (first) held.push(first);
    if (second) held.push(second);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    await someoneStopped;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect([...compromised.first, ...compromised.second]).toEqual(['taken-over']);
  });

  // G3: the holder is paused between checking its lock is still its own and
  // refreshing it; a stealer finds the lock stale and takes it meanwhile.
  it('stops the stealer, not the refreshing holder, when a steal lands inside a heartbeat', async () => {
    const compromised: Record<string, CompromiseKind[]> = { holder: [], stealer: [] };
    let signalStealer!: (k: CompromiseKind) => void;
    const stealerCompromised = new Promise<CompromiseKind>((resolve) => { signalStealer = resolve; });

    let stealer: FileLockHandle | null = null;
    let holderHasAcquired = false;
    let injected = false;
    const holder = acquireFileLock(lockPath, {
      ...FAST,
      fs: hookedFs((method, phase) => {
        // Only the heartbeat's refresh (after acquire has returned) is paused
        // here, not the timestamp probe the library makes while acquiring.
        if (method === 'utimesSync' && phase === 'before' && holderHasAcquired && !injected) {
          injected = true;
          const old = new Date(Date.now() - 60_000);
          utimesSync(`${lockPath}.lock`, old, old);
          stealer = acquireFileLock(lockPath, {
            ...FAST,
            onCompromised: (k) => { compromised.stealer.push(k); signalStealer(k); },
          });
          letClockAdvance();
        }
      }),
      onCompromised: (k) => compromised.holder.push(k),
    });
    holderHasAcquired = true;
    if (holder) held.push(holder);
    expect(holder).not.toBeNull();

    expect(await stealerCompromised).toBe('taken-over');
    if (stealer) held.push(stealer);
    expect(compromised.holder).toEqual([]);
    expect(compromised.stealer).toEqual(['taken-over']);
  });

  // a releaser removes its own PID file before it removes the lock
  // directory, so a successor that acquires the instant the directory goes
  // keeps its PID file.
  it('leaves a successor\'s PID file in place when it acquires the moment the lock is released', () => {
    let successor: FileLockHandle | null = null;
    const releaser = acquireFileLock(lockPath, {
      fs: hookedFs((method, phase) => {
        if (method === 'rmdirSync' && phase === 'after' && successor === null) {
          successor = acquireFileLock(lockPath);
        }
      }),
    });
    expect(releaser).not.toBeNull();

    releaseFileLock(releaser!);

    expect(successor).not.toBeNull();
    held.push(successor!);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf-8').trim()).toBe(String(process.pid));
  });

  // a holder stopped by a takeover releases on its way out; the
  // release leaves the successor's lock directory and PID file in place.
  it('leaves the successor\'s lock in place when a taken-over holder releases', async () => {
    let signal!: () => void;
    const takenOver = new Promise<void>((resolve) => { signal = resolve; });
    const handle = acquireFileLock(lockPath, { ...FAST, onCompromised: () => signal() });
    expect(handle).not.toBeNull();

    rmSync(`${lockPath}.lock`, { recursive: true });
    mkdirSync(`${lockPath}.lock`);
    const later = new Date(Date.now() + 5000);
    utimesSync(`${lockPath}.lock`, later, later);
    writeFileSync(lockPath, '424242');
    await takenOver;

    releaseFileLock(handle!);

    expect(existsSync(`${lockPath}.lock`)).toBe(true);
    expect(readFileSync(lockPath, 'utf-8')).toBe('424242');
  });

  // a lock directory removed while held (a cleaned temp dir) is
  // reported as "vanished" and never thrown from the heartbeat timer.
  it('reports a vanished lock directory instead of throwing', async () => {
    const kinds: CompromiseKind[] = [];
    let signal!: (k: CompromiseKind) => void;
    const reported = new Promise<CompromiseKind>((resolve) => { signal = resolve; });
    const handle = acquireFileLock(lockPath, {
      ...FAST,
      onCompromised: (k) => { kinds.push(k); signal(k); },
    });
    held.push(handle!);

    rmSync(`${lockPath}.lock`, { recursive: true, force: true });

    expect(await reported).toBe('vanished');
    expect(kinds).toEqual(['vanished']);
  });

  // only the per-user lock handles a lost lock. A lock taken without a
  // handler keeps the library's behaviour: its holder stops after a takeover.
  it('stops a holder that gave no handler when its lock is taken over', () => {
    const fileLockUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'file-lock.js')).href;
    const lockDir = `${lockPath}.lock`;
    const script = `
      import fs from 'fs';
      import { acquireFileLock } from ${JSON.stringify(fileLockUrl)};
      acquireFileLock(${JSON.stringify(lockPath)}, { stale: 2000, update: 1000 });
      fs.rmdirSync(${JSON.stringify(lockDir)});
      fs.mkdirSync(${JSON.stringify(lockDir)});
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(${JSON.stringify(lockDir)}, later, later);
      setInterval(() => {}, 1000);
    `;
    // timeout: a hang guard far above the 1 s heartbeat that stops the holder.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8', timeout: 120_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ECOMPROMISED');
  });
});
