# AGT-329: the summarizer reports an overloaded API as a timeout, and a sync keeps trying

Ticket: AGT-329. Built after AGT-328 (merged). Follow-ups already filed: AGT-336, AGT-337.

## Goal

Summaries failed 111 times with "Summarizer query timed out after 120000ms" (6 to 12 November), and a batch kept calling the model after the first failures. The investigation (2026-11-13) found:

- **CPU starvation is not the cause.** A resume of a session that had timed out four times took 4.3 s at load 116, and a minimal call 2.3 s at load 88.
- **A silent retry loop is.** The summarizer's subprocess inherits the harness environment, which carries `CLAUDE_CODE_MAX_RETRIES=100` (observed in the stuck syncs' environment) and `CLAUDE_CODE_RETRY_WATCHDOG=1`. Against a local server that always answers HTTP 529, the SDK subprocess with the default retry count and with 100 was still retrying after 45 s with no output; with `CLAUDE_CODE_MAX_RETRIES` 0, 1 and 2 it returned `is_error`, `api_error_status` 529 after 0.9, 1.5 and 2.7 s. So an overloaded or rate-limited API shows up in the log as a bare 120 s timeout, ten times per sync. That the API was overloaded at the incident times is inferred (no log of it exists); the mechanism is demonstrated.
- **"Not logged in"** (9 to 16 September) arrives as `subtype: success` with the text in `result` and is not matched by `isAuthFailure`, so the batch went on.
- Each sync summarises at most 10 conversations (`--summary-limit`), so a failing API costs up to 10 attempts of 120 s per sync.

## Decisions

| # | Decision | Options | Choice and reason |
|---|---|---|---|
| D1 | Retry count of the summarizer subprocess | inherited (today: 100 in agent sessions); 0; 2; 3 | **2**, always set by the summarizer, replacing an inherited value; `EPISODIC_MEMORY_API_MAX_RETRIES` (a non-negative integer) overrides, an invalid value keeps 2 and warns. Measured: a 529 comes back as a clear error after 0.9 s (0 retries), 1.5 s (1) and 2.7 s (2); two retries absorb a transient blip. |
| D2 | What stops a summary batch | per-file failure only (today, plus expired auth); stop on any global failure | **Stop the batch at the first global failure**: auth (including "Not logged in"), an overloaded or unavailable service (HTTP 429, 529 or any 5xx), and the second consecutive timeout. A success between two timeouts resets the count; one timeout alone does not stop (a single huge session may just be slow). The files not yet tried get an error sentinel that names the cause, as the existing auth stop does, so they retry after the existing retry interval, not on the next session start. |
| D3 | Not done | load-aware skip; progress-based timeout; cross-sync backoff | **None of the three.** The load check and the progress timeout answered a CPU-starvation cause the probes disproved. Backoff across syncs is the user's in-flight work (`fix/summary-retry-policy`: bounded attempts, retry interval in the sentinel); this change adds no sentinel field so the two merge. |

## Acceptance criteria

1. The summarizer subprocess environment (`getApiEnv`) has `CLAUDE_CODE_MAX_RETRIES` equal to 2 by default and to `EPISODIC_MEMORY_API_MAX_RETRIES` when that is a non-negative integer; an inherited `CLAUDE_CODE_MAX_RETRIES` never reaches it; an empty or invalid override keeps 2 and warns once.
2. `isAuthFailure` is true for a `SummarizerSdkError` whose detail is "Not logged in · Please run /login" (subtype `success`) and false for an unrelated error.
3. After a `SummarizerSdkError` with HTTP 429, 529 or 5xx, a sync's summary batch makes no further summarizer call; each untried file gets an error sentinel naming the cause; the report names the cause once. A 4xx other than 401 and 429 (for example 400) is not global.
4. After two consecutive timeouts the batch stops the same way; one timeout, or two timeouts with a success between them, do not stop it.
5. Acceptance run: the real SDK subprocess against a local server that always answers 529 returns a `SummarizerSdkError` with HTTP 529 in under 10 s through the summarizer's own path (default retry cap), where the inherited environment (retries 100) gave no result in 45 s.
6. README documents `EPISODIC_MEMORY_API_MAX_RETRIES` and the stop conditions.

## State, invariants, Writers

None. The batch's stop flag and counters are local to one `syncConversations` call; the sentinel file format is unchanged (D3), and its writers are the ones that exist today. No interleaving case is added.

## Live-only items

Whether the real API was overloaded when the 111 timeouts happened cannot be settled offline; AC 5 settles the mechanism against a local server.

## Verification list

| AC | Test |
|---|---|
| 1 | `test/summarizer-retries.test.ts`: `getApiEnv` with an inherited 100; with the override 0, 5; empty, "x", "-1", "1.5" |
| 2 | `test/summarizer-auth-failure.test.ts`: the "Not logged in" error and an unrelated one |
| 3, 4 | `test/sync-summary-stop.test.ts`: `syncConversations` over four conversations with `summarizeConversation` mocked (process boundary: the model): 529 on the first call, 429, 503, 400 (per-file), auth, timeout then success then timeout (no stop), timeout twice (stop); asserts the calls made, the sentinel text of each skipped file and the report |
| 5 | recorded acceptance run (script in the ticket comment): local 529 server, SDK path through `runSummarizerQuery` with `getApiEnv` options |
| 6 | review reads the README |

## Task list (small change, no plan)

1. `src/summarizer.ts`: retry cap in `getApiEnv`, "Not logged in" in `isAuthFailure`, `globalSummaryFailure(error)` helper (cause text or null), tests.
2. `src/sync.ts`: the summary loop uses the helper and the consecutive-timeout count; tests.
3. README; acceptance run.

## Docs impact

`README.md` (environment variables and summary notes).
