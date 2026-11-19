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
| D8 | How a sync remembers a copy is archived but not yet indexed | copy every file in the walk, then index (today: the next sync skips an archived file whose copy is current, so a hard stop loses its index); copy each file after its index attempt; copy in the walk and carry the pending state in the copy's mtime (stamped below the source); copy in the walk and record each pending copy in the index database | **Copy in the walk, index that copy, and record each copy in a `pending_index` table of the index database until its index attempt ends.** Three earlier versions failed review. Copying only after the index attempt lost data: a sync that stops before a file's turn leaves it unarchived, and a source deleted by Claude Code's `cleanupPeriodDays` before the next sync is gone (probe: main kept it). Indexing from the source lost index entries: a source removed after the walk and before its turn was never indexed (main indexed 3 of 3, that version 1 of 3). Carrying the pending state in the copy's mtime failed on filesystems that round times up, that will not read a stamp back below the source, and that refuse to set file times (the conversation was neither archived nor indexed; main archives it but never indexes it): the advisor's design review found one cause, a state stored in a filesystem feature that varies by mount, and prototyped the table (264 of 264 stop-point cases over 3 filesystems, against 64 of 88 refused-times cases failing with the stamp fix). The walk inserts a file's archive path into `pending_index` before the copy is renamed into place; the copy is stamped like main's, from the walk's stat (a refused stamp keeps the copy with its copy time and is reported); the index loop reads that copy and deletes the row after the file's index attempt (indexed, failed, DO-NOT-INDEX or no exchanges); the walk also indexes any current copy whose row is still present. When the embedding backend is unavailable the rows stay, so a later sync indexes those copies while their sources exist. When the database cannot be opened the walk still archives every file, reports `(index database)` once per source directory, and that run indexes nothing; no later sync indexes those copies (as on main), so the report names `episodic-memory index --cleanup`, which indexes them while their sources exist (U3). A copy whose row insert fails is reported the same way. The table is additive (older code ignores it; `index-cli rebuild` deletes it with the database); sync.ts is the only writer of its rows; every `initDatabase` caller creates the empty table. Cost: the walk opens the index database and reads `pending_index` once per source directory; one autocommit INSERT and one DELETE per copied file (about 2-3 ms each on the HDD scratch filesystem; a sync at steady state copies a handful); the table holds only unfinished copies and copies whose sources were removed (SELECT 0.16 ms empty, 14 ms at 7,000 rows). An existing table needs no write lock to open; only its first creation waits on a writer, within `busy_timeout` 5000. |
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
6. After a deadline exit, the next sync indexes every exchange the interrupted sync did not, for each conversation whose source still exists when it runs and whose copy the interrupted sync recorded (D8, U2, U3).
7. README documents the new default, `EPISODIC_MEMORY_SYNC_TIMEOUT_MS` and the per-user lock.
8. Acceptance run under `arm-run`: a background sync child over a copy of 200 real conversations, with an isolated config dir
   and lock root and `EPISODIC_MEMORY_SKIP_SUMMARIES=1`, averages at most 2.5 cores over the indexing window. Sampled once a second
   over that window, the median count of threads in state R is at most 2, no sample shows more than 6 (model-load and file-read
   helper threads), and the process has at most 12 threads (42 before). In a separate short run started at nice 0 outside `arm-run` (whose CPU guard
   renices every job to `JOB_NICE`, 10 on this host; a few conversations, ended by the deadline), the main thread, the libuv pool and the onnxruntime worker have nice 10; the
   V8 platform threads created at start-up keep nice 0 (D5). With `EPISODIC_MEMORY_SYNC_TIMEOUT_MS` shorter than the indexing window
   (20000 in the recorded run, which indexed the corpus in 46 s) it exits 124 with the warn line and leaves no lock directory. A second run
   without the deadline finishes the index: the distinct `archive_path` count in `exchanges` equals the number of indexable conversations.

## Invariants

1. At most one background sync continues past its next heartbeat while holding the per-user lock (a taken-over holder stops, D9).
2. A process that exits (normal, signal or deadline) releases both locks it holds, and never deletes a successor's PID file.
3. After a deadline exit, the next sync indexes every exchange the interrupted sync did not, for each conversation whose source still exists when that sync walks and whose copy the interrupted sync recorded: the walk records each copy in `pending_index` before the copy can look current, and the record is deleted only after the copy's index attempt (until then the copy is archived but pending, whatever its mtime), and the high-water mark resumes a partly indexed file. A pending copy whose source is removed before then stays archived and unindexed; `episodic-memory index --repair` indexes it when it has no summary or an error sentinel, or index rows older than the copy, and its summary can be generated (it summarises first; a failing summariser leaves it unindexed); a pending copy that already has a real summary and no index rows is not seen by `index --repair`; both are tracked in AGT-336. An `index --cleanup` stopped part-way may leave a partly indexed copy current until `index --cleanup` runs again (U2). A copy the walk could not record (the index database could not be opened or loaded, or refused the row; each reported) is indexed only if that run reaches it, as on main; `episodic-memory index --cleanup` indexes it while its source exists (U3).
4. The deadline timer and nice setting never apply to a foreground sync.
5. A per-user lock error other than contention never stops a sync, and a per-user lock that vanished never throws from a timer; the per-config-dir and migration locks keep the library's behaviour (D9).

## Transitions

| State | Event | Guard | Next state | Side effect |
|---|---|---|---|---|
| none | hook runs `sync --background` | DISABLE_AUTO_SYNC is not `1` | parent logs and spawns child | child marked by `EPISODIC_MEMORY_BACKGROUND_CHILD=1` |
| child starting | per-config-dir lock busy | | exit 0 | message (today) |
| child starting | per-user lock busy | | exit 0 | message with holder pid (or "another process" when the PID file is empty) |
| child starting | per-user lock error other than contention | | running (per-config-dir lock only) | warn line; deadline timer armed |
| child starting | per-config-dir lock held | | taking the per-user lock | nice 10, before any embedding session |
| child starting | per-user lock held | | running | deadline timer armed |
| running | deadline fires | | exit 124 | release locks; warn line |
| running | heartbeat finds the per-user lock taken over | | exit 0 | release per-config-dir lock; warn line with the new holder's pid |
| running | per-user lock directory removed | | running (per-config-dir lock only) | warn line |
| running | done / SIGTERM / SIGINT / SIGHUP | | exit | release locks |

Archive copy of one conversation (pending means a `pending_index` row is present):

| State | Event | Guard | Next state | Side effect |
|---|---|---|---|---|
| absent or older than the source | walk | row inserted, copy succeeds | pending | W8, then W7 |
| absent or older than the source | walk | row insert fails | copied, not recorded | error reported, naming `index --cleanup`; indexed only if this run reaches it, as on main (U3) |
| absent or older than the source | walk | stamp refused | pending | copy kept with its copy time; error reported |
| absent or older than the source | walk | row inserted, copy fails | row present, copy unchanged | error reported; the next walk copies it again and the row is kept |
| pending | index attempt ends (indexed, failed, DO-NOT-INDEX, no exchanges) | | indexed | row deleted (W11) |
| pending | row delete fails | | pending | error reported; the next sync re-reads from the high-water mark and deletes the row |
| pending | embedding backend unavailable | | pending | rows stay; a later sync indexes the copy while its source exists |
| pending | the sync stops | source exists at the next walk | pending | the next sync's walk finds the row and indexes the copy |
| pending | the sync stops, then the source is removed before the next walk | | pending, unindexed | the walk does not visit a removed source, so the row stays; U2 narrows this case; `index --repair` indexes it when its summary can be generated |
| pending (partly indexed) | `index --cleanup` copies it | | partly indexed copy, row kept | W10; the next sync clears the row |
| pending | `index-cli rebuild` | | not pending | W12; re-indexed from its source when the source exists, else by `index --repair` |
| any | source removed | | unchanged | the copy is kept |

## Writers

| # | Writer | Reads | Writes | Write rule | Gaps |
|---|---|---|---|---|---|
| W1 | background sync child acquiring the per-user lock (each concurrent child is its own row: W1a, W1b) | `<lock>.lock/` existence and mtime | `mkdir <lock>.lock/`, then `<lock>` (holder PID) | mkdir create-if-absent (atomic); PID file overwritten | G1 mkdir to PID write: a contender reads the previous or no PID. G2 stale path `stat`, `rmdir`, `mkdir` (proper-lockfile `acquireLock`): a second stealer can remove the first stealer's fresh lock, so both acquire |
| W2 | per-user lock heartbeat (proper-lockfile timer, every 5 min, in W1's process) | `<lock>.lock/` mtime | `utimes <lock>.lock/` | update while the mtime is its own, else compromised (D9) | G3 `stat` to `utimes`: a stealer can replace the directory between them |
| W3 | per-user lock release (normal exit, signals, deadline, proper-lockfile's exit hook) | its PID file | unlink `<lock>` if it holds its own PID, then `rmdir <lock>.lock/` | delete | G4: after a takeover, a release that reads its own PID just before the successor writes its file deletes the successor's file (diagnostic only). Otherwise none (today `rmdir` comes first and can delete the next holder's PID file) |
| W4 | background sync child, per-config-dir lock | as W1 | as W1 | as W1 | G1, G2, G3 |
| W5 | foreground `sync` (no child marker), per-config-dir lock | as W4 | as W4 | as W4 | as W4 |
| W6 | `index-cli` (every command), per-config-dir lock | as W4 | as W4 | as W4 | as W4 |
| W7 | the sync walk (in W4 and W5) writing an archive copy | source stat and archive mtime (`archiveIsCurrent`) | archive file, stamped from the walk's source stat (as on main) | copy to a temp file, stamp it (a refused stamp is reported), then rename | none across processes: every writer of one archive, W9 and W10 included, holds the per-config-dir lock |
| W8 | the sync walk recording a pending copy (in W4 and W5) | none (`INSERT OR IGNORE`) | one row per copy to archive | `INSERT OR IGNORE`, before W7's rename | none across processes beyond W4's G2/G3, as for W7 (per-config-dir lock; SQLite serialises the writes); a stop between W8 and W7 leaves a row with no copy, which the next walk copies again |
| W9 | `index-cli` `index-all`, `rebuild` and `index-session` (`indexConversations`, `indexSession`; in W6) | archive file existence | archive file copied from the source when absent, stamped at copy time (current) | `copyFileSync` to the archive path | none across processes (W6's lock); a copy whose row is present keeps it, and the next sync indexes it from the high-water mark |
| W10 | `index-cli` `index-cleanup` (`indexUnprocessed`; in W6) | archive file existence and the high-water mark | archive file copied from the source when absent or partly indexed, stamped at copy time (current) | `copyFileSync` to the archive path | none across processes (W6's lock); a stop after the copy and before the run's index ends leaves a partly indexed copy current (Inv 3) |
| W11 | the sync index loop (in W4 and W5) | the `pending_index` row and the high-water mark | deletes the row after the file's index attempt | `DELETE` | none across processes beyond W4's G2/G3, as for W7; a stop before it leaves the row, and the next sync resumes from the high-water mark |
| R1 | the sync walk's pending check (in W4 and W5), a guarded reader | the `pending_index` rows, read once at sync start (`listIndexPending`) | guards indexing a current copy and W11's delete | check-to-act gap: the walk, the embedding-backend load and each earlier file's index (awaits) | none across processes beyond W4's G2/G3, as for W7 |
| W12 | `index-cli rebuild` (in W6) | | the index database file and every summary file | deletes them; the pending rows go with the database | none: it holds the per-config-dir lock. The rebuild re-indexes each conversation whose source exists (`indexConversations` walks the source directories); a copy whose source is gone loses its row and its summary, so `index --repair` sees it as missing and indexes it |

`verify` reads the archive mtime against `last_indexed` (`verify.ts` 78-89) as on main; the mtime no longer carries the pending state.

Guarded readers: R1; `readLockHolder` only prints the PID it reads. G1 stays: the busy line may name the previous holder.
G2 and G3 are proper-lockfile's own: the loser finds its lock compromised at its next heartbeat, within 5 minutes, and acts as D9 says.
The interleaving test is required (verification list).

## Live-only items

The CPU and thread-state measurement of AC 8 needs a real model load and a real corpus. It runs as the recorded acceptance run under `arm-run`.

## Verification list

| AC / Inv | Test |
|---|---|
| 1 | `test/embed-threads.test.ts` (updated: default is 2 everywhere; empty and non-numeric keep 2); `buildEmbeddingSessionOptions` cases in the same file; `test/embeddings-session-options.test.ts` (the pipeline receives them) |
| 2 | `test/sync-limits.test.ts` (parse, clamp above the timer limit, timer fires); `test/sync-cli-background.test.ts` (exit 124 at the deadline with both lock directories gone; a foreground sync with the same deadline completes; a process left with only the deadline timer exits 0 before it fires) |
| 3 | `test/sync-limits.test.ts`: `lowerBackgroundPriority` with an injected `setPriority`, and `startBackgroundSyncLimits` with injected hooks (priority first, then lock, then deadline; none for a foreground sync); `test/sync-cli-background.test.ts` (priority set before the sync starts; none in the foreground); thread nice values by AC 8's nice-0 run |
| 4, 5 | `test/sync-global-lock.test.ts`: the test takes the per-user lock with `acquireFileLock` on the resolved path, then runs `dist/sync-cli.js` with the child marker, its own `HOME` and `EPISODIC_MEMORY_CONFIG_DIR`, a different `TMPDIR` and the shared lock root. It asserts exit 0, output naming the test's pid, and that the child never opened its index database. A foreground run with the same env syncs. With an unwritable lock root the child logs a warn line and syncs |
| 6, Inv 3 | `test/sync-deadline-resume.test.ts`: `syncConversations` over three files with an embedder that never resolves on the second file's first exchange; the test abandons that run, as a hard exit would, then runs a second sync with a working embedder and asserts every exchange of all three files is indexed once and all three archive copies exist; the same on a filesystem that rounds file times up to 2 s and on one that refuses to set file times; copies made while the embedding backend was unavailable are indexed by the next sync; a source removed after the walk and before its turn is still indexed from its walk copy; a finished run leaves no pending record and a second run reads nothing again; a row whose delete is refused stays and is reported, and the next sync re-reads the copy from the high-water mark, embeds nothing twice and deletes the row; a run that cannot open the index database, and one whose row insert is refused, report the file naming `index --cleanup` and still archive it (`index --cleanup` indexes such a copy while its source exists, shown by the review's probe) |
| Inv 1, 2, 5 | `test/sync-user-lock-interleaving.test.ts`: `acquireFileLock` takes an injected `fs` (proper-lockfile's `fs` option) and update interval. Two acquirers of a stale per-user lock, the first held between its stale check and its `rmdir` (G2) while the second acquires: exactly one is stopped as taken over (Inv 1); a holder held between `stat` and `utimes` (G3) while a stealer runs: the stealer is stopped, the holder is not; a contender that acquires the moment a releaser's `rmdir` returns keeps its PID file, and a taken-over holder's release leaves the successor's lock and PID file (Inv 2); a vanished lock is reported, not thrown (Inv 5), and a lock taken without a handler still stops its holder (D9) |
| Inv 3 | `test/sync-deadline-resume.test.ts` (as above) and `test/sync-index-db-unavailable.test.ts`: when the index database cannot be opened or loaded every conversation is still archived and `(index database)` is reported once per source directory |
| Safety (standing) | `test/sync-deadline-resume.test.ts`: a conversation whose source is removed after a run abandoned mid-index stays in the archive; an archive filesystem that refuses to set file times still archives and indexes every conversation, reports each copy and leaves no temp copy; `test/sync-archive-failure.test.ts`: a source removed during its index is indexed from the walk copy, the copy stays and nothing is reported as an error |
| 7 | review reads the README |
| 8 | recorded acceptance run |

The update to `embed-threads.test.ts` rewrites the "null elsewhere" assertion to the new contract; it does not weaken it.

## Task list

1. Embeddings: `resolveIntraOpThreads` default 2 with strict parsing, `buildEmbeddingSessionOptions` with spin off; tests.
2. `src/sync-limits.ts`: `startSyncDeadline`, `lowerBackgroundPriority`, `acquireUserSyncSlot`; `file-lock.ts` takes `onCompromised`, an injectable `fs` and release order (PID file, then directory); tests.
3. `src/db.ts` (`pending_index` table and its three accessors) and `src/sync.ts`: record each copy in the walk, index that copy, delete the record after the index attempt (D8); `test/sync-deadline-resume.test.ts`, `test/sync-archive-failure.test.ts`, `test/sync-index-db-unavailable.test.ts`; skip the index phase, including the embedding-model load, when the index database did not open.
4. Wire into `src/sync-cli.ts` (child marker, lock order, nice before model load, release on every exit path); `test/setup-isolated-config.ts` sets `TMPDIR` and `XDG_RUNTIME_DIR` under its isolated root so no test takes the developer's real per-user lock; build `dist/`; tests for AC 4 and 5 and the interleaving test.
5. README and docs.
6. Acceptance run (AC 8) and final review. Environment: run `npm rebuild better-sqlite3` in the worktree; the embedding model is cached only in the main checkout's `node_modules`.

## Docs impact

`README.md` (environment variables and background-sync notes) and `docs/SCHEMA.md` (the `pending_index` table). The repository has no overview doc; none is added.

## Downstream check

The user's real index may already hold archived but never indexed conversations from syncs killed mid-index. A read-only check on 2026-11-12: 7,013 archived files, 3,864 distinct indexed, 3,149 without rows; 2,169 of those are under 2 KB (zero-exchange files, expected) and 980 are larger and may be genuinely unindexed (unverified: sidechain and DO-NOT-INDEX files are skipped by design). The repair, `episodic-memory index --cleanup --no-summaries`, writes user data and needs the user's go-ahead. Do not run it until AGT-336 F1 lands: `index --cleanup`, index-all, rebuild, index-session and `index --repair` do not honour the DO NOT INDEX marker, so they would index every marked conversation whose source still exists.

## Consistency with AGT-329

This change also edits `sync.ts` (D8); AGT-329 rebases on it. A deadline exit during a summary writes no error sentinel, so that
conversation is retried first on the next sync. Once AGT-329 replaces the 120 s per-call wall-clock limit with a progress-based one,
the 30-minute deadline is the only wall-clock bound on a summary, and AGT-329's backoff counts a deadline-interrupted summary as an attempt.
D5's nice 10 is why AGT-329 must stop counting starvation as failure.
