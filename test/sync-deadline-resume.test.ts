import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs, { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, appendFileSync, utimesSync, readdirSync } from 'fs';
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
  initFails: false,
}));

vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: async () => { if (embedState.initFails) throw new Error('libvips missing'); },
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

// Behaviour: a sync that stops part-way through indexing leaves no
// conversation that later syncs skip without having indexed. Each copy stays
// recorded in pending_index until its index attempt ends; on a filesystem that
// rounds times up a copy can look current before it is indexed, and the next
// sync still indexes it.
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
    embedState.initFails = false;
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
  it('clears the pending record of a copy it does not index', async () => {
    appendFileSync(join(sourceDir, 'proj', `${files[0].id}.jsonl`),
      '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>\n');
    await syncConversations(sourceDir, destDir, { skipSummaries: true });

    const db = new Database(dbPath, { readonly: true });
    const pending = db.prepare('SELECT COUNT(*) AS n FROM pending_index').get() as { n: number };
    db.close();
    expect(pending.n).toBe(0);
  });

  it('reports nothing when a source with a pending record has grown since the interrupted run', async () => {
    embedState.hangOn = 'bravo-two';
    const reached = new Promise<void>((resolve) => { embedState.reachedHang = resolve; });
    void syncConversations(sourceDir, destDir, { skipSummaries: true });
    await reached;

    const grown = join(sourceDir, 'proj', `${files[2].id}.jsonl`);
    appendFileSync(grown, exchangeLines(`${files[2].id}-late`, 'charlie-late'));
    const later = new Date(Date.now() + 5000);
    utimesSync(grown, later, later);
    embedState.hangOn = null;
    embedState.reachedHang = null;
    const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });

    expect(result.errors).toEqual([]);
    expect(embedState.embedded.some(u => u.includes('charlie-late'))).toBe(true);
  });

  // Stands in for a filesystem that stores file times its own way: each
  // mtime sync sets is stored as storedAs(requested), in seconds.
  function storeFileTimesAs(storedAs: (seconds: number) => number): void {
    const realUtimes = fs.utimesSync;
    vi.spyOn(fs, 'utimesSync').mockImplementation(((p: fs.PathLike, atime: fs.TimeLike, mtime: fs.TimeLike) =>
      realUtimes(p, atime, storedAs(Number(mtime)))) as typeof fs.utimesSync);
  }

  // On a filesystem that rounds times up to 2 s a copy can look current before
  // it is indexed; it stays recorded in pending_index, so the next sync still
  // indexes what an abandoned run did not.
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

  // Standing safety and Inv 3: an archive filesystem that refuses to set file
  // times still gets every conversation archived, a deadline exit on it is
  // resumed, and no temp copy is left behind.
  it('resumes an abandoned run on an archive filesystem that refuses to set file times', async () => {
    const real = fs.utimesSync;
    vi.spyOn(fs, 'utimesSync').mockImplementation(((p: fs.PathLike, a: fs.TimeLike, m: fs.TimeLike) => {
      if (String(p).startsWith(destDir)) throw Object.assign(new Error('EPERM: operation not permitted, utime'), { code: 'EPERM' });
      return real(p, a, m);
    }) as typeof fs.utimesSync);
    embedState.hangOn = 'bravo-two';
    const reached = new Promise<void>((resolve) => { embedState.reachedHang = resolve; });
    void syncConversations(sourceDir, destDir, { skipSummaries: true });
    await reached;

    embedState.hangOn = null;
    embedState.reachedHang = null;
    const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT archive_path, COUNT(*) AS n FROM exchanges GROUP BY archive_path').all() as Array<{ n: number }>;
    db.close();
    expect(rows.map(r => r.n)).toEqual([1, 1, 1]);
    expect(readdirSync(join(destDir, 'proj')).filter(name => name.includes('.tmp.'))).toEqual([]);
    expect(result.indexed).toBeGreaterThan(0);
  });

  it('archives and indexes every conversation, and reports each copy, when the archive filesystem refuses to set file times', async () => {
    vi.spyOn(fs, 'utimesSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p).startsWith(destDir)) throw Object.assign(new Error('EPERM: operation not permitted, utime'), { code: 'EPERM' });
    }) as typeof fs.utimesSync);
    const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });

    expect(result.indexed).toBe(3);
    for (const f of files) expect(existsSync(join(destDir, 'proj', `${f.id}.jsonl`))).toBe(true);
    expect(readdirSync(join(destDir, 'proj')).filter(name => name.includes('.tmp.'))).toEqual([]);
    expect(new Set(result.errors.map(e => e.file))).toEqual(new Set(files.map(f => join(sourceDir, 'proj', `${f.id}.jsonl`))));
  });

  // Copies made while the embedding backend was unavailable stay recorded as
  // not indexed, so the next sync indexes them.
  it('indexes on the next sync the copies made while the embedding backend was unavailable', async () => {
    embedState.initFails = true;
    await syncConversations(sourceDir, destDir, { skipSummaries: true });
    embedState.initFails = false;
    await syncConversations(sourceDir, destDir, { skipSummaries: true });

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT archive_path, COUNT(*) AS n FROM exchanges GROUP BY archive_path').all() as Array<{ n: number }>;
    db.close();
    expect(rows.map(r => r.n)).toEqual([1, 1, 1]);
  });

  it('archives every conversation and resolves when the index database cannot be opened', async () => {
    process.env.TEST_DB_PATH = testDir; // a directory: opening it fails
    const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });

    for (const f of files) expect(existsSync(join(destDir, 'proj', `${f.id}.jsonl`))).toBe(true);
    expect(result.errors.some(e => e.file === '(index database)')).toBe(true);
  });

  // A finished index attempt clears the file's pending record; a record that
  // stayed would make every later sync read the file again.
  it('leaves no pending record after an uninterrupted run, so a second run reads nothing again', async () => {
    await syncConversations(sourceDir, destDir, { skipSummaries: true });
    const embeddedAfterFirst = embedState.embedded.length;
    await syncConversations(sourceDir, destDir, { skipSummaries: true });

    const db = new Database(dbPath, { readonly: true });
    const pending = db.prepare('SELECT COUNT(*) AS n FROM pending_index').get() as { n: number };
    db.close();
    expect(pending.n).toBe(0);
    expect(embedState.embedded.length).toBe(embeddedAfterFirst);
  });

  // A row whose delete is refused stays and is reported; the next sync reads
  // the copy again from the high-water mark, embeds nothing twice and clears it.
  it('keeps and reports a pending record whose delete is refused, then clears it on the next run', async () => {
    let blocked = false;
    embedState.onEmbed = () => {
      if (blocked) return;
      blocked = true;
      const other = new Database(dbPath);
      other.exec("CREATE TRIGGER block_pending_delete BEFORE DELETE ON pending_index BEGIN SELECT RAISE(ABORT, 'delete refused'); END");
      other.close();
    };
    const first = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(first.errors.some(e => e.error.includes('delete refused'))).toBe(true);

    const unblock = new Database(dbPath);
    unblock.exec('DROP TRIGGER block_pending_delete');
    const stuck = (unblock.prepare('SELECT COUNT(*) AS n FROM pending_index').get() as { n: number }).n;
    unblock.close();
    expect(stuck).toBeGreaterThan(0);

    embedState.onEmbed = null;
    const embeddedAfterFirst = embedState.embedded.length;
    await syncConversations(sourceDir, destDir, { skipSummaries: true });

    const db = new Database(dbPath, { readonly: true });
    const pending = (db.prepare('SELECT COUNT(*) AS n FROM pending_index').get() as { n: number }).n;
    const rows = db.prepare('SELECT archive_path, COUNT(*) AS n FROM exchanges GROUP BY archive_path').all() as Array<{ n: number }>;
    db.close();
    expect(pending).toBe(0);
    expect(rows.map(r => r.n)).toEqual([1, 1, 1]);
    expect(embedState.embedded.length).toBe(embeddedAfterFirst);
  });

  // U3: a copy the walk cannot record is still archived, and the report names
  // the command that indexes it later.
  it('archives a copy whose pending record is refused and reports the command that indexes it', async () => {
    const prepare = new Database(dbPath);
    prepare.exec('CREATE TABLE IF NOT EXISTS pending_index (archive_path TEXT PRIMARY KEY)');
    prepare.exec("CREATE TRIGGER block_pending_insert BEFORE INSERT ON pending_index BEGIN SELECT RAISE(ABORT, 'insert refused'); END");
    prepare.close();

    const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });

    for (const f of files) expect(existsSync(join(destDir, 'proj', `${f.id}.jsonl`))).toBe(true);
    const refused = result.errors.filter(e => e.error.includes('insert refused'));
    expect(refused).toHaveLength(3);
    expect(refused.every(e => e.error.includes('episodic-memory index --cleanup'))).toBe(true);
  });
});
