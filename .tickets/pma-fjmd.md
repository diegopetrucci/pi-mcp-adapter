---
id: pma-fjmd
status: open
deps: []
links: []
created: 2026-10-05T22:31:55Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Observe load-time startup in one isolated diagnostic

SCRATCH-ONLY IMPLEMENTATION/DIAGNOSTIC: developer, not read-only reviewer/test-runner. Human approved scope; created ticket needs approval before dispatch. First tk show THIS ticket. Parent owns tickets/Gnosis. Create one NEW /tmp/pma-s19f-loadtime-diag.XXXXXX directory; copy all462 candidate paths from /tmp/pma-afhq-parent-final-load-candidate.sha256.json using cp -c and independent cp -cR node_modules. Create isolated home/agent/xdg/npm sibling directories. Verify source hash seal and frozen index fingerprint before/after; no root source/test/artifact/index changes. Original failed scratches /tmp/pma-merge-final-validation.ifmblip_ and /tmp/pma-merge-final-validation-renewed.e4loftab and all logs immutable evidence never restoration. Instrument ONLY fresh scratch __tests__/load-time-project-trust.test.ts observationally: append NDJSON to sibling trace.ndjson with performance.now/Date.now for index import, adapter call, actual runtime import enter/finish, call-through actual factory/handleSessionStart, existing manager connect calls, wait start/end/cleanup. Capture existing console.error spy args and Error.stack in finally without changing its semantics. Real module exports/factory/runtime callbacks must pass through, correct this/args/return; no fake initializer/private-state/spec echoes. Preserve ALL original assertions and DEFAULT1000ms vi.waitFor; no extra delays/warmup/timeout changes or fake connects. Full original failure /tmp/pma-s19f-parent-renewed-first-failure-raw-04.log shows connect always absent at94; likely cold-load timing but not proven. Scratch-only diagnostic may write fixture trace files. No source correction, full-suite retry or release acceptance authorized. Cumulative10min diagnostic/source-triage cap INCLUDING prior135253ms plus no-run reviewer6c883c79 native duration recorded in parent note; do not reset/borrow original validator budget. No Root emit/test/install/model/config/keyring/network/browser/services/stage/unstage/commit/reset/restore/stash/cleanup/branch/worktree/gitwrite-tree. Existing full484-entry index contains256 intentional staged changes SHA32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4 fixed.

## Acceptance Criteria

ONE Vitest invocation ONLY in new scratch repo, exact command with own resolved absolute paths: env -u MCP_UI_VIEWER MCP_DIRECT_TOOLS=__none__ HOME=<diag>/home PI_CODING_AGENT_DIR=<diag>/agent XDG_CONFIG_HOME=<diag>/xdg npm_config_cache=<diag>/npm npx --no-install vitest run __tests__/load-time-project-trust.test.ts. No unmodified baseline/warmup/additional env/probe/retry/full-suite/build. Test explicitly clears MCP_DIRECT_TOOLS internally: positive fixture not negative ambient proof. Save exact command, stdout/stderr, original stack/failure identity, truncation references, trace and instrumentation-only diff/provenance. If single run fails stop preserve/contact supervisor BEFORE any correction/new execution; independent integrity-only before/after root seal allowed, never original validator remaining steps PASS. If passes report isolated instrumented pass NOT proof full-suite timing or waiver. Report actual timestamp intervals/import/handle/connect ordering and console error messages/stacks (controlled fixture data only), instrumentation overhead and remaining uncertainty, no invented production diagnosis. Root all462 file hashes/index unchanged; old snapshots/logs unmodified. No files newly staged, existing merge index unchanged. Independent READ-ONLY review of diagnostic diff/log/trace before closure; broader s19f/whole-merge/Correction A/release/commit gates stay open.


## Notes

**2026-10-05T22:32:15Z**

EXACTphasebudget native135253Source-onlytriage+30967read-onlyrefusedexecution=166220msUSED oforiginal10min, REMAIN433780ms(~7m14) developercontinuationsMUSTcarry notreset/borrow. PriorreviewerroleSTOPNOclone/instrument/test/runtimewrite occurred. HumanapprovedscopeNOTyetcreatedticketapproval: askliteralapprovedbeforedeveloperlaunch. One scratch-only instrumentation implementation withticketlocalONEVitest; independentreviewREADONLYartifacts/diff notanotherexecution. Root484index/462seal frozen, no native/userstate/network writes. No source/full-suite/timeoutcorrection authorized.
