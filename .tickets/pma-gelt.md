---
id: pma-gelt
status: closed
deps: [pma-dt5s]
links: []
created: 2026-10-03T18:54:22Z
type: task
priority: 1
assignee: Diego Petrucci
---
# Restore project-server session startup with faithful trust surface regressions

Implementation slice of pma-gkeb, approved after review21de4076. Keep filtered ambient load-time/pre-trust configuration for direct tools, prompt commands, proxy surface and advisories. Retain unfiltered session configuration for runtime trust resolution AND startup decisions: in non-programmatic mode, raw project-server definitions force runtime initialization at session_start, as released v5.0.0 does, even when all metadata is cached and all filtered surfaces are empty. Do not disable the accepted genuinely zero-server guard or force-start explicit programmatic configurations based on unrelated ambient project files. No new trust policy: restore current upstream-compatible behavior, not later pma-5m1x 1b behavior. Add permanent tests in __tests__/index-project-trust-surfaces.test.ts using real config loading/source metadata, trust filtering/resolution and production facade/runtime boundaries; only lower-level transports/server manager may be mocked. Cover untrusted project .mcp.json plus cached tool/prompt metadata with no model-visible project surfaces at load, during/after session_start or after async settling; trusted but pending approval with no premature exposure; approved project-only warm-cache tools/prompts and runtime appearing from session_start WITHOUT first gateway/tool/command use; global functional positive control and programmatic isolation. Positive controls must actually exercise direct registrations so inherited MCP_DIRECT_TOOLS=__none__ cannot make absence assertions vacuously pass; explicitly isolate required fixture env. Keep import/shutdown guards, shared owner-only startup signal, descriptors/context and reentrant cleanup intact. Preserve all pre-existing staged/unstaged work and accepted config/lifecycle/panel safeguards. Entire index must remain exactly 32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4; no staging/unstaging, commits, reset/restore/stash, branch/worktree changes, whole-file rewrites, ticket edits, or real user-config writes. Fixtures may use isolated temporary directories only. No test deletion/skipping/assertion weakening. No Jev, project-policy 1b, description/cwd/footer/package/release or model/config changes. Full npm test deferred until pma-b76k and parent checkpoint; combined correction verification is separate. Run tk show THIS ticket before edits. Report actual modified paths, commands/exits/counts, index fingerprint, and any incomplete work; explicitly distinguish intentional existing merge staging from zero files newly staged by this worker.

## Acceptance Criteria

Permanent specified test file exists and its assertions reproduce the prior approved-startup regression and prevent cached untrusted/pending exposure. npx tsc --noEmit passes. Run env -u MCP_DIRECT_TOOLS npx vitest run __tests__/index-project-trust-surfaces.test.ts __tests__/project-server-trust.test.ts __tests__/load-time-project-trust.test.ts __tests__/init-project-trust-start.test.ts __tests__/index-import-closure.test.ts __tests__/index-facade-lifecycle.test.ts __tests__/index-startup-budget.test.ts; repeat identical command with env MCP_DIRECT_TOOLS=__none__. Run git diff --check -- index.ts mcp-runtime.ts project-server-trust.ts __tests__/index-project-trust-surfaces.test.ts. All targeted cases pass with no new skips; preserve index fingerprint and no unmerged paths/.tickets staged. Five classified upstream lifecycle fixture failures are deferred explicitly to the separate fixture slice; do not change them here.


## Notes

**2026-10-03T19:00:33Z**

Human approved created ticket tree and execution. Started sole writer developer e6557607-d3fb-4431-8605-83c1884ba2a3 for exactly this newly bounded project-startup/permanent-trust-test slice. Branch upstream-intake-v5.0.0, initial index fingerprint32f1524e...c04e4 confirmed unchanged; no unmerged paths/staged tickets. Old writer14d8d040 remains complete, not resumed/reset. Exact local checks in both explicit environment modes required; pma-kk6o/pma-9cy1 source and full npm remain outside this dispatch. Independent scoped review required before closing/advancing.

**2026-10-03T19:01:44Z**

Supervisor clarification of paused e6557607: the preservation fingerprint is SHA-256 from git ls-files --stage | shasum -a 256, NOT the different git write-tree tree-object ID. Architect reverified exact32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4; no index change, unmerged paths or staged tickets. Do not replace the required baseline with11247bea...; compare the SAME index-entry SHA-256 command before/after. Resume same approved task and continuous budget.

**2026-10-03T19:27:54Z**

Developer d1a41c52 reports index.ts + new untracked index-project-trust-surfaces.test.ts complete. Architect independently reran typecheck0, full7-file62 cases/no skips in explicit unset and __none__, plus prior lifecycle33/33 in both modes; scoped whitespace0/index exact unchanged32f1524e...c04e4. Automatic staged-files rejection reflects intentional pre-existing merge staging, not new index mutation. Fresh read-only reviewer aab97650-0d6d-41ff-84dc-8e947fec0a9d checks source and coverage before acceptance. Potential exact-criteria gaps from parent inspection: approved test named project-only still includes cached global config; headless approval-required case is not an interactive selection pending; immediate negative waitFor does not itself establish after-settling safety. No ticket closure or next writer yet. Developer continuation active duration15m20 plus pre-pause time; any corrections must share same original budget.

**2026-10-03T19:32:25Z**

Review aab97650 REJECTS ONLY missing exact test obligations; production/raw startup/filtering/real trust/programmatic/zero-server/double-read behavior accepted. Mutation probes independently prove existing cases catch raw-force removal, unfiltered surfaces and programmatic leakage; after-status checks are genuinely after commit/settling, no extra timing rewrite needed. Required TEST-ONLY correction: retain/rename existing approved project+global case as global positive control; add true project-only approved warm cache with user-global settings.projectServers allow but mcpServers empty, cache only project, real filtered cfg zero servers and no *_lookup at load, then session_start alone publishes project tool/prompt, one manager, zero connect calls. Keep/rename headless case as approval-required; add true trusted interactive UI.select unresolved promise, start session WITHOUT awaiting it, wait select once, assert project tool/prompt absent/global present while pending, resolve Allow, await start and assert project surfaces arrive. Existing v5 approval behavior, not policy1b. Robustly settle prompt/start/shutdown in cleanup if assertions fail. No production edits or other slices. Same developer d1a41c52 continuation; conservatively20m12 consumed including pre-resume wall, ~39m48 of original60m planning budget remains, never reset. All exact7-file checks/typecheck/whitespace in both envs required; expected at least6 new trust cases/64 local tests, no skipped cases. Independent re-review required before close.

**2026-10-03T19:44:13Z**

Test-only continuation40ccb047 adds both exact required cases: truly project-only cfg/cache with zero filtered/load-time declarations and startup without first use; real unresolved trusted UI.select then Allow/publish. Original4 cases retained, names corrected, finally shutdown cleanup added. Architect independently confirms npx tsc0,7-file64/64 no skips in explicit unset/__none__, scoped whitespace0/index unchanged32f1524e...c04e4. Reviewer continuation59898e3d re-checks exact additions before acceptance. Production previously accepted by aab97650 unchanged in this continuation. No close/next writer yet; generic staged-files rejection is not index mutation.

**2026-10-03T19:52:37Z**

Independent reviewer59898e3d explicitly ACCEPTS production+all6 permanent trust cases, with mutation sensitivity verified outside repo. Architect64/64 exact local groups pass in both env modes, typecheck/whitespace0 and unchanged index. Residual evidence: reviewer FIRST unset run exited1 with63 pass/1 unknown failure; log prematurely deleted, failed test/root cause UNIDENTIFIED. 33 subsequent group/single-file/parallel/load repetitions did not reproduce; do not report every run passed or blame cold startup/new pending case as proven. Source criteria met, closing bounded slice; uncertainty remains tracked on parent/final validation, no flaky-test waiver or release acceptance.
