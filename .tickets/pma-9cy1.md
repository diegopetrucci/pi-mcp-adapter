---
id: pma-9cy1
status: closed
deps: [pma-kk6o]
links: []
created: 2026-10-03T18:54:22Z
type: task
priority: 1
assignee: Diego Petrucci
---
# Align five upstream lifecycle fixtures with accepted zero-server guard

FIXTURE-ONLY implementation slice of pma-gkeb, approved after review21de4076. Modify ONLY the five identified __tests__/index-lifecycle.test.ts fixtures; no runtime source edits or unrelated test changes. Upstream initialized empty configurations; fork deliberately does not. Add configured demo startup server to session_tree approval restoration (near739), immediate replacement initialization (near2410), stale initialization finalization (near2450), and updateStatusBar error logging (near3731). For /mcp-adapter completions (near3336), first loadMcpConfig call remains empty and later calls return demo so no completion before startup and current state names afterward. Preserve EVERY existing protective assertion: branch approval restoration; immediate replacement with stale-result/OAuth shutdown exactly once; no stale status/new promise clearing; null-before-start/current subcommands/server completions; expected initialization failure status-boom logging. Reviewer proved these exact fixture-only changes make all five cases pass; do not waive or reclassify them as footer/description/package cleanup. Preserve real zero-server tests/guard. Preserve all pre-existing staged/unstaged work and accepted config/lifecycle/panel safeguards. Entire index must remain exactly 32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4; no staging/unstaging, commits, reset/restore/stash, branch/worktree changes, whole-file rewrites, ticket edits, or real user-config writes. Fixtures may use isolated temporary directories only. No test deletion/skipping/assertion weakening. No Jev, project-policy 1b, description/cwd/footer/package/release or model/config changes. Full npm test deferred until pma-b76k and parent checkpoint; combined correction verification is separate. Run tk show THIS ticket before edits. Report actual modified paths, commands/exits/counts, index fingerprint, and any incomplete work; explicitly distinguish intentional existing merge staging from zero files newly staged by this worker.

## Acceptance Criteria

Diff is fixture-only, limited to the five test bodies with no altered/deleted/skipped assertions and no production edits. npx tsc --noEmit passes. env -u MCP_DIRECT_TOOLS npx vitest run __tests__/index-lifecycle.test.ts passes in full (baseline151 cases, no skipped cases); repeat with env MCP_DIRECT_TOOLS=__none__. git diff --check -- __tests__/index-lifecycle.test.ts passes. Exact index fingerprint remains unchanged; no unmerged paths/.tickets staged. Combined cross-slice checks deferred to the separate final-validation ticket, not omitted.


## Notes

**2026-10-03T19:01:44Z**

Fingerprint clarification for dispatch: use git ls-files --stage | shasum -a 256 to compare the required64-hex SHA-256. git write-tree produces a different tree-object ID, not a comparable fingerprint. Expected index remains32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4, no new staging/unstaging.

**2026-10-03T20:52:25Z**

Next sole writer after independent pma-kk6o acceptance/closure. Current fixture titles/anchors: restores approval state from active session branch on session_tree~706; starts replacement init immediately and shuts down stale init results~2397; does not let stale init finalization publish status or clear newer init promise~2433; completes current /mcp-adapter subcommands and server arguments~3321; status-boom initialization error~3714. Read-only before-slice snapshot /tmp/pma-9cy1-before-index-lifecycle.test.ts (not restore source). Production baseline sha256 index.ts f1b663178bff8a23cbebe93b74c5974a6b0a2bd7573ff65f45543d5f03b90b77; mcp-runtime.ts938899bcc488dbbce75e0ed7497105b6f250b26aff822bbe9d91dfd8c2085ee4. Diff only five fixture bodies, no assertions/source/helper changes. First unexpected failure must preserve identifying log/stack and report, no rerun-until-green/scope expansion. Existing merge index fixed, fullnpm/cross-slice validation deferred.

**2026-10-03T20:53:46Z**

Sole developer6bcf3251-1732-461f-94a5-47e50166a737 dispatched approved fixture-only task. Must edit only5 setup bodies, compare external before-slice snapshot, preserve ALL assertions and source hashes. Exact full151-case lifecycle bothenv/tsc/whitespace/index checks required, first-failure evidence retained. No broader fixes/fullnpm; next cross-slice verification routes to test-runner pma-2xal after acceptance.

**2026-10-03T20:58:11Z**

Parent incremental snapshot review confirms only five setup blocks added, all prior assertions untouched; production hashes and original index unchanged. Small exact-scope correction before closure: completion fixture currently later returns matching github/gitlab/notion config (9 added lines), whereas approved ticket/reviewer-proven correction prescribes later demo. Use the exact empty-once then demo config chain; keep initialized state github/gitlab/notion and all completion assertions untouched. No extra fields/helper/source edits. Revalidate full151 both env/tsc/whitespace, first-failure evidence retained. Parent will inspect final minimal5-block diff before closure.

**2026-10-03T21:01:40Z**

Closure: developer6bcf3251->78e7dbd9 implemented EXACT approved5 fixture setups, completion firstempty/laterdemo. Architect inspected final diff against /tmp/pma-9cy1-before-index-lifecycle.test.ts: ONLY4 single setup lines plus3-line completion chain; all prior assertions/helpers intact. Production index.ts sha f1b663178bff8a23cbebe93b74c5974a6b0a2bd7573ff65f45543d5f03b90b77 and runtime sha938899bcc488dbbce75e0ed7497105b6f250b26aff822bbe9d91dfd8c2085ee4 unchanged. Read actual final logs /tmp/pma-9cy1-revival-vitest-{no-direct,direct-none}.log:151/151 no skips EXIT0 each; tsc/whitespace0 reported. Parent whitespace/index/unmerged/ticket-staging independently verified clean/expected original32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4. No source/new staging/commits. Combined validation pma-2xal and independent gkeb/wholemerge review still pending.
