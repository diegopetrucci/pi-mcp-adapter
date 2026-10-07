import { Check, Errors } from "typebox/value";
import { Type } from "typebox";
import type { DirectToolSpec, McpConfig, ToolPrefix, ToolSelectorCandidateIndex } from "./types.ts";
import { createToolSelectorCandidateIndex, formatToolName, getToolNameCandidates, isServerDisabled, isToolAllowed, resolveToolPrefix, resolveUniqueNameOwnership } from "./types.ts";
import type { MetadataCache } from "./metadata-cache.ts";
import {
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
import { isUiToolVisibleToModel } from "./ui-tool-visibility.ts";
import { normalizeDirectToolInputSchema } from "./utils.ts";

const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);

export const DIRECT_TOOLS_ADVISORY_THRESHOLD = 75;

export function getLargeDirectToolsAdvisory(config: McpConfig, specs: readonly DirectToolSpec[]): string | undefined {
  if (config.settings?.warnOnLargeDirectTools === false) return undefined;
  const eagerCount = specs.filter((spec) => !spec.lazy).length;
  if (eagerCount < DIRECT_TOOLS_ADVISORY_THRESHOLD) return undefined;
  return `MCP: ${eagerCount} direct tools resolved. Each direct tool adds prompt context; the direct tools guide in docs/tools.md recommends targeted sets of 5-20 tools and using the proxy or an explicit string[] when 75+ direct tools would be registered. Set settings.warnOnLargeDirectTools to false to hide this advisory.`;
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
      // A valid string may be intentional (for example, string | object).
      // Only recover JSON when the advertised property rejects the raw value.
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
  // TLH fork: pass session cwd so stdio server cache hashes are cwd-scoped.
  defaultCwd?: string,
  unavailableServers: ReadonlySet<string> = new Set(),
  reservedNames?: Set<string>,
): DirectToolSpec[] {
  const specs: DirectToolSpec[] = [];
  if (!cache) return specs;

  const envSelection = envOverride ? parseDirectToolSelectors(envOverride) : null;
  const globalDirect = config.settings?.directTools;
  let selectorCandidateIndex: ToolSelectorCandidateIndex | undefined;

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    if (isServerDisabled(definition)) continue;
    const serverCache = cache.servers[serverName];
    if (!serverCache || !isServerCacheValid(serverCache, definition, 0, defaultCwd ?? process.env)) continue;

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
        // Real tools with real schemas, but registered inactive; the model
        // reaches them through mcp({ search }), which activates the matches.
        toolFilter = true;
        lazy = true;
      } else if (selected !== undefined) {
        toolFilter = selected;
      }
    }

    if (!toolFilter) continue;

    const effectivePrefix = resolveToolPrefix(definition, prefix);
    const hasToolFilters =
      (Array.isArray(definition.includeTools) && definition.includeTools.length > 0) ||
      (Array.isArray(definition.excludeTools) && definition.excludeTools.length > 0);
    if (hasToolFilters && !selectorCandidateIndex) {
      const candidates = new Set<string>();
      for (const [otherServerName, otherDefinition] of Object.entries(config.mcpServers)) {
        const otherCache = cache.servers[otherServerName];
        if (!otherCache || !isServerCacheValid(otherCache, otherDefinition, 0, defaultCwd ?? process.env) || isServerDisabled(otherDefinition)) continue;
        const otherPrefix = resolveToolPrefix(otherDefinition, prefix);
        for (const otherTool of otherCache.tools ?? []) {
          if (!isUiToolVisibleToModel(otherTool.uiVisibility)) continue;
          for (const candidate of getToolNameCandidates(otherTool.name, otherServerName, otherPrefix, false)) candidates.add(candidate);
        }
        if (otherDefinition.exposeResources !== false) {
          for (const resource of otherCache.resources ?? []) {
            const baseName = `read_${resourceNameToToolName(resource.name)}`;
            for (const candidate of getToolNameCandidates(baseName, otherServerName, otherPrefix, false)) candidates.add(candidate);
          }
        }
      }
      selectorCandidateIndex = createToolSelectorCandidateIndex(candidates);
    }

    for (const tool of serverCache.tools ?? []) {
      if (!isUiToolVisibleToModel(tool.uiVisibility)) continue;
      if (toolFilter !== true && !toolFilter.includes(tool.name)) continue;
      if (!isToolAllowed(tool.name, serverName, effectivePrefix, definition.includeTools, definition.excludeTools, selectorCandidateIndex)) continue;
      const prefixedName = formatToolName(tool.name, serverName, effectivePrefix);
      if (BUILTIN_NAMES.has(prefixedName)) {
        console.warn(`MCP: skipping direct tool "${prefixedName}" (collides with builtin)`);
        continue;
      }
      specs.push({
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

    if (definition.exposeResources !== false) {
      for (const resource of serverCache.resources ?? []) {
        const baseName = `read_${resourceNameToToolName(resource.name)}`;
        if (toolFilter !== true && !toolFilter.includes(baseName)) continue;
        if (!isToolAllowed(baseName, serverName, effectivePrefix, definition.includeTools, definition.excludeTools, selectorCandidateIndex)) continue;
        const prefixedName = formatToolName(baseName, serverName, effectivePrefix);
        if (BUILTIN_NAMES.has(prefixedName)) {
          console.warn(`MCP: skipping direct resource tool "${prefixedName}" (collides with builtin)`);
          continue;
        }
        specs.push({
          ...(lazy ? { lazy: true } : {}),
          serverName,
          originalName: baseName,
          prefixedName,
          description: resource.description ?? `Read resource: ${resource.uri}`,
          resourceUri: resource.uri,
        });
      }
    }
  }

  const ownership = resolveUniqueNameOwnership(specs, (spec) => spec.prefixedName);
  for (const [name, colliding] of ownership.collisions) {
    console.warn(`MCP: skipping colliding direct name "${name}" from ${colliding.map((spec) => `"${spec.serverName}"`).join(", ")}`);
  }
  const uniqueSpecs = ownership.unique;
  for (const spec of uniqueSpecs) reservedNames?.add(spec.prefixedName);

  const emittedSpecs = unavailableServers.size === 0
    ? uniqueSpecs
    : uniqueSpecs.filter((spec) => !unavailableServers.has(spec.serverName));

  return emittedSpecs;
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
    // Compatibility form used by the pre-v5 facade: the third argument is cwd.
    return getMissingConfiguredDirectToolServers(config, cache, undefined, envOverrideOrCwd);
  }
  return getMissingConfiguredDirectToolServers(config, cache, envOverrideOrCwd, defaultCwd);
}
export { getMissingConfiguredDirectToolServers };

/**
 * Pure function of config: the description must stay byte-stable across
 * runtime metadata changes (tool counts, instructions, connection state) so
 * re-registering the proxy tool never rewrites the cached prompt prefix.
 * Live counts/status belong to `mcp({ })`, full instructions to
 * `mcp({ instructions })`.
 *
 * Fork delta: the model-facing URL installer (mcp({ action: "install" })) is
 * excluded from this fork; see docs/tlh-patch-inventory.md.
 */
export function buildProxyDescription(_config: McpConfig, scriptTool = false): string {
  const scriptHint = scriptTool ? " Use mcpScript for several MCP calls with logic between them." : "";
  return `MCP gateway for server status, tool search, tool description, connection, authentication, and single MCP tool calls.${scriptHint} Use mcp({}) for status, mcp({search: \"query\"}) to find tools, mcp({describe: \"tool\"}) for parameters, and mcp({tool: \"tool\", args: \"{\\\"key\\\":\\\"value\\\"}\"}) for one call. Non-MCP tools should be called directly.`;
}

export function getDirectToolParametersSchema(spec: Pick<DirectToolSpec, "inputSchema">) {
  const schema = normalizeDirectToolInputSchema(spec.inputSchema);
  const unsafe = (Type as unknown as { Unsafe?: (value: unknown) => unknown }).Unsafe;
  return typeof unsafe === "function" ? unsafe(schema) : schema;
}

const optionalNumberSchema = (description: string, minimum = 0) => {
  const schema = { type: "number", minimum, description };
  const number = (Type as unknown as { Number?: (options: unknown) => unknown }).Number;
  const optional = (Type as unknown as { Optional?: (schema: unknown) => unknown }).Optional;
  return typeof optional === "function" ? optional(typeof number === "function" ? number(schema) : schema) : schema;
};

const nativeObjectSchema = (() => {
  const unsafe = (Type as unknown as { Unsafe?: (schema: unknown) => unknown }).Unsafe;
  const schema = { type: "object", properties: {}, additionalProperties: true, description: "Arguments as a native object" };
  return typeof unsafe === "function" ? unsafe(schema) : schema;
})();

export const MCP_PROXY_TOOL_PARAMETERS_SCHEMA = Type.Object({
  tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
  args: Type.Optional(Type.Union([
    Type.String({ description: "Arguments as JSON string (e.g., '{\"key\": \"value\"}')" }),
    nativeObjectSchema as never,
  ])),
  connect: Type.Optional(Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" })),
  describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
  search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
  searchMode: Type.Optional(Type.String({ enum: ["lexical", "semantic"], description: "Search backend (default: lexical; semantic is available when a System One key is configured)" })),
  regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
  includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
  limit: optionalNumberSchema("Maximum number of search results to return (default: 50)", 1) as never,
  offset: optionalNumberSchema("Number of search results to skip (default: 0)", 0) as never,
  server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls and describe operations)" })),
  action: Type.Optional(Type.String({ description: "Action: 'ui-messages', 'auth-start', or 'auth-complete'" })),
});

export {
  createMcpDirectToolCallRenderer,
  renderMcpProxyToolCall,
  renderMcpToolResult,
};
