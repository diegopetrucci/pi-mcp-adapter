---
id: pma-9m3v
status: closed
deps: [pma-hxha]
links: []
created: 2026-10-04T18:58:08Z
type: task
priority: 1
assignee: Diego Petrucci
---
# Final validation of affected-server panel refresh

FINAL-VALIDATION READONLY; route ONLY to test-runner. Depends on pma-hxha. FIRST tk show THIS ticket, then ONLY exact10 acceptance commands ONCE INORDER atrepo root. Stop first failure; preserve identifying command/output/test/stack, no edits/retries/fixes/additional commands. No source/config/index/ticket/gnosis changes/staging/unstaging/commits/cleanup. Existing256mergepaths intentionallystaged, SHA256 32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4 muststay; report no files newly staged/existing merge index unchanged. Priorcy7a179/171 pass is dated evidence BEFORE this fix, not forthcoming code acceptance. Final10 copied literally from cy7a except step6 also checks authorized inventory edit. Fresh combinedgkeb SOURCE acceptance remainsmandatory afterpass; B76/fullnpm/wholemerge/Jev/policy/release stayseparate. All old uncertainty/limits remainunwaived.

## Acceptance Criteria

Execute these exact steps in order; stop and report on failure:
1. npx tsc --noEmit
2. env -u MCP_DIRECT_TOOLS npx vitest run __tests__/index-lifecycle.test.ts
3. env MCP_DIRECT_TOOLS=__none__ npx vitest run __tests__/index-lifecycle.test.ts
4. env -u MCP_DIRECT_TOOLS npx vitest run __tests__/mcp-runtime.test.ts __tests__/direct-tool-host-contract.test.ts __tests__/commands-direct-tools-refusal.test.ts __tests__/pi-registered-servers.test.ts __tests__/runtime-register.test.ts __tests__/runtime-tool-call.test.ts __tests__/namespace-tools.test.ts __tests__/lifecycle-lazy-keep-alive-init.test.ts __tests__/index-import-closure.test.ts __tests__/index-facade-lifecycle.test.ts __tests__/load-time-project-trust.test.ts __tests__/init-project-trust-start.test.ts __tests__/index-startup-budget.test.ts __tests__/project-server-trust.test.ts __tests__/index-project-trust-surfaces.test.ts __tests__/index-direct-refresh-execution.test.ts
5. env MCP_DIRECT_TOOLS=__none__ npx vitest run __tests__/mcp-runtime.test.ts __tests__/direct-tool-host-contract.test.ts __tests__/commands-direct-tools-refusal.test.ts __tests__/pi-registered-servers.test.ts __tests__/runtime-register.test.ts __tests__/runtime-tool-call.test.ts __tests__/namespace-tools.test.ts __tests__/lifecycle-lazy-keep-alive-init.test.ts __tests__/index-import-closure.test.ts __tests__/index-facade-lifecycle.test.ts __tests__/load-time-project-trust.test.ts __tests__/init-project-trust-start.test.ts __tests__/index-startup-budget.test.ts __tests__/project-server-trust.test.ts __tests__/index-project-trust-surfaces.test.ts __tests__/index-direct-refresh-execution.test.ts
6. git diff --check -- index.ts mcp-runtime.ts project-server-trust.ts __tests__ docs/tlh-patch-inventory.md
7. test -z "$(git ls-files -u)"
8. test -z "$(git diff --cached --name-only -- .tickets)"
9. test "$(git ls-files --stage | shasum -a 256)" = "32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4  -"
10. git ls-files --stage | shasum -a 256
All exits zero, new regression files included and nonzero tests, no new skips; explicitly report counts and existing unchanged staging. Known duplicate fixture-key/collision/expected-init-error warnings are not a reason to edit.


## Notes

**2026-10-05T14:35:37Z**

Human previously approved exact10 ticket. Dependencies closed after independent730a1d16 substantive full-slice acceptance andparent inspection, notgenericstagednotice. RouteONLYread-onlytest-runner: FIRSTtkshow thenTENliteralcommands ONCEeachINORDER; stopfirstfailure/noextras/retries/edits. Parentwill auditrawcalls. Known intentional256mergeindex staging unchanged; no newstaging. Freshcombinedgkeb review remainsrequiredafterpass; no cleanup/commit/releaseapproval.

**2026-10-05T14:40:24Z**

PASS ebb5c6c9; parent audited canonical65b46107 rawsession: tkshow at6 thenexact10literalcommands at8/10/12/14/16/18/20/22/24/26, results9..27 allisErrorfalse, NOadditionaltools/retries/wrappers. Typecheck PASS; lifecycle198/198 eachliteralunset/none; broader16files172/172 each, no skips; scoped whitespace/unmerged/ticketstage/fingerprint allPASS. Parent preserved rawstepoutputs /tmp/pma-9m3v-parent-raw-check-01..10.log. All256nonscopehash/index unchanged; nofilesnewlystaged. Harness changed-files-evidence missing is metadata only forread-onlyworker, not substantive failure/permissiontoedit. Closing exact validationintent; freshcombinedgkebsourceacceptance mandatory, B76/fullnpm/wholemerge/Jev/policy/release remainseparate. Oldlimitsunwaived.
