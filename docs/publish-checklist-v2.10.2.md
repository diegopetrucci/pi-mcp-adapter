# Publish checklist — v2.10.2

> Release metadata, docs, local package validation, and release-prep review are prepared; tagging and publish steps remain pending.

## Release scope

- [x] prepare the tlh-maintained fork as the scoped npm package `@diegopetrucci/pi-mcp-adapter@2.10.2`
- [x] document git tag `tlh-v2.10.2`
- [x] update install guidance to use the scoped package and pinned `2.10.2` install for tlh automation
- [x] add `2.10.2` changelog and release docs for the scoped npm release
- [x] preserve runtime behavior by limiting this ticket to documentation/version metadata only

## Preflight and release docs

- [x] verify `@diegopetrucci/pi-mcp-adapter@2.10.2` is not already published on npm
- [x] create release docs
  - [x] `docs/release-notes-v2.10.2.md`
  - [x] `docs/github-release-v2.10.2.md`
  - [x] `docs/publish-checklist-v2.10.2.md`
- [x] run local validation before any tag or publish step
- [x] complete release package validation in ticket `pma-d5g9`
- [x] complete release-prep validation review before tagging or publishing

## Validation

- [x] npm registry availability check: `npm view @diegopetrucci/pi-mcp-adapter@2.10.2 version --json`
- [x] `npm test`
- [x] `env -u PI_CODING_AGENT_DIR npm test`

Validation run on 2026-07-08:
- `npm view @diegopetrucci/pi-mcp-adapter@2.10.2 version --json` → `E404 No match found for version 2.10.2` (expected; confirms unpublished version is still available)
- `npm test` → passed (`42` test files, `381` tests)
- `env -u PI_CODING_AGENT_DIR npm test` → passed (`42` test files, `381` tests)

```bash
npm view @diegopetrucci/pi-mcp-adapter@2.10.2 version --json
npm test
env -u PI_CODING_AGENT_DIR npm test
```

Release-prep review on 2026-07-08:
- final code review reported no blockers after checklist status wording was corrected

## Package dry-run

- [x] inspect the publish tarball metadata and included files
- [x] package dry-run inspected: `npm pack --dry-run --json`
- [x] review the dry-run package manifest for `diegopetrucci-pi-mcp-adapter-2.10.2.tgz`

Dry-run manifest checks on 2026-07-08:
- package name: `@diegopetrucci/pi-mcp-adapter`
- package version: `2.10.2`
- tarball filename: `diegopetrucci-pi-mcp-adapter-2.10.2.tgz`
- entry count: `47`
- expected release files present, including `cli.js`, `index.ts`, `mcp-runtime.ts`, `README.md`, `CHANGELOG.md`, `LICENSE`, `app-bridge.bundle.js`, and `banner.png`

```bash
npm pack --dry-run --json
```

## Commit, tag, and GitHub release

- [ ] commit release changes on a non-main branch
- [ ] push the release branch
- [ ] open or update the PR targeting `main`
- [ ] after PR merge, tag `tlh-v2.10.2` on `main`
- [ ] push tag `tlh-v2.10.2`
- [ ] create the GitHub release for tag `tlh-v2.10.2` using `docs/github-release-v2.10.2.md`

## Stop before npm publish

> Human-only: npm publishing depends on the authenticated npm session.

- [ ] human publishes `@diegopetrucci/pi-mcp-adapter@2.10.2`

```bash
npm publish --access public
```

## Post-publish validation

- [ ] wait for npm propagation before validation (for example, 5 minutes after publish completes)
- [ ] verify the npm registry/package page shows `@diegopetrucci/pi-mcp-adapter@2.10.2`
- [ ] verify package metadata after propagation
- [ ] run an install check after propagation

```bash
npm view @diegopetrucci/pi-mcp-adapter@2.10.2 name version dist.tarball --json
pi install npm:@diegopetrucci/pi-mcp-adapter@2.10.2
```
