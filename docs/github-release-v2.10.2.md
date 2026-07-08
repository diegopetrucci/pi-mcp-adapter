Publishes the tlh-maintained fork as the scoped npm package `@diegopetrucci/pi-mcp-adapter@2.10.2`. The `tlh-v2.10.2` tag and GitHub release already exist; npm publication remains pending until the trusted publishing workflow runs.

## Highlights

- Scoped npm release: `@diegopetrucci/pi-mcp-adapter@2.10.2`
- Git tag: `tlh-v2.10.2`
- Exact install pin for tlh automation: `pi install npm:@diegopetrucci/pi-mcp-adapter@2.10.2`
- Includes the lazy-loading startup facade changes shipped since `2.10.1`
- Completed local release-prep validation: npm availability check, `npm test`, `env -u PI_CODING_AGENT_DIR npm test`, and `npm pack --dry-run --json` manifest inspection

## Install

```bash
pi install npm:@diegopetrucci/pi-mcp-adapter@2.10.2
```

Then reload Pi:

```text
/reload
```

## Validation and publish handoff

- `npm view @diegopetrucci/pi-mcp-adapter@2.10.2 version --json` returned the expected npm E404, confirming the scoped `2.10.2` release is still available to publish
- `npm test` passed in the current tlh environment, and `env -u PI_CODING_AGENT_DIR npm test` also passed
- `npm pack --dry-run --json` was reviewed, including the dry-run package manifest for `diegopetrucci-pi-mcp-adapter-2.10.2.tgz`
- Follow `docs/publish-checklist-v2.10.2.md` for reviewer signoff, confirmation that the tag/release already exist, GitHub Actions trusted publishing via `.github/workflows/release.yml`, and post-publish validation after npm propagation
