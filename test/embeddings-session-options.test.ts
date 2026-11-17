import { describe, it, expect, vi, afterEach } from 'vitest';

const pipelineCalls = vi.hoisted(() => [] as Array<{ task: string; model: string; options: any }>);

vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: async (task: string, model: string, options: any) => {
    pipelineCalls.push({ task, model, options });
    return async () => ({ data: new Float32Array(384) });
  },
}));

// Behaviour: the embedding pipeline is created with the capped,
// non-spinning session options, not only built by a helper nobody calls.
describe('initEmbeddings session options', () => {
  const original = process.env.EPISODIC_MEMORY_EMBED_THREADS;

  afterEach(() => {
    pipelineCalls.length = 0;
    vi.resetModules();
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.EPISODIC_MEMORY_EMBED_THREADS;
    else process.env.EPISODIC_MEMORY_EMBED_THREADS = original;
  });

  it('passes the capped, non-spinning session options to the pipeline', async () => {
    delete process.env.EPISODIC_MEMORY_EMBED_THREADS;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { initEmbeddings } = await import('../src/embeddings.js');
    await initEmbeddings();

    expect(pipelineCalls).toHaveLength(1);
    expect(pipelineCalls[0].options.session_options).toEqual({
      intraOpNumThreads: 2,
      interOpNumThreads: 1,
      extra: { 'session.intra_op.allow_spinning': '0' },
    });
  });

  it('keeps spinning off when the cap is lifted with 0', async () => {
    process.env.EPISODIC_MEMORY_EMBED_THREADS = '0';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { initEmbeddings } = await import('../src/embeddings.js');
    await initEmbeddings();

    expect(pipelineCalls[0].options.session_options).toEqual({
      extra: { 'session.intra_op.allow_spinning': '0' },
    });
  });
});
