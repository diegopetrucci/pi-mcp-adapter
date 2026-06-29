# Release notes — v2.10.1

## Highlights

This release publishes the tlh-maintained fork as the scoped npm package `@diegopetrucci/pi-mcp-adapter@2.10.1`, prepares the GitHub release for tag `tlh-v2.10.1`, and keeps the install guidance pinned for tlh automation.

## pi-mcp-adapter

- publishes this fork to npm as `@diegopetrucci/pi-mcp-adapter@2.10.1` with public package metadata and pinned-install guidance for tlh automation
- prepares the release handoff for git tag `tlh-v2.10.1`
- completed local release-prep validation covering npm availability, both tlh test environments, and package dry-run inspection

## Packaging

- scoped package: `@diegopetrucci/pi-mcp-adapter@2.10.1`
- git tag: `tlh-v2.10.1`
- publish access: `public`
- repository: `https://github.com/diegopetrucci/pi-mcp-adapter`

## Install

```bash
pi install npm:@diegopetrucci/pi-mcp-adapter@2.10.1
```

Then reload Pi:

```text
/reload
```

## Validation status

- `npm view @diegopetrucci/pi-mcp-adapter@2.10.1 version --json` returned the expected npm E404, confirming the scoped `2.10.1` release is still available to publish
- `npm test` passed in the current tlh environment (`40` test files, `372` tests)
- `env -u PI_CODING_AGENT_DIR npm test` passed (`40` test files, `372` tests)
- `npm pack --dry-run --json` was inspected for `diegopetrucci-pi-mcp-adapter-2.10.1.tgz`, including the generated package manifest and `45` published entries
- release-prep validation details remain tracked in `docs/publish-checklist-v2.10.1.md`
