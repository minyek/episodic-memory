import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
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
}));

vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: async () => {},
  generateExchangeEmbedding: async (user: string) => {
    if (embedState.hangOn && user.includes(embedState.hangOn)) {
      embedState.reachedHang?.();
      return new Promise<number[]>(() => {});
    }
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
// indexed: a file is brought into the archive only after its exchanges are
// indexed, so the next sync does the rest.
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
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
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

  it('reports every file as copied and indexed on an uninterrupted run', async () => {
    const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(result.copied).toBe(3);
    expect(result.indexed).toBe(3);
  });
});
