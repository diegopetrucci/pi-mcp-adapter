---
id: pma-85pc
status: open
deps: [pma-3oj1]
links: []
created: 2026-10-02T16:57:14Z
type: task
priority: 1
assignee: Diego Petrucci
---
# Final validation for v5.0.0 intake

Final cross-ticket validation, executed by test-runner exactly in order: 1) npm ci  2) npx tsc --noEmit  3) npm test  4) env -u PI_CODING_AGENT_DIR npm test  5) npx vitest run __tests__/index-import-closure.test.ts __tests__/startup-mcp-facade.test.ts __tests__/mcp-runtime.test.ts __tests__/index-lifecycle.test.ts __tests__/direct-tools.test.ts __tests__/init-status-bar.test.ts __tests__/init-status.test.ts __tests__/commands-direct-tools-refusal.test.ts __tests__/config.test.ts __tests__/mcp-setup-preview-refusal.test.ts __tests__/exclusive-config.test.ts __tests__/package-manifest.test.ts  6) npm run test:oauth  7) npm run test:public-exports  8) npm audit --audit-level=high  9) npm pack --dry-run --json  10) git ls-files | grep -E '(^|/)(mcp-install|pi-builtin-mcp)\.|^bench/|^VISION\.md' ; test $? -eq 1  11) git diff --check

## Acceptance Criteria

All 11 steps pass in order; step 9 output reported with entry count and confirmation that jev, QuickJS/WASM worker assets and host-managed export are present.

