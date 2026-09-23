# Upstream Sync Playbook (non-rebase, released-tag-only model)

This document is the source of truth for how this fork (`diegopetrucci/pi-mcp-adapter`) integrates changes from `nicobailon/pi-mcp-adapter` (upstream). The fork stays reviewable and close to upstream without replaying TLH changes on `upstream/main`.

## 1. Intake boundary: released upstream tags only

A normal intake is exactly one upstream **released version tag** (for example `v2.36.0`) and the commits reachable from that tag that are part of the released history. An upstream release tag is an audit anchor, not the fork's release identity.

Do not intake `upstream/main`, a moving branch, a pull request range, or a coherent feature cluster that has not been released. In particular, do not create a synthetic intake from unreleased commits merely because they look related. A later released tag can adopt those changes when the tag is reviewed as a whole. This released-tag-only boundary prevents accidental adoption of work that upstream has not shipped and keeps ledger rows reproducible.

The v2.36.0 intake is therefore bounded by upstream tag `v2.36.0` at commit `c00e66b5b959f3327ebefddd93fffe8d402694a3`; commits after that tag, including `upstream/main`, are outside the intake.

## 2. Integration mechanism: explicit merge or squash-import PRs

Each released-tag intake is integrated through one of:

- an explicit **merge PR**, or
- a **squash-import PR** that brings in the reviewed released-tag range as one or a small number of fork commits.

The fork's history is **not** kept current by perpetual rebases onto `upstream/main`. Rebase/replay-on-top is rejected because it rewrites fork-only SHAs on every sync, weakens reviewability, and makes the patch history harder to audit.

Each intake should produce:

- one fork PR that performs the merge/squash-import,
- one ledger row in `.upstream-ledger.jsonl`, and
- patch-inventory updates in `docs/tlh-patch-inventory.md` if a TLH delta was added, removed, or re-verified.

## 3. Exception-only ledger plus git DAG are authoritative

**Path:** `.upstream-ledger.jsonl`

The ledger is append-only JSONL, one JSON object per line, one line per intake. Newer entries are appended at the bottom.

Field schema:

| Field | Meaning |
| --- | --- |
| `date` | Intake integration date (`YYYY-MM-DD`). |
| `upstream_ref` | Released upstream tag covered by the intake; an isolated urgent hotfix may name its exact commit. |
| `intake_type` | `release` for a released tag, or exceptional `hotfix` for an isolated urgent fix between release intakes. No `cluster` rows are permitted. |
| `integration_pr` | Fork PR number/link, or an explicit merge/import reference. |
| `status` | `adopted`, `adopted-with-exceptions`, `rejected`, or `baseline`. |
| `exceptions` | Array of `{ "ref": "...", "reason": "..." }` objects; empty array when nothing was excluded. |
| `notes` | Free-text context for maintainers, including the exact merge and upstream tag commits when useful. |

The ledger records only:

- one-time baseline context,
- one row per real released-tag intake,
- explicit exceptions or rejections,
- high-value notes needed by future maintainers.

The **git DAG plus `.upstream-ledger.jsonl` are authoritative**. Heuristics such as `git cherry`, `git patch-id`, or future reports may be useful hints, but they never override the DAG/ledger record.

A `baseline` row is informational only. It marks the historical fork base and current review starting point; it does **not** assert that every upstream change after that base has been adopted.

## 4. TLH patch inventory must survive every intake

**Path:** `docs/tlh-patch-inventory.md`

This file lists the deliberate fork-only deltas and safeguards that must be re-checked whenever a released upstream tag is imported. At minimum, walk the dim connected-server footer, the lazy startup facade versus heavy runtime boundary, scoped package/trusted publishing identity, config ownership/write boundaries, context-bounded model-facing surfaces, and any security regression tests retained from an older backport.

## 5. Exceptional hotfixes between released-tag intakes

A single upstream commit may be recorded as `intake_type: "hotfix"` only when it is urgent, isolated, and cannot wait for the next released tag. It must receive its own ledger row explaining the urgency and stating that the next full released-tag intake must reconcile or supersede it; a hotfix must not broaden the released-tag boundary.

## 6. Fork release identity stays fork-owned

Upstream sync work must preserve the fork's release identity unless a separately approved ticket changes it:

- `package.json` `name` stays `@diegopetrucci/pi-mcp-adapter`;
- TLH decides the fork `version`; do not blindly adopt upstream version bumps during intake work;
- upstream `v*` tags are intake anchors, not fork release tags, and are never published as the fork's identity;
- this scoped intake uses fork version `2.36.0` and the planned fork tag `tlh-v2.36.0`;
- fork releases use `tlh-v*` tags;
- if an upstream intake adopts a `package-lock.json`, regenerate it from the resolved, scoped fork `package.json` rather than hand-merging the upstream lockfile;
- fork release/publish workflow remains the trusted-publishing path in `.github/workflows/release.yml`, with dependency installation and public-artifact build before `npm publish --provenance`;
- changelog/docs should preserve both upstream-adopted context and TLH fork release notes when they coexist.

## 7. Reporting helpers are non-authoritative

Any future upstream report at `scripts/upstream-report.*` is read-only operator aid only. It may summarize ahead/behind counts or likely already-applied commits, but it must never be treated as proof of adoption or as a substitute for ledger bookkeeping.
