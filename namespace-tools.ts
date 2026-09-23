import type { AgentToolResult, ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type McpConfig } from "./types.ts";
import { isServerCacheValid, type MetadataCache } from "./metadata-cache.ts";
import { createMcpProxyToolCallRenderer, createMcpToolResultRenderer, resolveMcpToolRenderOptions, type McpToolRenderOptions, type RenderTheme, type McpToolRenderContext } from "./tool-result-renderer.ts";
export { namespaceProxyName } from "./mcp-references.ts";
import { hasCallableCachedTargets, isMcpServerDirectlyRegistered, namespaceProxyName, type DirectToolSelectorOverride } from "./mcp-references.ts";

/**
 * Namespace-proxy tool registration for proxy-only MCP servers.
 *
 * For each configured proxy-only server (no `directTools: true` and not a
 * runtime server forced direct), register exactly one tool named
 * `mcp__<server>` (matching the harness `_shared/mcp-tools` resolver's
 * `namespaceProxyName`). Its execute accepts `{tool, args}` and forwards
 * through the adapter's existing `executeCall`, so it inherits the same
 * auto-auth, session recovery, output guard, and approval rules as the
 * single `mcp` proxy tool — without polluting the prompt with one entry
 * per tool.
 *
 * This unblocks `mcp:<server>` references from `tool-groups` and
 * `slow-mode` against proxy-only servers without flipping `directTools: true`.
 */

export interface NamespaceProxySpec {
  serverName: string;
  toolName: string;
  description: string;
}

function namespaceProxyCandidate(
  config: McpConfig,
  cache: MetadataCache,
  envOverride: DirectToolSelectorOverride | null,
  existingDirectNames: Set<string>,
  serverName: string,
  defaultCwd?: string,
): NamespaceProxySpec | null {
  const definition = config.mcpServers[serverName];
  if (!definition || isServerDisabled(definition)) return null;
  if (isMcpServerDirectlyRegistered(definition, config.settings, serverName, envOverride)) return null;
  const entry = cache.servers?.[serverName];
  if (!entry || !isServerCacheValid(entry, definition, undefined, defaultCwd) || !hasCallableCachedTargets(entry, definition)) return null;
  const toolName = namespaceProxyName(serverName);
  if (existingDirectNames.has(toolName)) return null;
  return {
    serverName,
    toolName,
    description:
      `Namespace-proxy for MCP server "${serverName}". ` +
      `Forwards \`{tool, args}\` through the adapter's executeCall, so it inherits ` +
      `the same auth / lifecycle / output-guard rules as the \`mcp\` proxy.`,
  };
}

function filterCollidingNamespaceProxyTools(candidates: NamespaceProxySpec[]): NamespaceProxySpec[] {
  const names = new Map<string, NamespaceProxySpec[]>();
  for (const spec of candidates) {
    const colliding = names.get(spec.toolName) ?? [];
    colliding.push(spec);
    names.set(spec.toolName, colliding);
  }
  return candidates.filter((spec) => {
    const colliding = names.get(spec.toolName)!;
    if (colliding.length === 1) return true;
    if (colliding[0] === spec) {
      console.warn(`MCP: skipping namespace proxy "${spec.toolName}" because servers ${colliding.map(({ serverName }) => `"${serverName}"`).sort().join(", ")} normalize to the same name`);
    }
    return false;
  });
}

function resolveNamespaceProxyTools(
  config: McpConfig | null,
  cache: MetadataCache | null,
  envOverride: DirectToolSelectorOverride | null,
  existingDirectNames: Set<string>,
  unavailableServers: ReadonlySet<string>,
  defaultCwd?: string,
): NamespaceProxySpec[] {
  if (!config || !cache || config.settings?.namespaceProxyTools !== true) return [];
  return filterCollidingNamespaceProxyTools(
    Object.keys(config.mcpServers)
      .map((serverName) => namespaceProxyCandidate(config, cache, envOverride, existingDirectNames, serverName, defaultCwd))
      .filter((spec): spec is NamespaceProxySpec => spec !== null),
  ).filter((spec) => !unavailableServers.has(spec.serverName));
}

/**
 * Lazily-required reference to the agent state — passed as a closure so the
 * namespace proxy tool's execute can call `executeCall` once `state` exists.
 * `getInitPromise` lets the executor await the first initialization round
 * the same way `createDirectToolExecutor` does.
 */
export type GetState = () => McpExtensionState | null;
export type GetInitPromise = () => Promise<McpExtensionState> | null;
export type GetPiTools = () => ToolInfo[];
export type EnsureNamespaceRuntime = (ctx: unknown) => Promise<McpExtensionState | null>;
export type ExecuteNamespaceCall = (
  state: McpExtensionState,
  toolName: string,
  args: Record<string, unknown>,
  serverName: string,
  getPiTools: GetPiTools,
  signal: AbortSignal | undefined,
  origin: "proxy",
) => Promise<AgentToolResult<Record<string, unknown>>>;

function namespaceExecute(
  getState: GetState,
  getInitPromise: GetInitPromise,
  ensureRuntime: EnsureNamespaceRuntime | undefined,
  executeCall: ExecuteNamespaceCall,
  serverName: string,
  getPiTools: GetPiTools,
) {
  return async (
    _toolCallId: string,
    params: { tool?: string; args?: Record<string, unknown> },
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: unknown,
  ): Promise<AgentToolResult<Record<string, unknown>>> => {
    if (typeof params.tool !== "string" || params.tool.length === 0) {
      return {
        content: [{ type: "text" as const, text: `mcp__${serverName} requires a \`tool\` parameter naming the underlying MCP tool.` }],
        details: { error: "missing_tool", server: serverName },
      };
    }
    let state = getState();
    if (!state && ensureRuntime) {
      try {
        state = await ensureRuntime(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `MCP initialization failed for ${serverName}: ${message}` }],
          details: { error: "init_failed", server: serverName, message },
        };
      }
    }
    if (!state) {
      const initPromise = getInitPromise();
      if (initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: `MCP initialization failed for ${serverName}: ${message}` }],
            details: { error: "init_failed", server: serverName, message },
          };
        }
      }
    }
    if (!state) {
      return {
        content: [{ type: "text" as const, text: `MCP not initialized for ${serverName}.` }],
        details: { error: "not_initialized", server: serverName },
      };
    }
    return executeCall(
      state,
      params.tool,
      params.args ?? {},
      serverName,
      getPiTools,
      signal,
      "proxy",
    );
  };
}

const parameters = Type.Object({
  tool: Type.String({ description: "Underlying MCP tool name to call on this server." }),
  args: Type.Optional(Type.Object({}, {
    additionalProperties: true,
    description: "Arguments for the underlying tool. When mcp is available, use mcp({ search: '...' }) to inspect schemas; for unique names use mcp({ describe: 'tool_name' }) with the exact tool name returned by search.",
  })),
});

export interface SyncNamespaceProxyToolsInput {
  config: McpConfig | null;
  cache: MetadataCache | null;
  envOverride: DirectToolSelectorOverride | null;
  existingDirectNames: Set<string>;
  activeDirectNames?: ReadonlySet<string>;
  existingNamespaceNames: Set<string>;
  /** Tool names removed from Pi's active loadout by this adapter. */
  adapterDeactivatedNames?: Set<string>;
  /** Tool names removed from Pi's active loadout by the user. */
  userDeactivatedNames?: ReadonlySet<string>;
  unavailableServers?: ReadonlySet<string>;
  /** Session cwd used when validating command-server cache identity. */
  defaultCwd?: string;
  pi: ExtensionAPI;
  getState: GetState;
  getInitPromise: GetInitPromise;
  ensureRuntime?: EnsureNamespaceRuntime;
  executeCall?: ExecuteNamespaceCall;
  getPiTools: GetPiTools;
  renderOptions?: McpToolRenderOptions;
  renderShell?: "self" | "default";
  renderResult?: unknown;
  guardReentrant?: () => void;
  onToolRegistered?: (name: string) => void;
}

export interface SyncNamespaceProxyToolsResult {
  specs: NamespaceProxySpec[];
  added: string[];
  updated: string[];
  deactivated: string[];
}

function createNamespaceRenderCall(renderOptions: McpToolRenderOptions, serverName: string) {
  const renderCall = createMcpProxyToolCallRenderer(renderOptions);
  return (args: { tool?: string; args?: Record<string, unknown> }, theme?: RenderTheme, context?: McpToolRenderContext) => renderCall({
    ...(args.tool !== undefined ? { tool: args.tool } : {}),
    ...(args.args !== undefined ? { args: args.args } : {}),
    server: serverName,
  }, theme, context);
}

let defaultProxyModesPromise: Promise<typeof import("./proxy-modes.ts")> | null = null;
async function loadDefaultExecuteCall(): Promise<(typeof import("./proxy-modes.ts"))["executeCall"]> {
  defaultProxyModesPromise ??= import("./proxy-modes.ts").catch((error) => {
    defaultProxyModesPromise = null;
    throw error;
  });
  return (await defaultProxyModesPromise).executeCall;
}

function registerNamespaceProxyTool(
  input: SyncNamespaceProxyToolsInput,
  spec: NamespaceProxySpec,
  renderOptions: McpToolRenderOptions,
  renderShell: "self" | "default",
  renderResult: unknown,
): void {
  const executeCall = input.executeCall ?? (async (...args: Parameters<ExecuteNamespaceCall>) => {
    const expectedState = args[0];
    const loadedExecuteCall = await loadDefaultExecuteCall();
    if (input.getState() !== expectedState || expectedState.owner?.isActive() === false) {
      throw expectedState.owner?.signal.reason ?? new Error("MCP namespace operation belongs to a stale session");
    }
    return loadedExecuteCall(...args);
  });

  input.onToolRegistered?.(spec.toolName);
  input.guardReentrant?.();
  (input.pi.registerTool as (tool: unknown) => unknown)({
    name: spec.toolName,
    label: `MCP: ${spec.serverName}`,
    description: spec.description,
    promptSnippet: `MCP namespace proxy for ${spec.serverName}`,
    parameters,
    renderShell,
    renderCall: createNamespaceRenderCall(renderOptions, spec.serverName),
    renderResult,
    execute: namespaceExecute(
      input.getState,
      input.getInitPromise,
      input.ensureRuntime,
      executeCall,
      spec.serverName,
      input.getPiTools,
    ),
  });
  input.guardReentrant?.();
}

function getActiveToolsForSync(pi: ExtensionAPI): string[] | undefined {
  try {
    return pi.getActiveTools?.();
  } catch (error) {
    if (error instanceof Error && error.message.includes("Action methods cannot be called during extension loading")) return undefined;
    throw error;
  }
}

function syncNamespaceToolActivity(input: SyncNamespaceProxyToolsInput, nextNames: Set<string>): string[] {
  const activeDirectNames = input.activeDirectNames ?? new Set<string>();
  const adapterDeactivatedNames = input.adapterDeactivatedNames;
  const userDeactivatedNames = input.userDeactivatedNames;
  const staleNames = [...input.existingNamespaceNames].filter(name => !nextNames.has(name));
  const activeTools = getActiveToolsForSync(input.pi);
  if (!activeTools) return staleNames;

  const managedNamespaceNames = new Set([...input.existingNamespaceNames, ...nextNames]);
  const nextActiveTools = activeTools.filter((name) => {
    if (!managedNamespaceNames.has(name) || activeDirectNames.has(name)) return true;
    if (nextNames.has(name) && !userDeactivatedNames?.has(name)) return true;
    adapterDeactivatedNames?.add(name);
    return false;
  });
  for (const name of nextNames) {
    const mayReactivate = (adapterDeactivatedNames === undefined || adapterDeactivatedNames.has(name))
      && !userDeactivatedNames?.has(name);
    if (!activeDirectNames.has(name) && !nextActiveTools.includes(name) && mayReactivate) {
      nextActiveTools.push(name);
      adapterDeactivatedNames?.delete(name);
    }
  }
  if (nextActiveTools.length !== activeTools.length || nextActiveTools.some((name, index) => name !== activeTools[index])) {
    input.guardReentrant?.();
    input.pi.setActiveTools(nextActiveTools);
    input.guardReentrant?.();
  }
  return staleNames;
}

/**
 * Idempotent sync of namespace-proxy tool registrations.
 */
export function syncNamespaceProxyTools(input: SyncNamespaceProxyToolsInput): SyncNamespaceProxyToolsResult {
  const specs = resolveNamespaceProxyTools(
    input.config,
    input.cache,
    input.envOverride,
    input.existingDirectNames,
    input.unavailableServers ?? new Set(),
    input.defaultCwd,
  );
  const nextNames = new Set(specs.map((s) => s.toolName));
  const result: SyncNamespaceProxyToolsResult = { specs, added: [], updated: [], deactivated: [] };
  const renderOptions = input.renderOptions ?? resolveMcpToolRenderOptions();
  const renderShell = input.renderShell ?? (renderOptions.resultRendering === "compact" ? "self" : "default");
  const renderResult = input.renderResult ?? createMcpToolResultRenderer(renderOptions);

  for (const spec of specs) {
    registerNamespaceProxyTool(input, spec, renderOptions, renderShell, renderResult);
    (input.existingNamespaceNames.has(spec.toolName) ? result.updated : result.added).push(spec.toolName);
  }

  result.deactivated.push(...syncNamespaceToolActivity(input, nextNames));

  return result;
}
