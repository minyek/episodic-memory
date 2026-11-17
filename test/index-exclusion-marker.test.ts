import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';

vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: vi.fn(async () => {}),
  generateExchangeEmbedding: vi.fn(async () => new Array(384).fill(0.01)),
  generateEmbedding: vi.fn(async () => new Array(384).fill(0.01)),
}));

const summarizer = vi.hoisted(() => ({ fails: false }));
vi.mock('../src/summarizer.js', () => ({
  summarizeConversation: vi.fn(async () => {
    if (summarizer.fails) throw new Error('summariser down');
    return 'Mock summary';
  }),
}));

import { indexConversations, indexSession, indexUnprocessed } from '../src/indexer.js';
import { verifyIndex, repairIndex } from '../src/verify.js';

const MARKER = '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>';
const PLAIN_ID = '11111111-1111-4111-8111-111111111111';
const MARKED_ID = '22222222-2222-4222-8222-222222222222';

function exchangeLines(sessionId: string, text: string): string {
  const user = JSON.stringify({
    parentUuid: null, isSidechain: false, userType: 'external', cwd: '/test/project',
    sessionId, version: '2.0.9', gitBranch: 'main', type: 'user',
    message: { role: 'user', content: text },
    uuid: `user-${sessionId}`, timestamp: new Date(2026, 0, 2).toISOString(),
  });
  const assistant = JSON.stringify({
    parentUuid: `user-${sessionId}`, isSidechain: false, userType: 'external', cwd: '/test/project',
    sessionId, version: '2.0.9', gitBranch: 'main', type: 'assistant',
    message: { model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    uuid: `asst-${sessionId}`, timestamp: new Date(2026, 0, 2).toISOString(),
  });
  return user + '\n' + assistant + '\n';
}

describe('index commands honour the DO NOT INDEX marker and keep archive copies whole', () => {
  let testDir: string;
  let sourceDir: string;
  let archiveDir: string;
  let dbPath: string;
  let restoreConsole: () => void;

  const plainSource = () => join(sourceDir, 'proj', `${PLAIN_ID}.jsonl`);
  const markedSource = () => join(sourceDir, 'proj', `${MARKED_ID}.jsonl`);
  const plainArchive = () => join(archiveDir, 'proj', `${PLAIN_ID}.jsonl`);
  const markedArchive = () => join(archiveDir, 'proj', `${MARKED_ID}.jsonl`);

  function indexedArchivePaths(): string[] {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT DISTINCT archive_path FROM exchanges').all() as Array<{ archive_path: string }>;
    db.close();
    return rows.map(r => r.archive_path).sort();
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-index-marker-'));
    sourceDir = join(testDir, 'projects');
    archiveDir = join(testDir, 'archive');
    dbPath = join(testDir, 'test.db');
    mkdirSync(join(sourceDir, 'proj'), { recursive: true });
    mkdirSync(join(archiveDir, 'proj'), { recursive: true });
    writeFileSync(plainSource(), exchangeLines(PLAIN_ID, 'plain question'));
    writeFileSync(markedSource(), exchangeLines(MARKED_ID, `marked question ${MARKER}`));
    process.env.TEST_PROJECTS_DIR = sourceDir;
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.TEST_DB_PATH = dbPath;
    summarizer.fails = false;
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreConsole();
    delete process.env.TEST_PROJECTS_DIR;
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.TEST_DB_PATH;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('index --cleanup indexes the plain conversation and not the marked one', async () => {
    await indexUnprocessed(1, true);
    expect(indexedArchivePaths()).toEqual([plainArchive()]);
  });

  it('index-all and rebuild index the plain conversation and not the marked one', async () => {
    await indexConversations(undefined, undefined, 1, true);
    expect(indexedArchivePaths()).toEqual([plainArchive()]);
  });

  it('index-session does not index a marked conversation', async () => {
    await indexSession(MARKED_ID, 1, true);
    expect(indexedArchivePaths()).toEqual([]);
  });

  it('index --repair does not index a marked archive copy', async () => {
    writeFileSync(markedArchive(), readFileSync(markedSource()));
    writeFileSync(plainArchive(), readFileSync(plainSource()));
    await repairIndex(await verifyIndex());
    expect(indexedArchivePaths()).toEqual([plainArchive()]);
  });

  it('index --repair indexes a conversation whose summary fails', async () => {
    writeFileSync(plainArchive(), readFileSync(plainSource()));
    summarizer.fails = true;
    await repairIndex(await verifyIndex());
    expect(indexedArchivePaths()).toEqual([plainArchive()]);
  });

  it('index --cleanup refreshing a grown archive copy leaves the whole new copy and no temp file', async () => {
    await indexUnprocessed(1, true);
    fs.appendFileSync(plainSource(), exchangeLines('33333333-3333-4333-8333-333333333333', 'later question'));
    await indexUnprocessed(1, true);
    expect(readFileSync(plainArchive(), 'utf-8')).toBe(readFileSync(plainSource(), 'utf-8'));
    expect(readdirSync(join(archiveDir, 'proj')).filter(f => f.includes('.tmp.'))).toEqual([]);
  });

  it('index --cleanup leaves the existing archive copy intact and no temp file when the copy fails part-way', async () => {
    await indexUnprocessed(1, true);
    const before = readFileSync(plainArchive(), 'utf-8');
    fs.appendFileSync(plainSource(), exchangeLines('33333333-3333-4333-8333-333333333333', 'later question'));
    const realCopy = fs.copyFileSync;
    vi.spyOn(fs, 'copyFileSync').mockImplementation(((src: fs.PathLike, dest: fs.PathLike) => {
      realCopy(src, dest);
      fs.truncateSync(dest, 10); // a copy cut short, then the process dies
      throw new Error('simulated crash mid-copy');
    }) as typeof fs.copyFileSync);
    await indexUnprocessed(1, true);
    vi.restoreAllMocks();
    expect(readFileSync(plainArchive(), 'utf-8')).toBe(before);
    expect(readdirSync(join(archiveDir, 'proj')).filter(f => f.includes('.tmp.'))).toEqual([]);
  });
});
