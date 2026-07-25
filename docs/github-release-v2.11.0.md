Publishes the TLH-maintained fork as the scoped npm package `@diegopetrucci/pi-mcp-adapter@2.11.0`. This release keeps the merged upstream `v2.11.0` ancestry, preserves the reviewed TLH deltas, and leaves tag creation, GitHub release publication, and npm publishing pending.

## Highlights

- Scoped npm release: `@diegopetrucci/pi-mcp-adapter@2.11.0`
- Planned git tag: `tlh-v2.11.0`
- Exact install pin for TLH automation: `pi install npm:@diegopetrucci/pi-mcp-adapter@2.11.0`
- Preserves the current merged upstream `v2.11.0` intake plus TLH-specific scoped packaging, lazy startup facade, and trusted OIDC publication path
- Carries post-`v2.11.0` TLH security backports/adaptations for URL-bound auth state and reviewed follow-up fixes for metadata-cache cwd identity/validity, schema normalization, output ordering, and cancellation/resource aborts
- Pre-release validation completed on 2026-07-25 from a clean staged-tree archive; later approved work still owns tag, release, workflow dispatch, publish, and post-publish operations

## Install

```bash
pi install npm:@diegopetrucci/pi-mcp-adapter@2.11.0
```

Then reload Pi:

```text
/reload
```

## Validation and publish handoff

- Completed: `npm view @diegopetrucci/pi-mcp-adapter@2.11.0 version` returned `E404`, confirming the version is not yet published
- Completed: staged-tree `npm test` and `env -u PI_CODING_AGENT_DIR npm test` both passed with `52` test files / `476` tests
- Completed: `npx tsc --noEmit` passed with no diagnostics
- Completed: `npm pack` from the staged-tree archive produced `diegopetrucci-pi-mcp-adapter-2.11.0.tgz` for `@diegopetrucci/pi-mcp-adapter@2.11.0`; tarball inspection confirmed `50` packaged entries, including the expected runtime TypeScript files, root docs, `cli.js`, and bundled assets while excluding `.tickets`, `.pi-subagents`, tests, workflow files, and unrelated metadata
- Completed: isolated temp-project smoke checks passed for both `node node_modules/@diegopetrucci/pi-mcp-adapter/cli.js init --dry-run` and `./node_modules/.bin/pi-mcp-adapter init --dry-run`; both reported the expected Pi-agent config target without writing it
- Completed: release-prep metadata checks confirmed package/lock dependency equality, workflow `id-token: write`, workflow default ref `tlh-v2.11.0`, a single current README pin, preserved changelog history, and no merge-conflict markers
- Pending in a later approved ticket: create tag `tlh-v2.11.0`
- Pending in a later approved ticket: publish the GitHub release for tag `tlh-v2.11.0` using this body
- Pending in a later approved ticket: run `.github/workflows/release.yml` with trusted publishing and OIDC provenance
- Pending in a later approved ticket: complete post-publish npm propagation checks and install verification
