import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredMcpServer, ToolInfo } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { cloneMcpConfig, discoverConfiguredClaudePluginSkills, getLegacyMcpMigrationNotices, getPiMcpAuthPath, loadMcpConfig, resolveConfiguredClaudePluginMcp, setPiMcpConfigEnabled, translatePiMcpServer } from "./config.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { toolErrorOverride } from "./error-signal.ts";
import { computeServerHash, isServerCacheValid, loadMetadataCache, type MetadataCache } from "./metadata-cache.ts";
import type { McpExtensionState } from "./state.ts";
import {
  createPromptCommand,
  McpInitializationPendingError,
  MCP_INITIALIZATION_PENDING_MESSAGE,
  resolveCachedPrompts,
} from "./prompts.ts";
import { isServerDisabled, type McpAdapterOptions, type McpConfig, type PromptMetadata, type ServerEntry } from "./types.ts";
import { excludeProjectServersAtLoadTime, hasProjectServerDefinitions } from "./project-server-trust.ts";
import { isServerInActiveFailureBackoff } from "./failure-backoff.ts";
import { restoreSessionApprovalState } from "./session-approvals.ts";
import { syncNamespaceProxyTools } from "./namespace-tools.ts";
import type { McpRuntime, McpRuntimeOptions, McpRuntimeSurfaceHelpers } from "./mcp-runtime.ts";

type ProxyToolParams = Parameters<McpRuntime["executeProxyTool"]>[1];
type ToolUpdate = AgentToolUpdateCallback<Record<string, unknown>>;
export {
  namespaceProxyName,
  parseMcpReference,
  resolveMcpToolReferences,
  type McpReferenceResolution,
  type ParsedMcpReference,
} from "./mcp-references.ts";
import {
  buildProxyDescription,
  getLargeDirectToolsAdvisory,
  getMissingConfiguredDirectToolServers,
  prepareDirectToolArguments,
  resolveDirectTools,
} from "./direct-tool-surface.ts";
import {
  createMcpDirectToolCallRenderer,
  getDirectToolParametersSchema,
  MCP_PROXY_TOOL_PARAMETERS_SCHEMA,
  renderMcpToolResult,
} from "./startup-mcp-facade.ts";
import {
  createMcpProxyToolCallRenderer,
  createMcpScriptToolCallRenderer,
  resolveMcpToolRenderOptions,
} from "./tool-result-renderer.ts";
import { getConfigPathFromArgv, truncateAtWord } from "./utils.ts";

export interface McpServerRegistration {
  dispose(): Promise<void>;
}

export const MCP_RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1" as const;
export const MCP_RUNTIME_REGISTER_VERSION = 1 as const;

export const MCP_RUNTIME_SNAPSHOT_EVENT = "pi-mcp-adapter:runtime-snapshot:v1" as const;
export const MCP_RUNTIME_SNAPSHOT_VERSION = 1 as const;

export const MCP_RUNTIME_TOOL_CALL_EVENT = "pi-mcp-adapter:runtime-tool-call:v1" as const;
export const MCP_RUNTIME_TOOL_CALL_VERSION = 1 as const;

export type McpRuntimeToolCallResult =
  | { ok: true; result: AgentToolResult<Record<string, unknown>> }
  | { ok: false; error: Error };

export interface McpRuntimeToolCallRequest {
  version: typeof MCP_RUNTIME_TOOL_CALL_VERSION;
  tool: string;
  args?: Record<string, unknown>;
  server?: string;
  result?: Promise<McpRuntimeToolCallResult>;
}

export type McpRuntimeRegistrationResult =
  | { ok: true; registration: McpServerRegistration }
  | { ok: false; error: Error };

export interface McpRuntimeRegistrationRequest {
  version: typeof MCP_RUNTIME_REGISTER_VERSION;
  name: string;
  definition: ServerEntry;
  result?: McpRuntimeRegistrationResult;
}

export interface McpRuntimeServerSnapshot {
  readonly name: string;
  readonly definition: ServerEntry;
  readonly runtime: true;
  readonly persisted: false;
}

export type McpRuntimeSnapshotResult =
  | { ok: true; snapshot: McpRuntimeServerSnapshot }
  | { ok: false; error: Error };

export interface McpRuntimeSnapshotRequest {
  version: typeof MCP_RUNTIME_SNAPSHOT_VERSION;
  name: string;
  result?: McpRuntimeSnapshotResult;
}

// Fast path for extensions that share this adapter module and ExtensionAPI.
// Distinct wrappers use the versioned event bridge installed below.
const runtimeRegistrars = new WeakMap<ExtensionAPI, (name: string, definition: ServerEntry) => McpServerRegistration>();
const runtimeSnapshotters = new WeakMap<ExtensionAPI, (name: string) => McpRuntimeServerSnapshot>();
const INIT_WAIT_TIMEOUT_MS = 30_000;
const INIT_WAIT_TIMED_OUT = Symbol("mcp-initialization-wait-timed-out");

async function awaitWithDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  signal?: AbortSignal,
): Promise<T | typeof INIT_WAIT_TIMED_OUT> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return INIT_WAIT_TIMED_OUT;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = Promise.race<T | typeof INIT_WAIT_TIMED_OUT>([
    promise,
    new Promise<typeof INIT_WAIT_TIMED_OUT>(resolve => {
      timer = setTimeout(() => resolve(INIT_WAIT_TIMED_OUT), remaining);
      timer.unref?.();
    }),
  ]);
  try {
    return await abortable(timed, signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hasEnabledServerWithoutValidMetadata(
  config: McpConfig,
  cache: ReturnType<typeof loadMetadataCache>,
  directSpecs: readonly { serverName: string }[],
  defaultCwd?: string,
): boolean {
  return Object.entries(config.mcpServers).some(([serverName, definition]) => {
    if (isServerDisabled(definition) || directSpecs.some(spec => spec.serverName === serverName)) return false;
    const entry = cache?.servers?.[serverName];
    return entry === undefined || !isServerCacheValid(entry, definition, 0, defaultCwd);
  });
}

const RETRY_FAILURE = Symbol("mcp-initialization-retry-failure");
const RETRY_WAIT_TIMED_OUT = Symbol("mcp-initialization-retry-wait-timed-out");

type RetryFailure = Error & { [RETRY_FAILURE]?: true };

function markRetryFailure(error: unknown): RetryFailure {
  const marked = (error instanceof Error ? new Error(error.message, { cause: error }) : new Error(String(error))) as RetryFailure;
  marked[RETRY_FAILURE] = true;
  return marked;
}

function toDeferredCallToolResult(result: AgentToolResult<Record<string, unknown>>): AgentToolResult<Record<string, unknown>> {
  return {
    ...result,
    structuredContent: {
      content: result.content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(result.details?.error !== undefined ? { isError: true } : {}),
    } as unknown as NonNullable<AgentToolResult["structuredContent"]>,
  };
}

function resolveProgrammaticClaudePluginPath(path: string, cwd: string): string {
  if (path === "~") return resolve(process.env.HOME ?? "", ".");
  if (path.startsWith("~/")) return resolve(process.env.HOME ?? "", path.slice(2));
  return resolve(cwd, path);
}

function normalizeProgrammaticConfig(config: McpConfig): McpConfig {
  if (!config.claudePlugins) return config;
  const cwd = process.cwd();
  return {
    ...config,
    claudePlugins: config.claudePlugins.map(plugin => ({
      ...plugin,
      path: resolveProgrammaticClaudePluginPath(plugin.path, cwd),
    })),
  };
}

function shouldInitializeRuntimeOnSessionStart(
  config: ReturnType<typeof loadMcpConfig>,
  missingConfiguredDirectToolServers: string[],
  directToolBootstrapDisabled: boolean,
): boolean {
  if (!directToolBootstrapDisabled && missingConfiguredDirectToolServers.length > 0) return true;
  if (config.settings?.namespaceProxyTools === true) return true;
  if (config.settings?.directTools === "search") return true;
  if (Object.values(config.mcpServers).some(server => server.directTools === "search")) return true;

  return Object.values(config.mcpServers).some(server => (
    server.lifecycle === "eager" || server.lifecycle === "keep-alive"
  ));
}

function installMcpAdapter(pi: ExtensionAPI, options: McpAdapterOptions = {}) {
  const programmaticConfig = options.config !== undefined;
  const programmaticConfigSnapshot = programmaticConfig
    ? normalizeProgrammaticConfig(cloneMcpConfig(options.config!))
    : undefined;
  if (!programmaticConfig) setPiMcpConfigEnabled(typeof pi.registerMcpServer === "function");
  const earlyConfigPath = programmaticConfig ? undefined : options.configPath ?? getConfigPathFromArgv();
  const earlyConfig = programmaticConfig
    ? resolveConfiguredClaudePluginMcp(cloneMcpConfig(programmaticConfigSnapshot!), process.cwd())
    : excludeProjectServersAtLoadTime(loadMcpConfig(earlyConfigPath));
  const earlyCache = loadMetadataCache();
  const prefix = earlyConfig.settings?.toolPrefix ?? "server";

  const envRaw = process.env.MCP_DIRECT_TOOLS;
  const directToolBootstrapDisabled = envRaw === "__none__";
  const envDirectToolOverride = envRaw === undefined || envRaw === "__none__"
    ? undefined
    : envRaw.split(",").map(s => s.trim()).filter(Boolean);
  const directSpecs = directToolBootstrapDisabled
    ? []
    : resolveDirectTools(
        earlyConfig,
        earlyCache,
        prefix,
        envDirectToolOverride,
        process.cwd(),
        new Set(),
        new Set(),
      );
  const namespaceEnvOverride = envRaw === undefined
    ? null
    : envRaw === "__none__"
      ? { servers: new Set<string>(), tools: new Map<string, Set<string>>() }
      : (() => {
          const servers = new Set<string>();
          const tools = new Map<string, Set<string>>();
          for (const raw of envDirectToolOverride ?? []) {
            const item = raw.replace(/\/+$/, "");
            if (item.includes("/")) {
              const [server, tool] = item.split("/", 2);
              if (server && tool) {
                const selected = tools.get(server) ?? new Set<string>();
                selected.add(tool);
                tools.set(server, selected);
              } else if (server) {
                servers.add(server);
              }
            } else if (item) {
              servers.add(item);
            }
          }
          return { servers, tools };
        })();
  const missingConfiguredDirectToolServers = envDirectToolOverride === undefined
    ? getMissingConfiguredDirectToolServers(earlyConfig, earlyCache, undefined, process.cwd())
    : getMissingConfiguredDirectToolServers(earlyConfig, earlyCache, envDirectToolOverride, process.cwd());
  const hasSearchDirectTools = !directToolBootstrapDisabled && envDirectToolOverride === undefined && (
    directSpecs.some(spec => spec.lazy === true)
    || earlyConfig.settings?.directTools === "search"
    || Object.values(earlyConfig.mcpServers).some(server => server.directTools === "search")
  );
  const hasUncachedProxyServer = hasEnabledServerWithoutValidMetadata(earlyConfig, earlyCache, directSpecs, process.cwd());
  const shouldRegisterProxyTool =
    earlyConfig.settings?.disableProxyTool !== true
    || directSpecs.length === 0
    || missingConfiguredDirectToolServers.length > 0
    || hasSearchDirectTools
    || hasUncachedProxyServer;

  let runtimePromise: Promise<McpRuntime> | null = null;
  type SessionStart = {
    event: unknown;
    ctx: ExtensionContext;
    generation: number;
    nativeSignInReady: Promise<void>;
    nativeSignInSignal: AbortSignal;
  };
  let latestSessionStart: SessionStart | null = null;
  let sessionSignInController: AbortController | null = null;
  let activeRuntimeState: McpExtensionState | null = null;
  let activeSurfaceContext: ExtensionContext | null = null;
  let activeSurfaceHelpers: McpRuntimeSurfaceHelpers | null = null;
  const runtimeServers = new Map<string, { definition: ServerEntry; entry: ServerEntry }>();
  const shadowedRuntimeServers = new Set<string>();
  const registeredDirectTools = new Map<string, { spec: typeof directSpecs[number]; fingerprint: string }>();
  const registeredDirectToolDefinitions = new Map<string, Record<string, unknown>>();
  // Freeze-scoped panel refreshes must retain the catalog that produced each
  // unaffected declaration. This is lifecycle state only: it never replaces
  // the shared metadata cache or changes its TTL/private-scope policy.
  const appliedDirectToolCatalogs = new Map<string, MetadataCache["servers"][string]>();
  // A frozen search server may be discovered once when it has no applied
  // catalog yet. The marker is session-owned, including valid empty catalogs.
  const appliedSearchDirectToolServers = new Set<string>();
  const coldSearchDiscoveryReservations = new Map<string, object>();
  // A connect owns its attribution set from start to finish. Metadata refreshes
  // outside that operation can still reconcile the live surface, but cannot
  // leak names into a later connect result.
  type DirectToolAttribution = {
    serverName: string;
    names: Set<string>;
  };
  const directToolAttributions = new Set<DirectToolAttribution>();
  const directToolAttributionsByServer = new Map<string, Set<DirectToolAttribution>>();
  const piRegisteredServers = new Map<string, { config: string; registration: McpServerRegistration | null }>();
  let piRegistered: RegisteredMcpServer[] = [];
  let applyingPiRegisteredServers = false;
  let proxyToolRegistered = false;
  let proxyToolDescription: string | null = null;
  let proxyToolRegistrationOwner: object | null = null;
  // Pi owns the active-tool loadout. Track only removals performed by this
  // adapter so syncs never resurrect a user-deactivated tool.
  const adapterDeactivatedTools = new Set<string>();
  const userDeactivatedTools = new Set<string>();
  let lastObservedActiveTools: Set<string> | null = null;
  let observingSessionReset = false;
  const lazyDirectTools = new Set<string>();
  const searchActivatedTools = new Set<string>();
  const registeredNamespaceTools = new Set<string>();
  let scriptToolRegistered = false;
  let sessionScriptMode: boolean | undefined;
  let sessionScriptConfig: McpConfig | undefined;
  // A non-programmatic load can be followed by a session in another cwd. Do
  // not publish a model skill pointer from the load-time config before that
  // session has selected its effective scripting config.
  const deferEarlyScriptToolRegistration = !programmaticConfig
    && earlyConfig.settings?.scriptMode === true
    && earlyConfig.settings?.scriptSkill === "model";

  const deferSearchTools = typeof pi.registerMcpServer === "function";

  function directToolFingerprint(spec: typeof directSpecs[number], deferred?: Record<string, unknown>): string {
    return JSON.stringify({
      serverName: spec.serverName,
      originalName: spec.originalName,
      prefixedName: spec.prefixedName,
      description: spec.description,
      inputSchema: spec.inputSchema,
      resourceUri: spec.resourceUri,
      uiResourceUri: spec.uiResourceUri,
      uiStreamMode: spec.uiStreamMode,
      lazy: spec.lazy === true,
      deferred,
    });
  }

  function deferredToolFields(spec: typeof directSpecs[number], config: McpConfig, cache: ReturnType<typeof loadMetadataCache>): Record<string, unknown> | undefined {
    if (!deferSearchTools || !spec.lazy) return undefined;
    const serverCache = cache?.servers?.[spec.serverName];
    const tool = spec.resourceUri ? undefined : serverCache?.tools?.find(candidate => candidate.name === spec.originalName);
    const description = config.mcpServers[spec.serverName]?.description?.trim();
    const instructions = serverCache?.instructions;
    const { title: _title, ...annotations } = tool?.annotations ?? {};
    return {
      exposure: "deferred",
      namespace: {
        name: `mcp__${spec.serverName.replace(/-/g, "_")}`,
        ...(description ? { description } : {}),
        ...(instructions ? { instructions } : {}),
      },
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      outputSchema: {
        type: "object",
        properties: {
          content: { type: "array", items: { type: "object" } },
          ...(tool?.outputSchema !== undefined ? { structuredContent: tool.outputSchema } : {}),
          isError: { type: "boolean" },
          _meta: { type: "object" },
        },
        required: ["content"],
      },
    };
  }

  function getActiveToolsIfReady(): string[] | undefined {
    try {
      return pi.getActiveTools?.();
    } catch (error) {
      if (error instanceof Error && error.message.includes("Action methods cannot be called during extension loading")) return undefined;
      throw error;
    }
  }

  function isAdapterManagedTool(name: string): boolean {
    return registeredDirectTools.has(name) || registeredNamespaceTools.has(name) || name === "mcpScript" || name === "mcp";
  }

  function observeActiveToolOwnership(activeTools: readonly string[]): void {
    const activeSet = new Set(activeTools);
    if (lastObservedActiveTools) {
      for (const name of lastObservedActiveTools) {
        if (!isAdapterManagedTool(name) || activeSet.has(name) || adapterDeactivatedTools.has(name)) continue;
        // If the host removes the gateway and its direct companions together
        // in one same-turn loadout, the gateway removal is the ownership
        // signal; direct tools remain adapter-owned and can be restored.
        const removedWithGateway = !activeSet.has("mcp") && name !== "mcp" && !observingSessionReset && activeSet.size > 0;
        if (!removedWithGateway || name === "mcp") userDeactivatedTools.add(name);
      }
    }
    // An empty host loadout is authoritative. Do not claim ownership of a
    // fallback tool and resurrect it into a deliberately empty loadout.
    if (activeSet.size === 0) {
      for (const name of lastObservedActiveTools ?? []) {
        if (isAdapterManagedTool(name)) userDeactivatedTools.add(name);
      }
      adapterDeactivatedTools.clear();
    }
    for (const name of activeSet) userDeactivatedTools.delete(name);
    lastObservedActiveTools = activeSet;
  }

  function setActiveTools(next: string[]): void {
    pi.setActiveTools(next);
    lastObservedActiveTools = new Set(next);
  }

  function beginDirectToolAttribution(serverName: string): object {
    const attribution: DirectToolAttribution = { serverName, names: new Set<string>() };
    directToolAttributions.add(attribution);
    const operations = directToolAttributionsByServer.get(serverName) ?? new Set<DirectToolAttribution>();
    operations.add(attribution);
    directToolAttributionsByServer.set(serverName, operations);
    return attribution;
  }

  function discardDirectToolAttribution(value: object): void {
    const attribution = value as DirectToolAttribution;
    if (!directToolAttributions.delete(attribution)) return;
    const operations = directToolAttributionsByServer.get(attribution.serverName);
    operations?.delete(attribution);
    if (operations?.size === 0) directToolAttributionsByServer.delete(attribution.serverName);
    attribution.names.clear();
  }

  function queueDirectToolNames(
    attribution: object | undefined,
    specs: readonly { serverName: string; prefixedName: string; lazy?: boolean }[],
    names: readonly string[],
  ): void {
    if (!attribution || !directToolAttributions.has(attribution as DirectToolAttribution)) return;
    const owner = attribution as DirectToolAttribution;
    for (const name of names) {
      const spec = specs.find(candidate => candidate.prefixedName === name);
      // Search-mode tools are registered during connect, but search—not connect—
      // is what loads them into the active tool set.
      if (!spec || spec.lazy === true || spec.serverName !== owner.serverName) continue;
      owner.names.add(name);
    }
  }

  function isAttributableDirectTool(name: string, serverName: string): boolean {
    const registered = registeredDirectTools.get(name);
    if (!registered || registered.spec.serverName !== serverName || registered.spec.lazy === true) return false;
    if (userDeactivatedTools.has(name)) return false;
    if (activeRuntimeState && isServerInActiveFailureBackoff(activeRuntimeState, serverName)) return false;
    const activeTools = getActiveToolsIfReady();
    return activeTools === undefined || activeTools.includes(name);
  }

  function consumeDirectToolNames(serverName: string, attribution?: object): string[] {
    if (!attribution || !directToolAttributions.has(attribution as DirectToolAttribution)) return [];
    const owner = attribution as DirectToolAttribution;
    if (owner.serverName !== serverName) return [];
    const names = [...owner.names].filter(name => isAttributableDirectTool(name, serverName));
    owner.names.clear();
    return names;
  }

  function clearPendingDirectToolNames(): void {
    for (const attribution of directToolAttributions) attribution.names.clear();
  }

  function syncDirectToolActivity(): string[] {
    if (deferSearchTools) return [];
    const activeTools = getActiveToolsIfReady();
    if (!activeTools) return [];

    observeActiveToolOwnership(activeTools);
    const next = activeTools.filter(name => {
      if (!lazyDirectTools.has(name) || searchActivatedTools.has(name)) return true;
      adapterDeactivatedTools.add(name);
      return false;
    });
    const restored: string[] = [];
    for (const name of registeredDirectTools.keys()) {
      const shouldBeActive = !lazyDirectTools.has(name) || searchActivatedTools.has(name);
      if (!shouldBeActive || userDeactivatedTools.has(name)) continue;
      if (!next.includes(name) && adapterDeactivatedTools.has(name)) {
        next.push(name);
        adapterDeactivatedTools.delete(name);
        restored.push(name);
      }
    }
    if (next.length !== activeTools.length || next.some((name, index) => name !== activeTools[index])) {
      setActiveTools(next);
    }
    return restored;
  }

  function holdLazyDirectTools(): void {
    syncDirectToolActivity();
  }

  function activateSearchMatches(matches: ReadonlyArray<{ server: string; tool: string }>): string[] {
    const activeTools = getActiveToolsIfReady();
    if (!activeTools) return [];
    observeActiveToolOwnership(activeTools);
    const active = new Set(activeTools);
    const additions: string[] = [];
    for (const match of matches) {
      const entry = [...registeredDirectTools.entries()].find(([, registered]) => (
        registered.spec.serverName === match.server
        && (registered.spec.originalName === match.tool || registered.spec.prefixedName === match.tool)
      ));
      if (!entry) continue;
      const [prefixedName] = entry;
      if (!lazyDirectTools.has(prefixedName)) continue;
      if (userDeactivatedTools.has(prefixedName)) continue;
      searchActivatedTools.add(prefixedName);
      if (active.has(prefixedName) || additions.includes(prefixedName)) continue;
      additions.push(prefixedName);
    }
    if (additions.length === 0) return [];
    for (const name of additions) adapterDeactivatedTools.delete(name);
    setActiveTools([...activeTools, ...additions]);
    return additions;
  }

  function hideRegisteredDeferredTool(name: string): void {
    const definition = registeredDirectToolDefinitions.get(name);
    // Pi cannot unregister deferred tools on older hosts. Re-registering the
    // complete declaration hidden is the only way to make them unreachable
    // from codemode without changing the original executor or metadata.
    if (definition?.exposure !== "deferred") return;
    registeredDirectToolDefinitions.delete(name);
    (pi.registerTool as (tool: unknown) => unknown)({ ...definition, exposure: "hidden" });
  }

  function deactivateTools(names: readonly string[]): void {
    if (names.length === 0) return;
    const unregisterTool = (pi as ExtensionAPI & { unregisterTool?: (name: string) => boolean }).unregisterTool;
    const removed = new Set<string>();
    for (const name of names) {
      const didUnregister = unregisterTool?.(name) === true;
      if (didUnregister) removed.add(name);
      else hideRegisteredDeferredTool(name);
    }
    const activeTools = getActiveToolsIfReady();
    if (!activeTools) return;
    observeActiveToolOwnership(activeTools);
    const fallbackNames = names.filter(name => !removed.has(name) && activeTools.includes(name));
    if (fallbackNames.length === 0) return;
    const next = activeTools.filter(name => !fallbackNames.includes(name));
    for (const name of fallbackNames) adapterDeactivatedTools.add(name);
    if (next.length !== activeTools.length) setActiveTools(next);
  }

  function isAppliedDirectToolCatalogValid(
    entry: MetadataCache["servers"][string],
    definition: ServerEntry,
    defaultCwd: string | undefined,
  ): boolean {
    if (!entry || entry.discoveryFailed === true) return false;
    try {
      // The snapshot was already accepted by the normal cache policy when it
      // was acquired. Once it has produced a registered declaration, its
      // server identity remains usable for selector/collision analysis even
      // after the shared disk TTL expires.
      return entry.configHash === computeServerHash(definition, defaultCwd);
    } catch {
      return false;
    }
  }

  function captureAppliedDirectToolCatalogs(
    config: McpExtensionState["config"],
    cache: ReturnType<typeof loadMetadataCache>,
    defaultCwd: string | undefined,
  ): MetadataCache["servers"] {
    const captured: MetadataCache["servers"] = {};
    if (!cache) return captured;
    for (const [serverName, entry] of Object.entries(cache.servers)) {
      const definition = config.mcpServers[serverName];
      if (!definition || isServerDisabled(definition)) continue;
      try {
        if (!isServerCacheValid(entry, definition, 0, defaultCwd)) continue;
        captured[serverName] = structuredClone(entry);
      } catch {
        // Invalid or non-cloneable cache entries cannot represent an applied
        // direct-tool catalog.
      }
    }
    return captured;
  }

  function rememberAppliedDirectToolCatalogs(
    config: McpExtensionState["config"],
    cache: ReturnType<typeof loadMetadataCache>,
    defaultCwd: string | undefined,
    serverNames?: ReadonlySet<string>,
    capturedCatalogs?: MetadataCache["servers"],
  ): void {
    const source = capturedCatalogs ?? cache?.servers;
    if (!source) return;
    for (const [serverName, entry] of Object.entries(source)) {
      if (serverNames && !serverNames.has(serverName)) continue;
      const definition = config.mcpServers[serverName];
      if (!definition || isServerDisabled(definition)) continue;
      if (capturedCatalogs
        ? !isAppliedDirectToolCatalogValid(entry, definition, defaultCwd)
        : !isServerCacheValid(entry, definition, 0, defaultCwd)) continue;
      // TTL and private-scope markers govern acquisition from shared disk, not
      // the lifetime of this ephemeral catalog that already produced the
      // applied declaration. Strip them so the resolver cannot expire the
      // retained selector/collision candidates on a later frozen refresh.
      const { ttlMs: _ttlMs, cacheScope: _cacheScope, ...snapshot } = structuredClone(entry);
      appliedDirectToolCatalogs.set(serverName, snapshot);
      // Any guarded applied-catalog commit consumes this session's cold-search
      // grant, including empty catalogs and catalogs first applied by a mode
      // change, Save, backoff recovery, or runtime-initial sync.
      appliedSearchDirectToolServers.add(serverName);
    }
  }

  function directToolSelectorsForServers(serverNames: ReadonlySet<string>): string[] | undefined {
    if (envDirectToolOverride === undefined) return undefined;
    return envDirectToolOverride.filter(raw => {
      const selection = raw.replace(/\/+$/, "").split("/", 1)[0] ?? "";
      return serverNames.has(selection);
    });
  }

  function isEffectiveSearchDirectToolServer(config: McpExtensionState["config"], serverName: string): boolean {
    if (envRaw !== undefined) return false;
    const definition = config.mcpServers[serverName];
    if (!definition || isServerDisabled(definition)) return false;
    const selected = definition.directTools !== undefined ? definition.directTools : config.settings?.directTools;
    return selected === "search";
  }

  function captureColdSearchDiscoveryCatalogs(
    config: McpExtensionState["config"],
    cache: MetadataCache | null,
    defaultCwd: string,
    serverNames: ReadonlySet<string>,
  ): Set<string> {
    const captured = new Set<string>();
    for (const serverName of serverNames) {
      if (!isEffectiveSearchDirectToolServer(config, serverName)) continue;
      const definition = config.mcpServers[serverName];
      const entry = cache?.servers?.[serverName];
      if (!definition || !entry) continue;
      try {
        if (isServerCacheValid(entry, definition, 0, defaultCwd)) captured.add(serverName);
      } catch {
        // A malformed or otherwise untrusted entry cannot consume discovery.
      }
    }
    return captured;
  }

  function reserveColdSearchDiscovery(
    config: McpExtensionState["config"],
    serverNames: ReadonlySet<string> | undefined,
  ): { token: object; servers: Set<string> } | undefined {
    if (!serverNames || serverNames.size === 0) return undefined;
    const eligible = new Set<string>();
    for (const serverName of serverNames) {
      if (!isEffectiveSearchDirectToolServer(config, serverName)
        || appliedSearchDirectToolServers.has(serverName)
        || appliedDirectToolCatalogs.has(serverName)
        || coldSearchDiscoveryReservations.has(serverName)
        || [...registeredDirectTools.values()].some(({ spec }) => spec.serverName === serverName)) continue;
      eligible.add(serverName);
    }
    if (eligible.size === 0) return undefined;
    const token = {};
    for (const serverName of eligible) coldSearchDiscoveryReservations.set(serverName, token);
    return { token, servers: eligible };
  }

  function releaseColdSearchDiscovery(reservation: { token: object; servers: ReadonlySet<string> }): void {
    for (const serverName of reservation.servers) {
      if (coldSearchDiscoveryReservations.get(serverName) === reservation.token) {
        coldSearchDiscoveryReservations.delete(serverName);
      }
    }
  }

  function markAppliedSearchDirectToolServers(
    config: McpExtensionState["config"],
    cache: MetadataCache | null,
    defaultCwd: string,
    serverNames?: ReadonlySet<string>,
  ): void {
    if (envRaw !== undefined) return;
    for (const [serverName, definition] of Object.entries(config.mcpServers)) {
      if ((serverNames && !serverNames.has(serverName))
        || !isEffectiveSearchDirectToolServer(config, serverName)) continue;
      const entry = cache?.servers?.[serverName];
      if (!entry) continue;
      try {
        if (isServerCacheValid(entry, definition, 0, defaultCwd)) {
          appliedSearchDirectToolServers.add(serverName);
        }
      } catch {
        // Invalid metadata remains eligible for a later live discovery.
      }
    }
  }

  function syncDirectToolsFor(
    config: McpExtensionState["config"],
    cache: ReturnType<typeof loadMetadataCache>,
    defaultCwd?: string,
    reportAdditions = false,
    attribution?: object,
    options: {
      affectedServers?: ReadonlySet<string>;
      reservedNames?: ReadonlySet<string>;
      canCommitAppliedDirectToolCatalogs?: () => boolean;
    } = {},
  ): { specs: typeof directSpecs; added: string[]; updated: string[]; deactivated: string[]; reservedNames: Set<string> } {
    if (envRaw === "__none__") {
      const staleNames = [...registeredDirectTools.keys()];
      deactivateTools(staleNames);
      registeredDirectTools.clear();
      registeredDirectToolDefinitions.clear();
      lazyDirectTools.clear();
      searchActivatedTools.clear();
      clearPendingDirectToolNames();
      return { specs: [], added: [], updated: [], deactivated: staleNames, reservedNames: new Set() };
    }
    const activeBeforeSync = getActiveToolsIfReady();
    if (activeBeforeSync) observeActiveToolOwnership(activeBeforeSync);
    const capturedCatalogs = captureAppliedDirectToolCatalogs(config, cache, defaultCwd);
    const unavailableServers = activeRuntimeState
      ? new Set(Object.keys(config.mcpServers).filter(name => isServerInActiveFailureBackoff(activeRuntimeState!, name)))
      : new Set<string>();
    const affectedServers = options.affectedServers;
    const reservedNames = new Set(options.reservedNames ?? []);
    const retainedNames = new Set<string>();
    const retainedActiveNames = new Set<string>();
    if (affectedServers) {
      for (const [name, registered] of registeredDirectTools) {
        const serverName = registered.spec.serverName;
        const definition = config.mcpServers[serverName];
        if (affectedServers.has(serverName) || !definition || isServerDisabled(definition)) continue;
        retainedNames.add(name);
        if (!unavailableServers.has(serverName)) retainedActiveNames.add(name);
      }
      // These names belong to the already-applied unaffected surface (or to a
      // safety removal such as backoff) and therefore own the collision slot.
      for (const name of retainedNames) reservedNames.add(name);
    }

    let specs: typeof directSpecs;
    if (!affectedServers) {
      specs = resolveDirectTools(
        config,
        cache,
        config.settings?.toolPrefix ?? "server",
        envDirectToolOverride,
        defaultCwd,
        unavailableServers,
        reservedNames,
      );
    } else {
      // Resolve only the persisted affected servers against the current live
      // catalog. Unaffected servers contribute an ephemeral copy of the
      // catalog that produced their retained declarations solely for selector
      // candidate analysis; their declarations/executors are never re-resolved.
      const scopedConfig: McpExtensionState["config"] = { ...config, mcpServers: {} };
      const scopedServers: MetadataCache["servers"] = {};
      for (const [serverName, definition] of Object.entries(config.mcpServers)) {
        if (affectedServers.has(serverName)) {
          scopedConfig.mcpServers[serverName] = definition;
          const currentEntry = cache?.servers?.[serverName];
          if (currentEntry) scopedServers[serverName] = currentEntry;
          continue;
        }
        const snapshot = appliedDirectToolCatalogs.get(serverName);
        if (!snapshot || isServerDisabled(definition)) continue;
        if (!isAppliedDirectToolCatalogValid(snapshot, definition, defaultCwd)) continue;
        scopedConfig.mcpServers[serverName] = { ...definition, directTools: false };
        scopedServers[serverName] = snapshot;
      }
      const scopedCache: MetadataCache | null = Object.keys(scopedServers).length > 0
        ? { version: cache?.version ?? 1, servers: scopedServers }
        : null;
      const scopedEnvOverride = directToolSelectorsForServers(affectedServers);
      const resolvedReservedNames = new Set<string>();
      const resolved = resolveDirectTools(
        scopedConfig,
        scopedCache,
        config.settings?.toolPrefix ?? "server",
        scopedEnvOverride,
        defaultCwd,
        unavailableServers,
        resolvedReservedNames,
      );
      const protectedNames = new Set([
        ...retainedNames,
        ...(options.reservedNames ?? []),
        ...registeredNamespaceTools,
      ]);
      specs = resolved.filter(spec => affectedServers.has(spec.serverName) && !protectedNames.has(spec.prefixedName));
      // Only accepted affected names become direct reservations here. A
      // rejected candidate must not make namespace cleanup mistake it for a
      // newly registered direct tool.
      for (const spec of specs) reservedNames.add(spec.prefixedName);
    }
    const nextNames = new Set(specs.map(spec => spec.prefixedName));
    for (const name of retainedActiveNames) nextNames.add(name);
    let existingNames = new Set<string>();
    try {
      existingNames = new Set(pi.getAllTools().map(tool => tool.name));
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("Action methods cannot be called during extension loading"))) throw error;
    }
    const added: string[] = [];
    const updated: string[] = [];
    const restored: string[] = [];
    for (const spec of specs) {
      const deferred = deferredToolFields(spec, config, cache);
      const fingerprint = directToolFingerprint(spec, deferred);
      const previous = registeredDirectTools.get(spec.prefixedName);
      const changed = !previous || previous.fingerprint !== fingerprint || !existingNames.has(spec.prefixedName);
      if (changed) {
        registerDirectTool(spec, deferred, config);
        existingNames.add(spec.prefixedName);
        (previous ? updated : added).push(spec.prefixedName);
      }
      if (spec.lazy && deferSearchTools && previous && !lazyDirectTools.has(spec.prefixedName)) {
        const activeTools = getActiveToolsIfReady();
        if (activeTools?.includes(spec.prefixedName)) setActiveTools(activeTools.filter(name => name !== spec.prefixedName));
      }
      if (!spec.lazy && lazyDirectTools.has(spec.prefixedName)) {
        searchActivatedTools.delete(spec.prefixedName);
        const activeTools = getActiveToolsIfReady();
        if (activeTools && !activeTools.includes(spec.prefixedName) && !userDeactivatedTools.has(spec.prefixedName)) {
          setActiveTools([...activeTools, spec.prefixedName]);
          restored.push(spec.prefixedName);
        }
      }
      if (!spec.lazy && adapterDeactivatedTools.has(spec.prefixedName)) {
        adapterDeactivatedTools.delete(spec.prefixedName);
        const activeTools = getActiveToolsIfReady();
        if (activeTools && !activeTools.includes(spec.prefixedName) && !userDeactivatedTools.has(spec.prefixedName)) {
          setActiveTools([...activeTools, spec.prefixedName]);
          restored.push(spec.prefixedName);
        }
      }
      registeredDirectTools.set(spec.prefixedName, { spec, fingerprint });
      if (spec.lazy) lazyDirectTools.add(spec.prefixedName);
      else {
        lazyDirectTools.delete(spec.prefixedName);
        searchActivatedTools.delete(spec.prefixedName);
        const activeTools = getActiveToolsIfReady();
        if (activeTools && !activeTools.includes(spec.prefixedName) && !userDeactivatedTools.has(spec.prefixedName)) {
          const unregisterTool = (pi as ExtensionAPI & { unregisterTool?: (name: string) => boolean }).unregisterTool;
          if (unregisterTool?.(spec.prefixedName) === true) {
            registerDirectTool(spec, deferred, config);
            restored.push(spec.prefixedName);
          } else {
            setActiveTools([...activeTools, spec.prefixedName]);
            restored.push(spec.prefixedName);
          }
        }
      }
    }
    const staleNames = [...registeredDirectTools.keys()].filter(name => !nextNames.has(name));
    for (const name of staleNames) {
      const previous = registeredDirectTools.get(name);
      if (deferSearchTools && previous?.spec.lazy) hideRegisteredDeferredTool(name);
      registeredDirectTools.delete(name);
      lazyDirectTools.delete(name);
      searchActivatedTools.delete(name);
    }
    deactivateTools(staleNames);
    const restoredByActivity = syncDirectToolActivity();
    if (options.canCommitAppliedDirectToolCatalogs?.() ?? true) {
      if (affectedServers) {
        rememberAppliedDirectToolCatalogs(config, cache, defaultCwd, affectedServers, capturedCatalogs);
      } else {
        appliedDirectToolCatalogs.clear();
        rememberAppliedDirectToolCatalogs(config, cache, defaultCwd, undefined, capturedCatalogs);
      }
    }
    if (reportAdditions) queueDirectToolNames(attribution, specs, [...added, ...restored, ...restoredByActivity]);
    const surfaceSpecs = affectedServers
      ? [...registeredDirectTools.values()].map(({ spec }) => spec)
      : specs;
    return { specs: surfaceSpecs, added, updated, deactivated: staleNames, reservedNames };
  }

  function syncDirectTools(
    state: McpExtensionState,
    reportAdditions = false,
    defaultCwd = state.sessionCwd ?? process.cwd(),
    attribution?: object,
    options: {
      affectedServers?: ReadonlySet<string>;
      reservedNames?: ReadonlySet<string>;
      canCommitAppliedDirectToolCatalogs?: () => boolean;
    } = {},
  ): ReturnType<typeof syncDirectToolsFor> {
    const cache = loadToolSurfaceCache(state.config, state);
    const result = syncDirectToolsFor(state.config, cache, defaultCwd, reportAdditions, attribution, options);
    if (state.directToolCounts) {
      state.directToolCounts.clear();
      for (const { spec } of registeredDirectTools.values()) {
        state.directToolCounts.set(spec.serverName, (state.directToolCounts.get(spec.serverName) ?? 0) + 1);
      }
    }
    return result;
  }

  function loadToolSurfaceCache(config: McpConfig, state?: McpExtensionState): MetadataCache | null {
    const cache = loadMetadataCache();
    if (!state?.sessionMetadata?.size) return cache;
    const servers = { ...(cache?.servers ?? {}) };
    for (const [serverName, entry] of state.sessionMetadata) {
      const definition = config.mcpServers[serverName];
      if (!definition || isServerDisabled(definition)) continue;
      try {
        if (entry.configHash !== computeServerHash(definition, state.sessionCwd ?? process.cwd())) continue;
      } catch {
        continue;
      }
      const { ttlMs: _ttlMs, cacheScope: _cacheScope, ...sessionEntry } = entry;
      servers[serverName] = { ...sessionEntry, cachedAt: Date.now() };
    }
    return { version: 1, servers };
  }

  // Mirror init's lifecycle registration for servers supplied by another
  // extension. Runtime registrations remain proxy-only, but still participate
  // in idle cleanup and keep-alive health checks according to their definition.
  function attachRuntimeServerLifecycle(state: McpExtensionState, name: string, definition: ServerEntry): void {
    const lifecycleMode = definition.lifecycle ?? "lazy";
    const persistsAfterFirstSpawn = lifecycleMode === "eager" || lifecycleMode === "lazy-keep-alive";
    const idleOverride = definition.idleTimeout ?? (persistsAfterFirstSpawn ? 0 : undefined);
    state.lifecycle.registerServer(
      name,
      definition,
      idleOverride !== undefined ? { idleTimeout: idleOverride } : undefined,
    );
    if (lifecycleMode === "keep-alive") state.lifecycle.markKeepAlive(name, definition);
  }

  function applyRuntimeServers(state: McpExtensionState): void {
    for (const [name, registration] of runtimeServers) {
      // Configured servers win over runtime registrations on a session
      // restart. Keep the registration so it can become active in a later
      // session where the configured collision disappears.
      if (Object.hasOwn(state.config.mcpServers, name) && state.config.mcpServers[name] !== registration.entry) {
        if (!shadowedRuntimeServers.has(name)) {
          console.warn(`MCP: runtime-registered server "${name}" now collides with a configured server; keeping the configured server`);
          shadowedRuntimeServers.add(name);
        }
        continue;
      }
      shadowedRuntimeServers.delete(name);
      state.config.mcpServers[name] = registration.entry;
      attachRuntimeServerLifecycle(state, name, registration.entry);
    }
  }

  function refreshActiveToolSurface(state: McpExtensionState): void {
    if (activeRuntimeState !== state || !activeSurfaceContext || !activeSurfaceHelpers) return;
    syncToolSurface(state, activeSurfaceContext, false, activeSurfaceHelpers);
    activeSurfaceHelpers.updateStatusBar(state);
  }

  function registerRuntimeServer(name: string, definition: ServerEntry): McpServerRegistration {
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("MCP server name must be a non-empty string");
    }
    if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
      throw new Error(`MCP server definition for "${name}" must be an object`);
    }

    const effectiveConfig = activeRuntimeState?.config ?? earlyConfig;
    if (runtimeServers.has(name) || Object.hasOwn(effectiveConfig.mcpServers, name)) {
      throw new Error(`MCP server "${name}" is already registered`);
    }

    // Snapshot caller-owned data at the API boundary. The runtime copy is
    // deliberately directTools:false so late registrations never widen the
    // persistent model-facing direct-tool surface.
    const snapshotDefinition = structuredClone(definition);
    const entry: ServerEntry = { ...structuredClone(snapshotDefinition), directTools: false };
    runtimeServers.set(name, { definition: snapshotDefinition, entry });

    const state = activeRuntimeState;
    if (state) {
      state.config.mcpServers[name] = entry;
      attachRuntimeServerLifecycle(state, name, entry);
      refreshActiveToolSurface(state);
    }

    let disposed = false;
    return {
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        runtimeServers.delete(name);
        shadowedRuntimeServers.delete(name);

        const currentState = activeRuntimeState;
        if (!currentState || currentState.config.mcpServers[name] !== entry) return;
        delete currentState.config.mcpServers[name];
        currentState.lifecycle.unregisterServer(name);
        await currentState.manager.close(name);
        refreshActiveToolSurface(currentState);
      },
    };
  }

  function registerAdapterServer(name: string, definition: ServerEntry): McpServerRegistration {
    if (typeof pi.getMcpServers === "function" && pi.getMcpServers().some(server => server.name === name)
      && !piRegisteredServers.has(name)) {
      throw new Error(`MCP server "${name}" is already registered`);
    }
    const registration = registerRuntimeServer(name, definition);
    return {
      dispose: async () => {
        try {
          await registration.dispose();
        } finally {
          const state = activeRuntimeState;
          const applied = piRegisteredServers.get(name);
          if (state && applied?.registration === null && !Object.hasOwn(state.config.mcpServers, name)) {
            await applyPiMcpServers(state, activeSurfaceContext ?? ({} as ExtensionContext));
          }
        }
      },
    };
  }

  async function applyPiMcpServers(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
    applyingPiRegisteredServers = true;
    const next = new Map(piRegistered.map(server => [server.name, JSON.stringify(server.config)]));
    for (const [name, applied] of [...piRegisteredServers]) {
      if (next.get(name) === applied.config) continue;
      piRegisteredServers.delete(name);
      if (applied.registration) {
        try {
          await applied.registration.dispose();
        } catch (error) {
          console.warn(`MCP: failed to dispose Pi-registered server "${name}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const configured = state.config.mcpServers;
    const report = (message: string) => {
      if (ctx.hasUI) ctx.ui?.notify(message, "warning");
      else console.warn(`MCP: ${message}`);
    };
    for (const server of piRegistered) {
      const configJson = JSON.stringify(server.config);
      const existing = piRegisteredServers.get(server.name);
      if (existing?.config === configJson && existing.registration) continue;
      if (existing?.config === configJson && existing.registration === null) {
        // A previous session may have configured the same name. Re-evaluate the
        // ownership decision now that this session's config is authoritative.
      }
      const label = `MCP server "${server.name}" registered by ${server.extensionPath}`;
      const translated = translatePiMcpServer(server.name, server.config);
      let registration: McpServerRegistration | null = null;
      if (typeof translated === "string") {
        report(`${label} is not connected: ${translated}.`);
      } else if (Object.hasOwn(configured, server.name) && configured[server.name] !== runtimeServers.get(server.name)?.entry) {
        report(`${label} is overridden by the configured server of the same name.`);
      } else if (runtimeServers.has(server.name)) {
        report(`${label} is overridden by the server registered earlier with pi-mcp-adapter's registerMcpServer().`);
      } else {
        const { directTools: _directTools, ...entry } = translated.entry;
        const ignored = [
          ...translated.ignored,
          ...(Array.isArray(translated.entry.directTools)
            ? translated.entry.directTools.map(tool => `toolExposure ${JSON.stringify(tool)}: direct`)
            : translated.entry.directTools !== undefined ? [`exposure: ${String(server.config.exposure)}`] : []),
        ];
        if (ignored.length > 0) report(`${label}: ignored settings ${ignored.join(", ")}.`);
        try {
          registration = registerRuntimeServer(server.name, entry);
        } catch (error) {
          report(`${label} is not connected: ${error instanceof Error ? error.message : String(error)}.`);
        }
      }
      piRegisteredServers.set(server.name, { config: configJson, registration });
    }
    applyingPiRegisteredServers = false;
  }

  function getRuntimeServerSnapshot(name: string): McpRuntimeServerSnapshot {
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("MCP runtime server name must be a non-empty string");
    }
    const runtimeServer = runtimeServers.get(name);
    if (!runtimeServer) {
      throw new Error(`MCP runtime server "${name}" is not registered or has been disposed`);
    }

    const state = activeRuntimeState;
    if (!state) {
      throw new Error(`MCP runtime server "${name}" is unavailable because the adapter has no active state`);
    }
    const activeEntry = state.config.mcpServers[name];
    if (Object.hasOwn(state.config.mcpServers, name) && activeEntry !== runtimeServer.entry) {
      throw new Error(`MCP runtime server "${name}" is shadowed by a configured server`);
    }
    if (activeEntry !== runtimeServer.entry) {
      throw new Error(`MCP runtime server "${name}" is unavailable in the active adapter state`);
    }
    return {
      name,
      definition: structuredClone(runtimeServer.definition),
      runtime: true,
      persisted: false,
    };
  }

  function registerScriptTool(config: McpConfig = earlyConfig): void {
    if (scriptToolRegistered) return;
    // The skill file is manual-only; Pi reads disable-model-invocation from the file and extensions cannot override it.
    const scriptingSkillPath = fileURLToPath(new URL("./skills/mcp-scripting/SKILL.md", import.meta.url));
    const skillPointer = config.settings?.scriptSkill === "model"
      ? ` Before writing a script, read ${scriptingSkillPath} for result shapes and limits.`
      : "";
    (pi.registerTool as (tool: unknown) => unknown)({
      name: "mcpScript",
      label: "MCP Script",
      description: "Run sandboxed JavaScript to loop, filter, chain, or fan out across multiple MCP calls in one request. Use mcp for a single call, search, describe, status, or auth. await tools.search({ query }) returns { items: [{ path, name, server, description? }], total, hasMore, nextOffset }, not { ok, data }. await tools.describe({ path }) returns a descriptor with inputTypeScript or { path, error: { code, message, suggestions } }. tools.call(path, args) and tools.<path>(args) return { ok: true, data } or { ok: false, error: { code, message } }. data is the raw MCP result { content, structuredContent? }: use data.structuredContent when present; otherwise JSON usually needs JSON.parse(data.content[0].text). Use emit(value) for user-visible output." + skillPointer,
      promptSnippet: "Batch multiple MCP tool calls in one JavaScript request (loop, filter, chain)",
      parameters: Type.Object({
        code: Type.String({ description: "Sandboxed JavaScript MCP script. Pass tool names exactly as mcp lists them, e.g. tools.call(\"github_search_issues\", args), and use emit(value)." }),
        timeoutMs: Type.Optional(Type.Number({ minimum: 1, description: "Execution timeout in milliseconds (default: 30000)" })),
      }),
      renderCall: createMcpScriptToolCallRenderer(),
      renderResult: renderMcpToolResult,
      execute: async (
        _toolCallId: string,
        params: { code: string; timeoutMs?: number },
        signal: AbortSignal | undefined,
        _onUpdate: ToolUpdate | undefined,
        ctx: ExtensionContext,
      ) => {
        let runtime: McpRuntime | null;
        try {
          runtime = await ensureRuntimeStarted(latestSessionStart, signal, true, ctx, true);
        } catch (error) {
          throwIfAborted(signal);
          if (isSessionTransitionError(error, latestSessionStart)) throw error;
          return initializationFailedResult(error, "script");
        }
        if (!runtime) return initializationPendingResult("script");
        return runtime.executeScript(params, signal, ctx);
      },
    });
    scriptToolRegistered = true;
  }

  function syncScriptToolFor(enabled: boolean, config?: McpConfig): void {
    if (enabled) {
      const effectiveConfig = config ?? sessionScriptConfig ?? (deferEarlyScriptToolRegistration ? undefined : earlyConfig);
      if (effectiveConfig) registerScriptTool(effectiveConfig);
    }

    const activeTools = getActiveToolsIfReady();
    if (!activeTools) return;
    observeActiveToolOwnership(activeTools);
    const next = [...activeTools];
    if (!enabled) {
      if (next.includes("mcpScript")) {
        adapterDeactivatedTools.add("mcpScript");
        next.splice(next.indexOf("mcpScript"), 1);
      }
    } else if (
      !next.includes("mcpScript")
      && adapterDeactivatedTools.has("mcpScript")
      && !userDeactivatedTools.has("mcpScript")
    ) {
      adapterDeactivatedTools.delete("mcpScript");
      next.push("mcpScript");
    }
    if (next.length !== activeTools.length || next.some((name, index) => name !== activeTools[index])) {
      setActiveTools(next);
    }
  }

  function refreshRegisteredProxyDescription(
    config: McpConfig,
    scriptMode: boolean,
    session: { generation: number },
    expectedSurfaceGeneration: number,
  ): void {
    const isCurrent = () => !lifecycleClosed
      && surfaceGeneration === expectedSurfaceGeneration
      && sessionIsCurrent(session);
    if (!proxyToolRegistered || !isCurrent()) return;

    const activeTools = getActiveToolsIfReady();
    if (!activeTools || !isCurrent()) return;
    observeActiveToolOwnership(activeTools);
    if (!isCurrent()
      || !activeTools.includes("mcp")
      || adapterDeactivatedTools.has("mcp")
      || userDeactivatedTools.has("mcp")) return;

    const description = buildProxyDescription(config, scriptMode);
    if (isCurrent()) registerProxyTool(description);
  }

  function recordNamespaceSyncResult(result: ReturnType<typeof syncNamespaceProxyTools>): void {
    for (const name of result.added) registeredNamespaceTools.add(name);
    for (const name of result.updated) registeredNamespaceTools.add(name);
    for (const name of result.deactivated) registeredNamespaceTools.delete(name);
  }

  function clearNamespaceProxyTools(): void {
    const result = syncNamespaceProxyTools({
      config: null,
      cache: null,
      envOverride: namespaceEnvOverride,
      existingDirectNames: new Set(registeredDirectTools.keys()),
      activeDirectNames: new Set(registeredDirectTools.keys()),
      existingNamespaceNames: registeredNamespaceTools,
      fallbackDeactivatedNames: adapterDeactivatedTools,
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => pi.getAllTools(),
    });
    recordNamespaceSyncResult(result);
  }

  function syncToolSurface(
    state: McpExtensionState,
    ctx: ExtensionContext,
    initial: boolean,
    helpers: McpRuntimeSurfaceHelpers,
    options: {
      forceDirectTools?: boolean;
      /** Scoped persisted panel refresh; ignored for unfrozen global reconciliation. */
      forceDirectToolServers?: ReadonlySet<string>;
      /** One-time cold discovery for the notifying search-mode server(s). */
      discoverDirectToolServers?: ReadonlySet<string>;
      reportDirectToolAdditions?: boolean;
      scriptMode?: boolean;
      attribution?: object;
    } = {},
  ): void {
    const scriptMode = options.scriptMode
      ?? (latestSessionStart ? sessionScriptMode === true : earlyConfig.settings?.scriptMode === true);
    activeRuntimeState = state;
    activeSurfaceContext = ctx;
    activeSurfaceHelpers = helpers;
    const capturedSurfaceGeneration = surfaceGeneration;
    const capturedSession = latestSessionStart;
    const capturedOwner = state.owner;
    const surfaceIsCurrent = () => surfaceGeneration === capturedSurfaceGeneration
      && activeRuntimeState === state
      && latestSessionStart === capturedSession
      && !lifecycleClosed
      && (capturedOwner?.isActive?.() ?? true);
    const surfaceCwd = state.sessionCwd ?? ctx.cwd ?? process.cwd();
    applyRuntimeServers(state);
    if (!applyingPiRegisteredServers) void applyPiMcpServers(state, ctx);
    syncScriptToolFor(scriptMode, sessionScriptConfig);
    // Recompute the bounded, model-facing description from the active state
    // without allowing the load-time script setting to leak into the session.
    buildProxyDescription(state.config, scriptMode);
    syncPromptCommands(state, state.config, state.sessionCwd);
    const directToolsFrozen = state.config.settings?.freezeDirectTools !== false;
    const surfaceCache = loadToolSurfaceCache(state.config, state);
    const hasAuthoritativeInitialCatalog = state.sessionMetadata?.size !== undefined && state.sessionMetadata.size > 0
      || surfaceCache !== null
      || envDirectToolOverride !== undefined;
    const unavailableServers = new Set(
      Object.keys(state.config.mcpServers).filter(name => isServerInActiveFailureBackoff(state, name)),
    );
    const unavailableDirectNames = [...registeredDirectTools.entries()]
      .filter(([, registered]) => unavailableServers.has(registered.spec.serverName))
      .map(([name]) => name);
    if (unavailableDirectNames.length > 0) {
      deactivateTools(unavailableDirectNames);
      for (const name of unavailableDirectNames) {
        registeredDirectTools.delete(name);
        registeredDirectToolDefinitions.delete(name);
        lazyDirectTools.delete(name);
        searchActivatedTools.delete(name);
      }
      if (state.directToolCounts) {
        state.directToolCounts.clear();
        for (const { spec } of registeredDirectTools.values()) {
          state.directToolCounts.set(spec.serverName, (state.directToolCounts.get(spec.serverName) ?? 0) + 1);
        }
      }
    }
    const coldDiscovery = !initial && directToolsFrozen && options.forceDirectToolServers === undefined
      ? reserveColdSearchDiscovery(state.config, options.discoverDirectToolServers)
      : undefined;
    const capturedColdCatalogs = coldDiscovery
      ? captureColdSearchDiscoveryCatalogs(state.config, surfaceCache, surfaceCwd, coldDiscovery.servers)
      : new Set<string>();
    const shouldSyncDirectTools = (!initial || hasAuthoritativeInitialCatalog)
      && (initial || options.forceDirectTools === true || !directToolsFrozen || coldDiscovery !== undefined);
    let directResult: ReturnType<typeof syncDirectToolsFor> = {
      specs: [...registeredDirectTools.values()].map(({ spec }) => spec),
      added: [],
      updated: [],
      deactivated: unavailableDirectNames,
      reservedNames: new Set([...registeredDirectTools.keys(), ...unavailableDirectNames]),
    };
    try {
      if (shouldSyncDirectTools) {
        directResult = syncDirectTools(
          state,
          options.reportDirectToolAdditions === true && options.attribution !== undefined,
          surfaceCwd,
          options.attribution,
          {
            // Panel Save and a reserved cold discovery are the only frozen
            // refreshes with an affected set. Unfrozen surfaces stay global.
            ...(directToolsFrozen && options.forceDirectToolServers !== undefined
              ? {
                  affectedServers: options.forceDirectToolServers,
                  reservedNames: new Set(unavailableDirectNames),
                }
              : coldDiscovery
                ? {
                    affectedServers: coldDiscovery.servers,
                    reservedNames: new Set(unavailableDirectNames),
                  }
                : {}),
            canCommitAppliedDirectToolCatalogs: surfaceIsCurrent,
          },
        );
      }
      if (!surfaceIsCurrent()) throw staleRuntimeError();
      if (coldDiscovery) {
        for (const serverName of capturedColdCatalogs) {
          if (!unavailableServers.has(serverName)) appliedSearchDirectToolServers.add(serverName);
        }
      }
    } finally {
      if (coldDiscovery) releaseColdSearchDiscovery(coldDiscovery);
    }
    const directChanges = directResult.added.length + directResult.updated.length + directResult.deactivated.length;
    if (directChanges > 0 && ctx?.hasUI && ctx.ui?.notify && surfaceIsCurrent()) {
      ctx.ui.notify(
        `MCP: direct tools refreshed (+${directResult.added.length}, ~${directResult.updated.length}, -${directResult.deactivated.length})`,
        "info",
      );
      if (!surfaceIsCurrent()) throw staleRuntimeError();
    }
    deliverLargeDirectToolsAdvisory(ctx, state.config);

    const result = syncNamespaceProxyTools({
      config: state.config,
      cache: surfaceCache,
      envOverride: namespaceEnvOverride,
      existingDirectNames: directResult.reservedNames,
      activeDirectNames: new Set(registeredDirectTools.keys()),
      existingNamespaceNames: registeredNamespaceTools,
      fallbackDeactivatedNames: adapterDeactivatedTools,
      unavailableServers,
      defaultCwd: surfaceCwd,
      pi,
      getState: helpers.getState,
      getInitPromise: helpers.getInitPromise,
      ensureRuntime: (ctx: unknown) => helpers.ensureState(ctx as ExtensionContext),
      executeCall: helpers.executeCall,
      getPiTools: helpers.getPiTools,
    });
    recordNamespaceSyncResult(result);
    syncProxyTool(state.config, surfaceCache, directResult.specs, surfaceCwd, undefined, scriptMode);
    void ctx;
  }
  let nextSessionGeneration = 0;
  let directToolBootstrapGeneration: number | null = null;
  let startedGeneration = 0;
  let runtimeStartInvokedGeneration = 0;
  let startupGeneration = 0;
  let startupPromise: Promise<void> | null = null;
  let retryGeneration = 0;
  let retryPromise: Promise<void> | null = null;
  let surfaceGeneration = 0;
  let loadTimeInitializationStarted = false;
  let lifecycleClosed = false;
  let loadTimeToken = 0;

  function staleRuntimeError(): Error {
    return new Error("MCP extension session restarted (stale session)");
  }

  function sessionIsCurrent(session: { generation: number } | null): boolean {
    return session !== null && latestSessionStart?.generation === session.generation;
  }

  function nativeSignInSessionIsCurrent(session: SessionStart, controller: AbortController): boolean {
    const owner = activeRuntimeState?.owner;
    return !lifecycleClosed
      && latestSessionStart === session
      && !controller.signal.aborted
      && (owner?.isActive?.() ?? true);
  }

  function beginNativeSignInOffer(
    session: SessionStart,
    config: McpConfig,
    controller: AbortController,
  ): Promise<void> {
    // Native sign-in is session-owned. It is intentionally separate from the
    // runtime owner because it must finish before the first runtime owner can
    // connect, while successor/shutdown still need to cancel its UI prompt.
    if (
      programmaticConfig
      || !session.ctx.hasUI
      || typeof pi.registerMcpServer !== "function"
      || !existsSync(getPiMcpAuthPath())
    ) return Promise.resolve();

    const offer = Promise.resolve().then(async () => {
      if (!nativeSignInSessionIsCurrent(session, controller)) return;
      try {
        const { offerPiSignInImports } = await import("./pi-signin-import.ts");
        if (!nativeSignInSessionIsCurrent(session, controller)) return;
        await offerPiSignInImports(
          session.ctx,
          config,
          controller.signal,
          () => nativeSignInSessionIsCurrent(session, controller),
        );
        if (!nativeSignInSessionIsCurrent(session, controller)) return;
      } catch (error) {
        if (!nativeSignInSessionIsCurrent(session, controller)) return;
        console.error(`MCP: could not offer Pi sign-in import: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    // A host UI is allowed to ignore the optional AbortSignal. Do not leave
    // cold first-use callers parked until that UI eventually answers; the
    // session-owned signal settles this prerequisite at owner cancellation.
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        settle();
      };
      const onAbort = () => finish(resolve);
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      controller.signal.addEventListener("abort", onAbort, { once: true });
      void offer.then(
        () => finish(resolve),
        error => finish(() => reject(error)),
      );
    });
  }

  function isSessionTransitionError(error: unknown, session: { generation: number } | null): boolean {
    return !sessionIsCurrent(session)
      || (error instanceof Error && /stale|restarted|session_shutdown|extension session/i.test(error.message));
  }

  const loadRuntime = () => {
    if (!runtimePromise) {
      runtimePromise = import("./mcp-runtime.ts").then(({ createMcpRuntime }) => {
        const runtimeOptions: McpRuntimeOptions = {
          ...(earlyConfigPath === undefined ? {} : { earlyConfigPath }),
          ...(programmaticConfigSnapshot !== undefined ? { config: cloneMcpConfig(programmaticConfigSnapshot) } : {}),
          startupConfig: cloneMcpConfig(earlyConfig),
          toolSurface: {
            sync: syncToolSurface,
            activateSearchMatches,
            getDirectToolNames: () => [...registeredDirectTools.keys()],
            beginDirectToolAttribution,
            consumeDirectToolNames,
            discardDirectToolAttribution,
          },
        };
        return createMcpRuntime(pi, runtimeOptions);
      });
    }
    return runtimePromise;
  };

  const waitForStartup = async (
    promise: Promise<void>,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<"ready" | "timeout"> => {
    const result = await awaitWithDeadline(promise, deadline, signal);
    return result === INIT_WAIT_TIMED_OUT ? "timeout" : "ready";
  };

  const ensureRuntimeStarted = async (
    session = latestSessionStart,
    signal?: AbortSignal,
    waitForReady = true,
    firstUseContext?: ExtensionContext,
    allowFirstUseExpedite = false,
  ): Promise<McpRuntime | null> => {
    if (waitForReady) throwIfAborted(signal);
    if (!session && lifecycleClosed) throw staleRuntimeError();
    const deadline = waitForReady ? Date.now() + INIT_WAIT_TIMEOUT_MS : undefined;
    const requestedSurfaceGeneration = surfaceGeneration;
    const hadStartedSession = session !== null
      && startedGeneration >= session.generation
      && startupGeneration === session.generation;
    const loadedRuntime = loadRuntime();
    let runtime: McpRuntime;
    if (deadline === undefined) {
      runtime = await loadedRuntime;
    } else {
      const loaded = await awaitWithDeadline(loadedRuntime, deadline, signal);
      if (loaded === INIT_WAIT_TIMED_OUT) return null;
      runtime = loaded;
    }

    const sessionWasStarted = session !== null
      && runtimeStartInvokedGeneration === session.generation;
    const startupAlreadyInFlight = session !== null
      && startupPromise !== null
      && startupGeneration === session.generation;
    if (session && !sessionWasStarted && !startupAlreadyInFlight
      && (lifecycleClosed || requestedSurfaceGeneration !== surfaceGeneration || !sessionIsCurrent(session))) {
      throw staleRuntimeError();
    }
    if (!session) {
      if (!waitForReady) return runtime;
      if (startupPromise && startupGeneration === 0) {
        const startupResult = await waitForStartup(startupPromise, deadline!, signal);
        if (startupResult === "timeout") return null;
      }
      const remaining = deadline! - Date.now();
      if (remaining <= 0) return null;
      const initialization = runtime.waitForInitialization?.(signal, remaining) ?? Promise.resolve("ready" as const);
      const bounded = await awaitWithDeadline(initialization, deadline!, signal);
      return bounded === INIT_WAIT_TIMED_OUT || bounded === "timeout" ? null : runtime;
    }

    // This branch has returned for the nullable pre-session path above; keep a
    // verified session value for the shared native-sign-in prerequisite.
    const currentSession = session;
    const waitForNativeSignIn = async (): Promise<boolean> => {
      if (deadline === undefined) {
        await currentSession.nativeSignInReady;
        return true;
      }
      const result = await awaitWithDeadline(currentSession.nativeSignInReady, deadline, signal);
      return result !== INIT_WAIT_TIMED_OUT;
    };

    const startSession = async (force = false): Promise<void> => {
      if (!force && startedGeneration >= session.generation && startupGeneration === session.generation) return;
      if (!sessionIsCurrent(session)) throw staleRuntimeError();
      startupGeneration = session.generation;
      const startupSource = firstUseContext ?? session.ctx;
      // Pi's ExtensionContext.signal is a live current-turn getter, including
      // on saved session_start contexts; it is never session ownership. Shared
      // startup is cancelled by the runtime owner, not by any Pi context turn.
      const startupContext = Object.create(Object.getPrototypeOf(startupSource), {
        ...Object.getOwnPropertyDescriptors(startupSource),
        signal: {
          value: undefined,
          enumerable: true,
          configurable: true,
          writable: true,
        },
      }) as ExtensionContext;
      const currentStartupPromise = Promise.resolve()
        .then(() => {
          if (lifecycleClosed || requestedSurfaceGeneration !== surfaceGeneration || !sessionIsCurrent(session)) {
            throw staleRuntimeError();
          }
          runtimeStartInvokedGeneration = session.generation;
          return runtime.handleSessionStart(session.event, startupContext, {
            waitForProjectTrust: true,
            ...(sessionScriptMode === (earlyConfig.settings?.scriptMode === true)
              ? {}
              : { scriptMode: sessionScriptMode === true }),
          });
        });
      startupPromise = currentStartupPromise;
      // Observe failures even when session_start deliberately does not wait
      // for initialization, but let the requesting operation receive the same
      // rejection when it is the one starting the runtime.
      void currentStartupPromise.catch(error => {
        console.error("MCP session initialization failed:", error);
      });
      try {
        await currentStartupPromise;
        if (!sessionIsCurrent(session) && !lifecycleClosed) throw staleRuntimeError();
        startedGeneration = session.generation;
      } finally {
        if (startupPromise === currentStartupPromise) startupPromise = null;
      }
    };

    const expediteFirstUse = async (capturedStartup: Promise<void> | null): Promise<void> => {
      if (!allowFirstUseExpedite || !waitForReady || !runtime.expediteSessionStart || !capturedStartup) return;
      const canExpedite = () => sessionIsCurrent(session)
        && startupGeneration === session.generation
        && startupPromise === capturedStartup;
      // handleSessionStart is scheduled by startSession's first microtask;
      // every attempt is fenced to the captured facade session and startup.
      if (!canExpedite()) return;
      if (runtime.expediteSessionStart()) return;
      // A replacement may win while the runtime start reaches its gate. Never
      // let that stale request release the successor's cleanup wait.
      await Promise.resolve();
      if (canExpedite()) runtime.expediteSessionStart();
    };

    if (!hadStartedSession && startedGeneration < session.generation) {
      // The native sign-in offer is a shared session prerequisite. Wait before
      // claiming startup ownership so a first-use deadline can return pending
      // without allowing a late prompt answer to start the runtime afterward.
      if (!startupAlreadyInFlight && !(await waitForNativeSignIn())) return null;
      // The native prerequisite settles immediately on owner abort. Fence the
      // parked caller before it can claim startup for a successor or shutdown.
      if (currentSession.nativeSignInSignal.aborted || !sessionIsCurrent(session) || lifecycleClosed) {
        throw staleRuntimeError();
      }
      if (startupPromise && startupGeneration === session.generation) {
        const startup = startupPromise;
        // Only an explicit first-use operation may release the runtime's
        // teardown gate. A normal session_start uses waitForReady=false and
        // never reaches this branch.
        await expediteFirstUse(startup);
        if (waitForReady) {
          const startupResult = await waitForStartup(startup, deadline!, signal);
          if (startupResult === "timeout") return null;
        } else {
          await abortable(startup, signal);
        }
      } else {
        const startup = startSession();
        await expediteFirstUse(startupPromise ?? startup);
        if (waitForReady) {
          const startupResult = await waitForStartup(startup, deadline!, signal);
          if (startupResult === "timeout") return null;
        } else {
          await startup;
        }
      }
    }
    if (!waitForReady) return runtime;

    const waitReady = async (): Promise<"ready" | "timeout"> => {
      const remaining = deadline! - Date.now();
      if (remaining <= 0) return "timeout";
      const initialization = runtime.waitForInitialization?.(signal, remaining) ?? Promise.resolve("ready" as const);
      const bounded = await awaitWithDeadline(initialization, deadline!, signal);
      return bounded === INIT_WAIT_TIMED_OUT ? "timeout" : bounded;
    };
    let waitResult: "ready" | "timeout";
    try {
      // The deadline starts before module loading and is passed through every
      // wait stage; a trust dialog or startup timeout never cancels shared
      // initialization.
      waitResult = await waitReady();
    } catch (error) {
      throwIfAborted(signal);
      if (!sessionIsCurrent(session)) throw error;
      if (deadline! - Date.now() <= 0) return null;

      // A rejected initialization is retryable; an abort or a session change
      // is not. Share the retry so concurrent first calls never create two
      // owners or two initializations. The shared retry has no caller-owned
      // timer; each waiter applies its own remaining deadline below.
      if (retryGeneration !== session.generation || !retryPromise) {
        retryGeneration = session.generation;
        const currentRetryPromise = (async () => {
          const retryStartup = startSession(true);
          await expediteFirstUse(startupPromise ?? retryStartup);
          await retryStartup;
          const retryResult = await runtime.waitForInitialization?.(undefined, Number.POSITIVE_INFINITY) ?? "ready";
          if (retryResult === "timeout") throw RETRY_WAIT_TIMED_OUT;
          if (!sessionIsCurrent(session)) throw staleRuntimeError();
        })();
        retryPromise = currentRetryPromise.finally(() => {
          if (retryGeneration === session.generation) {
            retryGeneration = 0;
            retryPromise = null;
          }
        });
        // A caller can time out while the shared retry continues. Keep its
        // eventual rejection observed without cancelling that retry.
        void retryPromise.catch(() => undefined);
      }
      let retryResult: void | typeof INIT_WAIT_TIMED_OUT;
      try {
        retryResult = await awaitWithDeadline(retryPromise, deadline!, signal);
      } catch (retryError) {
        throwIfAborted(signal);
        if (!sessionIsCurrent(session)) throw retryError;
        if (retryError === RETRY_WAIT_TIMED_OUT) return null;
        throw markRetryFailure(retryError);
      }
      if (retryResult === INIT_WAIT_TIMED_OUT) return null;
      waitResult = "ready";
    }
    if (waitResult === "timeout") return null;
    if (!sessionIsCurrent(session)) throw staleRuntimeError();
    return runtime;
  };

  function startLoadTimeInitialization(): void {
    // Eager/keep-alive load-time initialization intentionally remains outside
    // the UI sign-in prerequisite: Pi has no session UI or current project
    // trust at load time, so this preserves the existing pre-session
    // first-connect limitation rather than claiming a global before-connect
    // guarantee.
    const hasStartupServer = Object.values(earlyConfig.mcpServers).some(definition => (
      !isServerDisabled(definition) && (definition.lifecycle === "eager" || definition.lifecycle === "keep-alive")
    ));
    if (!hasStartupServer || loadTimeInitializationStarted) return;
    loadTimeInitializationStarted = true;
    const token = loadTimeToken;
    const loadContext = {
      mode: "print",
      hasUI: false,
      cwd: process.cwd(),
      signal: new AbortController().signal,
    } as unknown as ExtensionContext;
    let current: Promise<void>;
    current = loadRuntime()
      .then(runtime => {
        if (lifecycleClosed || token !== loadTimeToken || latestSessionStart || startedGeneration > 0) return;
        startupGeneration = 0;
        return runtime.handleSessionStart({}, loadContext, { excludeProjectServers: true });
      })
      .catch(error => {
        if (!lifecycleClosed && token === loadTimeToken) console.error("MCP session initialization failed:", error);
      })
      .finally(() => {
        if (startupPromise === current) startupPromise = null;
      });
    startupPromise = current;
  }

  const registeredPromptCommands = new Set<string>();
  let largeDirectToolsAdvisoryDelivered = false;
  function registerPromptCommands(specs: Iterable<PromptMetadata>): void {
    for (const spec of specs) {
      if (registeredPromptCommands.has(spec.commandName)) continue;
      pi.registerCommand(spec.commandName, createPromptCommand(
        pi,
        () => activeRuntimeState,
        spec,
        {
          ensureState: async (ctx) => {
            const runtime = await ensureRuntimeStarted(latestSessionStart, ctx.signal, true, ctx as unknown as ExtensionContext, true);
            if (!runtime) throw new McpInitializationPendingError();
            return activeRuntimeState;
          },
          lazyConnect: async (state, serverName, signal) => (await import("./init.ts")).lazyConnect(state, serverName, signal),
          isStateCurrent: (state) => state === activeRuntimeState,
        },
      ));
      registeredPromptCommands.add(spec.commandName);
    }
  }

  function syncPromptCommands(
    state?: McpExtensionState,
    config = earlyConfig,
    defaultCwd = process.cwd(),
    cache?: ReturnType<typeof loadMetadataCache>,
  ): void {
    if (state?.promptMetadata) {
      registerPromptCommands([...state.promptMetadata.values()].flat());
      return;
    }
    registerPromptCommands(resolveCachedPrompts(config, defaultCwd));
  }

  function deliverLargeDirectToolsAdvisory(
    ctx: ExtensionContext | undefined,
    config: McpExtensionState["config"],
  ): void {
    if (!ctx || largeDirectToolsAdvisoryDelivered) return;
    const message = getLargeDirectToolsAdvisory(
      config,
      [...registeredDirectTools.values()].map(({ spec }) => spec),
    );
    if (!message) return;
    largeDirectToolsAdvisoryDelivered = true;
    if (ctx.hasUI) ctx.ui?.notify(message, "warning");
    else console.warn(message);
  }

  function publishDeferredFooter(ctx: ExtensionContext, config: McpConfig, cache: ReturnType<typeof loadMetadataCache>): void {
    if (!ctx.hasUI || !ctx.ui?.setStatus) return;
    const enabled = Object.values(config.mcpServers).filter(definition => !isServerDisabled(definition)).length;
    if (enabled === 0 || config.settings?.mcpFooterStatus === "off") {
      ctx.ui.setStatus("mcp", undefined);
      return;
    }

    const formatted = config.settings?.mcpFooterStatus === "compact"
      ? `MCP 0/${enabled}`
      : `MCP: 0/${enabled} servers`;
    const theme = ctx.ui.theme;
    const styled = typeof theme?.fg === "function" ? theme.fg("dim", formatted) : formatted;
    void cache;
    ctx.ui.setStatus("mcp", styled);
  }

  function initializationPendingResult(mode?: string): AgentToolResult<Record<string, unknown>> {
    return {
      content: [{ type: "text", text: MCP_INITIALIZATION_PENDING_MESSAGE }],
      details: { ...(mode ? { mode } : {}), error: "init_timeout", timeoutMs: INIT_WAIT_TIMEOUT_MS },
    };
  }

  function initializationFailedResult(error: unknown, mode?: string, server?: string): AgentToolResult<Record<string, unknown>> {
    const message = error instanceof Error ? error.message : String(error);
    const retry = (error as RetryFailure)?.[RETRY_FAILURE] === true
      ? " Fix the MCP server configuration or startup failure, then call mcp(...) again to retry initialization."
      : "";
    return {
      content: [{ type: "text", text: `MCP initialization failed: ${message}${retry}` }],
      details: { ...(mode ? { mode } : {}), ...(server ? { server } : {}), error: "init_failed", message },
    };
  }

  function notifyInitializationPending(
    ctx: { hasUI?: boolean; ui?: { notify: (message: string, level: "info" | "warning" | "error") => void } },
    reportHeadless = false,
  ): void {
    if (ctx.hasUI) ctx.ui?.notify(MCP_INITIALIZATION_PENDING_MESSAGE, "info");
    else if (reportHeadless) console.warn(MCP_INITIALIZATION_PENDING_MESSAGE);
  }

  function notifyInitializationFailed(ctx: { hasUI?: boolean; ui?: { notify: (message: string, level: "info" | "warning" | "error") => void } }, error: unknown): void {
    const message = `MCP initialization failed: ${error instanceof Error ? error.message : String(error)}`;
    if (ctx.hasUI) ctx.ui?.notify(message, "error");
    else console.warn(message);
  }

  function registerProxyTool(description: string): void {
    if (proxyToolRegistered && proxyToolDescription === description) return;
    const previous = {
      registered: proxyToolRegistered,
      description: proxyToolDescription,
      owner: proxyToolRegistrationOwner,
    };
    const registration = {};
    // Pi may invoke host callbacks synchronously from registerTool. Publish
    // before that callback so nested refreshes see this descriptor; identity-
    // guarded rollback keeps a failed outer attempt from clobbering newer work.
    proxyToolRegistered = true;
    proxyToolDescription = description;
    proxyToolRegistrationOwner = registration;
    try {
      (pi.registerTool as (tool: unknown) => unknown)({
        name: "mcp",
        label: "MCP",
        description,
        promptSnippet: "MCP gateway - connect to MCP servers and call their tools",
        renderShell: resolveMcpToolRenderOptions(earlyConfig.settings).resultRendering === "boxed" ? "default" : "self",
        renderCall: createMcpProxyToolCallRenderer(resolveMcpToolRenderOptions(earlyConfig.settings)),
        parameters: MCP_PROXY_TOOL_PARAMETERS_SCHEMA,
        renderResult: renderMcpToolResult,
        async execute(
          toolCallId: string,
          params: ProxyToolParams,
          signal: AbortSignal | undefined,
          onUpdate: ToolUpdate | undefined,
          ctx: ExtensionContext,
        ) {
          let runtime: McpRuntime | null;
          try {
            runtime = await ensureRuntimeStarted(latestSessionStart, signal, true, ctx, true);
          } catch (error) {
            throwIfAborted(signal);
            if (isSessionTransitionError(error, latestSessionStart)) throw error;
            return initializationFailedResult(error);
          }
          if (!runtime) return initializationPendingResult();
          return runtime.executeProxyTool(toolCallId, params, signal, onUpdate, ctx);
        },
      });
    } catch (error) {
      if (proxyToolRegistrationOwner === registration) {
        proxyToolRegistered = previous.registered;
        proxyToolDescription = previous.description;
        proxyToolRegistrationOwner = previous.owner;
      }
      throw error;
    }
  }

  function syncProxyTool(
    config: McpConfig,
    cache: MetadataCache | null,
    directSpecs: readonly { serverName: string; lazy?: boolean }[],
    defaultCwd = process.cwd(),
    precomputedMissing?: string[],
    scriptMode = earlyConfig.settings?.scriptMode === true,
  ): void {
    const missing = precomputedMissing ?? getMissingConfiguredDirectToolServers(
      config,
      cache,
      envRaw === undefined || envRaw === "__none__" ? undefined : envDirectToolOverride,
      defaultCwd,
    );
    const hasSearch = directSpecs.some(spec => spec.lazy === true);
    const shouldRegister = config.settings?.disableProxyTool !== true
      || directSpecs.length === 0
      || hasSearch
      || missing.length > 0
      || hasEnabledServerWithoutValidMetadata(config, cache, directSpecs, defaultCwd);

    const activeTools = getActiveToolsIfReady();
    if (activeTools) observeActiveToolOwnership(activeTools);
    if (shouldRegister) {
      registerProxyTool(buildProxyDescription(config, scriptMode));
      const current = getActiveToolsIfReady();
      if (current?.includes("mcp")) {
        adapterDeactivatedTools.delete("mcp");
      } else if (current && adapterDeactivatedTools.delete("mcp") && !userDeactivatedTools.has("mcp")) {
        setActiveTools([...current, "mcp"]);
      }
      return;
    }

    if (!proxyToolRegistered) return;
    const unregisterTool = (pi as ExtensionAPI & { unregisterTool?: (name: string) => boolean }).unregisterTool;
    if (unregisterTool?.("mcp") === true) {
      proxyToolRegistered = false;
      proxyToolDescription = null;
      proxyToolRegistrationOwner = null;
      adapterDeactivatedTools.delete("mcp");
      return;
    }
    const current = getActiveToolsIfReady();
    if (!current || !current.includes("mcp")) return;
    adapterDeactivatedTools.add("mcp");
    setActiveTools(current.filter(name => name !== "mcp"));
  }

  function registerDirectTool(
    spec: typeof directSpecs[number],
    deferred?: Record<string, unknown>,
    config: McpConfig = earlyConfig,
  ): void {
    const renderOptions = resolveMcpToolRenderOptions(config.settings);
    const wrapDeferredResult = (result: AgentToolResult<Record<string, unknown>>): AgentToolResult<Record<string, unknown>> => (
      deferred ? toDeferredCallToolResult(result) : result
    );
    const definition: Record<string, unknown> = {
      name: spec.prefixedName,
      label: `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
      parameters: getDirectToolParametersSchema(spec),
      ...(config.settings?.strictDirectToolArguments === true
        ? { prepareArguments: (args: Record<string, unknown>) => prepareDirectToolArguments(spec.inputSchema, args) }
        : {}),
      ...deferred,
      execute: async (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: ToolUpdate | undefined,
        ctx: ExtensionContext,
      ) => {
        let runtime: McpRuntime | null;
        try {
          runtime = await ensureRuntimeStarted(latestSessionStart, signal, true, ctx, true);
        } catch (error) {
          throwIfAborted(signal);
          if (isSessionTransitionError(error, latestSessionStart)) throw error;
          return wrapDeferredResult(initializationFailedResult(error, undefined, spec.serverName));
        }
        if (!runtime) return wrapDeferredResult(initializationPendingResult("direct"));
        try {
          const result = await runtime.executeDirectTool(spec, toolCallId, params, signal, onUpdate, ctx);
          return wrapDeferredResult(result);
        } catch (error) {
          throwIfAborted(signal);
          if (isSessionTransitionError(error, latestSessionStart)) throw error;
          return wrapDeferredResult(initializationFailedResult(error, undefined, spec.serverName));
        }
      },
      renderShell: renderOptions.resultRendering === "boxed" ? "default" : "self",
      renderCall: createMcpDirectToolCallRenderer(spec.prefixedName, renderOptions),
      renderResult: renderMcpToolResult,
    };
    (pi.registerTool as (tool: unknown) => unknown)(definition);
    registeredDirectToolDefinitions.set(spec.prefixedName, definition);
  }

  runtimeRegistrars.set(pi, registerAdapterServer);
  runtimeSnapshotters.set(pi, getRuntimeServerSnapshot);
  if (pi.events) {
    pi.events.on(MCP_RUNTIME_REGISTER_EVENT, (rawRequest: unknown) => {
    if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) return;
    const request = rawRequest as McpRuntimeRegistrationRequest;
    if (request.result !== undefined) return;
    if (request.version !== MCP_RUNTIME_REGISTER_VERSION) {
      request.result = {
        ok: false,
        error: new Error(`Unsupported MCP runtime registration version: ${String(request.version)}`),
      };
      return;
    }
    try {
      request.result = { ok: true, registration: registerRuntimeServer(request.name, request.definition) };
    } catch (error) {
      request.result = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  });
  pi.events.on(MCP_RUNTIME_SNAPSHOT_EVENT, (rawRequest: unknown) => {
    if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) return;
    const request = rawRequest as McpRuntimeSnapshotRequest;
    if (request.result !== undefined) return;
    if (request.version !== MCP_RUNTIME_SNAPSHOT_VERSION) {
      request.result = {
        ok: false,
        error: new Error(`Unsupported MCP runtime snapshot version: ${String(request.version)}`),
      };
      return;
    }
    try {
      request.result = { ok: true, snapshot: getRuntimeServerSnapshot(request.name) };
    } catch (error) {
      request.result = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  });
  pi.events.on(MCP_RUNTIME_TOOL_CALL_EVENT, (rawRequest: unknown) => {
    if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) return;
    const request = rawRequest as McpRuntimeToolCallRequest;
    if (request.result !== undefined) return;
    request.result = (async (): Promise<McpRuntimeToolCallResult> => {
      if (request.version !== MCP_RUNTIME_TOOL_CALL_VERSION) {
        return { ok: false, error: new Error(`Unsupported MCP runtime tool-call version: ${String(request.version)}`) };
      }
      if (typeof request.tool !== "string" || request.tool.trim() === "") {
        return { ok: false, error: new Error("MCP runtime tool-call requires a non-empty `tool` name") };
      }
      const session = latestSessionStart;
      if (!session) return { ok: false, error: new Error("MCP runtime tool calls require an active Pi session") };
      try {
        const runtime = await ensureRuntimeStarted(session, undefined, true);
        if (!runtime) return { ok: false, error: new Error(`MCP initialization is still in progress after ${INIT_WAIT_TIMEOUT_MS}ms`) };
        if (!sessionIsCurrent(session)) return { ok: false, error: staleRuntimeError() };
        return await runtime.executeRuntimeToolCall(request.tool, request.args, request.server);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    })();
  });
  }

  if (typeof pi.registerMcpServer === "function" && typeof pi.getMcpServers === "function") {
    try {
      piRegistered = pi.getMcpServers();
    } catch {
      piRegistered = [];
    }
    pi.on("mcp_servers_change", async (event, ctx) => {
      piRegistered = (event as { servers?: RegisteredMcpServer[] }).servers ?? [];
      let state = activeRuntimeState;
      if (!state && latestSessionStart) {
        await ensureRuntimeStarted(latestSessionStart, undefined, false);
        state = activeRuntimeState;
      }
      if (state) await applyPiMcpServers(state, ctx as ExtensionContext);
    });
  }

  for (const spec of directSpecs) {
    const deferred = deferredToolFields(spec, earlyConfig, earlyCache);
    registerDirectTool(spec, deferred, earlyConfig);
    registeredDirectTools.set(spec.prefixedName, { spec, fingerprint: directToolFingerprint(spec, deferred) });
    if (spec.lazy) lazyDirectTools.add(spec.prefixedName);
  }

  if (earlyConfig.settings?.scriptMode === true && !deferEarlyScriptToolRegistration) registerScriptTool(earlyConfig);

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  pi.on("resources_discover", (event) => {
    const sessionConfig = programmaticConfig
      ? resolveConfiguredClaudePluginMcp(cloneMcpConfig(programmaticConfigSnapshot!), event.cwd ?? process.cwd())
      : loadMcpConfig(earlyConfigPath, event.cwd);
    const scriptMode = latestSessionStart
      ? sessionScriptMode === true
      : earlyConfig.settings?.scriptMode === true;
    syncScriptToolFor(scriptMode, latestSessionStart ? sessionScriptConfig : (deferEarlyScriptToolRegistration ? undefined : earlyConfig));
    const skillPaths = discoverConfiguredClaudePluginSkills(sessionConfig, event.cwd);
    if (scriptMode) {
      const scriptingSkillPath = fileURLToPath(new URL("./skills/mcp-scripting/SKILL.md", import.meta.url));
      if (existsSync(scriptingSkillPath) && !skillPaths.includes(scriptingSkillPath)) skillPaths.push(scriptingSkillPath);
    }
    return skillPaths.length > 0 ? { skillPaths } : undefined;
  });

  pi.on("before_agent_start", holdLazyDirectTools);

  pi.on("input", async (_event, ctx) => {
    const inputContext = ctx ?? ({} as ExtensionContext);
    const session = latestSessionStart;
    const inputConfig = activeRuntimeState?.config ?? earlyConfig;
    const needsKeepAliveBarrier = Object.values(inputConfig.mcpServers).some(server => (
      server.lifecycle === "keep-alive" || server.lifecycle === "lazy-keep-alive"
    ));
    if (!session || directToolBootstrapDisabled || (
      directToolBootstrapGeneration !== session.generation && !needsKeepAliveBarrier
    )) {
      return { action: "continue" as const };
    }

    // This is a best-effort, one-shot gate. Retire it before awaiting so a
    // slow bootstrap cannot hold every later turn hostage. Input handlers
    // must never consume the user's text when the gate cannot complete.
    directToolBootstrapGeneration = null;

    let runtime: McpRuntime | null;
    try {
      // This is the pre-turn gate for a cold direct-tool cache. session_start
      // deliberately remains non-blocking, but the first user turn must not
      // race the bootstrap that supplies its model-facing tools.
      runtime = await ensureRuntimeStarted(session, inputContext.signal);
    } catch (error) {
      if (inputContext.signal?.aborted) return { action: "continue" as const };
      if (isSessionTransitionError(error, session)) {
        notifyInitializationPending(inputContext, true);
        return { action: "continue" as const };
      }
      notifyInitializationFailed(inputContext, error);
      return { action: "continue" as const };
    }

    if (latestSessionStart?.generation !== session.generation) {
      // A replacement session won while initialization was in flight. Never
      // let the old session's surface activate the new turn or consume input.
      notifyInitializationPending(inputContext, true);
      return { action: "continue" as const };
    }
    if (!runtime) {
      notifyInitializationPending(inputContext, true);
      return { action: "continue" as const };
    }

    const state = activeRuntimeState;
    const config = state?.config ?? earlyConfig;
    const hasKeepAliveBarrier = Object.values(config.mcpServers).some(server => (
      server.lifecycle === "keep-alive" || server.lifecycle === "lazy-keep-alive"
    ));
    if (hasKeepAliveBarrier && state && latestSessionStart?.generation === session.generation) {
      const inputSurfaceGeneration = surfaceGeneration;
      const inputSession = session;
      const inputOwner = state.owner;
      await state.lifecycle.ensureConverged(inputContext.signal);
      if (latestSessionStart?.generation === session.generation
        && activeRuntimeState === state
        && state.config.settings?.freezeDirectTools === false) {
        syncDirectTools(state, false, state.sessionCwd ?? inputContext.cwd ?? process.cwd(), undefined, {
          // ensureConverged may synchronously re-enter the host and start a
          // successor session from a registerTool callback. The applied
          // catalog commit must still belong to the input operation's
          // session, surface generation, and active runtime owner.
          canCommitAppliedDirectToolCatalogs: () => surfaceGeneration === inputSurfaceGeneration
            && latestSessionStart === inputSession
            && activeRuntimeState === state
            && !lifecycleClosed
            && (inputOwner?.isActive?.() ?? true),
        });
      }
    }
    return { action: "continue" as const };
  });

  pi.on("session_tree", (_event, ctx) => {
    const state = activeRuntimeState;
    if (!state || !state.sessionManager || ctx.sessionManager !== state.sessionManager) return;
    restoreSessionApprovalState(state, state.sessionManager.getBranch());
  });

  pi.on("session_start", async (event, ctx) => {
    sessionSignInController?.abort(new Error("MCP extension session restarted"));
    sessionSignInController = null;
    surfaceGeneration++;
    const sessionSurfaceGeneration = surfaceGeneration;
    lifecycleClosed = false;
    loadTimeToken++;
    retryGeneration = 0;
    retryPromise = null;
    if (!programmaticConfig && ctx.hasUI) {
      for (const notice of getLegacyMcpMigrationNotices(ctx.cwd, earlyConfigPath)) ctx.ui?.notify(notice, "warning");
    }
    activeRuntimeState = null;
    activeSurfaceContext = null;
    activeSurfaceHelpers = null;
    // A successor session must not inherit a frozen catalog snapshot from its
    // predecessor; its first full reconciliation establishes fresh ownership.
    appliedDirectToolCatalogs.clear();
    appliedSearchDirectToolServers.clear();
    coldSearchDiscoveryReservations.clear();
    const sessionConfig = programmaticConfig
      ? resolveConfiguredClaudePluginMcp(cloneMcpConfig(programmaticConfigSnapshot!), ctx.cwd ?? process.cwd())
      : excludeProjectServersAtLoadTime(loadMcpConfig(earlyConfigPath, ctx.cwd));
    // Keep model-facing surfaces filtered until trust resolves, but let the raw
    // non-programmatic config authorize runtime/trust startup for project servers.
    const sessionStartupConfig = programmaticConfig
      ? sessionConfig
      : loadMcpConfig(earlyConfigPath, ctx.cwd);
    const sessionCache = loadMetadataCache();
    const nativeSignInController = new AbortController();
    const session = {
      event,
      ctx,
      generation: ++nextSessionGeneration,
      nativeSignInReady: Promise.resolve(),
      nativeSignInSignal: nativeSignInController.signal,
    } satisfies SessionStart;
    latestSessionStart = session;
    sessionSignInController = nativeSignInController;
    session.nativeSignInReady = beginNativeSignInOffer(session, sessionConfig, nativeSignInController);
    sessionScriptMode = sessionConfig.settings?.scriptMode === true;
    sessionScriptConfig = sessionConfig;
    const activeBeforeSessionReset = getActiveToolsIfReady();
    observingSessionReset = true;
    if (activeBeforeSessionReset) observeActiveToolOwnership(activeBeforeSessionReset);
    observingSessionReset = false;
    searchActivatedTools.clear();
    const sessionDirectResult = syncDirectToolsFor(sessionConfig, sessionCache, ctx.cwd, false, undefined, {
      canCommitAppliedDirectToolCatalogs: () => surfaceGeneration === sessionSurfaceGeneration
        && latestSessionStart === session
        && !lifecycleClosed,
    });
    syncScriptToolFor(sessionScriptMode === true);
    refreshRegisteredProxyDescription(sessionConfig, sessionScriptMode === true, session, sessionSurfaceGeneration);
    syncPromptCommands(undefined, sessionConfig, ctx.cwd, sessionCache);
    largeDirectToolsAdvisoryDelivered = false;
    deliverLargeDirectToolsAdvisory(ctx, sessionConfig);
    if (surfaceGeneration !== sessionSurfaceGeneration || lifecycleClosed || latestSessionStart !== session) return;
    markAppliedSearchDirectToolServers(sessionConfig, sessionCache, ctx.cwd ?? process.cwd());
    if (sessionConfig.settings?.namespaceProxyTools !== true && registeredNamespaceTools.size > 0) {
      clearNamespaceProxyTools();
    }
    const sessionCwd = ctx.cwd ?? process.cwd();
    const sessionMissingConfiguredDirectToolServers = envDirectToolOverride === undefined
      ? getMissingConfiguredDirectToolServers(sessionConfig, sessionCache, undefined, sessionCwd)
      : getMissingConfiguredDirectToolServers(sessionConfig, sessionCache, envDirectToolOverride, sessionCwd);
    const deferMissingMetadata = sessionConfig.settings?.deferWithMissingMetadata === true;
    const startupMissingConfiguredDirectToolServers = deferMissingMetadata ? [] : sessionMissingConfiguredDirectToolServers;
    directToolBootstrapGeneration = !directToolBootstrapDisabled && startupMissingConfiguredDirectToolServers.length > 0
      ? latestSessionStart.generation
      : null;
    const uncachedSessionServer = !directToolBootstrapDisabled
      && !deferMissingMetadata
      && hasEnabledServerWithoutValidMetadata(
        sessionConfig,
        sessionCache,
        directSpecs,
        sessionCwd,
      );
    const hasRawProjectServers = !programmaticConfig && hasProjectServerDefinitions(sessionStartupConfig);
    const shouldInitialize = (hasRawProjectServers || (sessionCache === null && (
      Object.keys(sessionStartupConfig.mcpServers).length > 0
      || piRegistered.length > 0
      || directSpecs.length > 0
      || sessionStartupConfig.claudePlugins?.some(plugin => plugin.mcp === true) === true
    )))
      || uncachedSessionServer
      || (sessionDirectResult.added.length > 0 && sessionConfig.settings?.deferWithMissingMetadata !== true)
      || shouldInitializeRuntimeOnSessionStart(
        sessionStartupConfig,
        startupMissingConfiguredDirectToolServers,
        directToolBootstrapDisabled,
      );
    const hasActiveOrInflightRuntimeStart = startedGeneration > 0 || startupPromise !== null;

    if (!shouldInitialize && !hasActiveOrInflightRuntimeStart) {
      holdLazyDirectTools();
      publishDeferredFooter(ctx, sessionConfig, sessionCache);
      return;
    }

    try {
      await ensureRuntimeStarted(latestSessionStart, undefined, false);
    } catch (error) {
      if (isSessionTransitionError(error, latestSessionStart)) return;
      throw error;
    }
  });

  pi.on("session_shutdown", async () => {
    sessionSignInController?.abort(new Error("MCP extension session shutdown"));
    sessionSignInController = null;
    surfaceGeneration++;
    await Promise.resolve();
    lifecycleClosed = true;
    loadTimeToken++;
    retryGeneration = 0;
    retryPromise = null;
    activeRuntimeState = null;
    activeSurfaceContext = null;
    activeSurfaceHelpers = null;
    appliedDirectToolCatalogs.clear();
    appliedSearchDirectToolServers.clear();
    coldSearchDiscoveryReservations.clear();
    searchActivatedTools.clear();
    directToolBootstrapGeneration = null;
    const staleDirectNames = [...registeredDirectTools.keys()];
    deactivateTools(staleDirectNames);
    registeredDirectTools.clear();
    registeredDirectToolDefinitions.clear();
    lazyDirectTools.clear();
    clearPendingDirectToolNames();
    holdLazyDirectTools();
    clearNamespaceProxyTools();
    syncScriptToolFor(false);
    sessionScriptMode = undefined;
    sessionScriptConfig = undefined;
    if (!runtimePromise) {
      latestSessionStart = null;
      return;
    }

    const runtime = await runtimePromise;
    // Let a startup already released by this session reach the runtime before
    // fencing it. Do not await its promise: unresolved starts must not block a
    // successor session from taking ownership.
    await Promise.resolve();
    await runtime.handleSessionShutdown();
    latestSessionStart = null;
    startupPromise = null;
    startupGeneration = 0;
    startedGeneration = 0;
  });

  pi.on("tool_result", (event) => toolErrorOverride(event.details));

  const handleMcpCommand = async (args: string | undefined, ctx: ExtensionCommandContext) => {
    let runtime: McpRuntime | null;
    try {
      runtime = await ensureRuntimeStarted(latestSessionStart, ctx.signal, true, ctx as unknown as ExtensionContext, true);
    } catch (error) {
      throwIfAborted(ctx.signal);
      if (isSessionTransitionError(error, latestSessionStart)) return;
      if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    if (!runtime) {
      notifyInitializationPending(ctx);
      return;
    }
    await runtime.handleMcpCommand(args, ctx);
  };

  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trimStart();
      const match = normalized.match(/^(\S+)\s+(.*)$/);
      if (!match) {
        const values = ["reconnect", "tools", "prompts", "setup", "edit", "logout", "status"]
          .filter(value => value.startsWith(normalized))
          .map(value => ({ value, label: value }));
        return values.length > 0 ? values : null;
      }
      const subcommand = match[1] ?? "";
      if (!["reconnect", "logout", "disable", "enable"].includes(subcommand)) return null;
      const config = activeRuntimeState?.config ?? earlyConfig;
      const prefixValue = match[2]?.trimStart() ?? "";
      const values = Object.keys(config.mcpServers)
        .filter(name => name.startsWith(prefixValue))
        .map(name => ({ value: `${subcommand} ${name}`, label: name }));
      return values.length > 0 ? values : null;
    },
    handler: handleMcpCommand,
  });

  pi.registerCommand("mcp-adapter", {
    description: "Show MCP server status",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trimStart();
      const match = normalized.match(/^(\S+)\s+(.*)$/);
      const subcommands = [
        ["reconnect", "Reconnect to an MCP server"],
        ["tools", "List available tools"],
        ["prompts", "List available prompts"],
        ["setup", "Configure MCP servers"],
        ["edit", "Edit MCP configuration"],
        ["logout", "Log out of an MCP server"],
        ["token", "Manage bearer tokens"],
        ["disable", "Disable an MCP server"],
        ["enable", "Enable an MCP server"],
        ["status", "Show server status"],
      ] as const;
      if (!match) {
        const values = subcommands
          .filter(([value]) => value.startsWith(normalized))
          .map(([value, label]) => ({ value, label: `${value} — ${label}` }));
        return values.length > 0 ? values : null;
      }
      const subcommand = match[1] ?? "";
      if (!["reconnect", "logout", "disable", "enable"].includes(subcommand)) return null;
      const config = activeRuntimeState?.config ?? earlyConfig;
      const prefixValue = match[2]?.trimStart() ?? "";
      const values = Object.keys(config.mcpServers)
        .filter(name => name.startsWith(prefixValue))
        .map(name => ({ value: `${subcommand} ${name}`, label: name }));
      return values.length > 0 ? values : null;
    },
    handler: handleMcpCommand,
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const serverName = args?.trim();
      if (!serverName && !ctx.hasUI) return;

      let runtime: McpRuntime | null;
      try {
        runtime = await ensureRuntimeStarted(latestSessionStart, ctx.signal, true, ctx as unknown as ExtensionContext, true);
      } catch (error) {
        throwIfAborted(ctx.signal);
        if (isSessionTransitionError(error, latestSessionStart)) return;
        if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      if (!runtime) {
        notifyInitializationPending(ctx);
        return;
      }
      await runtime.handleMcpAuthCommand(args, ctx);
    },
  });

  // Reconcile the bounded startup surface once Pi's registration methods are
  // available. Later session metadata updates use the same path.
  syncProxyTool(earlyConfig, earlyCache, directSpecs, process.cwd(), missingConfiguredDirectToolServers);
  const initialNamespaceResult = syncNamespaceProxyTools({
    config: earlyConfig,
    cache: earlyCache,
    envOverride: namespaceEnvOverride,
    existingDirectNames: new Set([...registeredDirectTools.keys(), ...directSpecs.map(spec => spec.prefixedName)]),
    activeDirectNames: new Set(registeredDirectTools.keys()),
    existingNamespaceNames: registeredNamespaceTools,
    fallbackDeactivatedNames: adapterDeactivatedTools,
    defaultCwd: process.cwd(),
    pi,
    getState: () => activeRuntimeState,
    getInitPromise: () => null,
    ensureRuntime: async (ctx: unknown) => {
      await ensureRuntimeStarted(latestSessionStart, undefined, true, ctx as ExtensionContext, true);
      return activeRuntimeState;
    },
    getPiTools: () => pi.getAllTools(),
  });
  recordNamespaceSyncResult(initialNamespaceResult);

  startLoadTimeInitialization();
}

export function createMcpAdapter(options: McpAdapterOptions = {}) {
  const snapshot = options.config === undefined ? undefined : cloneMcpConfig(options.config);
  return (pi: ExtensionAPI) => installMcpAdapter(pi, {
    ...(snapshot !== undefined ? { config: snapshot } : {}),
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
  });
}

export default createMcpAdapter();

/**
 * Register a session/runtime-scoped MCP server with the adapter installed for
 * this Pi instance. Runtime registrations are proxy-only and never persisted.
 */
export function registerMcpServer(options: { pi: ExtensionAPI; name: string; definition: ServerEntry }): McpServerRegistration {
  const { pi, name, definition } = options;
  const register = runtimeRegistrars.get(pi);
  if (register) return register(name, definition);

  if (!pi.events) throw new Error("pi-mcp-adapter is not installed for this Pi instance");
  const request: McpRuntimeRegistrationRequest = {
    version: MCP_RUNTIME_REGISTER_VERSION,
    name,
    definition,
  };
  pi.events.emit(MCP_RUNTIME_REGISTER_EVENT, request);
  if (!request.result) throw new Error("pi-mcp-adapter is not installed for this Pi instance");
  if (!request.result.ok) throw request.result.error;
  return request.result.registration;
}

/** Return a detached snapshot of one active runtime-registered server. */
export function getRuntimeMcpServerSnapshot(options: { pi: ExtensionAPI; name: string }): McpRuntimeServerSnapshot {
  const { pi, name } = options;
  const getSnapshot = runtimeSnapshotters.get(pi);
  if (getSnapshot) return getSnapshot(name);

  if (!pi.events) throw new Error("pi-mcp-adapter is not installed for this Pi instance");
  const request: McpRuntimeSnapshotRequest = {
    version: MCP_RUNTIME_SNAPSHOT_VERSION,
    name,
  };
  pi.events.emit(MCP_RUNTIME_SNAPSHOT_EVENT, request);
  if (!request.result) throw new Error("pi-mcp-adapter is not installed for this Pi instance");
  if (!request.result.ok) throw request.result.error;
  return request.result.snapshot;
}
