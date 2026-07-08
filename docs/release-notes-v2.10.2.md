# Release notes — v2.10.2

## Highlights

This release prepares the tlh-maintained fork for scoped package version `@diegopetrucci/pi-mcp-adapter@2.10.2`, updates the pinned install guidance for tlh automation, and hands off the already-created `tlh-v2.10.2` tag/GitHub release for trusted npm publishing.

## pi-mcp-adapter

- includes the lazy-loading startup facade changes introduced since `2.10.1`
- carries forward the documented tlh fork purpose and pinned-install guidance for tlh automation
- prepares the release handoff for the already-created git tag `tlh-v2.10.2` and matching GitHub release
- completed local release-prep validation covering npm availability, both tlh test environments, and package dry-run inspection

## Packaging

- scoped package: `@diegopetrucci/pi-mcp-adapter@2.10.2`
- git tag: `tlh-v2.10.2`
- publish access: `public` via GitHub Actions trusted publishing (OIDC)
- repository: `https://github.com/diegopetrucci/pi-mcp-adapter`

## Install

```bash
pi install npm:@diegopetrucci/pi-mcp-adapter@2.10.2
```

Then reload Pi:

```text
/reload
```

## Validation status

- `npm view @diegopetrucci/pi-mcp-adapter@2.10.2 version --json` returned the expected npm E404, confirming the scoped `2.10.2` release is still available to publish
- `npm test` passed in the current tlh environment (`42` test files, `381` tests)
- `env -u PI_CODING_AGENT_DIR npm test` passed (`42` test files, `381` tests)
- `npm pack --dry-run --json` was inspected for `diegopetrucci-pi-mcp-adapter-2.10.2.tgz`, including the generated package manifest and `47` published entries
- release-prep validation details remain tracked in `docs/publish-checklist-v2.10.2.md`
- tag `tlh-v2.10.2` and the matching GitHub release already exist
- npm publication remains pending until `.github/workflows/release.yml` runs its trusted publishing handoff
- no additional tag, push, or GitHub release creation steps are required for this release handoff
