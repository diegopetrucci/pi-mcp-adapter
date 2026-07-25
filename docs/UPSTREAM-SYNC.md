# Upstream Sync Playbook (non-rebase model)

This document is the source of truth for how this fork (`diegopetrucci/pi-mcp-adapter`, hereafter "the fork") integrates changes from `nicobailon/pi-mcp-adapter` (hereafter "upstream"). It replaces any older guidance that implies repeatedly rebasing TLH deltas on top of `upstream/main`.

This ticket establishes workflow policy only. It does **not** adopt upstream `v2.11.0` or any later release, and it does not change runtime behavior.

## 1. Intake unit: upstream release/tag or coherent feature cluster

The unit of upstream review and integration is one of:

- an upstream **release/tag** (for example `v2.11.0`), or
- a **coherent feature cluster**: a bounded set of upstream commits that implement one fix/feature together and should be reviewed together.

Per-commit sync is explicitly rejected. Reasons:

- upstream often lands coupled commits that are only safe to reason about as a batch;
- commit-by-commit triage creates a permanent backlog of half-reviewed SHAs;
- a release/tag or feature cluster gives a natural, auditable "caught up through here, except for recorded exceptions" boundary.

## 2. Integration mechanism: explicit merge or squash-import PRs

Each intake is integrated through one of:

- an explicit **merge PR**, or
- a **squash-import PR** that brings in the reviewed upstream range as one or a small number of fork commits.

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
| `upstream_ref` | Upstream tag or commit range covered by the intake. |
| `intake_type` | `release`, `cluster`, or `hotfix`. |
| `integration_pr` | Fork PR number/link, or `n/a (baseline)` for the one-time baseline row. |
| `status` | `adopted`, `adopted-with-exceptions`, `rejected`, or `baseline`. |
| `exceptions` | Array of `{ "ref": "...", "reason": "..." }` objects; empty array when nothing was excluded. |
| `notes` | Free-text context for maintainers. |

The ledger records only:

- one-time baseline context,
- one row per real intake,
- explicit exceptions or rejections,
- high-value notes needed by future maintainers.

The **git DAG plus `.upstream-ledger.jsonl` are authoritative**. Heuristics such as `git cherry`, `git patch-id`, or future reports may be useful hints, but they never override the DAG/ledger record.

A `baseline` row is informational only. It marks the historical fork base and current review starting point; it does **not** assert that every upstream change after that base has been adopted.

## 4. TLH patch inventory must survive every intake

**Path:** `docs/tlh-patch-inventory.md`

This file lists the deliberate fork-only deltas that must be re-checked whenever upstream changes are imported. For this fork, that starts with:

- the dim connected-server footer/status presentation delta,
- the lazy startup facade versus heavy runtime split,
- the scoped package identity and npm trusted-publishing release path.

After every merge/squash-import PR, walk the inventory and confirm none of those deltas were silently clobbered.

## 5. Hotfix cherry-picks are allowed only between intakes

Single upstream cherry-picks are reserved for urgent, isolated fixes that cannot wait for the next scheduled intake.

Every such cherry-pick must:

- be genuinely isolated rather than a disguised feature cluster, and
- receive its own ledger row with `intake_type: "hotfix"` explaining the urgency and noting that the next full intake must reconcile/supersede it.

Hotfix cherry-picks are the exception, not the default sync model.

## 6. Fork release identity stays fork-owned

Upstream sync work must preserve the fork's release identity unless a separately approved ticket changes it:

- `package.json` `name` stays `@diegopetrucci/pi-mcp-adapter`;
- TLH decides the fork `version`; do not blindly adopt upstream version bumps during intake work;
- upstream `v*` tags are intake anchors, not fork release tags; do not publish them as the fork's release identity;
- fork releases use `tlh-v*` tags;
- if an upstream intake adopts a `package-lock.json`, regenerate it from the resolved, scoped fork `package.json` rather than hand-merging the upstream lockfile;
- fork release/publish workflow remains the trusted-publishing path in `.github/workflows/release.yml`;
- changelog/docs should preserve both upstream-adopted content and TLH fork release notes when they coexist.

## 7. Reporting helpers are non-authoritative

Any future upstream report at `scripts/upstream-report.*` is read-only operator aid only. It may summarize ahead/behind counts or likely already-applied commits, but it must never be treated as proof of adoption or as a substitute for ledger bookkeeping.
