---
id: pma-ca8n
status: closed
deps: [pma-4ehy, pma-w3qj, pma-yga8]
links: []
created: 2026-10-04T09:42:24Z
type: task
priority: 1
assignee: Diego Petrucci
---
# Final validation of deferred outcomes, reporting and session scripting fixes

FINAL-VALIDATION ONLY: route to test-runner, not developer. Read tk show THIS ticket first. Execute ONLY exact10 ordered acceptance commands at repository root; stop on any failed step and preserve first useful output/test identity/stack in transcript/temp log. No source/index/ticket/gnosis/config edits, staging/unstaging/commit or extra retries. New permanent tests must be in the listed existing files. Prior pma-2xal pass predates these corrections and does not validate them. Full npm/B76/whole-merge/release checks still separate, and independent combined gkeb source review remains mandatory after pass. Inherited stale-loop guard risk and one unidentified first trust failure (log lost/33 later clean) remain uncertainty, not proven cause/waiver. Report no files newly staged/existing intentional merge index unchanged, not no staged files.

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

**2026-10-04T12:01:22Z**

Parent inspected8f3f2adf artifact AND rawtoolcalls/results: allTEN literal commands exactlyequal approvedticket order, all toolresults present/nonerror/exits0. Lifecycle168eachenv;16files170eachenv; no skips, expectedwarningsonly; tsc/whitespace/unmerged/ticketstaging/fingerprintchecks0, index32f1524e...04e4 unchanged. No repo edits/new staging. Genericchangedfilesgate expectedreadonly metadata, NOT substantivefailure. CloseONLY finalvalidation; fresh independent combinedgkeb source acceptance mandatory next, prior2xal supersededforcurrentwork. Inherited trustloglost/perstep loop risk andinactivegateway limit remainunwaived; fullnpm/B76/wholemerge/release checks stillseparate.
