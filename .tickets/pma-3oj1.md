---
id: pma-3oj1
status: open
deps: [pma-simb, pma-5m1x]
links: []
created: 2026-10-02T16:57:14Z
type: chore
priority: 2
assignee: Diego Petrucci
---
# Fork release identity, peer range, docs, ledger and patch inventory for 5.0.0

Set fork package.json version 5.0.0 (name stays @diegopetrucci/pi-mcp-adapter); add ^1.0.0 to the @earendil-works/pi-ai peer range; regenerate package-lock.json from the scoped package.json; update README exact install pin to 5.0.0; CHANGELOG entry combining upstream v2.37.0-v5.0.0 notes with TLH fork notes (exclusions, Jev restoration, projectServers delta, peer range); regenerate dist via npm run build:public. Append ONE .upstream-ledger.jsonl row for upstream_ref v5.0.0 (intake_type release, status adopted-with-exceptions, integration_pr TBD placeholder to fill once PR exists) recording exceptions: release-identity, url-install, pi-builtin-mcp-settings-write, agents-detection-only, tlh-safeguards, jev-restored (reverses v2.36 exclusion), project-servers-allow-interactive, peer-range-pi-1.0, upstream-docs-bench-vision. Update docs/tlh-patch-inventory.md: remove Jev from excluded list and note searchMode schema text, add rows for projectServers allow delta and builtin-mcp settings-write exclusion and .agents detection-only, add a v5.0.0 intake walk section. Update docs/UPSTREAM-SYNC.md references to the current intake where they name v2.36.0 as current.

## Acceptance Criteria

package.json name/version/peer range correct; lockfile scoped and consistent (npm ci works); README pin 5.0.0; CHANGELOG, ledger (valid JSONL, one new row), patch inventory, UPSTREAM-SYNC updated; npx vitest run __tests__/package-manifest.test.ts, npm run test:public-exports, npm audit --audit-level=high pass; npm pack --dry-run --json contains no mcp-install/pi-builtin-mcp/bench/VISION artifacts and includes QuickJS/WASM worker assets, jev assets, host-managed export.


## Notes

**2026-10-03T12:18:15Z**

When lifecycle fixes are verified, document the approved shared-initialization cancellation safeguard explicitly in patch inventory/release notes: retain v5 first-use cwd/UI/model context, but do not let the first caller signal own shared startup; request waits/execution remain caller-cancellable and session ownership stops shared work. Reviewer identified v5 itself couples first-use ctx.signal to initialization, so do not claim complete semantic parity on this boundary. Add the new startup-budget/facade and real-runtime ownership tests to re-verification; only record as implemented after lifecycle tickets pass review. Related empirical test-environment observation is gn entry efpkuh (child inherited __none__, architect unset); preserve/include related memory changes when commits are explicitly authorized.

**2026-10-03T13:01:40Z**

Verified lifecycle checkpoint 9f3485f4: shared startup context now has signal undefined, retains first-use/saved host descriptors and live getters, and relies on adapter runtime owner for shutdown/replacement cancellation. Real Pi session_start ctx.signal is a live current-turn getter, not session ownership. Reflect intentional cancellation safeguard in inventory. Residual effect to document: init.ts sampling getSignal now has owner-only cancellation, not turn signal; no separate sampling changes were authorized/performed. Reviewer also notes a theoretical bounded liveness-only first-expedite microtask window (30s pending, no overlap/stale publication), not a lifecycle blocker.
