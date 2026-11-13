import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ConversationExchange } from '../src/types.js';
import { suppressConsole } from './test-utils.js';

// The model is the process boundary: the SDK's query() is scripted, everything
// from syncConversations down to the error sentinels is real code.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { syncConversations } from '../src/sync.js';
import { summarizeConversation, classifySummaryFailure } from '../src/summarizer.js';

type Step =
  | { kind: 'ok' }
  | { kind: 'api'; status: number | null; text: string }
  | { kind: 'hang' };

const ok: Step = { kind: 'ok' };
const api = (status: number, text = `API Error: ${status}`): Step => ({ kind: 'api', status, text });
const notLoggedIn: Step = { kind: 'api', status: null, text: 'Not logged in · Please run /login' };
const creditLow: Step = { kind: 'api', status: 400, text: 'Your credit balance is too low to access the Anthropic API.' };
const hang: Step = { kind: 'hang' };

function script(steps: Step[]): void {
  let next = 0;
  vi.mocked(query).mockImplementation((() => {
    const step = steps[next++] ?? ok;
    if (step.kind === 'hang') {
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
    }
    const message = step.kind === 'ok'
      ? { type: 'result', subtype: 'success', is_error: false, result: '<summary>Did a thing.</summary>' }
      : { type: 'result', subtype: 'success', is_error: true, api_error_status: step.status, result: step.text };
    return (async function* () { yield message; })();
  }) as any);
}

function lines(sessionId: string, exchanges: number): string {
  const base = { isSidechain: false, userType: 'external', cwd: '/nonexistent-cwd', sessionId, version: '2.0.9', gitBranch: 'main' };
  let out = '';
  let previous: string | null = null;
  for (let i = 1; i <= exchanges; i++) {
    const timestamp = new Date(2026, 0, 2, 3, i).toISOString();
    out += JSON.stringify({ ...base, parentUuid: previous, type: 'user', message: { role: 'user', content: `Question ${i} about something specific enough to be a real exchange, number ${i}` }, uuid: `u${i}-${sessionId}`, timestamp }) + '\n';
    out += JSON.stringify({ ...base, parentUuid: `u${i}-${sessionId}`, type: 'assistant', message: { model: 'm', role: 'assistant', content: [{ type: 'text', text: `Answer ${i} with enough detail to count as a real reply, number ${i}` }] }, uuid: `a${i}-${sessionId}`, timestamp }) + '\n';
    previous = `a${i}-${sessionId}`;
  }
  return out;
}

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

describe('a summary batch stops on a global failure and on repeated suspect ones', () => {
  let dir: string;
  let src: string;
  let dest: string;
  let restoreConsole: () => void;
  const savedTimeout = process.env.EPISODIC_MEMORY_SUMMARY_TIMEOUT_MS;

  const summaryPath = (n: number) => join(dest, 'proj', `${IDS[n]}-summary.txt`);
  const summaryText = (n: number) => (existsSync(summaryPath(n)) ? readFileSync(summaryPath(n), 'utf-8') : null);
  const calls = () => vi.mocked(query).mock.calls.length;
  const run = () => syncConversations(src, dest, { skipIndex: true });

  function conversations(exchangeCounts: number[]) {
    exchangeCounts.forEach((count, n) => writeFileSync(join(src, 'proj', `${IDS[n]}.jsonl`), lines(IDS[n], count)));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'em-summary-stop-'));
    src = join(dir, 'projects');
    dest = join(dir, 'archive');
    mkdirSync(join(src, 'proj'), { recursive: true });
    process.env.TEST_DB_PATH = join(dir, 'test.db');
    process.env.EPISODIC_MEMORY_SUMMARY_TIMEOUT_MS = '50';
    vi.mocked(query).mockReset();
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    delete process.env.TEST_DB_PATH;
    if (savedTimeout === undefined) delete process.env.EPISODIC_MEMORY_SUMMARY_TIMEOUT_MS;
    else process.env.EPISODIC_MEMORY_SUMMARY_TIMEOUT_MS = savedTimeout;
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([429, 503, 529])('stops after the first HTTP %i, with every untried file marked and reported', async (status) => {
    conversations([2, 2, 2, 2]);
    script([api(status)]);

    const result = await run();

    expect(calls()).toBe(1);
    for (let n = 0; n < 4; n++) expect(summaryText(n)).toMatch(/^__ERRORED__\n/);
    const skipped = result.errors.filter(e => e.error.startsWith('Summary generation skipped:'));
    expect(skipped).toHaveLength(3);
    expect(skipped.every(e => e.error.includes(`HTTP ${status}`))).toBe(true);
    expect(result.summaryStop).toBe('other');
  });

  it('stops at once on a credit-balance 400, without a second call for the resume fallback', async () => {
    conversations([2, 2, 2, 2]);
    script([creditLow]);

    const result = await run();

    expect(calls()).toBe(1);
    expect(result.errors.filter(e => e.error.startsWith('Summary generation skipped:'))).toHaveLength(3);
    expect(result.summaryStop).toBe('other');
  });

  it('stops at once when the CLI is not logged in', async () => {
    conversations([2, 2, 2, 2]);
    script([notLoggedIn]);

    const result = await run();

    expect(calls()).toBe(1);
    expect(result.errors.filter(e => e.error.startsWith('Summary generation skipped:'))).toHaveLength(3);
    expect(result.summaryStop).toBe('auth');
  });

  it('treats another 400 as that conversation\'s own failure: one resume fallback, then the batch goes on', async () => {
    conversations([2, 2, 2, 2]);
    script([api(400), api(400), ok, ok, ok]);

    const result = await run();

    expect(calls()).toBe(5);
    expect(summaryText(0)).toMatch(/^__ERRORED__\n/);
    for (const n of [1, 2, 3]) expect(summaryText(n)).toBe('Did a thing.');
    expect(result.summaryStop).toBeUndefined();
  });

  it('does not stop for one suspect failure followed by a summary', async () => {
    conversations([2, 2, 2, 2]);
    script([api(500), ok, ok, ok]);

    const result = await run();

    expect(calls()).toBe(4);
    expect(summaryText(0)).toMatch(/^__ERRORED__\n/);
    for (const n of [1, 2, 3]) expect(summaryText(n)).toBe('Did a thing.');
    expect(result.summaryStop).toBeUndefined();
  });

  it('stops at the second consecutive suspect failure', async () => {
    conversations([2, 2, 2, 2]);
    script([api(500), api(502)]);

    const result = await run();

    expect(calls()).toBe(2);
    expect(result.errors.filter(e => e.error.startsWith('Summary generation skipped:'))).toHaveLength(2);
    expect(result.summaryStop).toBe('other');
  });

  it('does not stop for timeouts separated by a summary', async () => {
    conversations([2, 2, 2, 2]);
    script([hang, ok, hang, ok]);

    const result = await run();

    expect(calls()).toBe(4);
    expect(summaryText(1)).toBe('Did a thing.');
    expect(summaryText(3)).toBe('Did a thing.');
    expect(result.summaryStop).toBeUndefined();
  });

  it('stops at the second consecutive timeout', async () => {
    conversations([2, 2, 2, 2]);
    script([hang, hang]);

    const result = await run();

    expect(calls()).toBe(2);
    expect(result.errors.filter(e => e.error.startsWith('Summary generation skipped:'))).toHaveLength(2);
    expect(result.summaryStop).toBe('other');
  });

  it('lets a conversation that needs no model call leave the suspect count as it is', async () => {
    writeFileSync(join(src, 'proj', `${IDS[0]}.jsonl`), lines(IDS[0], 2));
    const trivial = { isSidechain: false, userType: 'external', cwd: '/x', sessionId: IDS[1], version: '2.0.9', gitBranch: 'main' };
    writeFileSync(join(src, 'proj', `${IDS[1]}.jsonl`),
      JSON.stringify({ ...trivial, parentUuid: null, type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'tu', timestamp: new Date(2026, 0, 2).toISOString() }) + '\n' +
      JSON.stringify({ ...trivial, parentUuid: 'tu', type: 'assistant', message: { model: 'm', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, uuid: 'ta', timestamp: new Date(2026, 0, 2).toISOString() }) + '\n');
    writeFileSync(join(src, 'proj', `${IDS[2]}.jsonl`), lines(IDS[2], 2));
    writeFileSync(join(src, 'proj', `${IDS[3]}.jsonl`), lines(IDS[3], 2));
    script([hang, hang]);

    await run();

    expect(calls()).toBe(2);
    expect(summaryText(3)).toMatch(/^__ERRORED__\n/);
  });

  it('stops on a global failure inside a long conversation\'s chunk call, with no later chunk call', async () => {
    conversations([16, 2, 2, 2]);
    script([api(529)]);

    const result = await run();

    expect(calls()).toBe(1);
    expect(summaryText(0)).toMatch(/^__ERRORED__\n/);
    expect(result.errors.filter(e => e.error.startsWith('Summary generation skipped:'))).toHaveLength(3);
  });

  it('never writes summary text for a long conversation whose every chunk failed', async () => {
    conversations([16, 2, 2, 2]);
    script([api(400), api(400), ok, ok, ok]);

    const result = await run();

    expect(summaryText(0)).toMatch(/^__ERRORED__\n/);
    expect(summaryText(0)).not.toContain('Unable to summarize');
    for (const n of [1, 2, 3]) expect(summaryText(n)).toBe('Did a thing.');
    expect(result.summarized).toBe(3);
  });
});

describe('a Codex conversation whose Claude fallback fails', () => {
  const savedBin = process.env.EPISODIC_MEMORY_CODEX_BIN;

  beforeEach(() => {
    process.env.EPISODIC_MEMORY_CODEX_BIN = '/nonexistent/codex-for-test';
    vi.mocked(query).mockReset();
  });

  afterEach(() => {
    if (savedBin === undefined) delete process.env.EPISODIC_MEMORY_CODEX_BIN;
    else process.env.EPISODIC_MEMORY_CODEX_BIN = savedBin;
  });

  it('fails that conversation alone: the login is not a global problem for a Codex user', async () => {
    script([notLoggedIn]);
    const exchange: ConversationExchange = {
      id: 'x1', project: 'p', timestamp: '2026-01-02T00:00:00Z', harness: 'codex', sessionId: 'codex-sess-1',
      userMessage: 'A question long enough to be a real exchange for the summarizer, number one.',
      assistantMessage: 'An answer long enough to be a real reply for the summarizer, number one.',
      archivePath: '/tmp/none.jsonl', lineStart: 1, lineEnd: 2, cwd: '/x',
    };

    const failure = await summarizeConversation([exchange, { ...exchange, id: 'x2' }]).then(() => null, e => e as Error);

    expect(failure).not.toBeNull();
    expect(failure!.message).toMatch(/Codex/);
    expect(failure!.message).toMatch(/Not logged in/);
    expect(classifySummaryFailure(failure)).toBeNull();
  });
});
