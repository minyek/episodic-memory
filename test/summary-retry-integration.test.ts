import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

vi.mock('../src/summarizer.js', async () => ({
  ...await vi.importActual<typeof import('../src/summarizer.js')>('../src/summarizer.js'),
  summarizeConversation: vi.fn(),
}));
vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: vi.fn(async () => {}),
  generateExchangeEmbedding: vi.fn(async () => Array.from({ length: 384 }, (_, i) => (i + 1) / 384)),
}));

import { syncConversations } from '../src/sync.js';
import { summarizeConversation, SummarizerSdkError, SummarizerTimeoutError } from '../src/summarizer.js';
import { indexConversations, indexSession, indexUnprocessed } from '../src/indexer.js';
import { verifyIndex, repairIndex } from '../src/verify.js';

const HOUR_MS = 60 * 60 * 1000;
// Runs are spaced past the one-hour retry interval stubbed below.
const PAST_RETRY_INTERVAL_MS = 2 * HOUR_MS;

const indexEntryPoints: Record<'all' | 'session' | 'unprocessed', (sessionId: string) => Promise<void>> = {
  all: () => indexConversations(),
  session: sessionId => indexSession(sessionId),
  unprocessed: () => indexUnprocessed(),
};

function exchange(sessionId: string, turn: number): string {
  return [
    { type: 'user', uuid: `${sessionId}-u${turn}`, sessionId, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: `Explain deployment step ${turn}.` } },
    { type: 'assistant', uuid: `${sessionId}-a${turn}`, sessionId, timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: `Deployment step ${turn} updates the service.` }] } },
  ].map(line => JSON.stringify(line)).join('\n') + '\n';
}

describe('summary retry lifecycle through callers', () => {
  let root: string;
  let source: string;
  let archive: string;
  let now: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'summary-retry-integration-'));
    source = join(root, 'source');
    archive = join(root, 'archive');
    mkdirSync(join(source, 'project'), { recursive: true });
    mkdirSync(join(archive, 'project'), { recursive: true });
    vi.stubEnv('TEST_PROJECTS_DIR', source);
    vi.stubEnv('TEST_ARCHIVE_DIR', archive);
    vi.stubEnv('TEST_DB_PATH', join(root, 'index.sqlite'));
    vi.stubEnv('EPISODIC_MEMORY_SUMMARY_MAX_ATTEMPTS', '2');
    vi.stubEnv('EPISODIC_MEMORY_SUMMARY_ERROR_RETRY_HOURS', '1');
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(summarizeConversation).mockReset().mockRejectedValue(new Error('Transcript exceeds capacity'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function addConversation(number: number): { id: string; sourcePath: string; summaryPath: string } {
    const id = `1111aaaa-1111-1111-1111-${String(number).padStart(12, '0')}`;
    const sourcePath = join(source, 'project', `${id}.jsonl`);
    writeFileSync(sourcePath, exchange(id, 1));
    return { id, sourcePath, summaryPath: join(archive, 'project', `${id}-summary.txt`) };
  }

  function seedFailure(summaryPath: string, attempts: number): void {
    writeFileSync(summaryPath, `__ERRORED__\n${JSON.stringify({ attempts, lastAttempt: now - PAST_RETRY_INTERVAL_MS })}\nFailure\n`);
  }

  function failureState(summaryPath: string): unknown {
    return JSON.parse(readFileSync(summaryPath, 'utf8').split('\n')[1]);
  }

  it('stops automatic sync at the configured failure cap', async () => {
    const { summaryPath } = addConversation(0);
    const secondRunAt = now + PAST_RETRY_INTERVAL_MS;
    for (let run = 0; run < 4; run++) {
      await syncConversations(source, archive, { skipIndex: true });
      now += PAST_RETRY_INTERVAL_MS;
    }
    expect(summarizeConversation).toHaveBeenCalledTimes(2);
    expect(failureState(summaryPath)).toEqual({ attempts: 2, lastAttempt: secondRunAt });
  });

  it('selects fresh work ahead of eligible retries before the limit', async () => {
    const retry = addConversation(0);
    const fresh = addConversation(1);
    seedFailure(retry.summaryPath, 1);
    vi.mocked(summarizeConversation).mockResolvedValue('Fresh conversation summary');
    const result = await syncConversations(source, archive, { skipIndex: true, summaryLimit: 1 });
    expect(result.summarized).toBe(1);
    expect(readFileSync(fresh.summaryPath, 'utf8')).toBe('Fresh conversation summary');
    expect(failureState(retry.summaryPath)).toMatchObject({ attempts: 1 });
  });

  it('keeps a skipped retry count and a first-time skip at zero after auth failure', async () => {
    const first = addConversation(0);
    const skippedFresh = addConversation(1);
    const skippedRetry = addConversation(2);
    seedFailure(skippedRetry.summaryPath, 1);
    vi.mocked(summarizeConversation).mockRejectedValue(new Error('Failed to authenticate. API Error: 401'));
    const result = await syncConversations(source, archive, { skipIndex: true });
    expect(summarizeConversation).toHaveBeenCalledTimes(1);
    expect(result.errors).toHaveLength(3);
    expect(failureState(first.summaryPath)).toEqual({ attempts: 0, lastAttempt: now });
    expect(failureState(skippedFresh.summaryPath)).toEqual({ attempts: 0, lastAttempt: now });
    expect(failureState(skippedRetry.summaryPath)).toEqual({ attempts: 1, lastAttempt: now });
  });

  it('does not abandon valid conversations during repeated global auth outages', async () => {
    const { summaryPath } = addConversation(0);
    vi.mocked(summarizeConversation).mockRejectedValue(new Error('Failed to authenticate. API Error: 401'));
    for (let run = 0; run < 3; run++) {
      await syncConversations(source, archive, { skipIndex: true });
      now += PAST_RETRY_INTERVAL_MS;
    }
    vi.mocked(summarizeConversation).mockResolvedValue('Recovered after reauthentication');
    const result = await syncConversations(source, archive, { skipIndex: true });
    expect(result.summarized).toBe(1);
    expect(readFileSync(summaryPath, 'utf8')).toBe('Recovered after reauthentication');
  });

  it('prioritizes a previously skipped first attempt over a failed retry', async () => {
    const retry = addConversation(0);
    const skipped = addConversation(1);
    seedFailure(retry.summaryPath, 1);
    seedFailure(skipped.summaryPath, 0);
    vi.mocked(summarizeConversation).mockResolvedValue('First actual summary');
    await syncConversations(source, archive, { skipIndex: true, summaryLimit: 1 });
    expect(readFileSync(skipped.summaryPath, 'utf8')).toBe('First actual summary');
  });

  it('bounds unsuccessful attempts within a sync run', async () => {
    for (let number = 0; number < 4; number++) addConversation(number);
    const result = await syncConversations(source, archive, { skipIndex: true, summaryLimit: 2 });
    expect(result.errors).toHaveLength(2);
    expect(summarizeConversation).toHaveBeenCalledTimes(2);
  });

  it.each(['all', 'session', 'unprocessed'] as const)('records and caps failures from the %s index entry point', async entry => {
    const { id, sourcePath, summaryPath } = addConversation(0);
    for (let run = 0; run < 3; run++) {
      await indexEntryPoints[entry](id);
      now += PAST_RETRY_INTERVAL_MS;
      appendFileSync(sourcePath, exchange(id, run + 2));
    }
    expect(summarizeConversation).toHaveBeenCalledTimes(2);
    expect(failureState(summaryPath)).toMatchObject({ attempts: 2 });
  });

  // Sync and every index entry point record one failure the same way: a global
  // failure keeps the retry count, any other failure spends an attempt.
  const summaryCallers: Record<'sync' | 'all' | 'session' | 'unprocessed', (sessionId: string) => Promise<unknown>> = {
    sync: () => syncConversations(source, archive, { skipIndex: true }),
    ...indexEntryPoints,
  };
  const failureClasses = [
    { failure: 'an expired login', error: () => new Error('Failed to authenticate. API Error: 401'), attempts: 0 },
    { failure: 'an overloaded API', error: () => new SummarizerSdkError('success', undefined, 529, 'API Error: 529 overloaded'), attempts: 0 },
    { failure: 'an unreachable API', error: () => new SummarizerSdkError('success', undefined, null, 'API Error: Unable to connect to API (ConnectionRefused)'), attempts: 0 },
    { failure: 'a timeout', error: () => new SummarizerTimeoutError(50), attempts: 1 },
    { failure: 'a failure of its own', error: () => new Error('Transcript exceeds capacity'), attempts: 1 },
  ];
  describe.each(Object.keys(summaryCallers) as Array<keyof typeof summaryCallers>)('through %s', caller => {
    it.each(failureClasses)('records $failure with the attempt count its class gives', async ({ error, attempts }) => {
      const { id, summaryPath } = addConversation(0);
      vi.mocked(summarizeConversation).mockRejectedValue(error());
      await summaryCallers[caller](id);
      expect(failureState(summaryPath)).toEqual({ attempts, lastAttempt: now });
    });
  });

  it('prints retry exhaustion and its recovery command in the verify CLI', () => {
    const { id, summaryPath } = addConversation(0);
    writeFileSync(join(archive, 'project', `${id}.jsonl`), exchange(id, 1));
    seedFailure(summaryPath, 2);
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('../src/index-cli.ts', import.meta.url)), 'verify',
    ], {
      env: { ...process.env, EPISODIC_MEMORY_CONFIG_DIR: join(root, 'config') },
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/Summary retry limit reached; run episodic-memory-index --repair/);
  }, 180_000);

  it('reports an exhausted summary and permits explicit repair', async () => {
    const { id, summaryPath } = addConversation(0);
    writeFileSync(join(archive, 'project', `${id}.jsonl`), exchange(id, 1));
    seedFailure(summaryPath, 2);
    const issues = await verifyIndex();
    expect(issues.missing).toEqual([{ path: join(archive, 'project', `${id}.jsonl`), reason: expect.stringMatching(/retry limit.*repair/i) }]);
    vi.mocked(summarizeConversation).mockResolvedValue('Explicit repair recovered the summary');
    await repairIndex(issues);
    expect(readFileSync(summaryPath, 'utf8')).toBe('Explicit repair recovered the summary');
    expect((await verifyIndex()).missing).toHaveLength(0);
  });
});
