---
id: pma-dt5s
status: closed
deps: [pma-bb9p]
links: []
created: 2026-10-03T07:50:07Z
type: task
priority: 1
assignee: Diego Petrucci
---
# Correct v5 runtime initialization, shutdown and cancellation

First narrowed correction for the existing uncommitted v5.0.0 merge (parent pma-1l4l), not a new intake. Branch upstream-intake-v5.0.0; MERGE_HEAD peels to 5783e5eacfe820829b18be5d4de91e5f46e79dbb. Preserve all staged merge/config correction A changes and the previous developer's unstaged edits in index.ts, mcp-runtime.ts, startup-mcp-facade.ts and commands.ts; build on this state, do not reset/restore/abort/stash/replace whole files. Finish production index.ts -> lazy mcp-runtime.ts initialization/lifecycle integration only. Keep single shared startup, load-time eager/keep-alive handling, session-start trust/config/cwd/context, config-vs-runtime ownership, OAuth owner teardown, bounded waits, retry after genuine init failure, cancellation propagation, stale-generation rejection, cleanup of superseded initialization, and reentrant shutdown/session-switch safety. Preserve v5 APIs and host-supplied createMcpAdapter config isolation. Restore deleted HEAD initialization/cancellation/first-use lifecycle regressions with v5 mock/API/path adaptations, never weaker assertions. Update obsolete mocks (including createOAuthRuntime) to test real ownership semantics. Remove temporary DEBUG_PMA instrumentation introduced by the unfinished pass. Leave direct-tool registration/reconciliation/activation correctness to next correction and description/cache/footer/packaging to final correction; report conflicts instead of widening scope. No Jev restoration, projectServers policy/version changes, user config mutation, commits, new branches/worktrees or ticket edits. Leave the existing index unchanged; do not stage whole mixed files, hunk-stage or unstage anything. Staging is deferred to the reviewed merge checkpoint. Full npm test remains deferred until all correction slices are complete and the parent merge checkpoint is finalized; only ticket-local checks here.

## Design

Preserve the fork lazy facade/runtime split, not an unused module import or a new runtime monolith in index. HEAD and upstream v5.0.0 are read-only comparison anchors. Test initialization/shutdown at the production index boundary as well as mcp-runtime directly; retain transitive index-import-closure test unchanged. Changed mocks must retain errors, owner signals and stale-session effects rather than return dummy state to make tests pass.

## Acceptance Criteria

npx tsc --noEmit passes; npx vitest run __tests__/mcp-runtime.test.ts __tests__/index-import-closure.test.ts __tests__/index-facade-lifecycle.test.ts __tests__/load-time-project-trust.test.ts __tests__/init-project-trust-start.test.ts passes. Restore the HEAD facade initialization/input-gate regressions in __tests__/index-facade-lifecycle.test.ts (new file), without skipping/deleting the restored cases. Map the old facade tests to restored destinations or explicitly reserved pma-gkeb/pma-b76k cases in the report; npx vitest run __tests__/index-lifecycle.test.ts -t '^(?!.*footer).*(?:extension load|load-time|failed initialization|initialization failure|initialization stalls|initialization rejects|shutdown|session restart|first-use context|coalesces concurrent|synchronous session replacement|project-server approval|first-use initialization|manual auth actions|replaced session)' passes with nonzero matched tests. Footer expectations are deliberately deferred to the final correction slice. Report matched counts and actual exit statuses. Production runtime wired dynamically, concurrent first calls share startup, cancellation and old sessions cannot publish/execute into successor, retries and current context preserved. Tests guarding these behaviours restored and explained. Trust-approval test must deterministically wait until onProjectTrustResolved is installed, then prove session_start stays open until that callback resolves while server initialization remains pending; never optional-call an unset callback. Load-time initialization must pass excludeProjectServers through the actual runtime path. First-use wait including prior-session cleanup must be bounded; preserve v5 first-use-during-cleanup behavior if possible and escalate any incompatible pending-result alternative before changing the contract. Restore exact forwarded signal identity and prove shutdownOAuth gets the previous OAuth runtime with its signal aborted. Preserve v5 stale-session error text and manual-auth argument contract. No unmerged paths, merge uncommitted, no .tickets staged; unrelated failures recorded rather than fixed out of scope.


## Notes

**2026-10-03T09:31:40Z**

Supervisor staging clarification: target files mix existing staged merge content with earlier unstaged correction work. Leave the index exactly as found; do not stage whole mixed files, attempt hunk staging, or unstage anything. Additional staging is deferred until reviewed at the merge checkpoint. This changes staging sequencing only, not implementation or validation acceptance. Developer reports ticket-local tsc plus 14 runtime/import-closure and 28 lifecycle-filter tests passing; evidence and final report still required before acceptance.

**2026-10-03T09:35:23Z**

Architect verification after report-only resumed run 1a8f0f8c was rejected by harness acceptance (no new edits/no-staged-files evidence). Actual source/test changes remain present. Independently reran exact ticket checks: tsc exit 0; runtime + import closure 14 passed, exit 0; lifecycle acceptance filter 28 passed/123 skipped, exit 0. Fresh read-only reviewer 3ec2dada running; ticket stays in_progress pending findings. Index preserved. git diff --check exit 2 points only to existing startup-mcp-facade.ts:271 trailing whitespace in pending final correction; recorded on pma-b76k.

**2026-10-03T09:45:29Z**

Fresh review 3ec2dada rejects this ticket despite selected checks passing. Current runtime initializeMcp options omit onProjectTrustResolved and load-time excludeProjectServers; facade first-use awaits session startup/previous cleanup without a bound; HEAD facade suite was not restored; signal/OAuth assertions were weakened. Review artifact: /Users/diegopetrucci/.the-last-harness-main/agent/sessions/--Users-diegopetrucci-Developer-forks-pi-mcp-adapter--/subagent-artifacts/3ec2dada-8200-4559-a9b5-dbd0b3bf2865_code-reviewer_output.md. Fix review items 1–7 within the already approved lifecycle scope. Acceptance now includes the restored facade suite, real trust tests and missed current lifecycle cases. Saved session context baseline test must be explicitly adapted to the approved v5 complete first-use context, with saved-context fallback, rather than removed. Keep-alive no-context input and remaining tool/host events belong pma-gkeb. No advance/close until corrections and fresh review.

**2026-10-03T10:03:23Z**

Correction continuation 86505c8d exhausted its remaining cumulative budget (837479ms); no worker remains live. Current edits preserved. Architect reran strengthened checks: tsc exit 0; runtime/import-closure/restored-facade/load-time-trust/init-trust group 45 passed/1 failed, exit 1; expanded lifecycle filter 33 passed/118 skipped, exit 0. Restored facade suite now contains 30 tests (29 pass); only observed group failure is empty zero-server/no metadata importing runtime because index.ts shouldInitialize treats sessionCache === null as unconditional startup. Trust callback/load-time exclusion/manual auth/OAuth signal changes are present and newly selected cases pass, but changes still need independent review. No staging/commit or unmerged paths. Do not revive exhausted developer run; next implementation requires a separately scoped follow-up decision.

**2026-10-03T10:09:38Z**

Follow-up review 2ad204df confirms original findings 1/2/5/6/7 fixed and HEAD suite restored (30 cases), but rejects completion. Remaining A: previous cleanup is now fire-and-forget, causing routine session switches to overlap old/new eager or keep-alive servers; restore HEAD/v5 normal cleanup ordering with a narrowly scoped explicit first-use expedite path, not a blanket overlap deviation. B: facade startup and init can consume two 30s budgets; retries can wait unbounded for trust and misreport timeout as init_failed. Use a shared request deadline and pending timeout semantics. C: null-cache zero-server unconditional startup. D: rename first-use context test/add saved-context fallback, assert stale command is never forwarded. Artifact: /Users/diegopetrucci/.the-last-harness-main/agent/sessions/--Users-diegopetrucci-Developer-forks-pi-mcp-adapter--/subagent-artifacts/2ad204df_code-reviewer_output.md. Architect recommends one narrowly scoped follow-up task for A-D; no new implementation dispatch before user approval. Exhausted developer stays stopped; all current code and index retained.

**2026-10-03T11:36:17Z**

User approved restoring upstream cleanup ordering and one request deadline. Remaining A-D split into focused child pma-bb9p, which must complete and pass independent review before this gate closes. Already restored suites/fixed trust/OAuth work retained. The exhausted developer remains stopped; new follow-up worker awaits user approval of its created ticket.

**2026-10-03T12:06:27Z**

Focused child pma-bb9p implementation now reports A-D complete. Architect independently verified typecheck and 55 full local +33 selected lifecycle tests, all exit 0, zero-server regression now green; index content unchanged. Fresh reviewer 8a787500 must accept underlying lifecycle guarantees before this gate closes; sibling corrections and full merge suite remain pending.

**2026-10-03T12:16:38Z**

Reviewer 8a787500 confirms trust/load-exclusion/OAuth/signal assertions/restored suite/import closure/stale-state fencing, but blocks completion on child pma-bb9p: plain-input expedite and stale hook eligibility plus shared startup inheriting caller cancellation. Cancellation isolation is already required by the approved child; preserve first-use context fields while removing caller-owned startup cancellation. Parent remains open pending fixes and new review.

**2026-10-03T12:49:34Z**

Review 9b8e7312 confirms all parent guarantees except child caller-abort isolation. Saved Pi ctx.signal is current-turn getter, not session ownership. Child now explicitly requires startup signal neutralization and live-getter real-boundary regression. No new scope; do not close until correction and independent acceptance.

**2026-10-03T13:01:40Z**

Accepted after child pma-bb9p completed and independent reviewer 9f3485f4 explicitly accepted parent and child. Original trust/load-exclusion/ownership/OAuth/runtime delegation/HEAD-facade restoration plus ordering/deadline/zero-server/context/cancellation guarantees verified. 59 complete and 33 selected lifecycle cases pass in both environments; typecheck clean, index unchanged. Parent merge pma-1l4l is NOT accepted yet; direct reconciliation, bounded surfaces/cache/footer/packaging, full suite and full merge review remain required.
