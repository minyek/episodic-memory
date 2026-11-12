# AGT-328: bound the CPU a background sync can use

Ticket: AGT-328. Follow-on in the same repository: AGT-329 (summarizer fixes), built after this one.

## Goal

A `sync --background` started by the SessionStart hook can no longer use many cores for hours.
On 2026-11-12 thirteen orphaned syncs, each started under a scratch `HOME`, used about 22 of 32
cores for up to 7 hours (host load average 470). Cause, measured:

- onnxruntime ran with one worker per core: the thread cap in `resolveIntraOpThreads` applies only
  to Apple Silicon. Each process had 37 threads, workers in state R, 41,000 to 66,000 CPU-seconds.
- The per-config-dir lock (`$HOME/.config/superpowers/logs/episodic-memory-sync.lock` unless
  `EPISODIC_MEMORY_CONFIG_DIR`, `PERSONAL_SUPERPOWERS_DIR` or `XDG_CONFIG_HOME` is set; `paths.ts`
  176-188) did not stop them, because each fake `HOME` had its own lock (`os.homedir()` follows `$HOME`).
- A sync has no deadline.

## Findings that change the ticket

- `EPISODIC_MEMORY_DISABLE_AUTO_SYNC=1` already exists (#163, README, `sync-cli.ts`) and exits the
  hook-launched sync at once. The ticket's new `EPISODIC_MEMORY_SKIP_SYNC` is not needed. AGT-330
  sets the existing switch.
- A deadline exit loses work unless the copy order changes (D8): sync copies every new file into
  the archive before indexing any, and skips an archive copy that is current.

## Decisions

| # | Decision | Options | Choice and reason |
|---|---|---|---|
| D1 | Default embedding thread cap | none (today); 1; 2; cores/4 | **2 on every platform**; `EPISODIC_MEMORY_EMBED_THREADS` overrides. Only the exact value `0` restores onnxruntime's default; an empty, negative or non-numeric value keeps 2 and logs a warn line. Measured 2026-11-12 on this 32-core host at load about 140, 300 embeddings at 2 threads: 2.4-2.6 CPU-s and 2.7-3.0 s wall with spinning off, 4.3-4.5 CPU-s and 3.3-3.6 s with it on; 100 embeddings uncapped with spinning on: 50 CPU-s in 2.6 s, 32 threads in state R. Vectors identical (1536 of 1536 values) uncapped against 2 threads with spinning off, so no `EMBEDDING_VERSION` bump. The pipeline spreads `session_options` into `InferenceSession.create` (`transformers.node.mjs` 12684-12690); the onnxruntime-node 1.30.0 binding reads `extra` and rejects a non-string value. |
| D2 | onnxruntime spin-wait | leave on; off | **Off** (`session.intra_op.allow_spinning` = `'0'` through `session_options.extra`; the value is a string). Spin-waiting is why idle workers show state R. Cost: none measured; spinning off was faster in the run above. |
| D3 | Deadline | none; 30 min; 2 h | **30 min**, `EPISODIC_MEMORY_SYNC_TIMEOUT_MS`; only the exact value `0` disables it; an empty, negative or non-numeric value keeps 30 min and logs a warn line. Sync is incremental, so progress is kept (given D8). The timer is `unref()`'d, so a sync that finishes earlier exits at once with its own code. |
| D4 | What the deadline does | cooperative stop; hard exit | **Hard exit**, code 124, after releasing the locks and logging a warning. A timer callback runs only between JavaScript tasks, so it never cuts a better-sqlite3 call (synchronous; WAL, `db.ts` 122) or the archive's copy-and-rename (`sync.ts` 152-154) part-way. A hard exit reaches every phase (walk, index, summaries, migration) without threading a stop flag through `sync.ts`, `summarizer.ts` and `embedding-migration.ts`. The Agent SDK SIGTERMs its Claude children on exit, `codex app-server` exits on stdin EOF (measured: 1 s), and proper-lockfile's exit hook removes every held lock directory (`lockfile.js` 331-337). |
| D5 | CPU priority of a background sync | none; nice 19; nice 10 | **nice 10**, background child only, called before any embedding session exists: on Linux a nice value belongs to a thread and only threads created after the call inherit it (measured: after `os.setPriority(10)` the onnxruntime worker and libuv threads had nice 10, the V8 platform threads created earlier kept 0). 19 would starve the summarizer subprocess (AGT-329 handles starvation separately). |
| D6 | Cross-`HOME` limit | none; lock in `os.tmpdir()`; lock in `$XDG_RUNTIME_DIR` else `os.tmpdir()`; lock in the passwd home | **Approved by the user (U1, option b): `episodic-memory-sync-<uid>.lock` in `$XDG_RUNTIME_DIR` when it is set and a directory, else `os.tmpdir()`**, taken by the background child after its per-config-dir lock. `<uid>` is `process.getuid()` (`os.userInfo().username` where absent), so accounts that share a temp dir never share or squat it. Neither depends on `$HOME`. Every ARM job has its own `TMPDIR` (checked 2026-11-12: 190 of 201 ARM-job processes had `XDG_RUNTIME_DIR=/run/user/1001`; every one had a per-job `TMPDIR`), so `os.tmpdir()` alone would not be per user. macOS and Windows leave `XDG_RUNTIME_DIR` unset and their temp dir is already per user. Foreground `sync` and `index` do not take it. Cost: a scratch-`HOME` sync holding it makes the user's real background syncs skip until it ends (at most the deadline); a foreground sync still runs. |
| D7 | New skip switch | add `SKIP_SYNC` | **None**: reuse DISABLE_AUTO_SYNC. |
| D8 | Copy order in a sync | copy every file in the walk, then index (today); copy each file after its index attempt | **After its index attempt.** Today the walk copies every new or changed file (`sync.ts` 217-258) before indexing any (296-342), and the next sync skips a file whose archive copy is current (`copyIfNewer` 143-149): checked, an archived never-indexed conversation gives `Copied: 0, Skipped: 1, Indexed: 0`. The walk records each file that needs copying with the source mtime it saw. The index loop parses the source file with the archive path as `archivePath`, inserts its new exchanges, then copies it (temp file and rename, as now) and sets the copy's mtime to the source mtime recorded before parsing, so a source that grew meanwhile is copied again next time. It copies after a failed or DO-NOT-INDEX attempt too, as today. When indexing is skipped or the embedding backend is unavailable, the walk's files are copied before summaries, as now. The summary queue checks the DO-NOT-INDEX marker on the source file while its archive copy does not exist yet, and a file whose copy failed is not summarized. Cost: a file reaches the archive only when its index attempt runs, so a backlog larger than one deadline's indexing reaches the archive over several syncs, and a source deleted before its turn (Claude Code's `cleanupPeriodDays`, a user deleting a transcript) is never archived; today's order would have kept it. |
| D9 | A held per-user lock found compromised | throw from the timer (proper-lockfile default, today); continue; stop | **Stop when taken over, continue when it vanished.** `acquireFileLock` accepts an `onCompromised` handler. When the lock directory exists with an mtime not its own (another sync took it), the child logs a warn line naming the new holder's PID and exits 0 after releasing its per-config-dir lock (Inv 1). When the directory is gone (ENOENT, a cleaned temp dir), it logs a warn line and continues under its per-config-dir lock and the deadline (Inv 5). The per-config-dir lock keeps today's behaviour. Today's default throws from a timer (`proper-lockfile/lib/lockfile.js` 120-139, 200, 213). |

## Acceptance criteria

1. With `EPISODIC_MEMORY_EMBED_THREADS` unset, `resolveIntraOpThreads()` returns 2 on every platform, and
   the session options passed to the pipeline set `intraOpNumThreads` 2, `interOpNumThreads` 1 and
   `extra['session.intra_op.allow_spinning']` `'0'`. An explicit positive override wins; `0` keeps the
   onnxruntime default, and spinning is still off. An empty and a non-numeric value keep the default 2.
2. A background sync child exits with code 124 after `EPISODIC_MEMORY_SYNC_TIMEOUT_MS` (default
   1,800,000), having released both locks and logged a warning that names the deadline. `0` disables it;
   an empty and a non-numeric value keep the default. A sync that finishes before the deadline exits at once
   with its own code. A foreground sync arms no deadline.
3. A background sync child runs at nice 10, set before any embedding session exists. A foreground sync keeps its priority.
4. While one background sync holds the per-user lock, a second background sync with a different `HOME`,
   `EPISODIC_MEMORY_CONFIG_DIR` and `TMPDIR` and the same `XDG_RUNTIME_DIR` exits 0 without syncing and says which
   pid holds it. With `XDG_RUNTIME_DIR` unset, the lock is in `os.tmpdir()`. A foreground `sync` does not take the lock.
5. A lock failure other than contention (for example an unwritable lock directory) is logged at warn and does
   not stop the sync (the per-config-dir lock still applies): a service never refuses to start over a file it writes.
   A lock found compromised follows D9.
6. After a deadline exit, the next sync indexes every exchange the interrupted sync did not (D8).
7. README documents the new default, `EPISODIC_MEMORY_SYNC_TIMEOUT_MS` and the per-user lock.
8. Acceptance run under `arm-run`: a background sync child over a copy of 200 real conversations, with an isolated config dir
   and lock root and `EPISODIC_MEMORY_SKIP_SUMMARIES=1`, averages at most 2.5 cores over 60 s of indexing. Sampled once a second
   over that window, at most 3 of its threads are in state R and every thread onnxruntime created has nice 10. With
   `EPISODIC_MEMORY_SYNC_TIMEOUT_MS=120000` it exits 124 with the warn line and leaves no lock directory. A second run
   without the deadline finishes the index: the distinct `archive_path` count in `exchanges` equals the number of indexable conversations.

## Invariants

1. At most one background sync continues past its next heartbeat while holding the per-user lock (a taken-over holder stops, D9).
2. A process that exits (normal, signal or deadline) releases both locks it holds, and never deletes a successor's PID file.
3. After a deadline exit, the next sync indexes every exchange the interrupted sync did not: a file's archive copy is brought
   up to date only after its exchanges are inserted or its index attempt failed, and the high-water mark resumes a partly indexed file.
4. The deadline timer and nice setting never apply to a foreground sync.
5. A lock error other than contention never stops a sync, and a lock that vanished never throws from a timer.

## Transitions

| State | Event | Guard | Next state | Side effect |
|---|---|---|---|---|
| none | hook runs `sync --background` | DISABLE_AUTO_SYNC is not `1` | parent logs and spawns child | child marked by `EPISODIC_MEMORY_BACKGROUND_CHILD=1` |
| child starting | per-config-dir lock busy | | exit 0 | message (today) |
| child starting | per-user lock busy | | exit 0 | message with holder pid (or "another process" when the PID file is empty) |
| child starting | per-user lock error other than contention | | running (per-config-dir lock only) | warn line |
| child starting | both locks held | | running | nice 10; deadline timer armed |
| running | deadline fires | | exit 124 | release locks; warn line |
| running | heartbeat finds the per-user lock taken over | | exit 0 | release per-config-dir lock; warn line with the new holder's pid |
| running | per-user lock directory removed | | running (per-config-dir lock only) | warn line |
| running | done / SIGTERM / SIGINT / SIGHUP | | exit | release locks |

## Writers

| # | Writer | Reads | Writes | Write rule | Gaps |
|---|---|---|---|---|---|
| W1 | background sync child acquiring the per-user lock (each concurrent child is its own row: W1a, W1b) | `<lock>.lock/` existence and mtime | `mkdir <lock>.lock/`, then `<lock>` (holder PID) | mkdir create-if-absent (atomic); PID file overwritten | G1 mkdir to PID write: a contender reads the previous or no PID. G2 stale path `stat`, `rmdir`, `mkdir` (proper-lockfile `acquireLock`): a second stealer can remove the first stealer's fresh lock, so both acquire |
| W2 | per-user lock heartbeat (proper-lockfile timer, every 5 min, in W1's process) | `<lock>.lock/` mtime | `utimes <lock>.lock/` | update while the mtime is its own, else compromised (D9) | G3 `stat` to `utimes`: a stealer can replace the directory between them |
| W3 | per-user lock release (normal exit, signals, deadline, proper-lockfile's exit hook) | its PID file | unlink `<lock>` if it holds its own PID, then `rmdir <lock>.lock/` | delete | G4: after a takeover, a release that reads its own PID just before the successor writes its file deletes the successor's file (diagnostic only). Otherwise none (today `rmdir` comes first and can delete the next holder's PID file) |
| W4 | background sync child, per-config-dir lock | as W1 | as W1 | as W1 | G1, G2, G3 |
| W5 | foreground `sync` (no child marker), per-config-dir lock | as W4 | as W4 | as W4 | as W4 |
| W6 | `index-cli` (every command), per-config-dir lock | as W4 | as W4 | as W4 | as W4 |

No guarded reader: `readLockHolder` only prints the PID it reads. G1 stays: the busy line may name the previous holder.
G2 and G3 are proper-lockfile's own: the loser finds its lock compromised at its next heartbeat, within 5 minutes, and acts as D9 says.
The interleaving test is required (verification list).

## Live-only items

The CPU and thread-state measurement of AC 8 needs a real model load and a real corpus. It runs as the recorded acceptance run under `arm-run`.

## Verification list

| AC / Inv | Test |
|---|---|
| 1 | `test/embed-threads.test.ts` (updated: default is 2 everywhere; empty and non-numeric keep 2); `buildEmbeddingSessionOptions` cases in the same file; `test/embeddings-session-options.test.ts` (the pipeline receives them) |
| 2 | `test/sync-limits.test.ts` (parse, clamp above the timer limit, timer fires and is unref'd); `test/sync-cli-background.test.ts` (exit 124 at the deadline with both lock directories gone; a foreground sync with the same deadline completes) |
| 3 | `test/sync-limits.test.ts`: `lowerBackgroundPriority` with an injected `setPriority`, and `startBackgroundSyncLimits` with injected hooks (priority first, then lock, then deadline; none for a foreground sync); `test/sync-cli-background.test.ts` (priority set before the sync starts; none in the foreground); thread nice values by the AC 8 run |
| 4, 5 | `test/sync-global-lock.test.ts`: the test takes the per-user lock with `acquireFileLock` on the resolved path, then runs `dist/sync-cli.js` with the child marker, its own `HOME` and `EPISODIC_MEMORY_CONFIG_DIR`, a different `TMPDIR` and the shared lock root. It asserts exit 0, no copy, and output naming the test's pid. A foreground run with the same env syncs. With an unwritable lock root the child logs a warn line and syncs |
| 6, Inv 3 | `test/sync-deadline-resume.test.ts`: `syncConversations` over three files with an embedder that never resolves on the second file's first exchange; the test abandons that run, as a hard exit would, then runs a second sync with a working embedder and asserts every exchange of all three files is indexed once and all three archive copies exist. On today's code the second sync indexes neither the second nor the third file |
| Inv 1, 2, 5 | `test/sync-user-lock-interleaving.test.ts`: `acquireFileLock` takes an injected `fs` (proper-lockfile's `fs` option) and update interval. Two acquirers of a stale per-user lock, each held between its `stat` and its `rmdir` (G2) while the other runs; a holder held between `stat` and `utimes` (G3) while a stealer runs; a releaser held between its PID-file unlink and its `rmdir` while a contender acquires. After each step: at most one process continues past its next heartbeat (Inv 1), the PID file names the live holder, and a compromised holder acts as D9 says instead of throwing (Inv 5) |
| 7 | review reads the README |
| 8 | recorded acceptance run |

The update to `embed-threads.test.ts` rewrites the "null elsewhere" assertion to the new contract; it does not weaken it.

## Task list

1. Embeddings: `resolveIntraOpThreads` default 2 with strict parsing, `buildEmbeddingSessionOptions` with spin off; tests.
2. `src/sync-limits.ts`: `startSyncDeadline`, `lowerBackgroundPriority`, `acquireUserSyncSlot`; `file-lock.ts` takes `onCompromised`, an injectable `fs` and release order (PID file, then directory); tests.
3. `src/sync.ts`: copy each file after its index attempt (D8); `test/sync-deadline-resume.test.ts`.
4. Wire into `src/sync-cli.ts` (child marker, lock order, nice before model load, release on every exit path); `test/setup-isolated-config.ts` sets `TMPDIR` and `XDG_RUNTIME_DIR` under its isolated root so no test takes the developer's real per-user lock; build `dist/`; tests for AC 4 and 5 and the interleaving test.
5. README and docs.
6. Acceptance run (AC 8) and final review. Environment: run `npm rebuild better-sqlite3` in the worktree; the embedding model is cached only in the main checkout's `node_modules`.

## Docs impact

`README.md` (environment variables and background-sync notes). The repository has no overview doc; none is added.

## Downstream check

The user's real index may already hold archived but never indexed conversations from syncs killed mid-index. A read-only check on 2026-11-12: 7,013 archived files, 3,864 distinct indexed, 3,149 without rows; 2,169 of those are under 2 KB (zero-exchange files, expected) and 980 are larger and may be genuinely unindexed (unverified: sidechain and DO-NOT-INDEX files are skipped by design). The repair, `episodic-memory index --cleanup --no-summaries`, writes user data and needs the user's go-ahead.

## Consistency with AGT-329

This change also edits `sync.ts` (D8); AGT-329 rebases on it. A deadline exit during a summary writes no error sentinel, so that
conversation is retried first on the next sync. Once AGT-329 replaces the 120 s per-call wall-clock limit with a progress-based one,
the 30-minute deadline is the only wall-clock bound on a summary, and AGT-329's backoff counts a deadline-interrupted summary as an attempt.
D5's nice 10 is why AGT-329 must stop counting starvation as failure.
