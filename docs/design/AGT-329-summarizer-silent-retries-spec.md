# AGT-329: the summarizer reports an overloaded API as a timeout, and a sync keeps trying

Ticket: AGT-329. Built after AGT-328 (merged). Follow-ups already filed: AGT-336, AGT-337.

## Goal

Summaries failed 111 times with "Summarizer query timed out after 120000ms" (`grep -c 'Summarizer query timed out after 120000ms'` over the sync log, `getSyncLogPath()`, src/logging.ts:15; 6 to 12 November), and a batch kept calling the model after the first failures. The investigation (2026-11-13) found:

- **CPU starvation is not the cause.** A resume of a session that had timed out four times took 4.3 s at load 116, and a minimal call 2.3 s at load 88 (timed with the SDK's `query()` from scratch scripts, `uptime` beside each).
- **A silent retry loop is.** The summarizer's subprocess inherits the harness environment, which carries `CLAUDE_CODE_MAX_RETRIES=100` and `CLAUDE_CODE_RETRY_WATCHDOG=1` (read from `/proc/<pid>/environ` of the stuck syncs on 2026-11-12). Against a local server that always answers HTTP 529, the SDK subprocess (0.2.141) with the default retry count (10), with 100, and with 2 while `CLAUDE_CODE_RETRY_WATCHDOG=1` was still retrying after 45 s with no output (6 model requests): watchdog mode retries 429 and 529 without the retry count's bound (waits up to 5 min, for up to 6 h). With the watchdog off and `CLAUDE_CODE_MAX_RETRIES` 0, 1 and 2 it returned `is_error`, `api_error_status` 529 after 1, 2 and 3 model requests (0.9, 1.5 and 2.7 s run alone). A 429 behaves like a 529; a 500 is bounded by the retry count even with the watchdog on. So an overloaded or rate-limited API shows up in the log as a bare 120 s timeout. That the API was overloaded at the incident times is inferred (no log of it exists); the mechanism is demonstrated.
- **"Not logged in"** (9 to 16 September) arrives as `subtype: success` with the text in `result` and is not matched by `isAuthFailure`, so the batch went on.
- Each sync summarises at most 10 conversations per source directory (`--summary-limit`, src/sync-cli.ts:68 and 233-240; up to seven source directories, src/paths.ts:108-116), so a failing API costs up to 10 attempts of 120 s per source per sync. The stop (D2) is per source: a Codex source's conversations use the Codex summarizer, which a Claude failure does not stop; after this change a global failure costs each other source one call of a few seconds.
- **Long conversations hide failures.** A conversation of more than 15 exchanges is summarised in chunks, and the chunk and synthesis catches skip every error (summarizer.ts:823-831 and 854-860). Probe on the built code against a 529 server: a 16-exchange conversation's chunk calls were skipped silently, sync went on to the next conversation, and wrote `Error: Unable to summarize conversation.` as the summary, counted it in `summarized`, and never retried it (`shouldQueueForSummary` false). This is pre-existing and probably also what the September "Not logged in" period left behind.

## Decisions

| # | Decision | Options | Choice and reason |
|---|---|---|---|
| D1 | Retry count and watchdog of the summarizer subprocess | inherited (today: 100 and watchdog 1 in agent sessions); 0; 2; 3 | **2**, always set by the summarizer, replacing an inherited value, and `CLAUDE_CODE_RETRY_WATCHDOG` always set to `0`: with the watchdog on, the SDK retries 429 and 529 without the retry count's bound (probe: retries 2 with the watchdog on still retrying after 45 s). `EPISODIC_MEMORY_API_MAX_RETRIES` (a non-negative integer) overrides the count; an invalid value keeps 2 and warns. Measured with the watchdog off: a 529 comes back as a clear error after 1, 2 and 3 model requests for 0, 1 and 2 retries; two retries absorb a transient blip. |
| D2 | What stops a summary batch | per-file failure only (today, plus expired auth); stop on any global failure; stop on the first suspect failure | **Stop the batch at a global failure, and at the second consecutive suspect one.** `classifySummaryFailure(error)` in `src/summarizer.ts` returns `{ kind: 'global' | 'suspect', cause }` or null. Global, stopping at once: auth (`isAuthFailure`, now including "Not logged in"), HTTP 429, 503 or 529, and a 400 whose text says the credit balance is too low; none of these is one conversation's own. Suspect: a `SummarizerTimeoutError` or any other 5xx (500, 502, 504); either can be one conversation's own (a huge resumed session, a request a proxy cannot serve), so one alone does not stop, and the second consecutive one does. Any call that returns (a summary, or a per-file error such as a 400) resets the count. Stopping at the first suspect failure would lock the conversations behind one that always fails into its retry cycle (the walk order is fixed and their sentinels come due together): the head-of-queue block #96 removed (CHANGELOG.md, #96). The files not yet tried get an error sentinel that names the cause, as the existing auth stop does, so they retry after the existing retry interval (`EPISODIC_MEMORY_SUMMARY_ERROR_RETRY_HOURS`, default 1 h), not on the next session start. Inside `summarizeConversation`: the chunk and synthesis calls of a conversation of more than 15 exchanges rethrow a global or suspect failure instead of skipping the chunk (summarizer.ts:823-831 and 854-860 skip every error today, so the stop would never see one); a conversation for which no chunk produced a summary throws instead of returning `Error: Unable to summarize conversation.`, which sync writes today as a summary and never retries; the resume fallback is skipped for any classified failure, not only auth (every 400 counts as a resume failure, so a credit-balance 400 would pay a second call); and when a Codex conversation's Codex call failed, the failure of its Claude fallback is that conversation's own (the Codex path needs no Claude login or capacity), thrown as a per-file error naming both, so a Codex-only user with no Claude login is not stopped by one conversation Codex cannot fork. Residual: two adjacent conversations that each fail with a suspect failure every time still hold the ones behind them; before this change they cost 2 x 120 s per sync instead, and `fix/summary-retry-policy` removes it (zero-attempt skipped files sort before retries). |
| D3 | Not done | load-aware skip; progress-based timeout; cross-sync backoff | **None of the three.** The load check and the progress timeout answered a CPU-starvation cause the probes disproved. Backoff across syncs is the user's in-flight work (`fix/summary-retry-policy`: bounded attempts, retry state in the sentinel). This change adds no sentinel field, but both branches rewrite the stop and catch blocks of the summary loop in `src/sync.ts`, so their merge conflicts there and is resolved by hand: the stop path calls `recordSummarySkip`; the catch block chooses `recordSummarySkip` or `recordSummaryFailure` through `classifySummaryFailure`, which lives in `src/summarizer.ts` and so is the single auth-routing entry point that branch's plan (task 3) asks for without the sentinel module importing the summarizer; the three `indexer.ts` writers make the same choice through it. Whether a global failure other than auth spends an attempt is that merge's question for the user: the branch's requirements spend one on every failed call and exempt auth because capping it "would permanently abandon valid conversations while credentials are broken"; a long overload is the same case, so the recommendation is to exempt every global failure and charge suspect ones. |

## Taste choices

The stop messages and the skipped-file report entries follow the existing auth stop's form (sync.ts:423-426, 465-467): the cause, what the user can do, when summaries retry. The override is named after the existing `EPISODIC_MEMORY_API_*` keys (summarizer.ts:134-139). None open.

## Acceptance criteria

1. The summarizer subprocess environment (`getApiEnv`) has `CLAUDE_CODE_MAX_RETRIES` equal to 2 by default and to `EPISODIC_MEMORY_API_MAX_RETRIES` when that is a non-negative integer, and `CLAUDE_CODE_RETRY_WATCHDOG` equal to `0`; neither inherited value (for example 100 and 1) reaches it; an empty or invalid override keeps 2 and warns once.
2. `isAuthFailure` is true for a `SummarizerSdkError` whose detail is "Not logged in · Please run /login" (subtype `success`) and false for an unrelated error.
3. After a failure `classifySummaryFailure` classes as global (auth including "Not logged in", HTTP 429, 503 or 529, a credit-balance 400), that source's summary batch makes no further summarizer call; each untried file gets an error sentinel naming the cause, and its report entry reads `Summary generation skipped: <cause>`; the stop is announced once in the sync log (`Summarizing stopped: <cause>`), not once per skipped file; the cause also appears in each skipped file's report entry. Any other 4xx (for example 400) is per-file, and so is a Codex conversation's Claude-fallback failure.
4. After two consecutive suspect failures (a timeout, or a 5xx other than 503 and 529) the batch stops the same way; one, or two with a returned call (a summary or a per-file error) between them, do not stop it.
5. Acceptance run, from a shell whose environment carries `CLAUDE_CODE_MAX_RETRIES=100` and `CLAUDE_CODE_RETRY_WATCHDOG=1` as agent sessions do: the real SDK subprocess, run through `runSummarizerQuery` with `buildSummarizerQueryOptions` options against a local server that always answers 529, returns a `SummarizerSdkError` with HTTP 529 after exactly 3 `POST /v1/messages` requests and before the summary timeout; the same run with the parent environment passed unchanged makes more than 3 requests and gives no result in 45 s.
6. README documents `EPISODIC_MEMORY_API_MAX_RETRIES` and the stop conditions.
7. For a conversation of more than 15 exchanges, a global or suspect failure in a chunk or synthesis call propagates out of `summarizeConversation`, so AC 3 and AC 4 apply and no later chunk or synthesis call follows it.
8. A conversation for which no chunk call produced a summary ends with an error sentinel, never with summary text: a summary file holds summary text only when a model call returned it.

## State, invariants, Writers

State: each conversation's `<archive>/<project>/<session>-summary.txt`: missing, empty (permanent skip), error sentinel, or summary text; the format is unchanged (D3). The stop cause and the consecutive suspect count are local to one `syncConversations` call (one source).

### Invariants
1. The stop path writes an error sentinel only to a file the walk queued (missing, or an error sentinel past the retry interval); it never overwrites summary text or an empty sentinel.
2. A summary file holds summary text only when a model call returned it for that conversation, or the trivial-conversation placeholder for one that needs no call (AC 8).
3. After a stop, that `syncConversations` call makes no summarizer call.
4. An error sentinel written by a failure or a stop comes due after the retry interval, never earlier.

### Transitions (one summary file, within one sync)
| State | Event | Guard | Next state | Side effect |
|---|---|---|---|---|
| queued (missing, or error sentinel past the interval) | summary returned | none | summary text | `summarized` + 1; count reset |
| queued | no exchanges | none | empty | none |
| queued | per-file failure (for example 400) | none | error sentinel naming it | count reset |
| queued | suspect failure | count 0 | error sentinel naming it | count 1 |
| queued | suspect failure | count 1 | error sentinel naming it | batch stops |
| queued | global failure | none | error sentinel naming it | batch stops |
| queued | reached after the stop | none | error sentinel naming the cause | no call; report entry "Summary generation skipped" |
| error sentinel inside the interval | walk | none | unchanged | not queued |

### Writers
| Writer | Reads | Writes | Write rule | Gaps between read and write |
|---|---|---|---|---|
| sync summary loop (`src/sync.ts` under `sync-cli`), stop path included | the summary file at walk time (`shouldQueueForSummary`, sync.ts:281): a guarded reader | empty sentinel, summary text, error sentinel, skip sentinel (sync.ts:421, 437, 445, 455) | overwrites the whole file | indexing and earlier summaries (awaits) between check and write; no other writer acts in it, since every writer holds the sync lock (sync-cli.ts:202, index-cli.ts:16) |
| a second `sync-cli` (another session's SessionStart) | none | none | none | refused by the sync lock (sync-cli.ts:195-206) |
| `index-cli` indexer paths (indexer.ts:146-160, 262-271, 399-412) | `shouldQueueForSummary` | summary text, error sentinel | overwrites | under the same lock |
| `index-cli --repair` (verify.ts:162-164) | verify's missing and outdated lists | summary text when the call returns; on a failure the file is left as it was and the exchanges are indexed anyway | overwrites | under the same lock |

Readers of the summary file, which already read every state this change writes, a running earlier MCP server included: `search.ts:270` (skips error sentinels), `stats.ts:62` and `verify.ts:64` (an error sentinel counts as missing), and `shouldQueueForSummary` in sync and the indexer. No interleaving test: every writer holds the sync lock across its check-to-write gap. Residual, unchanged by this change: the lock is taken over after 10 minutes without a heartbeat (file-lock.ts:59-62), and the library exports (src/index.ts:5) let an outside caller run the indexer writers without it.

## Live-only items

Whether the real API was overloaded when the 111 timeouts happened cannot be settled offline; AC 5 settles the mechanism against a local server.

Summaries already written whose whole text is `Error: Unable to summarize conversation.` (count: `timeout 120 grep -rlx --include='*-summary.txt' 'Error: Unable to summarize conversation.' <archive dir> | wc -l`). If any exist, the acceptance report gives the user the command that removes them, after which the next sync re-queues them. That is an Authority and Scope ask; the change deletes nothing itself.

## Verification list

| AC | Test |
|---|---|
| 1 | `test/summarizer-retries.test.ts`: `getApiEnv` with an inherited `CLAUDE_CODE_MAX_RETRIES=100` and `CLAUDE_CODE_RETRY_WATCHDOG=1`; with the override 0, 5; empty, "x", "-1", "1.5"; asserts the count, and the watchdog `0` in every case |
| 2 | `test/summarizer-auth-failure.test.ts`: the "Not logged in" error and an unrelated one |
| 3, 4, 7, 8 | `test/sync-summary-stop.test.ts`: `syncConversations` with the SDK's `query` mocked (`vi.mock('@anthropic-ai/claude-agent-sdk')`, as `test/summarizer-resume-fallback.test.ts` does: the model is the process boundary, `summarizeConversation` is code under test): 529, 429, 503 and a credit-balance 400 on the first call (stop); auth and "Not logged in" (stop); 400 (per-file, one resume fallback); 500 then success (no stop); 500 then 502 (stop); timeout, success, timeout (no stop); timeout twice (stop); a 16-exchange conversation whose first chunk gets 529 (stop, no second chunk call); a 16-exchange conversation whose chunks all get 400 (error sentinel, no summary text); a Codex conversation whose Codex call fails (`EPISODIC_MEMORY_CODEX_BIN` stub) and whose Claude fallback says "Not logged in", then a Claude conversation (it is called); asserts the calls made, each summary file's content and the report |
| 5 | recorded acceptance run (script in the ticket comment), from an agent session's shell so the inherited retry and watchdog values are present: local 529 server counting requests; `runSummarizerQuery` with `buildSummarizerQueryOptions` options; then the parent environment unchanged |
| 6 | review reads the README |

## Task list (small change, no plan)

1. `src/summarizer.ts`: retry cap and watchdog off in `getApiEnv`; "Not logged in" in `isAuthFailure`; `classifySummaryFailure`; the chunk and synthesis catches rethrow global and suspect failures; a conversation with no chunk summary throws; the resume-fallback guard and the Codex-fallback wrap use the classifier; tests.
2. `src/sync.ts`: the summary loop stops on a global failure and on the second consecutive suspect one; the stop messages and the comment at sync.ts:410-413 say summaries retry after the retry interval (`EPISODIC_MEMORY_SUMMARY_ERROR_RETRY_HOURS`, default 1 h); `src/sync-cli.ts` prints the "Check your API configuration" hint (sync-cli.ts:283-288) only when no batch stopped on a non-auth cause; tests.
   - Settle in implementation: a conversation that needs no model call (zero exchanges, trivial) neither counts toward nor resets the suspect count; the invalid-override warning latches once per process like `meteredApiWarned` (summarizer.ts:220-243), with a test reset hook.
3. README; acceptance run; the live-archive count (Live-only items).

## Docs impact

`README.md` (environment variables and summary notes).
