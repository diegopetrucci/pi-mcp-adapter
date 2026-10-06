---
id: pma-2xal
status: closed
deps: [pma-gelt, pma-kk6o, pma-9cy1]
links: []
created: 2026-10-03T18:54:22Z
type: task
priority: 1
assignee: Diego Petrucci
---
# Final validation of gkeb project-trust and tool-definition corrections

FINAL-VALIDATION ONLY, route to test-runner, not developer. Read tk show THIS ticket first. Execute ONLY the exact ordered shell commands in acceptance criteria, from repository root, report actual exits/counts and fail without editing on any failed step. No source/index/ticket/.gnosis/config changes, no commit/staging or broad npm suite/build. Compare fingerprint to expected intentional merge index; do not claim no staged files exist. Full npm test remains deferred until pma-b76k/parent checkpoint; release final validation pma-85pc remains separate. Independent code review is still required after this validation.

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

**2026-10-03T19:52:37Z**

Evidence-preservation constraint, no command expansion: reviewer59898e3d had1 unidentified failure in first unset7-file group (63 pass), discarded log, then33 repeats did not reproduce. Parent exact groups pass64/64 both modes. Treat this as unresolved uncertainty, not a proven cold-start explanation. On ANY final-validation failure, STOP exactly as ticket directs; report failing test identity, full useful stdout/stderr/stack and artifact/log location, PRESERVE first failure evidence. No rerun-until-green, log deletion or attribution without proof.

**2026-10-03T21:02:08Z**

Dispatched test-runner6d294b64-a4a1-4e74-9335-f8b77a64035f after ALL prerequisites closed. Exact10 ordered commands only; first-failure stop/evidence preservation, no edits/reruns/fullnpm. Expected151 full lifecycle eachenv/new untracked regressions in16files; actual summaries required. Intentional staged merge fingerprint unchanged and not empty. Combined independent gkeb review required after pass.

**2026-10-03T21:06:07Z**

Closure: test-runner6d294b64 executed all exact10 steps ordered with exits0. Full lifecycle151/151 each explicit env;16-file group169/169 each, no skips/unexpected failures; typecheck/scoped whitespace/unmerged/ticket-staging/fingerprint checks all0. Actual outputs preserved in execution transcript /Users/diegopetrucci/.the-last-harness-main/agent/sessions/--Users-diegopetrucci-Developer-forks-pi-mcp-adapter--/2026-10-02T16-06-34-767Z_01a0fd5e-0e0e-744a-a8eb-f0cdc1f52400/56b5e403/run-0/session.jsonl; summary artifact6d294b64-a4a1-4e74-9335-f8b77a64035f_test-runner_output.md. No repo/ticket edits or NEW staging; parent independently confirmed original exact32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4 index unchanged/no unmerged/.tickets staged. Generic missing changed-files report metadata is not failed validation. Fullnpm/release/wholemerge review remain deferred. One inherited unidentified first trust failure(loglost/33 clean) unresolved, no cause guessed or waiver.
