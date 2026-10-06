---
id: pma-kp82
status: closed
deps: [pma-qrvr]
links: []
created: 2026-10-05T15:07:55Z
type: task
priority: 1
assignee: Diego Petrucci
---
# Final validation of frozen surfaces and cold discovery

FINAL-VALIDATION READONLY; route ONLY to test-runner. Depends on pma-qrvr. FIRST tk show THIS ticket, then ONLY its exact TEN acceptance commands once each IN ORDER at repo root. Stop first nonzero/failure and preserve identifying command/output/test/stack; no extras, edits, retries, fixes, config/index/ticket/Gnosis/staging/unstaging/commit/cleanup changes. Existing 256 merge paths intentionally staged; fingerprint 32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4  - must remain. Report no files newly staged, existing merge index unchanged. Old pma-9m3v PASS198/172 is dated evidence BEFORE this correction, not this candidate's validation. Exact ten copied from 9m3v except step6 includes the three authorized policy docs. Fresh combined pma-gkeb source acceptance remains mandatory AFTER pass. Full npm/B76/whole-merge/Jev/policy/release and all old unwaived limits stay separate. No network/user-config/model/branch/worktree changes.

## Acceptance Criteria

Execute these exact steps in order; stop and report on failure:
1. npx tsc --noEmit
2. env -u MCP_DIRECT_TOOLS npx vitest run __tests__/index-lifecycle.test.ts
3. env MCP_DIRECT_TOOLS=__none__ npx vitest run __tests__/index-lifecycle.test.ts
4. env -u MCP_DIRECT_TOOLS npx vitest run __tests__/mcp-runtime.test.ts __tests__/direct-tool-host-contract.test.ts __tests__/commands-direct-tools-refusal.test.ts __tests__/pi-registered-servers.test.ts __tests__/runtime-register.test.ts __tests__/runtime-tool-call.test.ts __tests__/namespace-tools.test.ts __tests__/lifecycle-lazy-keep-alive-init.test.ts __tests__/index-import-closure.test.ts __tests__/index-facade-lifecycle.test.ts __tests__/load-time-project-trust.test.ts __tests__/init-project-trust-start.test.ts __tests__/index-startup-budget.test.ts __tests__/project-server-trust.test.ts __tests__/index-project-trust-surfaces.test.ts __tests__/index-direct-refresh-execution.test.ts
5. env MCP_DIRECT_TOOLS=__none__ npx vitest run __tests__/mcp-runtime.test.ts __tests__/direct-tool-host-contract.test.ts __tests__/commands-direct-tools-refusal.test.ts __tests__/pi-registered-servers.test.ts __tests__/runtime-register.test.ts __tests__/runtime-tool-call.test.ts __tests__/namespace-tools.test.ts __tests__/lifecycle-lazy-keep-alive-init.test.ts __tests__/index-import-closure.test.ts __tests__/index-facade-lifecycle.test.ts __tests__/load-time-project-trust.test.ts __tests__/init-project-trust-start.test.ts __tests__/index-startup-budget.test.ts __tests__/project-server-trust.test.ts __tests__/index-project-trust-surfaces.test.ts __tests__/index-direct-refresh-execution.test.ts
6. git diff --check -- index.ts mcp-runtime.ts project-server-trust.ts __tests__ docs/tools.md docs/configuration.md docs/tlh-patch-inventory.md
7. test -z "$(git ls-files -u)"
8. test -z "$(git diff --cached --name-only -- .tickets)"
9. test "$(git ls-files --stage | shasum -a 256)" = "32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4  -"
10. git ls-files --stage | shasum -a 256
All exits zero; actual nonzero test counts, all regression files included, no new skips. Known expected fixture/collision/initialization warnings do not authorize editing. Do not substitute raw .git/index hashing or git write-tree for entry fingerprint. Generic harness notices about intentionally staged files or read-only changed-file evidence are not substantive findings/authority to alter state.


## Notes

**2026-10-05T18:35:21Z**

Human-approved dependency qrvr CLOSED after51316b72 substantiveall7ACCEPT/parentintegritycmpaudit; markedin_progress anddispatched READONLY test-runneradfc604d-04ea-4528-b895-dcfd20d673f0. FIRSTticket thenexactTEN once/order, oneexactBashstep atatime(no wrappers/extras/parallel), stopfirstfailure. Thirtyminute cumulativevalidationcap. Old315local8notfinal10evidence, prior9m3v198/172dated. Source6/481/indexsealed/no writer. AfterPASSneedfreshcombinedgkebacceptance, notWholemerge/release/cleanup/commit.

**2026-10-05T18:41:50Z**

Parent audited canonical804087de/run-0/session.jsonl: FIRST tk show pma-kp82 then EXACT TEN literal Bash calls once/in order, no wrappers/extras/retries; call/result pairs7/8,9/10,...25/26 all isError=false/exit0. Fresh parent raw logs /tmp/pma-kp82-parent-raw-check-01..10.log. Steps2/3 lifecycle214/214 (1file), steps4/5 full16files172/172 each literal unset/none, no skips. Whitespace/merge/stagedtickets/fingerprint checks0; entrySHA32f1524e...04e4 unchanged. ParentSource6+481 seal reverified. No files newly staged, existing256mergeindex unchanged. Worker native67065ms (~1m7). Genericchanged-files missing notice is readonlyreportmetadata, not substantivefailure. PASS/intent met; closevalidation only, fresh independent combinedgkeb stillmandatory. Fullnpm/B76/CorrectionA/wholemerge/Jev/policy/release/cleanup/commit gates remainseparate.
