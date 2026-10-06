---
id: pma-4ehy
status: closed
deps: []
links: []
created: 2026-10-04T09:42:24Z
type: bug
priority: 1
assignee: Diego Petrucci
---
# Wrap every returned deferred-tool outcome as CallToolResult

Bounded correction of pma-gkeb reviewer658bc695 finding1. Writable scope index.ts and __tests__/index-lifecycle.test.ts ONLY. registerDirectTool currently wraps success but returns raw init_failed/init_timeout from both catch paths and pending path. Match released v5: every RETURNED deferred outcome, including failed startup, pending deadline and execution failure, uses the declared CallToolResult structuredContent contract. Preserve nondeferred raw results and intentional abort/stale-session THROWS, exact signal identity and existing shared startup cancellation/deadline semantics; no catch-all conversion of cancellations. Execute permanent tests through real index registration/runtime delegation (lower initializer/transport mocks allowed), not fake return-only declarations. Reviewer repro retained in /tmp/rv-gkeb/__tests__/index-lifecycle.test.ts; improve it without wholesale copying fixtures. Preserve all pre-existing staged/unstaged/untracked work and prior accepted trust, hidden/live closure, panel, native bridge, shared-signal, deadline and shutdown safeguards. No source/test deletion, weakened assertions, config writes, staging/unstaging, commits, reset/restore/stash, branch/worktree operations or ticket edits. Index must remain SHA256 32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4 (git ls-files --stage | shasum -a 256), not an empty index. B76/docs/dist, policy/Jev and full npm/release validation deferred. Read AGENTS.md, released-tag sync policy and gn decisions. Preserve first failing command/test/output/stack in a temp log; stop/escalate unexpected failures, never rerun-until-green. Fixture construction failures require recorded diagnosis before correction.

## Acceptance Criteria

Permanent cases execute registered deferred tools for init failure and genuine pending initialization, assert declared outputSchema plus complete structuredContent.content/isError and SDK-consumable result shape; also cover the second failure-return path and preserve existing success/eager/cancellation controls. Use deterministic gated initialization/fake deadlines with cleanup, not long real-time sleeps. Run npx tsc --noEmit; env -u MCP_DIRECT_TOOLS npx vitest run __tests__/index-lifecycle.test.ts __tests__/index-direct-refresh-execution.test.ts __tests__/index-facade-lifecycle.test.ts __tests__/index-startup-budget.test.ts; env MCP_DIRECT_TOOLS=__none__ npx vitest run __tests__/index-lifecycle.test.ts __tests__/index-direct-refresh-execution.test.ts __tests__/index-facade-lifecycle.test.ts __tests__/index-startup-budget.test.ts; git diff --check -- index.ts __tests__/index-lifecycle.test.ts; verify exact index fingerprint, no unmerged paths or staged .tickets. All exit0, nonzero cases/no skips, report actual counts and changed-files delta versus dispatch baseline. Broader final validation deferred to dependent ticket.


## Notes

**2026-10-04T09:46:56Z**

Human approved all4 created tickets. Sole implementation writer dispatched for THIS ticket only; already on upstream-intake-v5.0.0. Read-only before-source snapshots/status/unstageddiff at /tmp/pma-4ehy-before.Z4q75a for delta review (never restore). Full-index unchanged32f1524e...04e4. Worker must preserve first-failure evidence and all previous source/index state; remaining slices not launched.

**2026-10-04T10:06:58Z**

Architect reviewed source delta:4 returned paths consistently wrapped, intentional abort/stale throws unchanged; helpers now precise AgentToolResult types. Worker reports tsc0/4files195 bothenv0/index unchanged, first construction failure2 missing mocked lazyConnect exports retained/diagnosed. Acceptance pending TEST-ONLY correction: existing success expectation was changed from literal content:text(7 rows) to content:ok.content (tautology) despite final fixture using mock executor that returns literal7 rows. Restore independent exact success content/nested content assertion (baseline intent), retain new schema checks/3 error cases and all current source fixes. Remove unnecessary bootPi099 signature formatting-only delta if safe. No new implementation scope or production changes; same child continuation cumulative budget. Do not close based on green checks alone.

**2026-10-04T10:13:04Z**

Closure after architect inspection of exact before/current source/test delta and corrected logs: all4 returned paths deferred-wrapped; abort/stale throws/nondeferred raw path unchanged.3 new initfailure/pending/second-catch execution cases (154 lifecycle), SDK CallToolResultSchema validation and exact original7rows success assertion restored, formatting noise removed. Read /tmp/pma-4ehy-correction-{tsc,unset,none,diffcheck}.log: all exits0,4files195 each explicit env/no skips. Architect confirmed entire index32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4, no unmerged/ticket staging, status matches dispatch baseline and no outside-ticket tracked unstaged changes. Architect diff-parser first failed because hard-coded a/b prefixes vs configured git mnemonic i/w; exact output/diagnosis saved /tmp/pma-4ehy-parent-delta-first-failure.log, corrected prefix normalization keeps same outside-scope check. Worker abandoned importActual/missing lazyConnect fixture failure remains preserved/diagnosed; no new test failures. Broad finalvalidation and independent combined gkeb review still required. Generic staged-file harness rejection is not substantive failure or authority to unstage.
