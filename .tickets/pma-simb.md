---
id: pma-simb
status: open
deps: [pma-1l4l]
links: []
created: 2026-10-02T16:57:14Z
type: feature
priority: 2
assignee: Diego Petrucci
---
# Restore Jev/System One semantic search behind a lazy boundary

Reverse the fork's v2.36 Jev/TypeSafe exclusion: restore upstream v5.0.0 Jev surface (jev-client.ts, jev-contracts.ts, jev-key-store.ts and related semantic-search code, @typesafe-ai/sdk dependency at upstream's pin, 'pi-mcp-adapter key set systemone' CLI incl. typesafe alias, SYSTEMONE_ENDPOINT/OpenRouter support, jev.evaluate RPC in mcpScript, searchMode semantic in mcp search, skills/mcp-scripting/references/jev.md, and upstream Jev tests). Upstream config.ts statically imports jev-client.ts which pulls the SDK and secure-keyring into the startup closure; keep a lightweight config-validation boundary so the SDK/keyring load lazily only when Jev is used.

## Acceptance Criteria

Upstream v5.0.0 Jev behavior and tests present; __tests__/index-import-closure.test.ts passes unchanged (no SDK/keyring/jev-client in startup closure); script worker still receives env {} and no key/endpoint/SDK; semantic search only when requested via searchMode semantic and a key is available; jev:false opt-out works; proxy tool description unchanged apart from upstream's searchMode schema text; npx tsc --noEmit and npm test pass.

