// Canonical startup/runtime direct-tool surface.
// Keep this compatibility module as an alias so lazy runtime consumers and
// startup resolution cannot drift in filtering, naming, or cache identity.
export {
  DIRECT_TOOLS_ADVISORY_THRESHOLD,
  buildProxyDescription,
  getDirectToolParametersSchema,
  getLargeDirectToolsAdvisory,
  getMissingConfiguredDirectToolServers,
  prepareDirectToolArguments,
  resolveDirectTools,
} from "./startup-mcp-facade.ts";
