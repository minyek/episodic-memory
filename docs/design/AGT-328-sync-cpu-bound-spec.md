# AGT-328: bound the CPU a background sync can use

Ticket: AGT-328. Follow-on in the same repository: AGT-329 (summarizer fixes), built after this.

## Goal

A `sync --background` started by the SessionStart hook can no longer use many cores for hours.
On 2026-11-12 thirteen orphaned syncs, each started under a scratch `HOME`, used about 22 of 32
cores for up to 7 hours (host load average 470). Cause, measured:

- onnxruntime ran with one worker per core: the thread cap in `resolveIntraOpThreads` applies only
  to Apple Silicon. Each process had 37 threads, workers in state R, 41,000 to 66,000 CPU-seconds.
- The per-`HOME` lock (`$HOME/.config/superpowers/logs/episodic-memory-sync.lock`) did not stop
  them, because each fake `HOME` had its own lock (`os.homedir()` follows `$HOME`).
- A sync has no deadline.

## Findings that change the ticket

- `EPISODIC_MEMORY_DISABLE_AUTO_SYNC=1` already exists (#163, README, `sync-cli.ts`) and exits the
  hook-launched sync at once. The ticket's new `EPISODIC_MEMORY_SKIP_SYNC` is not needed. AGT-330
  sets the existing switch. The ticket's AC is amended to say so.

## Decisions

| # | Decision | Options | Choice and reason |
|---|---|---|---|
| D1 | Default embedding thread cap | none (today); 1; 2; cores/4 | **2 on every platform**, `EPISODIC_MEMORY_EMBED_THREADS` still overrides, 0 still means onnxruntime default. The code comment records that 2 is as fast as uncapped on batch=1 work; 1 halves throughput on a cold index; cores/4 is 8 on this host. |
| D2 | onnxruntime spin-wait | leave on; off | **Off** (`session.intra_op.allow_spinning=0` through `session_options.extra`). Spin-waiting is why idle workers show state R and burn CPU. Cost: slightly higher latency per call; embeddings are bit-identical. |
| D3 | Deadline | none; 30 min; 2 h | **30 min**, `EPISODIC_MEMORY_SYNC_TIMEOUT_MS` (`0` disables). Sync is incremental, so progress is kept and the next sync resumes. A cold index may take several slices; that is better than one runaway. |
| D4 | What the deadline does | cooperative stop; hard exit | **Hard exit** with code 124 after releasing the locks and logging a warning. Embedding and SQLite work are inside awaits and native calls, so a cooperative flag would not be seen; SQLite recovers an interrupted transaction from its WAL. |
| D5 | CPU priority of a background sync | none; nice 19; nice 10 | **nice 10**, background child only. 19 would starve the summarizer subprocess it spawns (AGT-329 handles starvation separately). |
| D6 | Cross-`HOME` limit | none; global lock in `os.tmpdir()`; lock in the passwd home | **A per-user lock in `os.tmpdir()`**, taken by the background child after its per-`HOME` lock. It does not depend on `$HOME`, so scratch homes share it. It follows `TMPDIR`; a probe that also isolates `TMPDIR` is covered by DISABLE_AUTO_SYNC (AGT-330). Foreground `sync` and `index` do not take it, so a hand-run sync still works. |
| D7 | New skip switch | add `SKIP_SYNC` | **None**: reuse DISABLE_AUTO_SYNC. |

## Acceptance criteria

1. With `EPISODIC_MEMORY_EMBED_THREADS` unset, `resolveIntraOpThreads()` returns 2 on every platform, and
   the session options passed to the pipeline set `intraOpNumThreads` 2, `interOpNumThreads` 1 and
   `extra['session.intra_op.allow_spinning']` `'0'`. An explicit override still wins; `0` keeps the
   onnxruntime default, and then spinning is still off.
2. A background sync child exits with code 124 after `EPISODIC_MEMORY_SYNC_TIMEOUT_MS` (default
   1,800,000), having released both locks and logged a warning that names the deadline. `0` disables it.
3. A background sync child runs at nice 10. A foreground sync keeps its priority.
4. While one background sync holds the per-user lock, a second background sync with a different
   `HOME` and `EPISODIC_MEMORY_CONFIG_DIR` and the same `TMPDIR` exits 0 without syncing and says which pid holds it.
   A foreground `sync` does not take the lock.
5. A lock failure other than contention (for example an unwritable temp dir) is logged at warn and does
   not stop the sync (the per-`HOME` lock still applies): a service never refuses to start over a file it writes.
6. README documents the new default, `EPISODIC_MEMORY_SYNC_TIMEOUT_MS` and the per-user lock.
7. Acceptance run: a background sync over a copy of 200 real conversations in an isolated config dir
   uses at most about 2.5 cores averaged over 60 s, has no thread in state R at idle, and exits 124 at a 120 s deadline.

## Invariants

1. At most one background sync holds the per-user lock at a time.
2. A process that exits (normal, signal or deadline) releases both locks it holds.
3. A deadline exit never leaves the index or archive in a state the next sync cannot read: a
   partially written conversation is re-copied or re-indexed by the existing incremental logic.
4. The deadline timer and nice setting never apply to a foreground sync.
5. A lock error other than contention never stops a sync.

## Transitions

| State | Event | Guard | Next state | Side effect |
|---|---|---|---|---|
| none | hook runs `sync --background` | DISABLE_AUTO_SYNC is not `1` | parent logs and spawns child | child marked by `EPISODIC_MEMORY_BACKGROUND_CHILD=1` |
| child starting | per-`HOME` lock busy | | exit 0 | message (today) |
| child starting | per-user lock busy | | exit 0 | message with holder pid |
| child starting | both locks held | | running | nice 10; deadline timer armed |
| running | deadline fires | | exit 124 | release locks; warn line |
| running | done / SIGTERM / SIGINT / SIGHUP | | exit | release locks |

## Writers

Two lock files are written by every background sync. Acquisition is the atomic mkdir of
`proper-lockfile` with a retry count of 0, so there is no read-then-write gap in this change.
The existing mtime heartbeat can lapse on a starved process and let a contender steal the lock after
10 minutes; the per-user lock keeps that to one extra process, and the deadline bounds it. No guarded reader.
An interleaving test is advised and not required; AC 4 covers contention.

## Live-only items

The CPU and thread-state measurement of AC 7 needs a real model load and a real corpus. It runs as the recorded acceptance run under `arm-run`.

## Verification list

| AC | Test |
|---|---|
| 1 | `test/embed-threads.test.ts` (updated: default is 2 everywhere); new `buildEmbeddingSessionOptions` cases in the same file |
| 2 | `test/sync-deadline.test.ts`: fake timers on the helper (expires, `0` disables, releases locks, exit code 124) |
| 3 | `test/sync-background-priority.test.ts`: helper with an injected `setPriority`; foreground does not call it |
| 4, 5 | `test/sync-global-lock.test.ts`: spawn the built `dist/sync-cli.js` twice, two homes, shared `TMPDIR`; and a read-only `TMPDIR` |
| 6 | review reads the README |
| 7 | recorded acceptance run |

The update to `embed-threads.test.ts` rewrites the "null elsewhere" assertion to the new contract; it does not weaken it.

## Task list (small change, no plan)

1. Embeddings: `resolveIntraOpThreads` default 2, `buildEmbeddingSessionOptions` with spin off; tests.
2. `src/sync-limits.ts`: `startSyncDeadline`, `lowerBackgroundPriority`, `acquireUserSyncSlot`; tests.
3. Wire into `src/sync-cli.ts` (child marker, order of locks, release on every exit path); build `dist/`; tests for AC 4 and 5.
4. README and docs.
5. Acceptance run (AC 7) and final review.

## Docs impact

`README.md` (environment variables and background-sync notes). The repository has no overview doc; none is added.

## Consistency with AGT-329

The summarizer fixes (progress-based timeout, load-aware skip, retry backoff, auth circuit breaker,
the `match` crash) touch `summarizer.ts`, `sync.ts` and `indexer.ts`, not these files except
`sync-cli.ts` where AGT-329 may read the same child marker. D5's nice 10 is why AGT-329 must stop
counting starvation as failure.
