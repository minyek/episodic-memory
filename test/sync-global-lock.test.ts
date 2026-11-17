import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, chmodSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { acquireFileLock, releaseFileLock, type FileLockHandle } from '../src/file-lock.js';
import { resolveUserSyncLockPath, BACKGROUND_CHILD_ENV } from '../src/sync-limits.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SYNC_CLI = join(REPO_ROOT, 'dist', 'sync-cli.js');

// Behaviour: a background sync child takes a per-user lock
// that does not depend on HOME, the config dir or TMPDIR, so syncs started
// under scratch homes cannot run in parallel; a foreground sync never takes
// it; a lock that cannot be used never stops a sync.
describe('sync-cli per-user lock', () => {
  let root: string;
  let runtimeDir: string;
  let held: FileLockHandle | null = null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'episodic-memory-user-lock-e2e-'));
    runtimeDir = join(root, 'runtime');
    mkdirSync(runtimeDir);
  });

  afterEach(() => {
    if (held) { try { releaseFileLock(held); } catch {} held = null; }
    try { chmodSync(join(root, 'ro-tmp'), 0o700); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  // A sync that runs opens its index database; a child that skips never does.
  const ranSync = (name: string) => existsSync(join(root, name, 'test.db'));

  function runSync(name: string, extraEnv: Record<string, string | undefined>) {
    const home = join(root, name, 'home');
    const config = join(root, name, 'config');
    const projects = join(root, name, 'projects');
    const ownTmp = join(root, name, 'tmp');
    for (const d of [home, config, projects, ownTmp]) mkdirSync(d, { recursive: true });
    return spawnSync(process.execPath, [SYNC_CLI], {
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: ownTmp,
        TEST_PROJECTS_DIR: projects,
        TEST_DB_PATH: join(root, name, 'test.db'),
        EPISODIC_MEMORY_CONFIG_DIR: config,
        EPISODIC_MEMORY_SKIP_SUMMARIES: '1',
        EPISODIC_MEMORY_SUMMARIZER_GUARD: undefined as any,
        EPISODIC_MEMORY_DISABLE_AUTO_SYNC: undefined as any,
        [BACKGROUND_CHILD_ENV]: undefined as any,
        ...extraEnv,
      },
      encoding: 'utf-8',
      timeout: 60_000,
    });
  }

  it('skips a background child while another sync holds the per-user lock, naming the holder', () => {
    const lockPath = resolveUserSyncLockPath({ XDG_RUNTIME_DIR: runtimeDir }, process.getuid!());
    held = acquireFileLock(lockPath);
    expect(held).not.toBeNull();

    const result = runSync('child', { XDG_RUNTIME_DIR: runtimeDir, [BACKGROUND_CHILD_ENV]: '1' });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`pid ${process.pid}`);
    expect(ranSync('child')).toBe(false);
  });

  it('lets a foreground sync run while the per-user lock is held', () => {
    const lockPath = resolveUserSyncLockPath({ XDG_RUNTIME_DIR: runtimeDir }, process.getuid!());
    held = acquireFileLock(lockPath);
    expect(held).not.toBeNull();

    const result = runSync('foreground', { XDG_RUNTIME_DIR: runtimeDir });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain(`pid ${process.pid}`);
    expect(ranSync('foreground')).toBe(true);
  });

  it('runs a background child when the per-user lock is free', () => {
    const result = runSync('free', { XDG_RUNTIME_DIR: runtimeDir, [BACKGROUND_CHILD_ENV]: '1' });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/another|already running/);
    expect(ranSync('free')).toBe(true);
  });

  // The lock directory is unusable (read-only temp dir, no runtime dir): the
  // sync warns and still runs under its per-config-dir lock.
  it('warns and still syncs when the per-user lock cannot be created', () => {
    const readOnly = join(root, 'ro-tmp');
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);

    const result = runSync('unusable', {
      XDG_RUNTIME_DIR: undefined,
      TMPDIR: readOnly,
      [BACKGROUND_CHILD_ENV]: '1',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('per-user sync lock unavailable');
    expect(ranSync('unusable')).toBe(true);
  });
});
