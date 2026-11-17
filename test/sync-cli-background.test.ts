import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { BACKGROUND_CHILD_ENV, resolveUserSyncLockPath } from '../src/sync-limits.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SYNC_CLI = join(REPO_ROOT, 'dist', 'sync-cli.js');
const SHIM = join(REPO_ROOT, 'test', 'fixtures', 'sync-cli-shim.cjs');

// Behaviour: the detached child of a background
// sync stops at its deadline with exit code 124 and leaves no lock behind, and
// lowers its priority before it starts syncing; a foreground sync does neither.
describe('sync-cli background child limits', () => {
  let root: string;
  let events: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'episodic-memory-bg-child-'));
    events = join(root, 'events.log');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(opts: { child: boolean; deadlineMs?: string; holdMs: number }) {
    const dirs = {
      home: join(root, 'home'), config: join(root, 'config'), projects: join(root, 'projects'),
      runtime: join(root, 'runtime'), tmp: join(root, 'tmp'),
    };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    const result = spawnSync(process.execPath, [SYNC_CLI], {
      env: {
        ...process.env,
        HOME: dirs.home,
        TMPDIR: dirs.tmp,
        XDG_RUNTIME_DIR: dirs.runtime,
        TEST_PROJECTS_DIR: dirs.projects,
        TEST_DB_PATH: join(root, 'test.db'),
        EPISODIC_MEMORY_CONFIG_DIR: dirs.config,
        EPISODIC_MEMORY_SKIP_SUMMARIES: '1',
        EPISODIC_MEMORY_SUMMARIZER_GUARD: undefined as any,
        EPISODIC_MEMORY_DISABLE_AUTO_SYNC: undefined as any,
        [BACKGROUND_CHILD_ENV]: opts.child ? '1' : undefined as any,
        ...(opts.deadlineMs !== undefined && { EPISODIC_MEMORY_SYNC_TIMEOUT_MS: opts.deadlineMs }),
        NODE_OPTIONS: `--require ${SHIM}`,
        SHIM_EVENTS: events,
        SHIM_HOLD_MS: String(opts.holdMs),
      },
      encoding: 'utf-8',
      timeout: 120_000,
    });
    return { result, dirs };
  }

  function lockDirsLeft(dirs: { runtime: string; config: string }): string[] {
    const found: string[] = [];
    const userLock = `${resolveUserSyncLockPath({ XDG_RUNTIME_DIR: dirs.runtime }, process.getuid!())}.lock`;
    if (existsSync(userLock)) found.push(userLock);
    const configLock = join(dirs.config, 'logs', 'episodic-memory-sync.lock.lock');
    if (existsSync(configLock)) found.push(configLock);
    return found;
  }

  it('exits 124 at the deadline, names it, and releases both locks', () => {
    // The shim keeps the process alive for a minute, far past the 300 ms
    // deadline, so only the deadline can end it.
    const { result, dirs } = run({ child: true, deadlineMs: '300', holdMs: 60_000 });

    expect(result.status).toBe(124);
    expect(result.stderr).toMatch(/deadline of 300 ms reached/);
    expect(lockDirsLeft(dirs)).toEqual([]);
  });

  it('lowers its priority before it starts syncing', () => {
    const { result } = run({ child: true, deadlineMs: '0', holdMs: 0 });

    expect(result.status).toBe(0);
    const log = readFileSync(events, 'utf-8').split('\n');
    const priority = log.indexOf('setPriority:0:10');
    // The first line the sync prints marks its start.
    const syncStart = log.findIndex(line => line.startsWith('log:'));
    expect(priority).toBeGreaterThanOrEqual(0);
    expect(syncStart).toBeGreaterThan(priority);
  });

  it('arms no deadline and keeps its priority when run in the foreground', () => {
    // A 300 ms deadline would cut this run short, so reaching exit 0 after the
    // shim's hold shows no deadline was armed.
    const { result } = run({ child: false, deadlineMs: '300', holdMs: 1500 });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/deadline/);
    const log = existsSync(events) ? readFileSync(events, 'utf-8') : '';
    expect(log).not.toMatch(/setPriority/);
  });

  it('warns about an invalid deadline value and still exits when the sync finishes', () => {
    const { result } = run({ child: true, deadlineMs: 'abc', holdMs: 0 });

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/invalid EPISODIC_MEMORY_SYNC_TIMEOUT_MS/);
  });
});

// Behaviour: a sync that finishes before its deadline exits at
// once with its own code; a timer that kept the event loop alive would hold
// both locks until it fired, then exit 124.
describe('startSyncDeadline', () => {
  it('lets a process with nothing left to do exit before the deadline fires', () => {
    const syncLimits = pathToFileURL(join(REPO_ROOT, 'dist', 'sync-limits.js')).href;
    const script = `
      import { startSyncDeadline } from ${JSON.stringify(syncLimits)};
      startSyncDeadline(1000, () => process.exit(124));
    `;
    // timeout: a hang guard far above the 1 s deadline.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8', timeout: 120_000 });
    expect(result.status).toBe(0);
  });
});
