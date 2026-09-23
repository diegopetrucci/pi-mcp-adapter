import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { discoverConfiguredClaudePluginSkills, loadMcpConfig } from "./config.ts";
import { throwIfAborted } from "./abort.ts";
import { toolErrorOverride } from "./error-signal.ts";
import { getMissingConfiguredDirectToolServers, loadMetadataCache } from "./metadata-cache.ts";
import type { McpExtensionState } from "./state.ts";
import {
  createPromptCommand,
  McpInitializationPendingError,
  MCP_INITIALIZATION_PENDING_MESSAGE,
  resolveCachedPrompts,
} from "./prompts.ts";
import type { PromptMetadata, ServerEntry } from "./types.ts";
import { isServerInActiveFailureBackoff } from "./failure-backoff.ts";
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
  createMcpDirectToolCallRenderer,
  getDirectToolParametersSchema,
  getLargeDirectToolsAdvisory,
  MCP_PROXY_TOOL_PARAMETERS_SCHEMA,
  renderMcpProxyToolCall,
  renderMcpToolResult,
  resolveDirectTools,
} from "./startup-mcp-facade.ts";
import { createMcpScriptToolCallRenderer } from "./tool-result-renderer.ts";
import { getConfigPathFromArgv, truncateAtWord } from "./utils.ts";

export interface McpServerRegistration {
  dispose(): Promise<void>;
}

export const MCP_RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1" as const;
export const MCP_RUNTIME_REGISTER_VERSION = 1 as const;

export const MCP_RUNTIME_SNAPSHOT_EVENT = "pi-mcp-adapter:runtime-snapshot:v1" as const;
export const MCP_RUNTIME_SNAPSHOT_VERSION = 1 as const;

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

export default function mcpAdapter(pi: ExtensionAPI) {
  const earlyConfigPath = getConfigPathFromArgv();
  const earlyConfig = loadMcpConfig(earlyConfigPath);
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
  const shouldRegisterProxyTool =
    earlyConfig.settings?.disableProxyTool !== true
    || directSpecs.length === 0
    || missingConfiguredDirectToolServers.length > 0
    || hasSearchDirectTools;

  let runtimePromise: Promise<McpRuntime> | null = null;
  let latestSessionStart: { event: unknown; ctx: ExtensionContext; generation: number } | null = null;
  let activeRuntimeState: McpExtensionState | null = null;
  let activeSurfaceContext: ExtensionContext | null = null;
  let activeSurfaceHelpers: McpRuntimeSurfaceHelpers | null = null;
  const runtimeServers = new Map<string, { definition: ServerEntry; entry: ServerEntry }>();
  const shadowedRuntimeServers = new Set<string>();
  const registeredDirectTools = new Map<string, { spec: typeof directSpecs[number]; fingerprint: string }>();
  // Pi owns the active-tool loadout. Track only removals performed by this
  // adapter so syncs never resurrect a user-deactivated tool.
  const adapterDeactivatedTools = new Set<string>();
  const userDeactivatedTools = new Set<string>();
  let lastObservedActiveTools: Set<string> | null = null;
  const lazyDirectTools = new Set<string>();
  const searchActivatedTools = new Set<string>();
  const registeredNamespaceTools = new Set<string>();
  let scriptToolRegistered = false;

  function directToolFingerprint(spec: typeof directSpecs[number]): string {
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
    });
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
    return registeredDirectTools.has(name) || registeredNamespaceTools.has(name) || name === "mcpScript";
  }

  function observeActiveToolOwnership(activeTools: readonly string[]): void {
    const activeSet = new Set(activeTools);
    if (lastObservedActiveTools) {
      for (const name of lastObservedActiveTools) {
        if (isAdapterManagedTool(name) && !activeSet.has(name) && !adapterDeactivatedTools.has(name)) {
          userDeactivatedTools.add(name);
        }
      }
    }
    for (const name of activeSet) userDeactivatedTools.delete(name);
    lastObservedActiveTools = activeSet;
  }

  function setActiveTools(next: string[]): void {
    pi.setActiveTools(next);
    lastObservedActiveTools = new Set(next);
  }

  function syncDirectToolActivity(): void {
    const activeTools = getActiveToolsIfReady();
    if (!activeTools) return;

    observeActiveToolOwnership(activeTools);
    const next = activeTools.filter(name => {
      if (!lazyDirectTools.has(name) || searchActivatedTools.has(name)) return true;
      adapterDeactivatedTools.add(name);
      return false;
    });
    for (const name of registeredDirectTools.keys()) {
      const shouldBeActive = !lazyDirectTools.has(name) || searchActivatedTools.has(name);
      if (!shouldBeActive || userDeactivatedTools.has(name)) continue;
      if (!next.includes(name) && adapterDeactivatedTools.has(name)) {
        next.push(name);
        adapterDeactivatedTools.delete(name);
      }
    }
    if (next.length !== activeTools.length || next.some((name, index) => name !== activeTools[index])) {
      setActiveTools(next);
    }
  }

  function holdLazyDirectTools(): void {
    syncDirectToolActivity();
  }

  function deactivateTools(names: readonly string[]): void {
    if (names.length === 0) return;
    const activeTools = getActiveToolsIfReady();
    if (!activeTools) return;
    observeActiveToolOwnership(activeTools);
    const stale = new Set(names);
    const removed = activeTools.filter(name => stale.has(name));
    for (const name of removed) adapterDeactivatedTools.add(name);
    const next = activeTools.filter(name => !stale.has(name));
    if (next.length !== activeTools.length) setActiveTools(next);
  }

  function activateSearchMatches(matches: ReadonlyArray<{ server: string; tool: string }>): void {
    const activeTools = getActiveToolsIfReady();
    if (!activeTools) return;
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
    if (additions.length === 0) return;
    for (const name of additions) adapterDeactivatedTools.delete(name);
    setActiveTools([...activeTools, ...additions]);
  }

  function syncDirectToolsFor(config: McpExtensionState["config"], cache: ReturnType<typeof loadMetadataCache>, defaultCwd?: string): void {
    if (envRaw === "__none__") {
      deactivateTools([...registeredDirectTools.keys()]);
      registeredDirectTools.clear();
      lazyDirectTools.clear();
      searchActivatedTools.clear();
      return;
    }
    const specs = resolveDirectTools(
      config,
      cache,
      config.settings?.toolPrefix ?? "server",
      envDirectToolOverride,
      defaultCwd,
    );
    const nextNames = new Set(specs.map(spec => spec.prefixedName));
    let existingNames = new Set<string>();
    try {
      existingNames = new Set(pi.getAllTools().map(tool => tool.name));
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("Action methods cannot be called during extension loading"))) throw error;
    }
    for (const spec of specs) {
      const fingerprint = directToolFingerprint(spec);
      const previous = registeredDirectTools.get(spec.prefixedName);
      if (!previous || previous.fingerprint !== fingerprint || !existingNames.has(spec.prefixedName)) {
        registerDirectTool(spec);
        existingNames.add(spec.prefixedName);
      }
      registeredDirectTools.set(spec.prefixedName, { spec, fingerprint });
      if (spec.lazy) {
        lazyDirectTools.add(spec.prefixedName);
      } else {
        lazyDirectTools.delete(spec.prefixedName);
        searchActivatedTools.delete(spec.prefixedName);
      }
    }
    const staleNames = [...registeredDirectTools.keys()].filter(name => !nextNames.has(name));
    for (const name of staleNames) {
      registeredDirectTools.delete(name);
      lazyDirectTools.delete(name);
      searchActivatedTools.delete(name);
    }
    deactivateTools(staleNames);
    holdLazyDirectTools();
  }

  function syncDirectTools(state: McpExtensionState): void {
    syncDirectToolsFor(state.config, loadMetadataCache(), state.sessionCwd);
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
      if (Object.hasOwn(state.config.mcpServers, name)) {
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

  function registerScriptTool(): void {
    if (scriptToolRegistered) return;
    (pi.registerTool as (tool: unknown) => unknown)({
      name: "mcpScript",
      label: "MCP Script",
      description: "Run trusted JavaScript for multiple MCP calls with loops, filtering, chaining, or fan-out. Use tools.search({ query }) to discover, tools.describe({ path }) to inspect, tools.call(path, args) or tools.<path>(args) to call, and emit(value) for output.",
      promptSnippet: "Batch multiple MCP tool calls in one JavaScript request (loop, filter, chain)",
      parameters: Type.Object({
        code: Type.String({ description: "Trusted JavaScript MCP script. Use tools and emit(value)." }),
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
          runtime = await ensureRuntimeStarted(latestSessionStart, signal);
        } catch (error) {
          throwIfAborted(signal);
          return initializationFailedResult(error, "script");
        }
        if (!runtime) return initializationPendingResult("script");
        return runtime.executeScript(params, signal, ctx);
      },
    });
    scriptToolRegistered = true;
  }

  function syncScriptToolFor(config: McpExtensionState["config"]): void {
    const enabled = config.settings?.scriptMode === true;
    if (enabled) registerScriptTool();

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
      adapterDeactivatedNames: adapterDeactivatedTools,
      userDeactivatedNames: userDeactivatedTools,
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
    options: { forceDirectTools?: boolean } = {},
  ): void {
    activeRuntimeState = state;
    activeSurfaceContext = ctx;
    activeSurfaceHelpers = helpers;
    applyRuntimeServers(state);
    syncScriptToolFor(state.config);
    syncPromptCommands(state, state.config, state.sessionCwd);
    const directToolsFrozen = state.config.settings?.freezeDirectTools !== false;
    if (initial || options.forceDirectTools === true || !directToolsFrozen) syncDirectTools(state);
    deliverLargeDirectToolsAdvisory(ctx, state.config);

    const unavailableServers = new Set(
      Object.keys(state.config.mcpServers).filter(name => isServerInActiveFailureBackoff(state, name)),
    );
    const result = syncNamespaceProxyTools({
      config: state.config,
      cache: loadMetadataCache(),
      envOverride: namespaceEnvOverride,
      existingDirectNames: new Set(registeredDirectTools.keys()),
      activeDirectNames: new Set(registeredDirectTools.keys()),
      existingNamespaceNames: registeredNamespaceTools,
      adapterDeactivatedNames: adapterDeactivatedTools,
      userDeactivatedNames: userDeactivatedTools,
      unavailableServers,
      ...(state.sessionCwd !== undefined ? { defaultCwd: state.sessionCwd } : {}),
      pi,
      getState: helpers.getState,
      getInitPromise: helpers.getInitPromise,
      ensureRuntime: (ctx: unknown) => helpers.ensureState(ctx as ExtensionContext),
      executeCall: helpers.executeCall,
      getPiTools: helpers.getPiTools,
    });
    recordNamespaceSyncResult(result);
    void ctx;
  }
  let nextSessionGeneration = 0;
  let directToolBootstrapGeneration: number | null = null;
  let startedGeneration = 0;
  let startupGeneration = 0;
  let startupPromise: Promise<void> | null = null;

  const loadRuntime = () => {
    if (!runtimePromise) {
      runtimePromise = import("./mcp-runtime.ts").then(({ createMcpRuntime }) => {
        const runtimeOptions: McpRuntimeOptions = {
          ...(earlyConfigPath === undefined ? {} : { earlyConfigPath }),
          toolSurface: {
            sync: syncToolSurface,
            activateSearchMatches,
          },
        };
        return createMcpRuntime(pi, runtimeOptions);
      });
    }
    return runtimePromise;
  };

  const ensureRuntimeStarted = async (
    session = latestSessionStart,
    signal?: AbortSignal,
    waitForReady = true,
  ): Promise<McpRuntime | null> => {
    if (waitForReady) throwIfAborted(signal);
    const runtime = await loadRuntime();
    if (!session) return runtime;
    if (startedGeneration < session.generation) {
      if (!startupPromise || startupGeneration !== session.generation) {
        startupGeneration = session.generation;
        const currentStartupPromise = runtime.handleSessionStart(session.event, session.ctx)
          .finally(() => {
            if (startupPromise === currentStartupPromise) {
              startupPromise = null;
            }
          });
        startupPromise = currentStartupPromise;
        // Session-start is intentionally fire-and-forget; attach an observer so
        // a failed background initialization never becomes an unhandled
        // rejection. On-demand callers still await the original promise.
        void currentStartupPromise.catch((error) => {
          console.error("MCP session initialization failed:", error);
        });
        // Mark the generation as started immediately. The full initialization
        // promise remains available to on-demand callers, while session_start
        // itself only schedules the work.
        startedGeneration = session.generation;
      }
    }
    if (!waitForReady) return runtime;

    // The runtime owns the single bounded wait. Waiting for the facade's
    // session-start promise here would create a second, cumulative timeout.
    const waitResult = await runtime.waitForInitialization?.(signal, INIT_WAIT_TIMEOUT_MS) ?? "ready";
    if (waitResult === "timeout") return null;
    if (latestSessionStart?.generation !== session.generation) return null;
    return runtime;
  };

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
            const runtime = await ensureRuntimeStarted(latestSessionStart, ctx.signal);
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
    registerPromptCommands(resolveCachedPrompts(config, defaultCwd, cache));
  }

  function deliverLargeDirectToolsAdvisory(
    ctx: ExtensionContext | undefined,
    config: McpExtensionState["config"],
  ): void {
    if (!ctx?.hasUI || largeDirectToolsAdvisoryDelivered) return;
    const message = getLargeDirectToolsAdvisory(
      config,
      [...registeredDirectTools.values()].map(({ spec }) => spec),
    );
    if (!message) return;
    largeDirectToolsAdvisoryDelivered = true;
    ctx.ui.notify(message, "warning");
  }

  function initializationPendingResult(mode?: string): Record<string, unknown> {
    return {
      content: [{ type: "text", text: MCP_INITIALIZATION_PENDING_MESSAGE }],
      details: { ...(mode ? { mode } : {}), error: "init_timeout", timeoutMs: INIT_WAIT_TIMEOUT_MS },
    };
  }

  function initializationFailedResult(error: unknown, mode?: string): Record<string, unknown> {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `MCP initialization failed: ${message}` }],
      details: { ...(mode ? { mode } : {}), error: "init_failed", message },
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

  function registerDirectTool(spec: typeof directSpecs[number]): void {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: spec.prefixedName,
      label: `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
      parameters: getDirectToolParametersSchema(spec),
      execute: async (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: ToolUpdate | undefined,
        ctx: ExtensionContext,
      ) => {
        let runtime: McpRuntime | null;
        try {
          runtime = await ensureRuntimeStarted(latestSessionStart, signal);
        } catch (error) {
          throwIfAborted(signal);
          return initializationFailedResult(error);
        }
        if (!runtime) return initializationPendingResult();
        return runtime.executeDirectTool(spec, toolCallId, params, signal, onUpdate, ctx);
      },
      renderCall: createMcpDirectToolCallRenderer(spec.prefixedName),
      renderResult: renderMcpToolResult,
    });
  }

  runtimeRegistrars.set(pi, registerRuntimeServer);
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
  }

  syncPromptCommands(undefined, earlyConfig, process.cwd(), earlyCache);

  for (const spec of directSpecs) {
    registerDirectTool(spec);
    registeredDirectTools.set(spec.prefixedName, { spec, fingerprint: directToolFingerprint(spec) });
    if (spec.lazy) lazyDirectTools.add(spec.prefixedName);
  }

  if (earlyConfig.settings?.scriptMode === true) registerScriptTool();

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  pi.on("resources_discover", (event) => {
    const sessionConfig = loadMcpConfig(earlyConfigPath, event.cwd);
    syncScriptToolFor(sessionConfig);
    const skillPaths = discoverConfiguredClaudePluginSkills(sessionConfig, event.cwd);
    if (sessionConfig.settings?.scriptMode === true) {
      const scriptingSkillPath = fileURLToPath(new URL("./skills/mcp-scripting/SKILL.md", import.meta.url));
      if (existsSync(scriptingSkillPath) && !skillPaths.includes(scriptingSkillPath)) skillPaths.push(scriptingSkillPath);
    }
    return skillPaths.length > 0 ? { skillPaths } : undefined;
  });

  pi.on("input", async (_event, ctx) => {
    const session = latestSessionStart;
    if (
      !session
      || directToolBootstrapGeneration !== session.generation
      || directToolBootstrapDisabled
    ) {
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
      runtime = await ensureRuntimeStarted(session, ctx.signal);
    } catch (error) {
      if (ctx.signal?.aborted) return { action: "continue" as const };
      notifyInitializationFailed(ctx, error);
      return { action: "continue" as const };
    }

    if (latestSessionStart?.generation !== session.generation) {
      // A replacement session won while initialization was in flight. Never
      // let the old session's surface activate the new turn or consume input.
      notifyInitializationPending(ctx, true);
      return { action: "continue" as const };
    }
    if (!runtime) {
      notifyInitializationPending(ctx, true);
      return { action: "continue" as const };
    }
    return { action: "continue" as const };
  });

  pi.on("session_start", async (event, ctx) => {
    activeRuntimeState = null;
    activeSurfaceContext = null;
    activeSurfaceHelpers = null;
    const sessionConfig = loadMcpConfig(earlyConfigPath, ctx.cwd);
    const sessionCache = loadMetadataCache();
    const activeBeforeSessionReset = getActiveToolsIfReady();
    if (activeBeforeSessionReset) observeActiveToolOwnership(activeBeforeSessionReset);
    searchActivatedTools.clear();
    syncDirectToolsFor(sessionConfig, sessionCache, ctx.cwd);
    syncScriptToolFor(sessionConfig);
    syncPromptCommands(undefined, sessionConfig, ctx.cwd, sessionCache);
    largeDirectToolsAdvisoryDelivered = false;
    deliverLargeDirectToolsAdvisory(ctx, sessionConfig);
    if (sessionConfig.settings?.namespaceProxyTools !== true && registeredNamespaceTools.size > 0) {
      clearNamespaceProxyTools();
    }
    latestSessionStart = {
      event,
      ctx,
      generation: ++nextSessionGeneration,
    };

    const sessionMissingConfiguredDirectToolServers = envDirectToolOverride === undefined
      ? getMissingConfiguredDirectToolServers(sessionConfig, sessionCache, undefined, ctx.cwd)
      : getMissingConfiguredDirectToolServers(sessionConfig, sessionCache, envDirectToolOverride, ctx.cwd);
    directToolBootstrapGeneration = !directToolBootstrapDisabled && sessionMissingConfiguredDirectToolServers.length > 0
      ? latestSessionStart.generation
      : null;
    // A missing cache is enough to initialize when configured servers may
    // contribute prompt metadata. Keep the truly empty configuration lazy so
    // a first session with no servers does not import the heavy runtime.
    const shouldInitialize = (sessionCache === null && Object.keys(sessionConfig.mcpServers).length > 0)
      || shouldInitializeRuntimeOnSessionStart(
        sessionConfig,
        sessionMissingConfiguredDirectToolServers,
        directToolBootstrapDisabled,
      );
    const hasActiveOrInflightRuntimeStart = startedGeneration > 0 || startupPromise !== null;

    if (!shouldInitialize && !hasActiveOrInflightRuntimeStart) {
      holdLazyDirectTools();
      return;
    }

    await ensureRuntimeStarted(latestSessionStart, undefined, false);
  });

  pi.on("session_shutdown", async () => {
    activeRuntimeState = null;
    activeSurfaceContext = null;
    activeSurfaceHelpers = null;
    searchActivatedTools.clear();
    directToolBootstrapGeneration = null;
    holdLazyDirectTools();
    clearNamespaceProxyTools();
    syncScriptToolFor({ mcpServers: {} });
    latestSessionStart = null;
    startupPromise = null;
    startupGeneration = 0;
    startedGeneration = 0;

    if (!runtimePromise) {
      return;
    }

    const runtime = await runtimePromise;
    await runtime.handleSessionShutdown();
  });

  pi.on("tool_result", (event) => toolErrorOverride(event.details));

  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args, ctx) => {
      let runtime: McpRuntime | null;
      try {
        runtime = await ensureRuntimeStarted(latestSessionStart, ctx.signal);
      } catch (error) {
        throwIfAborted(ctx.signal);
        if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      if (!runtime) {
        notifyInitializationPending(ctx);
        return;
      }
      await runtime.handleMcpCommand(args, ctx);
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const serverName = args?.trim();
      if (!serverName && !ctx.hasUI) return;

      let runtime: McpRuntime | null;
      try {
        runtime = await ensureRuntimeStarted(latestSessionStart, ctx.signal);
      } catch (error) {
        throwIfAborted(ctx.signal);
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

  if (shouldRegisterProxyTool) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: "mcp",
      label: "MCP",
      description: buildProxyDescription(earlyConfig, earlyCache, directSpecs),
      promptSnippet: "MCP gateway - connect to MCP servers and call their tools",
      renderCall: renderMcpProxyToolCall,
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
          runtime = await ensureRuntimeStarted(latestSessionStart, signal, true);
        } catch (error) {
          throwIfAborted(signal);
          return initializationFailedResult(error);
        }
        if (!runtime) return initializationPendingResult();
        return runtime.executeProxyTool(toolCallId, params, signal, onUpdate, ctx);
      },
    });
  }
}

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
