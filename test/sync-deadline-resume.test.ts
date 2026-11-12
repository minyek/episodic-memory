import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs, { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, appendFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

// The embedder is a process boundary here: the first run's embedder never
// answers for the second file, standing in for a sync that was hard-exited by
// its deadline in the middle of indexing.
const embedState = vi.hoisted(() => ({
  hangOn: null as string | null,
  reachedHang: null as null | (() => void),
  embedded: [] as string[],
  onEmbed: null as null | ((user: string) => void),
}));

vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: async () => {},
  generateExchangeEmbedding: async (user: string) => {
    if (embedState.hangOn && user.includes(embedState.hangOn)) {
      embedState.reachedHang?.();
      return new Promise<number[]>(() => {});
    }
    embedState.onEmbed?.(user);
    embedState.embedded.push(user);
    return new Array(384).fill(0.01);
  },
  generateEmbedding: async () => new Array(384).fill(0.01),
}));

import { syncConversations } from '../src/sync.js';

function exchangeLines(sessionId: string, marker: string): string {
  const user = JSON.stringify({
    parentUuid: null, isSidechain: false, userType: 'external', cwd: '/test/project',
    sessionId, version: '2.0.9', gitBranch: 'main', type: 'user',
    message: { role: 'user', content: `question ${marker}` },
    uuid: `user-${sessionId}`, timestamp: new Date(2026, 0, 2).toISOString(),
  });
  const assistant = JSON.stringify({
    parentUuid: `user-${sessionId}`, isSidechain: false, userType: 'external', cwd: '/test/project',
    sessionId, version: '2.0.9', gitBranch: 'main', type: 'assistant',
    message: { model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: `answer ${marker}` }] },
    uuid: `asst-${sessionId}`, timestamp: new Date(2026, 0, 2).toISOString(),
  });
  return user + '\n' + assistant + '\n';
}

// Behaviour (spec AC 6, invariant 3): a sync that stops part-way through
// indexing leaves no conversation that later syncs skip without having
// indexed: a file's archive copy is stamped current only after its index
// attempt, so the next sync does the rest.
describe('sync resumes after an interrupted index run', () => {
  let testDir: string;
  let sourceDir: string;
  let destDir: string;
  let dbPath: string;
  let restoreConsole: () => void;

  const files = [
    { id: '11111111-1111-4111-8111-111111111111', marker: 'alpha-one' },
    { id: '22222222-2222-4222-8222-222222222222', marker: 'bravo-two' },
    { id: '33333333-3333-4333-8333-333333333333', marker: 'charlie-three' },
  ];

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-sync-resume-'));
    sourceDir = join(testDir, 'projects');
    destDir = join(testDir, 'archive');
    dbPath = join(testDir, 'test.db');
    mkdirSync(join(sourceDir, 'proj'), { recursive: true });
    for (const f of files) writeFileSync(join(sourceDir, 'proj', `${f.id}.jsonl`), exchangeLines(f.id, f.marker));
    process.env.TEST_DB_PATH = dbPath;
    embedState.hangOn = null;
    embedState.reachedHang = null;
    embedState.embedded = [];
    embedState.onEmbed = null;
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreConsole();
    delete process.env.TEST_DB_PATH;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('indexes every exchange of every file once, and archives all three, after a run abandoned mid-index', async () => {
    embedState.hangOn = 'bravo-two';
    const reached = new Promise<void>((resolve) => { embedState.reachedHang = resolve; });
    // The abandoned run never settles; it stands in for the hard-exited process.
    void syncConversations(sourceDir, destDir, { skipSummaries: true });
    await reached;

    embedState.hangOn = null;
    embedState.reachedHang = null;
    await syncConversations(sourceDir, destDir, { skipSummaries: true });

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT archive_path, COUNT(*) AS n FROM exchanges GROUP BY archive_path').all() as Array<{ archive_path: string; n: number }>;
    db.close();
    expect(rows.map(r => r.n)).toEqual([1, 1, 1]);
    for (const f of files) {
      expect(existsSync(join(destDir, 'proj', `${f.id}.jsonl`))).toBe(true);
    }
  });

  // Standing safety invariant: the walk archives every new conversation before
  // indexing starts, so one that only its source held survives an interrupted
  // run and the later removal of that source.
  it('keeps in the archive a conversation whose source is removed after a run abandoned mid-index', async () => {
    embedState.hangOn = 'bravo-two';
    const reached = new Promise<void>((resolve) => { embedState.reachedHang = resolve; });
    void syncConversations(sourceDir, destDir, { skipSummaries: true });
    await reached;

    rmSync(join(sourceDir, 'proj', `${files[2].id}.jsonl`));
    embedState.hangOn = null;
    embedState.reachedHang = null;
    await syncConversations(sourceDir, destDir, { skipSummaries: true });

    expect(existsSync(join(destDir, 'proj', `${files[2].id}.jsonl`))).toBe(true);
  });

  it('reports every file as copied and indexed on an uninterrupted run', async () => {
    const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(result.copied).toBe(3);
    expect(result.indexed).toBe(3);
  });

  // D8: the archive copy takes the source mtime the walk saw, so exchanges
  // appended while a file is being indexed are indexed by the next sync.
  it('indexes, on the next sync, exchanges appended to a source while it was being indexed', async () => {
    const grown = join(sourceDir, 'proj', `${files[0].id}.jsonl`);
    embedState.onEmbed = (user) => {
      if (!user.includes('alpha-one')) return;
      appendFileSync(grown, exchangeLines(`${files[0].id}-late`, 'alpha-late'));
      const later = new Date(Date.now() + 5000);
      utimesSync(grown, later, later);
    };
    await syncConversations(sourceDir, destDir, { skipSummaries: true });
    embedState.onEmbed = null;
    await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(embedState.embedded.some(u => u.includes('alpha-late'))).toBe(true);
  });

  // Inv 3: the index loop reads the walk copy, so a source that disappears
  // after the walk and before its file's turn is still indexed in that sync.
  it('indexes a file whose source is removed after the walk and before its turn', async () => {
    embedState.onEmbed = (user) => {
      if (!user.includes('alpha-one')) return;
      for (const f of files.slice(1)) rmSync(join(sourceDir, 'proj', `${f.id}.jsonl`));
    };
    await syncConversations(sourceDir, destDir, { skipSummaries: true });

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT archive_path, COUNT(*) AS n FROM exchanges GROUP BY archive_path').all() as Array<{ n: number }>;
    db.close();
    expect(rows.map(r => r.n)).toEqual([1, 1, 1]);
  });
  // Stands in for a filesystem that stores file times its own way: each
  // mtime sync sets is stored as storedAs(requested), in seconds.
  function storeFileTimesAs(storedAs: (seconds: number) => number): void {
    const realUtimes = fs.utimesSync;
    vi.spyOn(fs, 'utimesSync').mockImplementation(((p: fs.PathLike, atime: fs.TimeLike, mtime: fs.TimeLike) =>
      realUtimes(p, atime, storedAs(Number(mtime)))) as typeof fs.utimesSync);
  }

  // Inv 3 (D8) on a filesystem that rounds times up to 2 s: the walk copy is
  // still stamped below its source, so the next sync indexes what an
  // abandoned run did not.
  it('resumes an abandoned run on a filesystem that rounds file times up to 2 s', async () => {
    storeFileTimesAs(s => Math.ceil(s / 2) * 2);
    embedState.hangOn = 'bravo-two';
    const reached = new Promise<void>((resolve) => { embedState.reachedHang = resolve; });
    void syncConversations(sourceDir, destDir, { skipSummaries: true });
    await reached;

    embedState.hangOn = null;
    embedState.reachedHang = null;
    await syncConversations(sourceDir, destDir, { skipSummaries: true });

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT archive_path, COUNT(*) AS n FROM exchanges GROUP BY archive_path').all() as Array<{ n: number }>;
    db.close();
    expect(rows.map(r => r.n)).toEqual([1, 1, 1]);
  });

  // D8: when no pending stamp reads back below the source, the copy is
  // reported, because a stop before its index would leave it unindexed.
  it('reports each copy whose pending stamp the filesystem cannot keep below its source', async () => {
    storeFileTimesAs(() => 4_102_444_800); // 2100-01-01: no stamp reads back below the source
    const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });

    expect(result.indexed).toBe(3);
    expect(result.errors.map(e => e.file).sort()).toEqual(files.map(f => join(sourceDir, 'proj', `${f.id}.jsonl`)).sort());
  });
});
