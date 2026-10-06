---
id: pma-5m1x
status: open
deps: [pma-1l4l]
links: []
created: 2026-10-02T16:57:14Z
type: feature
priority: 2
assignee: Diego Petrucci
---
# Allow project servers without prompting in trusted projects when projectServers is allow

Fork delta (user decision 1b): in project-server-trust.ts, when user-global settings.projectServers is 'allow', admit unapproved project servers in TRUSTED projects for both interactive (hasUI) and headless sessions without the approval prompt. Untrusted projects stay blocked in all modes. Default stays upstream 'ask'; project config files still cannot set the policy; project servers still excluded from extension-load initialization until session_start supplies trust. Update docs/configuration.md to describe fork behavior.

## Acceptance Criteria

Tests cover matrix: trusted+interactive+allow -> admitted without prompt; trusted+headless+allow -> admitted; untrusted (both modes) + allow -> blocked; default ask unchanged (interactive prompts, headless skips); project-level projectServers ignored. npx tsc --noEmit and npm test pass.

