# Summary lifecycle review implementation plan

**Goal:** Deliver the accepted PR review fixes in three independently reviewable pieces.

**Architecture:** Shared sentinel policy owns retry state. Sync and index callers report failures or deferrals to that policy. Coverage and scheduling extend it in subsequent dependent tasks.

**Tech stack:** TypeScript, Node.js, Vitest, SQLite, tsc and esbuild.

**Spec:** `docs/requirements/summary-lifecycle-review-requirements.md`.

## Task 1: bounded retries and fair queueing

Dependencies: none. Base: upstream `7e06519`. Branch: `fix/summary-retry-policy`.

Touch set: `src/summary-config.ts`, `src/summary-sentinel.ts`, `src/sync.ts`, `src/indexer.ts`, `src/verify.ts`, `src/index-cli.ts`, corresponding focused tests, `README.md`, generated `dist`, this plan and the ledger.

Interfaces: `FailureState { attempts: number; lastAttempt: number }`; `recordSummaryFailure(path, error)` increments a real failure; `recordSummarySkip(path, error)` preserves the count; `parseErrorSentinel(content)` reads legacy/structured state; `isSummaryRetryExhausted(state)` drives verification; `orderFreshBeforeRetry(files)` prioritizes unattempted candidates before the sync limit.

- [x] Verify current upstream retry/auth tests and preserve the original PR branch.
- [x] Add failing filesystem/real-sync regressions for exact cap, fresh priority and auth skips; add codec/config boundary tests and index/repair integration coverage.
- [x] Run focused tests and record expected failures before source edits.
- [x] Implement the shared policy; route sync and all three indexer writers through it; surface exhaustion in verify.
- [x] Run focused tests, independently review the diff, and address findings.
- [x] Build, run the full upstream gate, inspect warnings and generated differences, and commit specific files.
- [x] Record completion, impacts and the next dependency-ready task in the ledger; end this root thread.

## Task 2: truthful coverage and working refresh paths

Dependencies: task 1. Start a fresh root thread and branch from its verified commit.

Touch set: sentinel/coverage module, indexer, sync summary writes, search, verify, CLI recovery, corresponding tests and generated dist.

- [ ] Port coverage from original PR head `eab6331`, separating full summarization exchanges from incremental indexing exchanges (F1).
- [ ] Refresh archive snapshots for the index CLI (F7), and stamp only the bytes actually summarized.
- [ ] Replace parser-only display testing with real search regression coverage (F4).
- [ ] Mark legacy baselines unverified and implement visible, explicit recovery (F5).
- [ ] Extend the retry policy to preserve bodies and accumulated refresh failures on failures/skips; verify exhausted refresh visibility (F6/F8).
- [ ] Review, build, run full gate, commit, and update the ledger. Do not release refresh without the next task's cost control.

## Task 3: quiescence and eligibility before budget

Dependencies: task 2. Start a fresh root thread and branch from its verified commit.

Touch set: summary scheduling configuration/helper, indexer, sync, verify/repair, integration tests, README and dist.

- [ ] Port idle checks with the accepted eventual refresh contract.
- [ ] Apply eligibility before consuming the limit and count attempted calls, including failures (F2).
- [ ] Test every caller with quiescence enabled and pin eventual eligibility and queue draining (F3).
- [ ] Distinguish deferred state in verify and retain explicit forced recovery (F6).
- [ ] Review and run the full combined gate; record release coordination and the three local delivery branches. Never push.
