# Release notes — v2.11.0

## Highlights

This scoped TLH fork release prepares `@diegopetrucci/pi-mcp-adapter@2.11.0` from the ancestry-preserving upstream `v2.11.0` intake, keeps the reviewed TLH fork deltas intact, and hands off the planned `tlh-v2.11.0` tag/GitHub release for trusted npm publishing.

## pi-mcp-adapter

- adopts upstream `v2.11.0` without rewriting ancestry, preserving the merged intake on `main`
- keeps TLH fork deltas for the scoped package identity, lazy-loading startup facade, and trusted GitHub Actions OIDC publication path
- carries post-`v2.11.0` TLH security backports/adaptations that keep stored OAuth state bound to the configured server URL
- includes reviewed post-intake fixes covering metadata-cache cwd identity/validity, direct-tool schema normalization, output guard ordering, and cancellation/resource abort handling
- prepares the release handoff for the planned git tag `tlh-v2.11.0` and matching GitHub release

## Packaging

- scoped package: `@diegopetrucci/pi-mcp-adapter@2.11.0`
- planned git tag: `tlh-v2.11.0`
- publish access: `public` via GitHub Actions trusted publishing (OIDC provenance)
- repository: `https://github.com/diegopetrucci/pi-mcp-adapter`

## Install

```bash
pi install npm:@diegopetrucci/pi-mcp-adapter@2.11.0
```

Then reload Pi:

```text
/reload
```

## Validation status

- Pre-release validation was completed on 2026-07-25 against a clean staged-tree archive created outside the worktree with `git archive $(git write-tree)`
- `npm view @diegopetrucci/pi-mcp-adapter@2.11.0 version` returned `E404`, confirming `2.11.0` is still unpublished
- `npm test` passed with `52` test files / `476` tests, and `env -u PI_CODING_AGENT_DIR npm test` passed with the same `52` / `476` counts
- `npx tsc --noEmit` passed with no diagnostics
- `npm pack` produced `diegopetrucci-pi-mcp-adapter-2.11.0.tgz` for `@diegopetrucci/pi-mcp-adapter@2.11.0`; tarball inspection confirmed `50` packaged entries with the expected runtime TypeScript files, root docs, `cli.js`, and bundled assets, while excluding `.tickets`, `.pi-subagents`, tests, workflow files, and unrelated metadata
- isolated install smoke checks passed for both `node node_modules/@diegopetrucci/pi-mcp-adapter/cli.js init --dry-run` and `./node_modules/.bin/pi-mcp-adapter init --dry-run`; both reported the expected Pi-agent config target without writing it
- release-prep metadata checks confirmed package/lock dependency equality, workflow `id-token: write`, workflow default ref `tlh-v2.11.0`, a single current README pin, preserved changelog history, and no merge-conflict markers
- Pending in later approved release-operation tickets: create the tag and GitHub release, dispatch trusted publishing, and complete post-publish verification
- No tag, release, publish, workflow dispatch, or post-publish action has been performed by this ticket
