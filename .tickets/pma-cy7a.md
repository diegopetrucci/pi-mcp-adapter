---
id: pma-cy7a
status: closed
deps: [pma-94x0]
links: []
created: 2026-10-04T17:26:33Z
type: task
priority: 1
assignee: Diego Petrucci
---
# Final validation of connect discovery attribution

FINAL-VALIDATION ONLY; route to test-runner, not developer. Depends on pma-94x0. First tk show THIS ticket, then execute ONLY the exact ten ordered acceptance commands at repository root. Stop at the first failure; preserve identifying output/test/stack, no extra retries or edits. No source/config/index/ticket/gnosis changes, staging/unstaging, commits or cleanup. Prior pma-ca8n pass predates this correction and does not validate it. Report actual counts/no skips and no files newly staged/existing intentional merge index unchanged. Fresh independent combined pma-gkeb source acceptance is mandatory after pass; B76/full npm/whole-merge/Jev/policy/release remain separate. Inherited stale-loop/lost-trust-log and inactive-gateway hint limits are not waived.

## Acceptance Criteria

Execute these exact steps in order; stop and report on failure:
1. npx tsc --noEmit
2. env -u MCP_DIRECT_TOOLS npx vitest run __tests__/index-lifecycle.test.ts
3. env MCP_DIRECT_TOOLS=__none__ npx vitest run __tests__/index-lifecycle.test.ts
4. env -u MCP_DIRECT_TOOLS npx vitest run __tests__/mcp-runtime.test.ts __tests__/direct-tool-host-contract.test.ts __tests__/commands-direct-tools-refusal.test.ts __tests__/pi-registered-servers.test.ts __tests__/runtime-register.test.ts __tests__/runtime-tool-call.test.ts __tests__/namespace-tools.test.ts __tests__/lifecycle-lazy-keep-alive-init.test.ts __tests__/index-import-closure.test.ts __tests__/index-facade-lifecycle.test.ts __tests__/load-time-project-trust.test.ts __tests__/init-project-trust-start.test.ts __tests__/index-startup-budget.test.ts __tests__/project-server-trust.test.ts __tests__/index-project-trust-surfaces.test.ts __tests__/index-direct-refresh-execution.test.ts
5. env MCP_DIRECT_TOOLS=__none__ npx vitest run __tests__/mcp-runtime.test.ts __tests__/direct-tool-host-contract.test.ts __tests__/commands-direct-tools-refusal.test.ts __tests__/pi-registered-servers.test.ts __tests__/runtime-register.test.ts __tests__/runtime-tool-call.test.ts __tests__/namespace-tools.test.ts __tests__/lifecycle-lazy-keep-alive-init.test.ts __tests__/index-import-closure.test.ts __tests__/index-facade-lifecycle.test.ts __tests__/load-time-project-trust.test.ts __tests__/init-project-trust-start.test.ts __tests__/index-startup-budget.test.ts __tests__/project-server-trust.test.ts __tests__/index-project-trust-surfaces.test.ts __tests__/index-direct-refresh-execution.test.ts
6. git diff --check -- index.ts mcp-runtime.ts project-server-trust.ts __tests__
7. test -z "$(git ls-files -u)"
8. test -z "$(git diff --cached --name-only -- .tickets)"
9. test "$(git ls-files --stage | shasum -a 256)" = "32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4  -"
10. git ls-files --stage | shasum -a 256
All exits zero, new regression files included and nonzero tests, no new skips; explicitly report counts and existing unchanged staging. Known duplicate fixture-key/collision/expected-init-error warnings are not a reason to edit.


## Notes

**2026-10-04T18:34:12Z**

PASS test-runner4f4cbf2a. ParentcomparedRAWsession d55d3bc1/run-0/session.jsonl calls withticketacceptance: EXACT10literalcommands ONCE INORDER, precededONLYmandatory tkshow; noother toolcalls, everyresultsuccess. Lifecycle179/179eachliteralenv;16listedfiles171/171each, no skips. Typecheck/scopedwhitespace/unmergedempty/stagedticketempty/unchangedfingerprintassert+print all0. Existing256stagedmergepaths unchanged32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4; nofilesNEWLYstaged/no edits. Genericmissingchangedfilesevidence hint notsubstantivetestfailure. ClosingfinalvalidationONLY; FRESHcombinedgkeb source acceptance remainsmandatory, no fullnpm/B76/wholemerge/releaseapproval.
