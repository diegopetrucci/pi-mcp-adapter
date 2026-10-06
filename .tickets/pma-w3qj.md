---
id: pma-w3qj
status: closed
deps: [pma-4ehy]
links: []
created: 2026-10-04T09:42:24Z
type: bug
priority: 1
assignee: Diego Petrucci
---
# Correct search activation text and cold-connect tool attribution

Bounded correction of pma-gkeb reviewer658bc695 findings2/3. Writable scope index.ts, mcp-runtime.ts and __tests__/index-lifecycle.test.ts ONLY. Replace literal backslash-n separators in search activation with real newlines, matching released v5. Exclude lazy/search-mode names from connect addition queue/report, while retaining eager additions, per-server attribution, overlapping-call ownership, real search/proxy activation and host inactive choices. Add cold metadata discovery during connect: no prior tools, lazy definitions appear only through that operation, remain inactive and are not claimed loaded. Drive catalog availability with operation state, NOT a guessed fixed number of resolver calls. Retain eager discovery positive controls and existing attribution protections. Reviewer variants retained /tmp/rv-gkeb/__tests__/index-lifecycle.test.ts. Preserve all pre-existing staged/unstaged/untracked work and prior accepted trust, hidden/live closure, panel, native bridge, shared-signal, deadline and shutdown safeguards. No source/test deletion, weakened assertions, config writes, staging/unstaging, commits, reset/restore/stash, branch/worktree operations or ticket edits. Index must remain SHA256 32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4 (git ls-files --stage | shasum -a 256), not an empty index. B76/docs/dist, policy/Jev and full npm/release validation deferred. Read AGENTS.md, released-tag sync policy and gn decisions. Preserve first failing command/test/output/stack in a temp log; stop/escalate unexpected failures, never rerun-until-green. Fixture construction failures require recorded diagnosis before correction.

## Acceptance Criteria

Strengthen search assertion to exact real-newline text, including multiple text blocks and preserved search text/activated names; permanent cold-connect regression asserts registration exists, tools still inactive, addedToolNames absent, while eager additions and later search activation still work. Existing held-inactive test remains. Run npx tsc --noEmit; env -u MCP_DIRECT_TOOLS npx vitest run __tests__/index-lifecycle.test.ts __tests__/mcp-runtime.test.ts __tests__/index-facade-lifecycle.test.ts; env MCP_DIRECT_TOOLS=__none__ npx vitest run __tests__/index-lifecycle.test.ts __tests__/mcp-runtime.test.ts __tests__/index-facade-lifecycle.test.ts; git diff --check -- index.ts mcp-runtime.ts __tests__/index-lifecycle.test.ts; verify exact index fingerprint/no unmerged paths/no staged .tickets. All exit0, nonzero cases/no skips; report actual counts and ticket delta. Full cross-ticket group deferred to dependent final validation.


## Notes

**2026-10-04T10:13:04Z**

Ready after closed pma-4ehy; human approved ticket chain. Sole next writer THIS reporting ticket only, preserve newly accepted deferred wrappers/schema/error tests. Before-source snapshots/status/unstaged diff at /tmp/pma-w3qj-before.UYnsga are READONLY (never restore). Current lifecycle154 cases, import/budget/facade/actualrefresh proof unchanged. Later scripting/finalvalidation remain pending; combined parent independent review still mandatory.

**2026-10-04T10:13:32Z**

Sole async developer0d118f4e-4fea-423b-82b9-6b7cbc958c0a launched for approved reporting task only. First task closed from source/test/log inspection, not generic staged-file metadata gate; no staging changes. Snapshot /tmp/pma-w3qj-before.UYnsga; preserve 154 lifecycle cases including all new4ehy controls. Explicit two-environment validation and cold-operation-state/multiple-block exact-text tests requested per ticket. Parent source review/final checks still pending.

**2026-10-04T10:26:27Z**

Closure after architect exact baseline delta/test/log inspection: newline2-line fix matches released v5; queue excludes spec.lazy, consume also excludes names currently lazy, original server/overlap ownership left unchanged. Existing held-inactive test retained/strengthened into genuine cold discovery via operation-state flag, registration/inactive/no-report then actual gateway search activation checks; no mock-call-count timing. Exact multi-block text and full search details asserted alongside original controls. Current lifecycle154 (no deletion) and mcp-runtime16/facade35:205/3files bothenv0 per actual /tmp/pma-w3qj-{unset,none}.log; artifact reports tsc0/scoped whitespace0. Architect verified only3 allowed tracked unstaged paths changed, status matches dispatch, original32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4 index/no unmerged/no ticket staging. No source/tests changed outside slice or new staging. Combined validation/review still deferred, parent NOT accepted.
