import { describe, it, expect } from 'vitest';
import { settlePendingMtime, currentArchiveMtimeMs } from '../src/archive-stamp.js';

// Behaviour: a pending archive copy must read back below its source's mtime on
// the filesystem it is written to, or the next sync would take it for current
// and skip indexing it.
describe('settlePendingMtime', () => {
  const identity = (mtimeMs: number) => mtimeMs;
  // A filesystem that rounds file times up to a 2 s step.
  const roundsUpTo2s = (mtimeMs: number) => Math.ceil(mtimeMs / 2000) * 2000;

  it('stamps one millisecond below the whole-millisecond source on a fine-grained filesystem', () => {
    expect(settlePendingMtime(10_000.4, identity)).toBe(10_000);
  });

  it('falls back to a margin the filesystem can represent when it rounds up', () => {
    const source = 1_001_001.5;
    const chosen = settlePendingMtime(source, roundsUpTo2s);
    expect(chosen).not.toBeNull();
    expect(roundsUpTo2s(chosen!)).toBeLessThan(source);
  });

  it('reports failure when no margin reads back below the source', () => {
    expect(settlePendingMtime(5_000, () => 5_000)).toBeNull();
  });
});

describe('currentArchiveMtimeMs', () => {
  it('rounds up to the next whole millisecond', () => {
    expect(currentArchiveMtimeMs(10.2)).toBe(11);
    expect(currentArchiveMtimeMs(10)).toBe(10);
  });
});
