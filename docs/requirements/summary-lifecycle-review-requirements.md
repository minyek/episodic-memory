# Summary lifecycle review requirements

Source: PR 109, review 5158930343, and the accepted delivery discussion.

## Delivery and constraints

Deliver three reviewable pieces, preserving current upstream safeguards and the original implementation where sound. Never push. Keep refresh and its cost control coordinated for release. Execute one verified delivery task per root thread; retain a durable ledger for the next task.

1. Retry policy: automatic failures have a configurable positive attempt cap (default five) and retry interval (default one hour). Skipped work does not spend or reset attempts; global authentication failures remain recoverable. Existing good summaries survive failure or skipping. First attempts precede retries. Verification identifies exhausted work and explicit repair can recover it. Legacy ISO sentinels remain readable.
2. Coverage and refresh: summarize the entire archived snapshot, index only new exchanges, update archives through every indexing entry point, strip headers through the actual search loader, and distinguish unverified legacy baselines from known coverage. Provide explicit legacy refresh without automatic mass regeneration.
3. Scheduling: eventual idle refresh remains guaranteed on a subsequent sync. Ineligible conversations consume no attempt budget; failed calls do consume it. Exercise every caller with quiescence enabled. Verification distinguishes deferred work; deliberate forced recovery remains possible.

## Decisions and alternatives

- Use upstream main as the delivery base. Rebasing the combined original PR would preserve one branch but obscure the requested independent pieces; extracting its retry policy gives a focused first diff.
- Keep failure state in the existing sentinel, with a JSON second line. Sidecar files would multiply lifecycle and migration cases. Retain legacy reads and the public one-argument formatter for callers that create a first failure.
- Preserve good summary bytes on skipped or failed work. The coverage piece will add persistent refresh-failure state; the retry-only piece does not schedule existing good summaries.
- Give zero-attempt skipped files fresh priority. Treating all error markers as retries would unfairly penalize work never attempted.
- Authentication failures defer the batch without spending per-conversation attempts. Capping these would permanently abandon valid conversations while credentials are broken.
- Retain explicit `index-conversations --repair` as intentional recovery from exhaustion. A new force flag is unnecessary for this first piece; the scheduling piece must preserve the explicit recovery contract while distinguishing ordinary deferred work.
- Retain eventual idle refresh. A byte/percentage threshold saves calls during growth but can permanently miss a small final decision; it cannot replace the final idle refresh.

## Acceptance evidence

Tests must exercise real queueing, filesystem state and caller behavior with only external inference/embedding boundaries replaced. Cover retry interval boundaries, exact cap, invalid config/state, legacy timestamps, batch skips, preserved summaries/counts, queue fairness, all indexing failure writers, and explicit recovery. Build committed `dist` output and run the upstream full gate. Record verification and deployment limits in the execution ledger.
