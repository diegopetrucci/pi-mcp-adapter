# AGENTS

## Repository role

- This repository is the `pi-mcp-adapter` fork maintained for **The Last Harness (tlh)**: https://github.com/diegopetrucci/the-last-harness
- Fork origin: `diegopetrucci/pi-mcp-adapter`
- Upstream source of truth: `nicobailon/pi-mcp-adapter`
- Purpose: maintain a reviewable fork of the Pi MCP adapter while preserving upstream compatibility unless an approved fork delta is required.

## Fork sync policy

- Keep this fork close to upstream `nicobailon/pi-mcp-adapter`.
- Prefer small, auditable diffs that are easy to rebase or replay during upstream sync.
- Treat upstream behavior, public MCP/tool contracts, config semantics, and user-visible workflows as the default.
- Add TLH-specific behavior only when required for compatibility, release/distribution, safety, or clearly approved fork needs.
- Avoid speculative refactors while the fork carries local deltas.

## Important TLH / MCP adapter hotspots

- **Bootstrap and tool surface**: `index.ts`, `init.ts`, `direct-tools.ts`, `proxy-modes.ts`
  - Changes here can break proxy-vs-direct tool behavior, initialization/shutdown, or the public `mcp` command/tool contract.
- **Config discovery, precedence, and writes**: `config.ts`, `commands.ts`, `agent-dir.ts`, `onboarding-state.ts`, `mcp-setup-panel.ts`
  - Preserve the documented precedence between `~/.config/mcp/mcp.json`, `<Pi agent dir>/mcp.json`, `.mcp.json`, and `.pi/mcp.json`.
  - Avoid unexpected writes to shared user/project MCP configs when Pi-owned override files are the intended destination.
- **Server lifecycle, metadata, and direct tool registration**: `server-manager.ts`, `lifecycle.ts`, `metadata-cache.ts`, `tool-registrar.ts`, `resource-tools.ts`
  - Changes here can break lazy/eager/keep-alive behavior, cached discovery, resource exposure, or direct tool naming/filtering.
- **OAuth and interactive UI flows**: `mcp-auth-flow.ts`, `mcp-auth.ts`, `mcp-oauth-provider.ts`, `mcp-callback-server.ts`, `oauth-handler.ts`, `mcp-panel.ts`, `sampling-handler.ts`, `elicitation-handler.ts`, `consent-manager.ts`, `ui-*.ts`
  - Preserve remote/manual auth flows, callback handling, approval prompts, and UI vs non-UI behavior.

## Development commands

- Validation command: `npm test`

## Gnosis / memory

- Commit `.gnosis/entries.jsonl` changes created or updated during repo work with the related work by default, unless the user explicitly says otherwise.
- Preserve existing `.gnosis/entries.jsonl` entries unless the assigned work explicitly requires changing them.

## Working rules

- Prefer the smallest correct change.
- Preserve upstream-compatible MCP config semantics, proxy/direct tool contracts, and auth/setup UX unless an approved ticket says otherwise.
- Keep user-owned configuration and on-disk state stable unless the task explicitly changes them.
- Update docs/tests together with behavior changes when they materially reduce fork risk.
- For docs-only work, inspect `git status` and `git diff`; run `npm test` when runtime behavior is touched or when confidence requires it.
