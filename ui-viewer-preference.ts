/**
 * MCP Apps UI is opt-in.
 *
 * Terminal hosts (Claude Code, Codex CLI) do not render MCP Apps, and the
 * capability is optional in the spec: servers must keep a text fallback. So the
 * adapter only advertises `io.modelcontextprotocol/ui` and starts UI sessions
 * when `MCP_UI_VIEWER` names a viewer explicitly. `auto` keeps the previous
 * default resolution (Glimpse when available, otherwise the browser).
 */
export const MCP_UI_VIEWER_PREFERENCES = ["auto", "browser", "glimpse", "orca"] as const;

export type McpUiViewerPreference = (typeof MCP_UI_VIEWER_PREFERENCES)[number];

/** Returns the requested viewer, or null when MCP Apps UI is disabled. */
export function resolveMcpUiViewerPreference(): McpUiViewerPreference | null {
  const requested = process.env.MCP_UI_VIEWER?.toLowerCase();
  if (!requested) return null;
  return MCP_UI_VIEWER_PREFERENCES.includes(requested as McpUiViewerPreference)
    ? requested as McpUiViewerPreference
    : null;
}

/** True only for the explicit opt-in values; unset, empty, or unknown values keep UI off. */
export function isMcpUiEnabled(): boolean {
  return resolveMcpUiViewerPreference() !== null;
}
