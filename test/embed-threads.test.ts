import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveIntraOpThreads, buildEmbeddingSessionOptions } from '../src/embeddings.js';

const ENV_KEY = 'EPISODIC_MEMORY_EMBED_THREADS';

// Behaviour: embedding must not fan out across every core. Without an
// override the cap is 2 on every platform; only the exact value "0" restores
// onnxruntime's own default; a malformed value keeps the cap rather than
// silently removing it.
describe('resolveIntraOpThreads', () => {
  const original = process.env[ENV_KEY];

  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('honors a positive integer override', () => {
    process.env[ENV_KEY] = '4';
    expect(resolveIntraOpThreads()).toBe(4);
  });

  it('treats exactly "0" as "use the onnxruntime default" (null)', () => {
    process.env[ENV_KEY] = '0';
    expect(resolveIntraOpThreads()).toBeNull();
  });

  it.each(['', 'nope', '-1', '2.5', ' '])('keeps the default cap of 2 for the malformed value %j and warns', (value) => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env[ENV_KEY] = value;
    expect(resolveIntraOpThreads()).toBe(2);
    expect(warn).toHaveBeenCalled();
  });

  it('defaults to a cap of 2 on every platform when unset', () => {
    delete process.env[ENV_KEY];
    expect(resolveIntraOpThreads()).toBe(2);
  });
});

// Behaviour: idle onnxruntime workers must not spin. Spinning is turned off
// whether or not a thread cap applies, and the option value is a string
// because the native binding rejects other types.
describe('buildEmbeddingSessionOptions', () => {
  it('caps threads and turns spin-waiting off', () => {
    expect(buildEmbeddingSessionOptions(2)).toEqual({
      intraOpNumThreads: 2,
      interOpNumThreads: 1,
      extra: { 'session.intra_op.allow_spinning': '0' },
    });
  });

  it('leaves the thread counts alone but still turns spinning off when there is no cap', () => {
    expect(buildEmbeddingSessionOptions(null)).toEqual({
      extra: { 'session.intra_op.allow_spinning': '0' },
    });
  });
});
