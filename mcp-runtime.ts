import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { getLegacyMcpMigrationNotices, writeProjectServerDisabledOverride } from "./config.ts";
import type { DirectToolSpec, McpAdapterOptions, McpConfig } from "./types.ts";
import {
  showStatus,
  showTools,
  showPrompts,
  reconnectServer,
  reconnectServers,
  authenticateServer,
  logoutServer,
  openMcpAuthPanel,
  openMcpPanel,
  openMcpSetup,
  setupJevSemanticSearch,
  editSharedConfig,
} from "./commands.ts";
import { flushMetadataCache, initializeMcp, updateStatusBar } from "./init.ts";
import {
  executeAuthComplete,
  executeAuthStart,
  executeCall,
  executeConnect,
  executeDescribe,
  executeList,
  executeSearch,
  executeStatus,
  executeUiMessages,
} from "./proxy-modes.ts";
import { createOAuthRuntime, initializeOAuth, shutdownOAuth, type McpOAuthRuntime } from "./mcp-auth-flow.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { createMcpRuntimeOwner, type McpRuntimeOwner } from "./runtime-owner.ts";
import { publishMcpStatusShutdown } from "./mcp-status.ts";

type DirectToolsModule = typeof import("./direct-tools.ts");
let directToolsModule: DirectToolsModule | null = null;
let directToolsModulePromise: Promise<DirectToolsModule> | null = null;

function preloadDirectTools(): Promise<DirectToolsModule> {
  if (directToolsModule) return Promise.resolve(directToolsModule);
  directToolsModulePromise ??= import("./direct-tools.ts").then(module => {
    directToolsModule = module;
    return module;
  }, error => {
    directToolsModulePromise = null;
    throw error;
  });
  return directToolsModulePromise;
}

const directToolsReadyAtModuleLoad = preloadDirectTools();

function parseProxyArgs(value: string | Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const gotType = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
    throw new Error(`Invalid args: expected a JSON object, got ${gotType}`);
  }
  return parsed as Record<string, unknown>;
}

export interface McpRuntimeSurfaceHelpers {
  getState: () => McpExtensionState | null;
  getInitPromise: () => Promise<McpExtensionState> | null;
  ensureState: (ctx: ExtensionContext) => Promise<McpExtensionState | null>;
  getPiTools: () => ToolInfo[];
  getDirectToolNames?: () => readonly string[];
  updateStatusBar: (state: McpExtensionState) => void;
  executeCall: (
    state: McpExtensionState,
    toolName: string,
    args: Record<string, unknown> | undefined,
    serverName: string | undefined,
    getPiTools: () => ToolInfo[],
    signal: AbortSignal | undefined,
    origin?: "proxy" | "script",
    internalDelivery?: { onSuccess: (data: unknown) => void },
    toolCallId?: string,
  ) => Promise<AgentToolResult<Record<string, unknown>>>;
}

export interface McpRuntimeSurface {
  sync(
    state: McpExtensionState,
    ctx: ExtensionContext,
    initial: boolean,
    helpers: McpRuntimeSurfaceHelpers,
    options?: {
      forceDirectTools?: boolean;
      /** Persisted panel changes identify the servers whose frozen surface may refresh. */
      forceDirectToolServers?: ReadonlySet<string>;
      /** A cold search discovery is scoped to the notifying server. */
      discoverDirectToolServers?: ReadonlySet<string>;
      reportDirectToolAdditions?: boolean;
      scriptMode?: boolean;
      attribution?: object;
    },
  ): void | Promise<void>;
  activateSearchMatches(matches: ReadonlyArray<{ server: string; tool: string }>): string[];
  getDirectToolNames?(): readonly string[];
  beginDirectToolAttribution?(serverName: string): object;
  consumeDirectToolNames?(serverName: string, attribution?: object): string[];
  discardDirectToolAttribution?(attribution: object): void;
}

export interface McpRuntimeOptions extends McpAdapterOptions {
  earlyConfigPath?: string;
  startupConfig?: McpConfig;
  toolSurface?: McpRuntimeSurface;
}

type McpRuntimeToolCallResult =
  | { ok: true; result: AgentToolResult<Record<string, unknown>> }
  | { ok: false; error: Error };

export interface McpRuntime {
  handleSessionStart(event: unknown, ctx: ExtensionContext, options?: {
    excludeProjectServers?: boolean;
    waitForProjectTrust?: boolean;
    scriptMode?: boolean;
  }): Promise<void>;
  /** Expedite only the current session start when an explicit first-use request races teardown. */
  expediteSessionStart?(): boolean;
  /** Wait for initialization without blocking session_start itself. */
  waitForInitialization?(signal?: AbortSignal, timeoutMs?: number): Promise<"ready" | "timeout">;
  handleSessionShutdown(): Promise<void>;
  handleMcpCommand(args: string | undefined, ctx: ExtensionCommandContext): Promise<void>;
  handleMcpAuthCommand(args: string | undefined, ctx: ExtensionCommandContext): Promise<void>;
  executeRuntimeToolCall(
    tool: string,
    args: Record<string, unknown> | undefined,
    server: string | undefined,
  ): Promise<McpRuntimeToolCallResult>;
  executeProxyTool(
    toolCallId: string,
    params: {
      tool?: string;
      args?: string | Record<string, unknown>;
      connect?: string;
      describe?: string;
      search?: string;
      searchMode?: "lexical" | "semantic";
      regex?: boolean;
      includeSchemas?: boolean;
      limit?: number;
      offset?: number;
      server?: string;
      action?: string;
    },
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>,
    ctx?: ExtensionContext,
  ): Promise<AgentToolResult<Record<string, unknown>>>;
  executeDirectTool(
    spec: DirectToolSpec,
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>,
    ctx?: ExtensionContext,
  ): Promise<AgentToolResult<Record<string, unknown>>>;
  executeScript(
    params: { code: string; timeoutMs?: number },
    signal?: AbortSignal,
    ctx?: ExtensionContext,
  ): Promise<unknown>;
}

export function createMcpRuntime(
  pi: ExtensionAPI,
  options: McpRuntimeOptions = {},
): McpRuntime {
  const { earlyConfigPath, toolSurface, config, startupConfig } = options;
  // Begin loading the execution-only graph without making runtime startup wait
  // for it. Direct calls can use the resolved module synchronously, while a
  // session shutdown still fences a delayed import before execution.
  const directToolsReady = directToolsReadyAtModuleLoad;
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;
  let initializationReady: Promise<void> | null = null;
  let sessionStartReady: Promise<void> | null = null;
  let resolveSessionStartReady: (() => void) | null = null;
  let initializationError: unknown = null;
  let lifecycleGeneration = 0;
  let oauthRuntime: McpOAuthRuntime | null = null;
  let oauthController: AbortController | null = null;
  let runtimeOwner: McpRuntimeOwner | null = null;
  let sessionContext: ExtensionContext | null = null;
  let resolveTrustReady: (() => void) | null = null;
  let shutdownStatusState: McpExtensionState | null = null;
  let pendingCleanup: Promise<void> | null = null;
  let pendingSessionStart: { generation: number; expedite: () => boolean } | null = null;
  let activeScriptMode = startupConfig?.settings?.scriptMode === true;
  const oauthShutdowns = new WeakMap<McpOAuthRuntime, Promise<void>>();
  const connectAttributionsByServer = new Map<string, Set<object>>();
  const connectAttributionContext = new AsyncLocalStorage<{ serverName: string; attribution: object }>();
  const DEFAULT_INITIALIZATION_WAIT_TIMEOUT_MS = 30_000;

  function beginConnectAttribution(serverName: string): object | undefined {
    const attribution = toolSurface?.beginDirectToolAttribution?.(serverName);
    if (!attribution) return undefined;
    const operations = connectAttributionsByServer.get(serverName) ?? new Set<object>();
    operations.add(attribution);
    connectAttributionsByServer.set(serverName, operations);
    return attribution;
  }

  function firstConnectAttribution(serverName: string, reason: string): object | undefined {
    if (reason !== "proxy-connect") return undefined;
    const owned = connectAttributionContext.getStore();
    return owned && owned.serverName === serverName && connectAttributionsByServer.get(serverName)?.has(owned.attribution)
      ? owned.attribution
      : undefined;
  }

  function discardConnectAttribution(serverName: string, attribution: object | undefined): void {
    if (!attribution) return;
    const operations = connectAttributionsByServer.get(serverName);
    operations?.delete(attribution);
    if (operations?.size === 0) connectAttributionsByServer.delete(serverName);
    toolSurface?.discardDirectToolAttribution?.(attribution);
  }

  function discardAllConnectAttributions(): void {
    for (const [serverName, operations] of connectAttributionsByServer) {
      for (const attribution of operations) {
        toolSurface?.discardDirectToolAttribution?.(attribution);
      }
      void serverName;
    }
    connectAttributionsByServer.clear();
  }

  function beginCleanup(cleanup: readonly Promise<void>[], message: string): Promise<void> | null {
    if (cleanup.length === 0) return pendingCleanup;
    const currentCleanup = Promise.all(cleanup).then(
      () => undefined,
      error => {
        console.error(message, error);
      },
    );
    const combined = pendingCleanup
      ? Promise.all([pendingCleanup, currentCleanup]).then(() => undefined)
      : currentCleanup;
    pendingCleanup = combined;
    void combined.then(() => {
      if (pendingCleanup === combined) pendingCleanup = null;
    });
    return combined;
  }

  function publishShutdownStatus(currentState: McpExtensionState | null): void {
    if (currentState && shutdownStatusState === currentState) return;
    if (currentState) shutdownStatusState = currentState;
    publishMcpStatusShutdown(currentState?.statusEvents ?? pi.events);
  }

  async function shutdownOAuthRuntime(currentRuntime: McpOAuthRuntime | null, controller: AbortController | null): Promise<void> {
    if (!currentRuntime) return;
    const existing = oauthShutdowns.get(currentRuntime);
    if (existing) {
      await existing;
      return;
    }
    controller?.abort(new Error("MCP OAuth runtime stopped"));
    const shutdown = Promise.resolve().then(() => shutdownOAuth(currentRuntime));
    oauthShutdowns.set(currentRuntime, shutdown);
    await shutdown;
  }

  /**
   * Stop one state/owner pair exactly once. initializeMcp installs the
   * lifecycle cleanup on its owner, so calling gracefulShutdown separately for
   * an owned state would run server teardown twice.
   */
  async function shutdownState(
    currentState: McpExtensionState | null,
    reason: string,
    owner: McpRuntimeOwner | null = currentState?.owner ?? null,
  ): Promise<void> {
    if (currentState?.uiServer) {
      currentState.uiServer.close(reason);
      currentState.uiServer = null;
    }

    let flushError: unknown;
    if (currentState) {
      try {
        flushMetadataCache(currentState);
      } catch (error) {
        flushError = error;
      }
    }

    try {
      if (currentState?.owner && currentState.owner === owner) {
        await owner.stop(reason);
      } else if (currentState) {
        // Unit-test/fallback states may not carry the owner installed by init.
        await currentState.lifecycle.gracefulShutdown();
        if (owner && owner !== currentState.owner) await owner.stop(reason);
      } else {
        await owner?.stop(reason);
      }
    } catch (error) {
      if (flushError) {
        console.error("MCP: graceful shutdown failed after metadata flush error", error);
      } else {
        throw error;
      }
    }

    if (flushError) throw flushError;
  }

  function staleSessionError(reason = "MCP extension session restarted"): Error {
    return new Error(reason);
  }

  function assertRuntimeCurrent(expectedState: McpExtensionState, generation: number, owner: McpRuntimeOwner | null): void {
    owner?.throwIfInactive();
    if (state !== expectedState || lifecycleGeneration !== generation || runtimeOwner !== owner) {
      throw staleSessionError();
    }
  }

  async function waitForInitialization(
    signal?: AbortSignal,
    timeoutMs = DEFAULT_INITIALIZATION_WAIT_TIMEOUT_MS,
  ): Promise<"ready" | "timeout"> {
    const ready = initializationReady ?? sessionStartReady;
    if (!ready) return "ready";

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timed = timeoutMs === Number.POSITIVE_INFINITY
      ? ready.then(() => "ready" as const)
      : Promise.race<"ready" | "timeout">([
          ready.then(() => "ready" as const),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), timeoutMs);
            timer.unref?.();
          }),
        ]);
    try {
      const result = await abortable(timed, signal);
      if (result === "ready" && initializationError !== null) throw initializationError;
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function ensureState(ctx: ExtensionContext): Promise<McpExtensionState | null> {
    runtimeOwner?.throwIfInactive();
    if (!state && (initPromise || initializationError !== null)) {
      try {
        const waitResult = await waitForInitialization(
          ctx.signal,
          DEFAULT_INITIALIZATION_WAIT_TIMEOUT_MS,
        );
        if (waitResult === "timeout") {
          if (ctx.hasUI) ctx.ui.notify("MCP initialization is still in progress. Try again shortly.", "info");
          return null;
        }
      } catch (error) {
        throwIfAborted(ctx.signal);
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
        return null;
      }
    }

    if (!state) {
      if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
      return null;
    }

    return state;
  }

  const surfaceHelpers = (): McpRuntimeSurfaceHelpers => ({
    getState: () => state,
    getInitPromise: () => initPromise,
    ensureState,
    getPiTools: () => pi.getAllTools(),
    getDirectToolNames: () => toolSurface?.getDirectToolNames?.() ?? [],
    updateStatusBar,
    executeCall: async (currentState, toolName, args, serverName, getPiTools, signal, origin, internalDelivery, toolCallId) => (
      executeCall(currentState, toolName, args, serverName, getPiTools, signal, origin, internalDelivery, toolCallId)
    ),
  });

  function isCurrentState(currentState: McpExtensionState, generation: number): boolean {
    return state === currentState && lifecycleGeneration === generation;
  }

  async function applyDirectToolsConfigChanges(
    currentState: McpExtensionState,
    generation: number,
    ctx: ExtensionContext,
    changes: Map<string, true | string[] | false>,
  ): Promise<void> {
    // Panel persistence happens before this callback. Re-check the runtime
    // identity so a panel from a replaced session cannot mutate its successor.
    if (!isCurrentState(currentState, generation)) return;
    const affectedServers = new Set<string>();
    for (const [serverName, directTools] of changes) {
      const definition = currentState.config.mcpServers[serverName];
      if (!definition) continue;
      definition.directTools = directTools;
      affectedServers.add(serverName);
    }
    // The panel already filters this map to persisted provenance. An empty
    // result (including runtime-only or otherwise unknown entries) is not a
    // refresh request and must not bypass the passive freeze.
    if (affectedServers.size === 0) return;
    if (!isCurrentState(currentState, generation) || !toolSurface) return;
    // This is an explicit user-requested refresh, so it must bypass the
    // passive freeze only for the persisted servers that changed. Unfrozen
    // surfaces retain their existing whole-surface reconciliation behavior.
    await toolSurface.sync(currentState, ctx, false, surfaceHelpers(), {
      forceDirectTools: true,
      forceDirectToolServers: affectedServers,
      scriptMode: activeScriptMode,
    });
  }

  return {
    async handleSessionStart(_event, ctx, sessionOptions = {}) {
      discardAllConnectAttributions();
      // A newer session owns the lifecycle immediately. Release an older
      // start that is still waiting for the same predecessor cleanup; its
      // generation check below will prevent it from publishing anything.
      pendingSessionStart?.expedite();
      pendingSessionStart = null;
      const generation = ++lifecycleGeneration;
      const scriptMode = sessionOptions.scriptMode ?? (startupConfig?.settings?.scriptMode === true);
      activeScriptMode = scriptMode;
      sessionContext = ctx;
      resolveTrustReady?.();
      resolveTrustReady = null;
      resolveSessionStartReady?.();
      resolveSessionStartReady = null;
      let resolveThisSessionStart!: () => void;
      const startReady = new Promise<void>((resolve) => {
        resolveThisSessionStart = resolve;
      });
      let trustResolved = false;
      let resolveThisTrust!: () => void;
      const trustReady = new Promise<void>((resolve) => {
        resolveThisTrust = () => {
          if (trustResolved) return;
          trustResolved = true;
          if (resolveTrustReady === resolveThisTrust) resolveTrustReady = null;
          resolve();
        };
      });
      resolveTrustReady = resolveThisTrust;
      resolveSessionStartReady = resolveThisSessionStart;
      sessionStartReady = startReady;
      const previousState = state;
      const previousOwner = runtimeOwner;
      const previousOAuthRuntime = oauthRuntime;
      if (previousState) publishShutdownStatus(previousState);
      const previousOAuthController = oauthController;
      state = null;
      runtimeOwner = null;
      oauthRuntime = null;
      oauthController = null;
      initPromise = null;
      initializationReady = null;
      initializationError = null;

      const cleanup = [
        previousState
          ? shutdownState(previousState, "MCP extension session restarted", previousOwner)
          : previousOwner?.stop("MCP extension session restarted"),
        ...(previousOAuthRuntime ? [shutdownOAuthRuntime(previousOAuthRuntime, previousOAuthController)] : []),
      ].filter((entry): entry is Promise<void> => entry !== undefined);
      const cleanupToAwait = beginCleanup(cleanup, "MCP: failed to shut down previous session state");
      if (cleanupToAwait) {
        let cleanupReleasedState = false;
        let releaseCleanupWait!: () => void;
        const cleanupReleased = new Promise<void>(resolve => {
          releaseCleanupWait = () => {
            if (cleanupReleasedState) return;
            cleanupReleasedState = true;
            resolve();
          };
        });
        const cleanupWait = {
          generation,
          expedite: () => {
            if (cleanupReleasedState) return false;
            releaseCleanupWait();
            return true;
          },
        };
        pendingSessionStart = cleanupWait;
        try {
          // Normal session starts preserve teardown-before-startup. The facade
          // may release this gate only for an explicit first-use request that
          // would otherwise wait behind cleanup.
          await Promise.race([cleanupToAwait, cleanupReleased]);
        } finally {
          if (pendingSessionStart === cleanupWait) pendingSessionStart = null;
        }
      }

      if (generation !== lifecycleGeneration) {
        resolveThisTrust();
        resolveThisSessionStart();
        return;
      }

      const currentOwner = createMcpRuntimeOwner();
      runtimeOwner = currentOwner;
      const currentOAuthController = new AbortController();
      const currentOAuthRuntime = createOAuthRuntime(currentOAuthController.signal);
      oauthController = currentOAuthController;
      oauthRuntime = currentOAuthRuntime;
      void Promise.resolve(initializeOAuth(currentOAuthRuntime)).catch(err => {
        console.error("MCP OAuth initialization failed:", err);
      });

      let initialization: Promise<McpExtensionState> | McpExtensionState | undefined;
      try {
        initialization = initializeMcp(pi, ctx, currentOwner, {
          ...(earlyConfigPath !== undefined ? { configPath: earlyConfigPath } : {}),
          ...(config !== undefined ? { config } : {}),
          oauthRuntime: currentOAuthRuntime,
          ...(sessionOptions.excludeProjectServers ? { excludeProjectServers: true } : {}),
          onProjectTrustResolved: resolveThisTrust,
        });
      } catch (error) {
        initialization = Promise.reject(error);
      }
      const promise: Promise<McpExtensionState> = Promise.resolve(initialization);
      initPromise = promise;

      const finalized = promise.then(async (nextState) => {
        if (generation !== lifecycleGeneration || initPromise !== promise) {
          try {
            await Promise.all([
              shutdownState(nextState, "stale_session_start", currentOwner),
              shutdownOAuthRuntime(currentOAuthRuntime, currentOAuthController),
            ]);
          } catch (error) {
            console.error("MCP: failed to clean stale session state", error);
          }
          return;
        }

        if (!nextState) throw new Error("MCP initialization returned no state");
        state = nextState;
        nextState.statusEvents ??= pi.events;
        if (config === undefined) {
          nextState.migrationNotices = getLegacyMcpMigrationNotices(ctx.cwd, earlyConfigPath);
        }
        nextState.scriptTool = scriptMode;
        const previousMetadataHook = nextState.onToolMetadataUpdated;
        try {
          nextState.onToolMetadataUpdated = async (serverName, reason) => {
            if (previousMetadataHook) await previousMetadataHook(serverName, reason);
            if (generation !== lifecycleGeneration || state !== nextState || !toolSurface) return;
            const attribution = firstConnectAttribution(serverName, reason);
            await toolSurface.sync(nextState, ctx, false, surfaceHelpers(), {
              discoverDirectToolServers: new Set([serverName]),
              ...(attribution ? { reportDirectToolAdditions: true, attribution } : {}),
              scriptMode,
            });
            if (generation === lifecycleGeneration && state === nextState) updateStatusBar(nextState);
          };
          if (toolSurface) await toolSurface.sync(nextState, ctx, true, surfaceHelpers(), { scriptMode });
          if (generation !== lifecycleGeneration || state !== nextState || runtimeOwner !== currentOwner) {
            if (runtimeOwner === currentOwner) {
              await shutdownState(nextState, "stale_session_start", currentOwner);
              await shutdownOAuthRuntime(currentOAuthRuntime, currentOAuthController);
            }
            return;
          }
          updateStatusBar(nextState);
          if (generation !== lifecycleGeneration || state !== nextState || runtimeOwner !== currentOwner) {
            if (runtimeOwner === currentOwner) {
              await shutdownState(nextState, "stale_session_start", currentOwner);
              await shutdownOAuthRuntime(currentOAuthRuntime, currentOAuthController);
            }
            return;
          }
          initPromise = null;
        } catch (error) {
          if (state === nextState) state = null;
          if (generation === lifecycleGeneration && runtimeOwner === currentOwner) {
            try {
              await shutdownState(nextState, "MCP initialization finalization failed", currentOwner);
              await shutdownOAuthRuntime(currentOAuthRuntime, currentOAuthController);
            } catch (cleanupError) {
              console.error("MCP: failed to clean failed initialization finalization", cleanupError);
            }
          }
          throw error;
        }
      });
      initializationReady = finalized.then(
        () => undefined,
        (error) => {
          if (generation === lifecycleGeneration && initPromise === promise) {
            initializationError = error;
            console.error(`MCP initialization failed: ${error instanceof Error ? error.message : String(error)}`);
            initPromise = null;
            void Promise.all([
              currentOwner.stop("MCP initialization failed"),
              shutdownOAuthRuntime(currentOAuthRuntime, currentOAuthController),
            ]).catch(cleanupError => {
              console.error("MCP: failed to clean rejected initialization", cleanupError);
            });
          }
          // Keep the original failure attached to the readiness promise. A
          // request that began before shutdown must observe that failure rather
          // than the owner's later stale-session abort reason.
          throw error;
        },
      );
      if (sessionOptions.waitForProjectTrust) {
        await Promise.race([
          trustReady,
          promise.then(() => undefined, () => undefined),
        ]);
      }
      void initializationReady.then(
        () => {
          if (sessionStartReady === startReady) {
            resolveThisSessionStart();
            if (resolveSessionStartReady === resolveThisSessionStart) resolveSessionStartReady = null;
          }
        },
        () => {
          if (sessionStartReady === startReady) {
            resolveThisSessionStart();
            if (resolveSessionStartReady === resolveThisSessionStart) resolveSessionStartReady = null;
          }
        },
      );
    },

    expediteSessionStart(): boolean {
      const pending = pendingSessionStart;
      if (
        pending === null
        || pending.generation !== lifecycleGeneration
        || state !== null
        || runtimeOwner !== null
      ) return false;
      return pending.expedite();
    },

    async waitForInitialization(signal, timeoutMs = DEFAULT_INITIALIZATION_WAIT_TIMEOUT_MS): Promise<"ready" | "timeout"> {
      return waitForInitialization(signal, timeoutMs);
    },

    async handleSessionShutdown() {
      discardAllConnectAttributions();
      pendingSessionStart?.expedite();
      pendingSessionStart = null;
      ++lifecycleGeneration;
      const currentState = state;
      const currentOwner = runtimeOwner;
      const currentOAuthRuntime = oauthRuntime;
      const currentOAuthController = oauthController;
      publishShutdownStatus(currentState);
      state = null;
      sessionContext = null;
      runtimeOwner = null;
      oauthRuntime = null;
      oauthController = null;
      initPromise = null;
      // Keep the previous readiness promise observable until a successor
      // session starts. Requests that raced shutdown must receive the
      // original initialization failure rather than an artificial stale
      // result caused by clearing this reference first.
      resolveSessionStartReady?.();
      resolveSessionStartReady = null;
      sessionStartReady = null;
      resolveTrustReady?.();
      resolveTrustReady = null;
      const cleanup = [
        shutdownState(currentState, "session_shutdown", currentOwner),
        ...(currentOAuthRuntime ? [shutdownOAuthRuntime(currentOAuthRuntime, currentOAuthController)] : []),
      ];
      const cleanupToAwait = beginCleanup(cleanup, "MCP: session shutdown cleanup failed");
      if (cleanupToAwait) await cleanupToAwait;
    },

    async handleMcpCommand(args, ctx) {
      const commandCtx = ctx.signal
        ? ctx
        : { ...ctx, signal: runtimeOwner?.signal ?? new AbortController().signal } as ExtensionCommandContext;
      const currentState = await ensureState(commandCtx);
      if (!currentState) return;

      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];
      const rest = parts.slice(1).join(" ");

      switch (subcommand) {
        case "reconnect":
          await reconnectServers(currentState, commandCtx, targetServer);
          break;
        case "tools":
          await showTools(currentState, commandCtx);
          break;
        case "prompts":
          await showPrompts(currentState, commandCtx);
          break;
        case "setup": {
          if (config !== undefined) {
            if (commandCtx.hasUI) commandCtx.ui.notify("MCP setup is unavailable in-memory when config is supplied by createMcpAdapter().", "info");
            return;
          }
          const result = await openMcpSetup(currentState, pi, commandCtx, earlyConfigPath, "setup");
          if (result?.configChanged) {
            await commandCtx.reload();
            return;
          }
          break;
        }
        case "jev": {
          if (parts[1] !== "setup" || parts.length !== 2) {
            if (commandCtx.hasUI) commandCtx.ui.notify("Usage: /mcp-adapter jev setup", "error");
            return;
          }
          if (config !== undefined) {
            if (commandCtx.hasUI) commandCtx.ui.notify("Jev setup is unavailable when config is supplied by createMcpAdapter().", "info");
            return;
          }
          const changed = await setupJevSemanticSearch(currentState, commandCtx, earlyConfigPath);
          if (changed) {
            await commandCtx.reload();
            return;
          }
          break;
        }
        case "edit": {
          if (parts.length > 2 || (targetServer !== undefined && targetServer !== "project" && targetServer !== "global")) {
            if (ctx.hasUI) ctx.ui.notify("Usage: /mcp edit [project|global]", "error");
            return;
          }
          if (currentState.programmaticConfig) {
            if (ctx.hasUI) ctx.ui.notify("MCP edit is unavailable when config is supplied by createMcpAdapter().", "info");
            return;
          }
          const changed = await editSharedConfig(commandCtx, (targetServer as "project" | "global" | undefined) ?? "project");
          if (changed) {
            await commandCtx.reload();
            return;
          }
          break;
        }
        case "disable":
        case "enable": {
          const serverName = targetServer;
          if (config !== undefined) {
            if (ctx.hasUI) ctx.ui.notify("MCP server overrides are unavailable in-memory when config is supplied by createMcpAdapter().", "info");
            return;
          }
          if (!serverName) {
            if (ctx.hasUI) ctx.ui.notify(`Usage: /mcp-adapter ${subcommand} <server>`, "error");
            return;
          }
          if (!Object.hasOwn(currentState.config.mcpServers, serverName)) {
            if (ctx.hasUI) ctx.ui.notify(`Server "${serverName}" not found in effective config`, "error");
            return;
          }
          const override = writeProjectServerDisabledOverride(earlyConfigPath, ctx.cwd, serverName, subcommand === "disable");
          if (override.changed) await ctx.reload?.();
          return;
        }
        case "logout": {
          const serverName = rest;
          if (!serverName) {
            if (ctx.hasUI) ctx.ui.notify("Usage: /mcp-adapter logout <server>", "error");
            return;
          }
          await logoutServer(serverName, currentState, commandCtx);
          break;
        }
        case "status":
        case "":
        default:
          if (config !== undefined) {
            await showStatus(currentState, commandCtx);
          } else if (commandCtx.hasUI) {
            const panelGeneration = lifecycleGeneration;
            const result = await openMcpPanel(
              currentState,
              pi,
              commandCtx,
              earlyConfigPath,
              (changes) => applyDirectToolsConfigChanges(currentState, panelGeneration, commandCtx, changes),
            );
            if (result?.configChanged) {
              await commandCtx.reload();
              return;
            }
          } else {
            await showStatus(currentState, commandCtx);
          }
          break;
      }
    },

    async handleMcpAuthCommand(args, ctx) {
      const serverName = args?.trim();
      if (!serverName && !ctx.hasUI) {
        return;
      }

      const currentState = await ensureState(ctx);
      if (!currentState) return;

      if (!serverName) {
        if (config !== undefined) {
          if (ctx.hasUI) ctx.ui.notify("MCP authentication picker is unavailable in-memory when config is supplied by createMcpAdapter().", "info");
          return;
        }
        await openMcpAuthPanel(currentState, pi, ctx, earlyConfigPath);
        return;
      }

      const signal = ctx.signal ?? runtimeOwner?.signal ?? new AbortController().signal;
      const authContext = { ...ctx, signal } as ExtensionCommandContext;
      const result = await authenticateServer(serverName, currentState.config, authContext, signal, currentState.oauthRuntime ?? { signal });
      if (result?.ok) await reconnectServer(currentState, authContext, serverName);
    },

    async executeRuntimeToolCall(tool, args, server) {
      const currentState = state;
      if (!sessionContext || (!currentState && !initPromise)) {
        return { ok: false, error: new Error("MCP runtime tool calls require an active Pi session") };
      }
      let callState = currentState;
      if (!callState) {
        try {
          callState = await ensureState(sessionContext);
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
        }
      }
      if (!callState) return { ok: false, error: new Error("MCP is not initialized") };
      const generation = lifecycleGeneration;
      const owner = runtimeOwner;
      try {
        const result = await executeCall(callState, tool, args, server, () => pi.getAllTools(), undefined, "script");
        assertRuntimeCurrent(callState, generation, owner);
        if (result.details && typeof result.details === "object" && "error" in result.details) {
          return { ok: false, error: new Error(`MCP tool call failed: ${String((result.details as { error?: unknown }).error)}`) };
        }
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },

    async executeProxyTool(_toolCallId, params, signal, _onUpdate, ctx) {
      const operationGeneration = lifecycleGeneration;
      const operationOwner = runtimeOwner;
      const operationSignal = signal ?? (state ? operationOwner?.signal : undefined);
      let parsedArgs: Record<string, unknown> | undefined;
      try {
        parsedArgs = parseProxyArgs(params.args);
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`Invalid args JSON: ${error.message}`, { cause: error });
        throw error;
      }
      if (params.args !== undefined && !params.tool && !params.action) {
        const nested = parsedArgs ?? {};
        const nestedKeys = Object.keys(nested);
        if (nestedKeys.length > 0 || params.args === "") {
          throw new Error("Gateway params were nested inside `args`; pass them top-level");
        }
      }

      if (!state && (initPromise || initializationError !== null)) {
        try {
          const waitResult = await waitForInitialization(operationSignal, DEFAULT_INITIALIZATION_WAIT_TIMEOUT_MS);
          if (waitResult === "timeout") {
            return {
              content: [{ type: "text" as const, text: "MCP initialization is still in progress. Try again shortly." }],
              details: { error: "init_timeout", timeoutMs: DEFAULT_INITIALIZATION_WAIT_TIMEOUT_MS },
            };
          }
        } catch (error) {
          throwIfAborted(signal);
          if (lifecycleGeneration !== operationGeneration || (operationOwner && runtimeOwner !== operationOwner)) throw error;
          const failure = initializationError ?? error;
          const message = failure instanceof Error ? failure.message : String(failure);
          return {
            content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
            details: { error: "init_failed", message },
          };
        }
      }
      if (!state) {
        if (lifecycleGeneration !== operationGeneration || (operationOwner && runtimeOwner !== operationOwner)) {
          throw staleSessionError();
        }
        return {
          content: [{ type: "text" as const, text: "MCP not initialized" }],
          details: { error: "not_initialized" },
        };
      }
      const executionState = state;
      const executionGeneration = lifecycleGeneration;
      const executionOwner = runtimeOwner;
      const executionSignal = signal;
      const assertCurrent = () => assertRuntimeCurrent(executionState, executionGeneration, executionOwner);

      if (params.action === "ui-messages") {
        const result = executeUiMessages(state);
        assertCurrent();
        return result;
      }
      if (params.action === "auth-start") {
        if (!params.server) {
          return {
            content: [{ type: "text" as const, text: "auth-start requires `server`. Example: mcp({ action: \"auth-start\", server: \"linear-server\" })" }],
            details: { mode: "auth-start", error: "missing_server" },
          };
        }
        const result = executionSignal === undefined
          ? await executeAuthStart(state, params.server)
          : await executeAuthStart(state, params.server, executionSignal);
        assertCurrent();
        return result;
      }
      if (params.action === "auth-complete") {
        if (!params.server) {
          return {
            content: [{ type: "text" as const, text: "auth-complete requires `server`." }],
            details: { mode: "auth-complete", error: "missing_server" },
          };
        }
        const input = parsedArgs?.redirectUrl ?? parsedArgs?.code ?? parsedArgs?.input;
        if (typeof input !== "string" || input.trim().length === 0) {
          return {
            content: [{ type: "text" as const, text: "auth-complete requires args with `redirectUrl`, `code`, or `input`." }],
            details: { mode: "auth-complete", error: "missing_input" },
          };
        }
        const result = executionSignal === undefined
          ? await executeAuthComplete(state, params.server, input)
          : await executeAuthComplete(state, params.server, input, executionSignal);
        assertCurrent();
        return result;
      }
      if (params.tool) {
        const result = await executeCall(state, params.tool, parsedArgs, params.server, () => pi.getAllTools(), executionSignal, undefined, undefined, _toolCallId);
        assertCurrent();
        const details = result.details;
        if (toolSurface && (!details || typeof details !== "object" || !("error" in details))) {
          const server = details && typeof details === "object" && typeof (details as { server?: unknown }).server === "string"
            ? (details as { server: string }).server
            : params.server;
          const canonicalTool = details && typeof details === "object" && typeof (details as { canonicalTool?: unknown }).canonicalTool === "string"
            ? (details as { canonicalTool: string }).canonicalTool
            : params.tool;
          if (server) {
            const added = toolSurface.activateSearchMatches([{ server, tool: canonicalTool }]);
            if (added.length > 0) return { ...result, details: { ...(details ?? {}), activated: added }, addedToolNames: added };
          }
        }
        return result;
      }
      if (params.connect) {
        const attribution = beginConnectAttribution(params.connect);
        try {
          const result = attribution
            ? await connectAttributionContext.run(
                { serverName: params.connect, attribution },
                () => executeConnect(executionState, params.connect!, executionSignal),
              )
            : await executeConnect(executionState, params.connect, executionSignal);
          assertCurrent();
          const surfaceContext = ctx ?? sessionContext;
          if (toolSurface && surfaceContext) {
            await toolSurface.sync(state, surfaceContext, false, surfaceHelpers(), {
              reportDirectToolAdditions: attribution !== undefined,
              ...(attribution ? { attribution } : {}),
              scriptMode: activeScriptMode,
            });
          }
          assertCurrent();
          const addedToolNames = attribution
            ? toolSurface?.consumeDirectToolNames?.(params.connect, attribution) ?? []
            : [];
          return addedToolNames.length > 0 ? { ...result, addedToolNames } : result;
        } finally {
          discardConnectAttribution(params.connect, attribution);
        }
      }
      if (params.describe) {
        const result = await executeDescribe(state, params.describe, params.server);
        assertCurrent();
        return result;
      }
      if (params.search) {
        const result = await executeSearch(state, params.search, params.regex, params.server, params.includeSchemas, params.limit, params.offset, params.searchMode, executionSignal);
        assertCurrent();
        const details = result.details;
        if (toolSurface && details && typeof details === "object" && "matches" in details && Array.isArray(details.matches)) {
          const matches = details.matches.filter((match): match is { server: string; tool: string } => (
            typeof match === "object" && match !== null
            && typeof (match as { server?: unknown }).server === "string"
            && typeof (match as { tool?: unknown }).tool === "string"
          ));
          const added = toolSurface.activateSearchMatches(matches);
          if (added.length > 0) {
            const text = result.content.map(block => ("text" in block ? block.text : "")).join("\n");
            return {
              ...result,
              content: [{ type: "text" as const, text: `Activated as direct tools: ${added.join(", ")}.\n\n${text}` }],
              details: { ...details, activated: added },
              addedToolNames: added,
            };
          }
        }
        return result;
      }
      if (params.server) {
        const result = await executeList(state, params.server);
        assertCurrent();
        return result;
      }
      const result = await executeStatus(state);
      assertCurrent();
      return result;
    },

    async executeDirectTool(spec, toolCallId, params, signal, onUpdate, ctx) {
      const executionState = state;
      const executionGeneration = lifecycleGeneration;
      const executionOwner = runtimeOwner;
      if (!executionState && !initPromise) {
        if (executionOwner?.signal.aborted) throwIfAborted(executionOwner.signal);
        return {
          content: [{ type: "text" as const, text: "MCP not initialized" }],
          details: { error: "not_initialized" },
        };
      }
      const directTools = directToolsModule ?? await directToolsReady;
      if (executionState) assertRuntimeCurrent(executionState, executionGeneration, executionOwner);
      const execute = directTools.createDirectToolExecutor(
        () => state,
        () => initPromise,
        spec,
        spec.lazy === true && typeof pi.registerMcpServer === "function",
      );
      const result = await execute(toolCallId, params, signal, onUpdate, ctx as ExtensionContext);
      if (executionState) {
        assertRuntimeCurrent(executionState, executionGeneration, executionOwner);
      } else if (lifecycleGeneration !== executionGeneration || runtimeOwner !== executionOwner) {
        throw staleSessionError();
      }
      return result;
    },

    async executeScript(params, signal, ctx) {
      const currentState = ctx ? await ensureState(ctx) : state;
      if (!currentState) {
        return {
          content: [{ type: "text" as const, text: "MCP not initialized" }],
          details: { mode: "script", error: "not_initialized" },
        };
      }
      const executionGeneration = lifecycleGeneration;
      const executionOwner = runtimeOwner;
      const executionSignal = signal;
      const { runMcpScript } = await import("./mcp-code.ts");
      executionOwner?.throwIfInactive();
      if (state !== currentState || lifecycleGeneration !== executionGeneration) throw staleSessionError();
      const result = await runMcpScript(currentState, params.code, params.timeoutMs, () => pi.getAllTools(), executionSignal);
      assertRuntimeCurrent(currentState, executionGeneration, executionOwner);
      return result;
    },
  };
}
