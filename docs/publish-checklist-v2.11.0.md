# Publish checklist — v2.11.0

> Release metadata and docs are prepared for the scoped TLH fork release. Pre-release validation for ticket `pma-7xw5` was completed on 2026-07-25 from a clean staged-tree archive; later approved tickets still own tag creation, GitHub release publication, trusted npm publishing, and post-publish verification.

## Release scope

- [x] prepare the TLH-maintained fork as the scoped npm package `@diegopetrucci/pi-mcp-adapter@2.11.0`
- [x] document planned git tag `tlh-v2.11.0`
- [x] update install guidance to use the scoped package and pinned `2.11.0` install for TLH automation
- [x] add `2.11.0` changelog and release docs for the scoped npm release
- [x] preserve runtime behavior by limiting this ticket to release metadata and documentation only

## Preflight and release docs

- [x] complete pre-release validation in ticket `pma-7xw5`
- [x] create release docs
  - [x] `docs/release-notes-v2.11.0.md`
  - [x] `docs/github-release-v2.11.0.md`
  - [x] `docs/publish-checklist-v2.11.0.md`
- [x] complete release-prep validation inputs for parent review before any later approved tag or publish ticket proceeds

Validation evidence recorded for `pma-7xw5`:
- [x] npm registry availability for `@diegopetrucci/pi-mcp-adapter@2.11.0`
  - `npm view @diegopetrucci/pi-mcp-adapter@2.11.0 version` returned `npm ERR! code E404` / `No match found for version 2.11.0`
- [x] full `npm test` suite in the current TLH environment
  - staged-tree archive run on 2026-07-25: `52` test files passed, `476` tests passed
- [x] full `env -u PI_CODING_AGENT_DIR npm test` suite
  - staged-tree archive run on 2026-07-25: `52` test files passed, `476` tests passed (same counts as `npm test`)
- [x] TypeScript check with `npx tsc --noEmit`
  - staged-tree archive run on 2026-07-25: passed with no diagnostics
- [x] clean-archive `npm pack` tarball metadata and contents inspection
  - archive source: `git archive $(git write-tree)` extracted outside the worktree
  - tarball: `diegopetrucci-pi-mcp-adapter-2.11.0.tgz`
  - package: `@diegopetrucci/pi-mcp-adapter@2.11.0`
  - entry count: `50`
  - confirmed present: `cli.js`, runtime root `*.ts` files including `index.ts`, `init.ts`, `mcp-runtime.ts`, `startup-mcp-facade.ts`, root docs `README.md` / `CHANGELOG.md` / `LICENSE`, and assets `app-bridge.bundle.js` / `banner.png`
  - confirmed absent: `.tickets`, `.pi-subagents`, `__tests__/`, `.github/`, and unrelated harness metadata
- [x] installed package CLI smoke evidence
  - isolated temp project command: `node node_modules/@diegopetrucci/pi-mcp-adapter/cli.js init --dry-run`
  - result: passed from an isolated cwd and reported the expected Pi-agent config target without writing it
- [x] symlinked package CLI smoke evidence
  - isolated temp project command: `./node_modules/.bin/pi-mcp-adapter init --dry-run`
  - result: passed from the same isolated cwd and reported the expected Pi-agent config target without writing it
- [x] JSON metadata checks for `package.json` and `package-lock.json`
  - package name/version match `@diegopetrucci/pi-mcp-adapter@2.11.0`
  - dependency, devDependency, peerDependency, and `bin` metadata in `package-lock.json` root match `package.json`
- [x] diff review for `README.md`, `.github/workflows/release.yml`, `CHANGELOG.md`, and the new release docs
  - `README.md`: exactly one current install pin `pi install npm:@diegopetrucci/pi-mcp-adapter@2.11.0`
  - `.github/workflows/release.yml`: keeps `id-token: write` and `default: tlh-v2.11.0`
  - `CHANGELOG.md`: preserves existing history and adds the TLH fork release note under `2.11.0`
  - conflict hygiene: no `<<<<<<<`, `=======`, or `>>>>>>>` markers found in the staged release tree

## Package metadata expectations

- package name: `@diegopetrucci/pi-mcp-adapter`
- package version: `2.11.0`
- exact install pin: `pi install npm:@diegopetrucci/pi-mcp-adapter@2.11.0`
- workflow input default ref: `tlh-v2.11.0`
- publish command: `npm publish --access public --provenance`

## Tag and GitHub release status

- [ ] a later approved ticket creates tag `tlh-v2.11.0`
- [ ] a later approved ticket publishes the GitHub release for tag `tlh-v2.11.0` using `docs/github-release-v2.11.0.md`
- [ ] npm publication is still pending

## Trusted publishing handoff

> A later approved ticket must publish from GitHub Actions using the trusted publishing workflow in `.github/workflows/release.yml`. Do not run `npm publish` from a human shell session.

- [ ] run the GitHub Actions workflow **Release to npm**
- [ ] use workflow input `ref=tlh-v2.11.0`
- [ ] confirm the workflow preflight reports `@diegopetrucci/pi-mcp-adapter@2.11.0` is not already published
- [ ] confirm the workflow completes `npm publish --access public --provenance`

## Post-publish validation

- [ ] wait for npm propagation before validation
- [ ] verify the npm registry/package page shows `@diegopetrucci/pi-mcp-adapter@2.11.0`
- [ ] verify package metadata after propagation
- [ ] run an install check after propagation

```bash
npm view @diegopetrucci/pi-mcp-adapter@2.11.0 name version dist.tarball --json
pi install npm:@diegopetrucci/pi-mcp-adapter@2.11.0
```
