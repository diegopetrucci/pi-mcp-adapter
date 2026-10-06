---
id: pma-xng5
status: closed
deps: []
links: []
created: 2026-10-04T21:22:36Z
type: task
priority: 1
assignee: Diego Petrucci
---
# Prove frozen panel SDK execution and UI resource ownership

TEST-ONLY implementation task, authorized as a separate proof slice after reviewer 4168cd01 accepted the pma-hxha source/guards but rejected execution proof. Read tk show THIS ticket first, then pma-hxha and reviewer artifact 4168cd01_code-reviewer_output.md. Sole writable file: __tests__/index-lifecycle.test.ts. Correct/extend the retained-B/refreshed-A production execution fixture at current lines 2116-2200. All production, docs, other tests, Gnosis and tickets are READONLY; parent manages tickets. Baseline /tmp/pma-sdk-ui-proof-before._20j7gtq is comparison evidence, NEVER a restoration source. Preserve every pre-existing change and all 256 intentionally staged merge paths; no stage/unstage/commit/reset/restore/stash/cleanup/branch/worktree/config/model changes. This is not a restart of the previous source implementation budget or a waiver of pma-hxha criteria. Stop/escalate any required source/scope change. No real server, HTTP listener, browser, remote client, user config or persistent cache writes. Existing production-direct-refresh-execution test is a READONLY lower-UI mock reference. Broad final validation remains exclusively pma-9m3v; full npm/B76/whole-merge/Jev/policy/release remain separate.

## Design

Keep the actual resolver, facade/runtime, registered executors, direct-tools implementation and SDK-call boundary. Mock only lower SDK clients/UI-server transport; do not fabricate executor results or hardcode structured=true. Give UiResourceContent valid meta and a contract-faithful lower startUiServer stub; exercise UI-session creation instead of swallowing its error. Retain the eager/default-frozen control. For raw structuredContent, use a faithful registered deferred/search companion if the eager contract does not return that field: direct-tools.ts preserves raw structuredContent only for structured/deferred execution, and index wraps it as SDK CallToolResult. Assert the actual branch contract, never change production or make eager return an invented shape. Use independent literal payload/target expectations, distinguish A/B client ownership, and demonstrate frozen B after A-only Save plus refreshed A. Preserve all prior protective assertions; explain fixture contract corrections before/after. Existing registry carryover/trust/stale-loop limits remain unwaived.

## Acceptance Criteria

1. The existing execution proof uses the production executor and distinct A/B SDK clients (or equally causal routing assertions). Before and after A-only persisted Save, prove retained B's complete declaration/schema/UI metadata and execution ownership; prove A's refreshed declaration/schema/tool/resource targets and outputs. Assert getConnection server names, callTool exact tool names/arguments, and readResource actual docs:// URIs. Results alone or spec snapshots do not prove routing.
2. Valid UI resource meta plus mocked lower transport reaches real UI-session code without HTTP/browser side effects. Assert readUiResource server/URI/options and startUiServer resource URI/meta for retained ui://b/keep and refreshed ui://a/new. No unexpected permissions TypeError or swallowed setup failure; do not suppress stderr to make the fixture appear healthy.
3. Independently assert SDK structured payload equality and the proper returned deferred CallToolResult contract through real registered execution; retain the eager branch and its actual public contract. No self-referential expected values, artificial executor result or forced structured flag. Tool/resource text/details and schemas stay checked. Correct SDK client/resource targets and UI URIs must be causally asserted.
4. No pre-existing protective assertion is deleted/skipped/weakened. All non-scope bytes match /tmp/pma-sdk-ui-proof-before._20j7gtq/read-only.sha256; index fingerprint unchanged; no new staged files or staged tickets. Report precise baseline delta, fixture diagnosis, raw ordered command/exits/counts/no skips/log paths. Independent code review must accept this slice and pma-hxha proof criteria before either closes. Review mutations should catch wrong server/tool/resource/UI URI and loss of structured payload in the real applicable branch.
Ticket-local validation: run exactly these commands once each in order after implementation; on first failure preserve identifying command/output/test/stack, diagnose before correcting, never rerun-until-green. Additional focused diagnostic checks require an explained cause; do not execute pma-9m3v final ten here.
1. npx tsc --noEmit
2. env -u MCP_DIRECT_TOOLS npx vitest run __tests__/index-lifecycle.test.ts __tests__/mcp-runtime.test.ts __tests__/index-direct-refresh-execution.test.ts
3. env MCP_DIRECT_TOOLS=__none__ npx vitest run __tests__/index-lifecycle.test.ts __tests__/mcp-runtime.test.ts __tests__/index-direct-refresh-execution.test.ts
4. git diff --check -- __tests__/index-lifecycle.test.ts
5. shasum -a 256 -c /tmp/pma-sdk-ui-proof-before._20j7gtq/read-only.sha256
6. test -z "$(git ls-files -u)"
7. test -z "$(git diff --cached --name-only -- .tickets)"
8. test "$(git ls-files --stage | shasum -a 256)" = "32f1524e43672921f6cea6095e696c01b3948babf13970aeb00b5efeb22c04e4  -"
Full-suite/broad validation explicitly deferred to its existing tickets. Positive fixtures may clear inherited MCP_DIRECT_TOOLS with documented environment restoration; preserve actual negative-mode controls.


## Notes

**2026-10-05T13:47:33Z**

Human approved created ticket and implementation. Sole writer for this separate test-only proof task; no revival/reset of previous hxha source chain. Branch already upstream-intake-v5.0.0; non-scope manifest verified before dispatch. One writable file __tests__/index-lifecycle.test.ts, production/other tests/docs/index/config/Gnosis/tickets read-only. Preserve expected index and all human changes. Independent proof/scope review required before this ticket and original hxha close; original source limits unwaived. Ticket-local eight checks only; pma-9m3v exact final ten remains blocked.

**2026-10-05T13:48:32Z**

Dispatched sole developer async96c76240-2eb0-44cd-b8fa-59bdcce0a837 for exactly this approved proof task. No model override. Eight ordered narrow checks required; independent review after completion, then parent evaluates original hxha criteria. Non-scope baseline verification log /tmp/pma-xng5-parent-preflight-hashes.log passed. No final-validation worker started.

**2026-10-05T14:02:19Z**

Supervisor decision after durable pause96c76240: parent inspected raw check02 exit1 (2failed216passed/218), stack lifecycle2320 expectedBcount0 actual1 after earlier B call; deferred2436 expected raw-onlycontent vs production appended structuredContent text. Correctiveedit changes counttoEXACT1 and constructs literal SDK payload/mirror expectations (not result-selfref); no protective assertion weakening seen in these two corrections. Focuseddiagnostic2pass196filtered-skips is NOT full suite evidence, barevitest is NOT explicit-unset mode evidence. Preserve logs01/02/diagnostic unchanged. Continue ticket steps03..08 ONCE/order, stopfirstfailure; doNOTrepeat02/restartsequence or claim all8green. Independent review must run corrected full3file suites literalunset andnone beforeacceptance, includingfresh typecheck ifnecessary. Separate9m3v exact10 stillblocked. Nonscopehash/indexverifiedatpause; scopeonlyonefile. Log parentdelta /tmp/pma-xng5-parent-paused-delta.diff. No freshworker/budgetreset/modeloverride; resume samewriter with cumulativeelapsed budget.

**2026-10-05T14:03:32Z**

Same paused writer resumed as5bae3aa8 with explicit03..08onlyguidance. Original failed02 immutableparentcopy /tmp/pma-xng5-parent-first-failure.log. Existing independent reviewer chain2184→605→0ec→4168 consumed698281ms(~11m38),2901719ms(~48m22)remaining60m; can resume4168 for new proof+originalhxhaacceptance withoutbudgetreset. Do not treat diagnostics196filteredskips asnewfullsuite-skips or barevitest asunset evidence. No finalvalidation worker beforeindependentintentacceptance.

**2026-10-05T14:08:41Z**

Parent audited raw completion: only lifecycle test differs from baseline (+279/-21); all 256 non-scope manifest entries and existing merge index unchanged. Commands executed once in order: raw session af509ede 75/79/90/92/94/96/98/100; 77 only reads log01, 85 is separate focused diagnostic. Check02 remains FAIL2/216passed, first log byte-identical to preserved copy. Corrected03 PASS218/3files no skips and no UI permissions error;04..08 PASS. Independent reviewer resumed4168 as e2556263 for all new criteria and entire hxha intent; requires fresh current typecheck/full3-file literalunset+none and causal SDK/UI/structured mutations. Parent flagged possible post-Save B UI/resource assertion gap (third UI call only server:tool map; B resource executed pre-Save only); reviewer to assess literal intent with mutation, no presumed source defect. Tickets remain open pending substantive acceptance,9m3v blocked; generic existing-staged rejection does not authorize unstaging.

**2026-10-05T14:13:08Z**

Independent e2556263 rejects only remaining post-Save retained-B proof. Fresh tsc and literalunset/none full3file suites218/218 pass no skips/no UI errors; routing/tool/resource/AUI/SDKpayload mutations causal, but MU4b redirects B-second-call UI to valid ui://a/new and2testsremaingreen. Needed same approved one-file scope: third readUiResource/startUiServer resourceURI/meta exact; B resource SDK execute again postSave with docs://b/keep on Bclient; valid passive current BUIv2/description/schema/resource metadata before A-only Save with authentic metadata hook, original B declaration/SDKtargets retained. No source change authorized; escalate if authentic case reveals new source defect. Resume SAME developer5bae; cumulative735123+150698=885821ms (~14m46),remaining2714179ms(~45m14)of60, no budget reset. NEW review-correction candidate warrants one new ordered8-check pass in new /tmp/pma-xng5-review-fix-01..08.log; initiallogs01..08 and failure/diagnostic preserved, not relabeled. Stop firstfailure and contact supervisor before further correction/retry. No final10/npm. All non-scope hashes/index unchanged before this correction; originalhxha criteria remainunwaived/open.

**2026-10-05T14:14:20Z**

Same developer resumed as87ba5b0f, one-file proof correction only. Precise before-fix checkpoint /tmp/pma-xng5-before-review-fix.tylew08i; compare only. New ordered validation logs review-fix-01..08 explicitly authorized once per new candidate; preserve initial failed02 and full chronology. Production remains sealed; authentic new fixture exposing production bug requires supervisor stop, not unauthorized source edit.

**2026-10-05T14:24:12Z**

Supervisor inspected paused87ba5 review-fix failure: check02 exit1,217passed/1failed before metadata update at lifecycle2245; registeredTool uses find FIRST while lastRegistered uses reverse.find LAST, legitimate initial duplicate registrations produce equal-valued distinct definition objects. Authorize only contract-aligned baseline correction: retain first B/tool-resource definitions, independently capture initial LAST definitions and both immutable execute callbacks before mutation, then assert exact unchanged last identity/registration counts/literalolddeclarations/callbacks after passive Bv2 and A Save. No guessing registration1 or first==last, no relaxing counts/reference equality, no self-referential execute:definition.execute expectation. Keep all earlier SDK/UI/resource/spec-identity assertions and validv2 metadata hook. Original review-fix01/02 immutable; firstfailureparentcopy /tmp/pma-xng5-parent-review-fix-first-failure.log. One fresh post-correction8-command pass authorized with NEW /tmp/pma-xng5-review-fix2-01..08.log, once/order/stopfirstfailure; no automatic retries. Cumulativewriter1399701ms23m20,remaining2200299ms36m40of60 continuous. Non-scope hashes/index unchanged; authentic production failure must stop/escalate, source remains READONLY.

**2026-10-05T14:25:41Z**

Same paused developer resumed as3d38718b with scoped first/last baseline correction and immutable executor callback capture. Review-fix2 fresh validation once/order explicitly authorized; all previous failure logs stay preserved. This pause is recoverable, not authority for parent source edits or fresh budget/model dispatch. Independent reviewer must accept corrected post-Save metadata/UI/resource proof before closure.

**2026-10-05T14:33:20Z**

Parent verified3d38718b completion: original-baseline delta+423/-24, review-correction delta+145/-4; source/non-scope256hashes/index unchanged. Fresh review-fix2 eight commands executed once/order rawsessionaf509ede215/217/219/221/223/225/227/229 with pipefail+tee, toolresults216..230isErrorfalse; both suites218/218 no skips. Logs now tee-only, so quiet success logs are empty (parent initial audit expected exit suffix and raised own AssertionError; corrected audit used raw results, no validation/source retries). Both original failed02 logs byte-identical to parent preserved copies. Independentreviewer730a1d16 resumed samechain to replay MU4b and validBv2 UI/postSave resource redirects and scope force-all causality, then decide full xng5/hxha intent. ValidpassiveBv2+realhook introduced; separate FIRST/LAST initial definition/callback baselines pinned; postSaveBthirdUI/resource executed with exact SDK/URI proofs. No self-referential callback assertions or relaxed counts. No ticket closure/final10 before independent acceptance; old limits unwaived.

**2026-10-05T14:35:37Z**

Independent730a1d16 ACCEPTS all4criteria and fullhxha intent. Fresh /tmp/xng5-rereview.JZ8C typecheck+literalunset/none218/218 no skips/no proofstderr. MU4b replay andMU6validBv2 UI redirect fail thirdURIassert; MU7 postSaveBresourceV2 fail2ndSDKreadResourceargs; N0forceall andN13freezeoff fail exactBreg3vs2, proving passiveBv2hook observable. Priorrouting/tool/resource/AUI/rawstructured mutations stillcaught. No protectiveassertion weakened; FIRST/LAST callbacks/definitions pinned separately notassumedidentical. Parent artifact/source/hashes/index inspection agrees. Existingstaged-files harnessREJECT is metadata only, all256intentionalindexpaths unchanged. Closing implementationproof intent; final9m3v andfreshcombinedgkeb stillmandatory, oldlimitsunwaived.
