---
id: pma-1l4l
status: in_progress
deps: [pma-b76k, pma-s19f]
links: []
created: 2026-10-02T16:57:14Z
type: task
priority: 1
assignee: Diego Petrucci
---
# Merge upstream v5.0.0 preserving TLH fork safeguards

Single released-tag intake of upstream nicobailon/pi-mcp-adapter tag v5.0.0 (5783e5e) into the fork (currently at upstream v2.36.0, c00e66b). Follow docs/UPSTREAM-SYNC.md (explicit merge, no rebase). Use 'git merge --no-ff --no-commit v5.0.0', resolve all conflicts, and STOP before committing; the architect will get user approval for the merge commit. Adopt all upstream behavior from v2.37.0..v5.0.0 except the exclusions below and the pieces split into sibling tickets. In this ticket keep Jev/TypeSafe/System One EXCLUDED (resolve modify/delete conflicts on jev-* files by keeping them deleted; keep @typesafe-ai/sdk out) - Jev is restored in a separate ticket. Exclusions handled here: (1) model-facing URL installer (mcp-install.ts, action install, settings.allowInstall) stays out; (2) remove the v5 pi-builtin-mcp.ts module and its session_start call site in index.ts (no no-op stub), plus write-specific onboarding bookkeeping/tests; keep /mcp registration and mcp_servers_change handling; (3) keep fork package name/version/README install pin, fork AGENTS.md, and drop upstream VISION.md and bench/. Preserve every safeguard in docs/tlh-patch-inventory.md: dim connected-server footer (init.ts); lazy startup facade vs heavy runtime split (startup-mcp-facade.ts, direct-tool-surface.ts, mcp-runtime.ts, index.ts) - port v5 index.ts changes (startup discovery that stops lazy servers, registerMcpServer/getMcpServers/mcp_servers_change, Pi deferred tools for directTools search, Pi mcp.json reading, project-server trust, progress-reset timeouts, resource-cleanup init-order fix from 76cc80b) through that split without adding heavy static imports to the startup closure; context-bounded defaults (namespace tools off, scriptMode off, freezeDirectTools on, manual-only skill, worker env isolation); explicit /mcp panel-save direct-tool reconciliation incl. lifecycle fencing and persistence provenance, now also correct for Pi deferred tools; config ownership: shared vs adapter-owned write targets, ~/.agents MCP files and host configs remain detection-only (do NOT adopt upstream automatic loading of ~/.agents/mcp.json and ~/.agents/mcp/mcp.json), symlink/alias checks, preview-before-mutation; URL-bound auth merge regressions.

## Design

Hotspots: index.ts (~557 upstream changed lines vs fork facade split), config.ts (~685), init.ts, commands.ts, mcp-setup-panel.ts, proxy-modes.ts, mcp-code.ts, mcp-script-worker.mjs (adopt QuickJS/WASM sandbox replacing node:vm). Regenerate package-lock.json from the scoped fork package.json rather than hand-merging. dist/ public artifacts are regenerated in a later ticket; do not hand-merge dist conflicts beyond what is needed to resolve the merge (prefer regenerating via npm run build:public).

## Acceptance Criteria

Merge of v5.0.0 staged with no conflict markers and not committed; upstream behavior adopted except listed exclusions; no mcp-install.ts, pi-builtin-mcp.ts, jev-* sources, @typesafe-ai/sdk, VISION.md, bench/; fork defaults (namespace off, scriptMode off, freezeDirectTools on) intact; ~/.agents and host configs not auto-loaded; npx tsc --noEmit passes; npm test passes, including __tests__/index-import-closure.test.ts, init-status-bar/init-status, startup-mcp-facade, mcp-runtime, index-lifecycle, direct-tools, commands-direct-tools-refusal, config, mcp-setup-preview-refusal, exclusive-config, mcp-code tests. Developer reports conflict resolutions per hotspot file.


## Notes

**2026-10-02T20:39:37Z**

Independent checkpoint review (run 699a0a73) rejected the staged merge: confirmed/reproduced config ownership and inactive .agents regressions; lost production facade/runtime wiring and stale panel-save fencing; unbounded proxy description; deleted/weakened fork regression tests. Ticket remains in_progress. Correction sequencing within this same approved scope: A) restore config ownership and detection-only .agents with regression tests; B) restore production lazy facade/runtime, lifecycle fencing, bounded description, cwd cache tests, deferred footer and frozen notice; C) remove stale public artifacts and correct excluded-feature docs/package docs scope. Preserve upstream v5 additions, leave merge uncommitted, do not delete/weaken safeguards to make tests pass. Fresh independent review required before requesting merge-commit approval.

**2026-10-02T21:33:04Z**

Correction A reported complete: config.ts, commands.ts and config/exclusive/onboarding tests; 174 targeted tests, tsc and npm test (2238 passed, 6 skipped) passed. Must still independently re-review. Correction B scope: wire production index facade to dynamically loaded mcp-runtime, preserving all v5 runtime capabilities; restore stale-session panel-save fencing and user-owned active tools, fixed proxy description, implicit stdio cwd hash coverage, dim connected-only footer (no enabled-only deferred footer), and freeze-default notice. Restore deleted fork regression assertions with only v5 contract/path adaptations. Ticket stays in_progress; no commits.

**2026-10-03T07:50:07Z**

Approved replanning after correction B hit 60-minute budget. Existing work preserved (tsc passes; last focused sample 65 failed/165 passed). Three new dependent correction tickets: pma-dt5s runtime init/shutdown/cancellation -> pma-gkeb tool/catalog/panel fencing -> pma-b76k bounded surface/cwd/footer/public cleanup. Parent waits for all three, then requires npm test, fresh independent full merge review and explicit user commit approval. Existing Jev/policy/release/final-validation dependencies unchanged. New tickets await user approval before worker dispatch.

**2026-10-03T14:17:53Z**

62919df6 review of second correction found 3 in-scope blockers on pma-gkeb; next slice cannot advance yet. Reviewer full index-lifecycle file (not full npm suite) reported 144 passed/7 failed. Two delayed import failures are confirmed gkeb regressions. FIVE additional failures require classification/fixing before parent acceptance: session_tree approval restoration, immediate replacement initialization, stale initialization finalization, /mcp-adapter completion, updateStatusBar error logging. Do not presume these are b76k footer/docs/description work or waive them; preserve assertions and determine owning scope after current focused fixes. Full npm test remains deferred until correction slices finish; combined parent review remains mandatory.

**2026-10-03T14:35:50Z**

Second-correction source follow-up restores original33 lifecycle checks (architect verified both env modes), expanded68/complete147 also green, but pma-gkeb remains unaccepted pending source re-review and permanent project-trust/deferred-transition regressions. Reviewer21de4076 is explicitly classifying the five previously reported full-lifecycle failures before they are assigned/waived. Source notes and cold trust/signal requirements preserved; no source/index/config deployment changes by architect.

**2026-10-03T14:45:57Z**

Reviewer21de4076 completes five-case classification: all five are v5 upstream fixture mismatches due approved fork zero-server guard, verified a temporary fixture-only copy passes5/5 without assertion changes. pma-gkeb still rejected for approved-project startup regression, hidden-definition metadata loss/assertion inversion, and absent permanent coverage. Proposing explicit bounded follow-up project-trust, live-vs-hidden tool, and five-fixture slices; full suite and parent acceptance remain blocked, no commits/staging/deployment.

**2026-10-03T19:52:37Z**

Project-startup/trust correction pma-gelt independently accepted; runtime/pretrust filtering/programmatic/zero-server protection and6 permanent real integration cases verified. Residual verification uncertainty: reviewer59898e3d first unset group63 pass/1 unidentified failure (log lost),33 further repetitions clean; parent64/64 bothenv clean. Do not hide/attribute/waive this; pma-2xal retains fail-fast and first-failure evidence requirement. Full suite/release acceptance still deferred and blocked.

**2026-10-05T19:53:02Z**

Allthreebounded correctionchains nowCLOSED: dt5s/gkeb/B76; lastB76 source/proof39aaa99d ACCEPT withdefaultnotice+disabled/countmutants causallycaughtbothliteralenvs. Whole-parentintent stillNOTaccepted/committable. Created pma-s19f FINAL-VALIDATION exact9steps, dependsB76; parentdepends s19f, HUMANapprovalofcreatedticketrequiredbeforetest-runner. Fullnpm runstwice literalnone/unset, withclone-copy461currentnonticketfiles+independentnode_modules in/tmp/pma-merge-final-validation.ifmblip_/repo andisolatedHOME/agent/XDG/npmcache, noRootbuilds/cachewrites. Wholecandidatewhitespace/root/hash/index safeguards; firstfailurestop/no retry/fix. SourceSnapshotcomparisonNEVERrestoration. AfterPASS stillfresh WHOLEMERGE source reviewinclCorrectionA/patchinventory/upstreamv5adoption andunwaivedrisks. No staging/commit permission, cleanupnotstarted/Jev/policy/release remainblocked.

**2026-10-05T20:25:58Z**

Humanapproved NEW boundedcorrection scope afterfirstfullFAIL/statictriage: upstreammcpScript guidance+EXPLICITmodelpointer/manualdefault(Gnosisjaczsg narrowclarificationrelatedwxcxnb); cancellablecurrentfiltered UI-native-signin offer/sharedcoldfirstusegate withoneexisting30sdeadline, adapter-ownedlive-responseauth/onboardingwritesONLY, nativefiles/settingsreadonly. Pre-sessioneager/keepalive semantics unchanged andoutsideguarantee. CREATED awaitingHUMANsignoff: pma-51ng(15min)->pma-afhq(45min)->renewedpma-s19f(original30min retains63636ms). No budgetreset/borrowingotherclosedchains. OriginalfullFAILcmds/logs/snapshotdatedimmutable; s19f renewedexplicitTEN0..9 commands withfreshsnapshotsetup AFTERbothindependentACCEPT, Rootnopublicbuild. StaticASTonly confirmshelperparse NOTnewtestpass. Workersnotlaunched; unstagedonlytickets/Gnosisparentmetadata. No filesnewlystaged existing256mergeindexunchanged. Wholemerge/CorrectionA/release/cleanup/commitstillunaccepted/unauthorized.
