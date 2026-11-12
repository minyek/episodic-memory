import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { suppressConsole } from './test-utils.js';

// The embedder and summarizer are process boundaries here. The first embed
// removes the source, so the later archive copy fails.
const state = vi.hoisted(() => ({ sourcePath: '' as string, removed: false }));

vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: async () => {},
  generateExchangeEmbedding: async () => {
    if (!state.removed) {
      state.removed = true;
      const { rmSync: remove } = await import('fs');
      remove(state.sourcePath);
    }
    return new Array(384).fill(0.01);
  },
  generateEmbedding: async () => new Array(384).fill(0.01),
}));

const summarizeConversation = vi.hoisted(() => vi.fn(async () => 'summary'));
vi.mock('../src/summarizer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/summarizer.js')>()),
  summarizeConversation,
}));

import { syncConversations } from '../src/sync.js';

// Behaviour: a file whose archive copy failed is reported once and is not
// summarized from a missing archive file.
describe('sync when the archive copy fails', () => {
  let testDir: string;
  let restoreConsole: () => void;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-sync-archive-failure-'));
    process.env.TEST_DB_PATH = join(testDir, 'test.db');
    state.removed = false;
    summarizeConversation.mockClear();
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    delete process.env.TEST_DB_PATH;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('reports the copy failure once and does not queue a summary for the missing file', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const sourceDir = join(testDir, 'projects');
    const destDir = join(testDir, 'archive');
    mkdirSync(join(sourceDir, 'proj'), { recursive: true });
    state.sourcePath = join(sourceDir, 'proj', `${id}.jsonl`);
    const base = { parentUuid: null, isSidechain: false, userType: 'external', cwd: '/p', sessionId: id, version: '2.0.9', gitBranch: 'main', timestamp: new Date(2026, 0, 2).toISOString() };
    writeFileSync(state.sourcePath,
      JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: 'q' }, uuid: 'u1' }) + '\n' +
      JSON.stringify({ ...base, parentUuid: 'u1', type: 'assistant', message: { model: 'm', role: 'assistant', content: [{ type: 'text', text: 'a' }] }, uuid: 'a1' }) + '\n');

    const result = await syncConversations(sourceDir, destDir, {});

    expect(result.errors.filter(e => e.error.includes('copyfile'))).toHaveLength(1);
    expect(summarizeConversation).not.toHaveBeenCalled();
    expect(existsSync(join(destDir, 'proj', `${id}-summary.txt`))).toBe(false);
  });
});
