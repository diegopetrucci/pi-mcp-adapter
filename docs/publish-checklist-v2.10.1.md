# Publish checklist — v2.10.1

> Local release-prep validation is complete; reviewer signoff, tagging, and publish steps remain pending.

## Release scope

- [x] publish the tlh-maintained fork as the scoped npm package `@diegopetrucci/pi-mcp-adapter@2.10.1`
- [x] document git tag `tlh-v2.10.1`
- [x] update install guidance to use the scoped package and pinned `2.10.1` install for tlh automation
- [x] add `2.10.1` changelog and release docs for the scoped npm release

## Preflight and release docs

- [x] verify `@diegopetrucci/pi-mcp-adapter@2.10.1` is not already published on npm
- [x] create release docs
  - [x] `docs/release-notes-v2.10.1.md`
  - [x] `docs/github-release-v2.10.1.md`
  - [x] `docs/publish-checklist-v2.10.1.md`
- [x] run local validation before any tag or publish step
- [ ] complete release-prep validation review before tagging or publishing

## Validation

- [x] npm registry availability check: `npm view @diegopetrucci/pi-mcp-adapter@2.10.1 version --json`
- [x] `npm test`
- [x] `env -u PI_CODING_AGENT_DIR npm test`

```bash
npm view @diegopetrucci/pi-mcp-adapter@2.10.1 version --json
npm test
env -u PI_CODING_AGENT_DIR npm test
```

## Package dry-run

- [x] inspect the publish tarball metadata and included files
- [x] package dry-run inspected: `npm pack --dry-run --json`
- [x] reviewed the dry-run package manifest for `diegopetrucci-pi-mcp-adapter-2.10.1.tgz` (45 entries) to confirm the included publish payload

```bash
npm pack --dry-run --json
```

## Commit, tag, and GitHub release

- [ ] commit release changes on a non-main branch
- [ ] push the release branch
- [ ] open or update the PR targeting `main`
- [ ] after PR merge, tag `tlh-v2.10.1` on `main`
- [ ] push tag `tlh-v2.10.1`
- [ ] create the GitHub release for tag `tlh-v2.10.1` using `docs/github-release-v2.10.1.md`

## Stop before npm publish

> Human-only: npm publishing depends on the authenticated npm session.

- [ ] human publishes `@diegopetrucci/pi-mcp-adapter@2.10.1`

```bash
npm publish --access public
```

## Post-publish validation

- [ ] wait for npm propagation before validation (for example, 5 minutes after publish completes)
- [ ] verify the npm registry/package page shows `@diegopetrucci/pi-mcp-adapter@2.10.1`
- [ ] verify package metadata after propagation
- [ ] run an install check after propagation

```bash
npm view @diegopetrucci/pi-mcp-adapter@2.10.1 name version dist.tarball --json
pi install npm:@diegopetrucci/pi-mcp-adapter@2.10.1
```
