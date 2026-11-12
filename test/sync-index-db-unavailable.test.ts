import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// The native sqlite binding is a process boundary: when its module cannot
// load, the walk must still archive every conversation.
const embedding = vi.hoisted(() => ({ loaded: false }));
vi.mock('../src/db.js', () => { throw new Error('better-sqlite3 native binding failed to load'); });
vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: async () => { embedding.loaded = true; },
  generateExchangeEmbedding: async () => new Array(384).fill(0.01),
  generateEmbedding: async () => new Array(384).fill(0.01),
}));

import { syncConversations } from '../src/sync.js';

// Behaviour (standing safety): a broken index database module costs the run's
// indexing, never an archived conversation.
it('archives every conversation and resolves when the index database module cannot load', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'em-sync-no-db-'));
  try {
    const src = join(dir, 'projects');
    const dest = join(dir, 'archive');
    mkdirSync(join(src, 'proj'), { recursive: true });
    const id = '44444444-4444-4444-8444-444444444444';
    const base = { parentUuid: null, isSidechain: false, userType: 'external', cwd: '/p', sessionId: id, version: '2.0.9', gitBranch: 'main', timestamp: new Date(2026, 0, 2).toISOString() };
    writeFileSync(join(src, 'proj', `${id}.jsonl`),
      JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: 'q' }, uuid: 'u1' }) + '\n' +
      JSON.stringify({ ...base, parentUuid: 'u1', type: 'assistant', message: { model: 'm', role: 'assistant', content: [{ type: 'text', text: 'a' }] }, uuid: 'a1' }) + '\n');

    const result = await syncConversations(src, dest, { skipSummaries: true });

    expect(existsSync(join(dest, 'proj', `${id}.jsonl`))).toBe(true);
    expect(result.errors.some(e => e.file === '(index database)')).toBe(true);
    // Nothing can be indexed, so the embedding model is not loaded either.
    expect(embedding.loaded).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
