import { Check, Errors } from "typebox/value";
import { Type } from "typebox";
import type { DirectToolSpec, McpConfig, ToolPrefix } from "./types.ts";
import type { MetadataCache } from "./metadata-cache.ts";
import {
  createCachedToolSelectorCandidateIndex,
  getMissingConfiguredDirectToolServers,
  isServerCacheValid,
  parseDirectToolSelectors,
} from "./metadata-cache.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import {
  createMcpDirectToolCallRenderer,
  renderMcpProxyToolCall,
  renderMcpToolResult,
} from "./tool-result-renderer.ts";
import {
  formatToolName,
  isServerDisabled,
  isToolAllowed,
  isToolExcluded,
  isToolIncluded,
  resolveToolPrefix,
  resolveUniqueNameOwnership,
  type ToolSelectorCandidateIndex,
} from "./types.ts";
import { isUiToolVisibleToModel } from "./ui-tool-visibility.ts";
import { normalizeDirectToolInputSchema } from "./utils.ts";

const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);

/**
 * Resolve the model-facing direct-tool surface from cached metadata.
 *
 * This is deliberately kept in the startup facade: it must be safe to use
 * before the runtime graph is loaded, while still applying the same visibility,
 * filtering, naming, and cache-identity rules as live metadata consumers.
 */
export function resolveDirectTools(
  config: McpConfig,
  cache: MetadataCache | null,
  prefix: ToolPrefix,
  envOverride?: string[],
  defaultCwd?: string,
): DirectToolSpec[] {
  if (!cache) return [];

  const specs: DirectToolSpec[] = [];
  const envSelection = envOverride ? parseDirectToolSelectors(envOverride) : null;
  const globalDirect = config.settings?.directTools;
  const hasConfiguredToolFilters = Object.values(config.mcpServers).some((definition) => (
    (Array.isArray(definition.includeTools) && definition.includeTools.length > 0)
    || (Array.isArray(definition.excludeTools) && definition.excludeTools.length > 0)
  ));
  const selectorIndex: ToolSelectorCandidateIndex | undefined = hasConfiguredToolFilters
    ? createCachedToolSelectorCandidateIndex(config.mcpServers, cache, prefix, defaultCwd)
    : undefined;

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    if (isServerDisabled(definition)) continue;

    const serverCache = cache.servers[serverName];
    if (!serverCache || !isServerCacheValid(serverCache, definition, undefined, defaultCwd)) continue;

    let toolFilter: true | string[] | false = false;
    let lazy = false;
    if (envSelection) {
      if (envSelection.servers.has(serverName)) {
        toolFilter = true;
      } else if (envSelection.tools.has(serverName)) {
        toolFilter = [...envSelection.tools.get(serverName)!];
      }
    } else {
      const selected = definition.directTools !== undefined ? definition.directTools : globalDirect;
      if (selected === "search") {
        // Search-mode tools are registered with their real schemas but held
        // out of the active tool set until lexical gateway search matches them.
        toolFilter = true;
        lazy = true;
      } else if (selected !== undefined) {
        toolFilter = selected;
      }
    }

    if (!toolFilter) continue;

    const effectivePrefix = resolveToolPrefix(definition, prefix);
    const addSpec = (spec: DirectToolSpec): void => {
      specs.push(spec);
    };

    for (const tool of serverCache.tools ?? []) {
      if (!isUiToolVisibleToModel(tool.uiVisibility)) continue;
      if (toolFilter !== true && !toolFilter.includes(tool.name)) continue;
      if (!isToolAllowed(
        tool.name,
        serverName,
        effectivePrefix,
        definition.includeTools,
        definition.excludeTools,
        selectorIndex,
      )) continue;

      const prefixedName = formatToolName(tool.name, serverName, effectivePrefix);
      if (BUILTIN_NAMES.has(prefixedName)) {
        console.warn(`MCP: skipping direct tool "${prefixedName}" (collides with builtin)`);
        continue;
      }
      addSpec({
        ...(lazy ? { lazy: true } : {}),
        serverName,
        originalName: tool.name,
        prefixedName,
        description: tool.description ?? "",
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.uiResourceUri !== undefined ? { uiResourceUri: tool.uiResourceUri } : {}),
        ...(tool.uiStreamMode !== undefined ? { uiStreamMode: tool.uiStreamMode } : {}),
      });
    }

    if (definition.exposeResources === false) continue;
    for (const resource of serverCache.resources ?? []) {
      const originalName = `read_${resourceNameToToolName(resource.name)}`;
      if (toolFilter !== true && !toolFilter.includes(originalName)) continue;
      const legacyResourceName = `get_${resourceNameToToolName(resource.name)}`;
      const included = isToolIncluded(originalName, serverName, effectivePrefix, definition.includeTools, selectorIndex)
        || isToolIncluded(legacyResourceName, serverName, effectivePrefix, definition.includeTools, selectorIndex);
      const excluded = isToolExcluded(originalName, serverName, effectivePrefix, definition.excludeTools, selectorIndex)
        || isToolExcluded(legacyResourceName, serverName, effectivePrefix, definition.excludeTools, selectorIndex);
      if (!included || excluded) continue;

      const prefixedName = formatToolName(originalName, serverName, effectivePrefix);
      if (BUILTIN_NAMES.has(prefixedName)) {
        console.warn(`MCP: skipping direct resource tool "${prefixedName}" (collides with builtin)`);
        continue;
      }
      addSpec({
        ...(lazy ? { lazy: true } : {}),
        serverName,
        originalName,
        prefixedName,
        description: resource.description ?? `Read resource: ${resource.uri}`,
        resourceUri: resource.uri,
      });
    }
  }

  const ownership = resolveUniqueNameOwnership(specs, spec => spec.prefixedName);
  for (const [name, colliding] of ownership.collisions) {
    console.warn(`MCP: skipping colliding direct name "${name}" from ${colliding.map(spec => `"${spec.serverName}"`).join(", ")}`);
  }
  return ownership.unique;
}

// Keep the legacy startup helper while accepting the unified selector-aware
// signature. The three-argument form remains cwd-first for older extensions.
export function getMissingStartupDirectToolServers(
  config: McpConfig,
  cache: MetadataCache | null,
  envOverrideOrCwd?: string[] | string,
  defaultCwd?: string,
): string[] {
  if (typeof envOverrideOrCwd === "string") {
    return getMissingConfiguredDirectToolServers(config, cache, undefined, envOverrideOrCwd);
  }
  return getMissingConfiguredDirectToolServers(config, cache, envOverrideOrCwd, defaultCwd);
}
export { getMissingConfiguredDirectToolServers };

export const DIRECT_TOOLS_ADVISORY_THRESHOLD = 75;

export function getLargeDirectToolsAdvisory(
  config: McpConfig,
  specs: readonly DirectToolSpec[],
): string | undefined {
  if (config.settings?.warnOnLargeDirectTools === false) return undefined;
  const eagerCount = specs.filter((spec) => !spec.lazy).length;
  if (eagerCount < DIRECT_TOOLS_ADVISORY_THRESHOLD) return undefined;
  return `MCP: ${eagerCount} direct tools resolved. Each direct tool adds prompt context; README guidance recommends targeted sets of 5-20 tools and using the proxy or an explicit string[] when 75+ direct tools would be registered. Set settings.warnOnLargeDirectTools to false to hide this advisory.`;
}

/**
 * Recover one model-emitted JSON layer for schema-declared object and array
 * properties, then validate the complete input against the same schema.
 */
export function prepareDirectToolArguments(inputSchema: unknown, args: unknown): unknown {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return args;
  const schema = inputSchema as Record<string, unknown>;
  if (schema.type !== "object") return args;
  const input = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : null;
  const properties = schema.properties;
  let prepared: Record<string, unknown> | undefined;

  if (input && properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(input, name) || typeof input[name] !== "string"
        || !propertySchema || typeof propertySchema !== "object" || Array.isArray(propertySchema)) continue;
      if (Check(propertySchema as never, input[name])) continue;
      try {
        const parsed: unknown = JSON.parse(input[name] as string);
        const isContainer = Array.isArray(parsed)
          || (parsed !== null && typeof parsed === "object");
        if (isContainer && Check(propertySchema as never, parsed)) {
          prepared ??= { ...input };
          prepared[name] = parsed;
        }
      } catch {
        // Validation below reports malformed or shape-incompatible values.
      }
    }
  }

  const candidate = prepared ?? args;
  if (!Check(inputSchema as never, candidate)) {
    const errors = Errors(inputSchema as never, candidate);
    const issues = errors.slice(0, 8).map((error) => ({
      instancePath: error.instancePath || "/",
      keyword: error.keyword,
      message: error.message,
    }));
    throw new TypeError(`MCP direct tool arguments do not match the advertised input schema: ${JSON.stringify({
      issues,
      total: errors.length,
      truncated: errors.length > issues.length,
    })}`);
  }
  return candidate;
}

/**
 * Pure function of config: the description must stay byte-stable across
 * runtime metadata changes (tool counts, connection state, and instructions).
 * Live counts belong to `mcp({})` and full server instructions are not a
 * gateway action in this bounded surface.
 */
export function buildProxyDescription(
  _config: McpConfig,
  _cache?: MetadataCache | null,
  _directSpecs?: DirectToolSpec[],
): string {
  return "MCP gateway for server status, tool search, tool description, connection, authentication, and single MCP tool calls. Use mcp({}) for status, mcp({search: \"query\"}) to find tools, mcp({describe: \"tool\"}) for parameters, and mcp({tool: \"tool\", args: \"{\\\"key\\\":\\\"value\\\"}\"}) for one call. Non-MCP tools should be called directly.";
}

export function getDirectToolParametersSchema(spec: Pick<DirectToolSpec, "inputSchema">) {
  return Type.Unsafe(normalizeDirectToolInputSchema(spec.inputSchema) as never);
}

export const MCP_PROXY_TOOL_PARAMETERS_SCHEMA = Type.Object({
  tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
  args: Type.Optional(Type.String({ description: "Arguments as JSON string (e.g., '{\"key\": \"value\"}')" })),
  connect: Type.Optional(Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" })),
  describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
  search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
  regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
  includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
  server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls)" })),
  action: Type.Optional(Type.String({ description: "Action: 'ui-messages', 'auth-start', or 'auth-complete'" })),
});

export {
  createMcpDirectToolCallRenderer,
  renderMcpProxyToolCall,
  renderMcpToolResult,
};
