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
- Sync and all three indexer entry points record failures through the same policy. Authentication failures and skipped batch entries preserve the previous count, including zero for work never attempted.
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
