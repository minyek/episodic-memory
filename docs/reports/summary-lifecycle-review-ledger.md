# Summary lifecycle review execution ledger

## Delivery state

Original PR branch: `fix/summarizer-stale-partial-resummary`, head `eab6331` (preserved).

First delivery branch: `fix/summary-retry-policy`, based on upstream `7e06519`.
Working directory: `.worktrees/stale-partial-resummary`.

| Task | Dependencies | Status |
| --- | --- | --- |
| Retry policy, fair queueing and explicit recovery | None | Complete; independently reviewed and full gate passed |
| Truthful coverage, archive refresh and legacy recovery | Retry policy | Not started |
| Quiescence, eligibility before budget and verification policy | Coverage | Not started |

Requirements: [summary lifecycle review](../requirements/summary-lifecycle-review-requirements.md).
Plan: [delivery tasks](../plans/summary-lifecycle-review-plan.md).

## First delivery implementation

- Automatic per-conversation failures stop at the configured cap; invalid configuration falls back to five attempts and a one-hour interval.
- Structured error sentinels retain attempts and the last attempt time. Legacy ISO timestamps remain readable; malformed state is recoverable.
- Sync and all three indexer entry points record failures through the same policy. A global failure (auth, rate limit, overload, no credit) and skipped batch entries preserve the previous count, including zero for work never attempted.
- Existing summary bytes, including existing coverage headers, survive failure or skipping. This piece does not requeue real summaries; task 2 must extend failure recording into coverage state.
- Fresh and zero-attempt skipped work precedes retries before the sync limit. Unsuccessful attempts still consume the per-sync limit.
- Verification identifies exhausted summaries and the CLI prints the reason. The installed `episodic-memory-index --repair` command deliberately bypasses the automatic cap; successful recovery replaces the error sentinel.
- Configuration defaults have a dedicated home in `src/summary-config.ts`. Stale sentinel-format and failure-history comments were removed from touched code.

## Evidence

- Baseline upstream retry/auth tests: 30 passed.
- New regression run before implementation: 33 failed, 11 passed. The cap case made four calls against an expected two; all three indexer cases made three against two. Fresh work lost its queue slot to an old failure.
- Focused suite after implementation: 86 passed across five files.
- Independent read-only review found one issue: the recovery diagnostic named the script rather than the installed executable. Diagnostic and real CLI regression now use `episodic-memory-index --repair`.
- Final gate: build/typecheck passed and all **396 tests in 64 files passed** on Node 22.23.1. Four workers, 19.97 seconds test duration, 22 seconds total arm job, approximately 1 GiB peak memory. Stderr contained expected model-load, lock and injected failure diagnostics; no unresolved gate warnings. `git diff --check` passed. No new responsibilities were added to existing classes; new comments/diagnostics were checked against the comment and sibling-wording rules.
- Initial full gate on `28f0933`: build passed; 395 tests passed, one preexisting timezone assertion in `test/show.test.ts` failed because it used the machine-local timezone. Upstream fixed the same test in #169 (`7e06519`), so the local test-only commit was dropped when the branch was rebased onto that head; production formatting was never changed.
- Focused validation after review/timezone fixes: 36 passed across the integration and show suites.
- Delivery review (2026-09-18): rebased onto upstream `7e06519`, removed the dead mtime backdating from the integration test seeder, and moved these process documents into their own commit so the PR push can exclude them. Typecheck, the full suite and the `dist` rebuild comparison were rerun after the rebase.
- Build environment: Node 22.23.1, TypeScript 5.9.3, esbuild 0.25.12. The repository has no `.claude/run-checks.sh`; use the upstream CI build plus full Vitest suite. The suite runs under `arm-run --wait --cpu-light --mutex episodic-memory-build` with four Vitest workers.

### MCP bundle reproducibility

The installed dependencies rebuild `dist/mcp-server.js` to 1,028,985 bytes; the upstream committed bundle is 1,223,511 bytes. Rebuilding with every changed source module replaced by its upstream version produced **byte-identical** output to the branch build. Thus none of this task's source changes affect the reachable MCP bundle; its diff was entirely inherited dependency/build drift. Retain the upstream committed MCP bundle and run the full suite against that retained artifact. All affected individual `dist` modules are regenerated normally. Do not carry a dependency rebundle as part of the retry fix.

## Review round against the maintainer feedback (2026-09-24)

Re-reviewed the retry piece against the maintainer's PR review. The maintainer's table numbers this piece 2 (coverage is 1, quiescence is 3); it lands first because it is independent. F8 is met: batch skips preserve the count and refresh the time. The exhaustion half of F6 is intentional: verify names the recovery command and repair bypasses the cap.

- Mutation check of the policy (cap, floor, skip counting, ordering, auth routing in sync and indexer, summary preservation, verify reason, legacy timestamp, zero-attempt priority, stop-batch skip, cap off-by-one). All but one were caught. Replacing the parsed legacy ISO time with zero stayed green, because the only legacy case was already past the retry interval. A recent legacy sentinel must now back off. After the fixes every mutation fails at least one test, including a new truthiness-guard mutation that would overwrite the empty sentinel.
- `orderFreshBeforeRetry` takes the summary path that sync computes once at queue time, instead of deriving it from the transcript path. `formatErrorSentinel` requires explicit failure state, which reverses the earlier one-argument decision in the requirements; no production caller used the default.
- Clean-code pass: upstream bodies of `hasRealSummary` and `shouldQueueForSummary` restored to cut churn, the sentinel file states are documented, test literals are named, and verify explains why an errored summary counts as missing.
- MCP bundle: rebuilt with the review edits and byte-compared with a build from the previous sources. They are identical, so the upstream bundle stays retained.
- Gate: typecheck clean and **400 tests in 65 files passed** with four Vitest workers. A first run with default workers, under a load average of about 43 on 32 cores, hit 10-second `beforeEach` timeouts in the unchanged cursor-legacy and opencode-sync suites. Both pass alone in 60 ms of test time, so that run was contention, not a regression.
- Deferred: the global-versus-other failure branch repeats at four call sites. A single entry point needs a module boundary decision, because the sentinel module sits on the search and MCP import path and must not import the summarizer, which loads the Agent SDK.

## Impact and follow-up

| Surface | Evidence and action |
| --- | --- |
| Retry code | Sync and three indexer failure paths covered by real-caller tests. New limits apply to subsequent automatic attempts. |
| Existing sentinels | Legacy reads and count-preserving skips covered. No real archive was migrated or rewritten during this task. |
| Summary content | Preservation tests cover plain and coverage-bearing good summaries. Refresh behavior and exhausted refresh visibility remain task 2. |
| Search/index data and tensor caches | No schema, parser, embedding or search source changes. Tests use isolated databases and archive directories; no production dataset regeneration was launched. |
| Production installation and running jobs | No deployment, push, restart or production-job intervention. Live installations were not audited; no claim that historic outputs were repaired. |
| Generated artifacts | Affected `dist` modules rebuilt; unchanged MCP bundle retained for the reproducibility reason above. |
| Previous conclusions | The first full-gate failure was a timezone-dependent test expectation, not a retry regression. Coverage/quiescence findings F1–F7 remain pending according to the plan (the exhaustion-visibility portion of F6 is implemented here); this piece does not repair previously stale or tail-only summaries. |
| Documentation/memory | This ledger records the verified corrections. No external review comments, tickets or historical conclusions were revised. |

## Next root thread

Read this ledger and the requirements/plan, then execute task 2 from the verified retry commit. Preserve the original PR branch as the source for porting coverage. Do not include a source-only delta threshold as a replacement for eventual idle refresh. Coordinate coverage and quiescence for release; nothing has been pushed.

## Merge with the fork's main (2026-11-18)

Merges local `main` at `b1fbb9b` (background-sync CPU bound, overload stop with `classifySummaryFailure`, DO NOT INDEX in every index command) and releases fork v1.6.2.

- A global failure (auth, rate limit, overload, no credit) keeps a conversation's attempt count in sync and in every index entry point; a suspect failure (a timeout, another 5xx) and any other failure spend one; files skipped after a batch stop keep theirs. One test runs a failure of each class through sync and the three index entry points.
- `test/sync-summary-stop.test.ts` ages the stored attempt time rather than the file mtime, since the stored time decides when a retry is due; main's mtime version fails on the merged code.
- `dist/` rebuilt from the merged sources; the MCP bundle differs from main's only in `VERSION`.
- Verification: see the final gate result posted with the landing.
- End review (2026-11-18) deferred: an unreachable API ("Unable to connect to API") classifies as the conversation's own failure, so an outage spends attempts until `index --repair`. The live sync log held no such failure. Fixing it changes the AGT-329 catch-all rule, so it is a follow-up together with the account-level texts (disabled organization, credit text without a 400).
- End review fixes: the verify-CLI test's time limit rose to 120 s, a future attempt time no longer blocks retries, and the lockfile root version follows the release.
- Unreachable API (follow-up of the end review): a connection failure ("Unable to connect to API") is a global failure like a rate limit, so an outage no longer spends conversations' attempts in sync or in the index commands. The account-level texts (disabled organization, credit text without a 400) stay a separate decision.
