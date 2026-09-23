import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import type { DirectToolSpec } from "./types.ts";
import {
  showStatus,
  showTools,
  reconnectServers,
  authenticateServer,
  logoutServer,
  openMcpAuthPanel,
  openMcpPanel,
  openMcpSetup,
  editSharedConfig,
} from "./commands.ts";
import { createDirectToolExecutor } from "./direct-tools.ts";
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
import { initializeOAuth, shutdownOAuth } from "./mcp-auth-flow.ts";
import { abortable, throwIfAborted } from "./abort.ts";

export interface McpRuntimeSurfaceHelpers {
  getState: () => McpExtensionState | null;
  getInitPromise: () => Promise<McpExtensionState> | null;
  ensureState: (ctx: ExtensionContext) => Promise<McpExtensionState | null>;
  getPiTools: () => ToolInfo[];
  updateStatusBar: (state: McpExtensionState) => void;
  executeCall: (
    state: McpExtensionState,
    toolName: string,
    args: Record<string, unknown>,
    serverName: string,
    getPiTools: () => ToolInfo[],
    signal: AbortSignal | undefined,
    origin: "proxy",
  ) => Promise<AgentToolResult<Record<string, unknown>>>;
}

export interface McpRuntimeSurface {
  sync(
    state: McpExtensionState,
    ctx: ExtensionContext,
    initial: boolean,
    helpers: McpRuntimeSurfaceHelpers,
    options?: { forceDirectTools?: boolean },
  ): void | Promise<void>;
  activateSearchMatches(matches: ReadonlyArray<{ server: string; tool: string }>): void;
}

export interface McpRuntimeOptions {
  earlyConfigPath?: string;
  toolSurface?: McpRuntimeSurface;
}

export interface McpRuntime {
  handleSessionStart(event: unknown, ctx: ExtensionContext): Promise<void>;
  /** Wait for initialization without blocking session_start itself. */
  waitForInitialization?(signal?: AbortSignal, timeoutMs?: number): Promise<"ready" | "timeout">;
  handleSessionShutdown(): Promise<void>;
  handleMcpCommand(args: string | undefined, ctx: ExtensionCommandContext): Promise<void>;
  handleMcpAuthCommand(args: string | undefined, ctx: ExtensionCommandContext): Promise<void>;
  executeProxyTool(
    toolCallId: string,
    params: {
      tool?: string;
      args?: string;
      connect?: string;
      describe?: string;
      search?: string;
      regex?: boolean;
      includeSchemas?: boolean;
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
  const { earlyConfigPath, toolSurface } = options;
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;
  let initializationReady: Promise<void> | null = null;
  let sessionStartReady: Promise<void> | null = null;
  let resolveSessionStartReady: (() => void) | null = null;
  let initializationError: unknown = null;
  let lifecycleGeneration = 0;
  const DEFAULT_INITIALIZATION_WAIT_TIMEOUT_MS = 30_000;

  async function shutdownState(currentState: McpExtensionState | null, reason: string): Promise<void> {
    if (!currentState) return;

    if (currentState.uiServer) {
      currentState.uiServer.close(reason);
      currentState.uiServer = null;
    }

    let flushError: unknown;
    try {
      flushMetadataCache(currentState);
    } catch (error) {
      flushError = error;
    }

    try {
      await currentState.lifecycle.gracefulShutdown();
    } catch (error) {
      if (flushError) {
        console.error("MCP: graceful shutdown failed after metadata flush error", error);
      } else {
        throw error;
      }
    }

    if (flushError) {
      throw flushError;
    }
  }

  async function waitForInitialization(
    signal?: AbortSignal,
    timeoutMs = DEFAULT_INITIALIZATION_WAIT_TIMEOUT_MS,
  ): Promise<"ready" | "timeout"> {
    const ready = initializationReady ?? sessionStartReady;
    if (!ready) return "ready";

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timed = Promise.race<"ready" | "timeout">([
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
    if (!state && (initPromise || initializationError !== null)) {
      try {
        const waitResult = await waitForInitialization(ctx.signal, DEFAULT_INITIALIZATION_WAIT_TIMEOUT_MS);
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
    updateStatusBar,
    executeCall: async (currentState, toolName, args, serverName, getPiTools, signal, origin) => (
      executeCall(currentState, toolName, args, serverName, getPiTools, signal, origin)
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
    for (const [serverName, directTools] of changes) {
      const definition = currentState.config.mcpServers[serverName];
      if (!definition) continue;
      definition.directTools = directTools;
    }
    if (!isCurrentState(currentState, generation) || !toolSurface) return;
    // This is an explicit user-requested refresh, so it must bypass the
    // passive freeze that protects the prompt cache from metadata callbacks.
    await toolSurface.sync(currentState, ctx, false, surfaceHelpers(), { forceDirectTools: true });
  }

  return {
    async handleSessionStart(_event, ctx) {
      const generation = ++lifecycleGeneration;
      resolveSessionStartReady?.();
      resolveSessionStartReady = null;
      let resolveThisSessionStart!: () => void;
      const startReady = new Promise<void>((resolve) => {
        resolveThisSessionStart = resolve;
      });
      resolveSessionStartReady = resolveThisSessionStart;
      sessionStartReady = startReady;
      const previousState = state;
      state = null;
      initPromise = null;
      initializationReady = null;
      initializationError = null;

      try {
        await Promise.all([
          shutdownState(previousState, "session_restart"),
          shutdownOAuth(),
        ]);
      } catch (error) {
        console.error("MCP: failed to shut down previous session state", error);
      }

      if (generation !== lifecycleGeneration) {
        resolveThisSessionStart();
        return;
      }

      await initializeOAuth().catch(err => {
        console.error("MCP OAuth initialization failed:", err);
      });

      initializationError = null;
      const promise = initializeMcp(pi, ctx);
      initPromise = promise;

      const finalized = promise.then(async (nextState) => {
        if (generation !== lifecycleGeneration || initPromise !== promise) {
          try {
            await shutdownState(nextState, "stale_session_start");
          } catch (error) {
            console.error("MCP: failed to clean stale session state", error);
          }
          return;
        }

        state = nextState;
        const previousMetadataHook = nextState.onToolMetadataUpdated;
        nextState.onToolMetadataUpdated = async (serverName, reason) => {
          await previousMetadataHook?.(serverName, reason);
          if (generation !== lifecycleGeneration || state !== nextState || !toolSurface) return;
          await toolSurface.sync(nextState, ctx, false, surfaceHelpers());
          updateStatusBar(nextState);
        };
        if (toolSurface) {
          await toolSurface.sync(nextState, ctx, true, surfaceHelpers());
        }
        updateStatusBar(nextState);
        initPromise = null;
      });
      initializationReady = finalized.then(
        () => undefined,
        (error) => {
          if (generation === lifecycleGeneration && initPromise === promise) {
            initializationError = error;
            console.error("MCP initialization failed:", error);
            initPromise = null;
          }
        },
      );
      void initializationReady.then(() => {
        if (sessionStartReady === startReady) {
          resolveThisSessionStart();
          if (resolveSessionStartReady === resolveThisSessionStart) resolveSessionStartReady = null;
        }
      });
    },

    async waitForInitialization(signal, timeoutMs = DEFAULT_INITIALIZATION_WAIT_TIMEOUT_MS): Promise<"ready" | "timeout"> {
      return waitForInitialization(signal, timeoutMs);
    },

    async handleSessionShutdown() {
      ++lifecycleGeneration;
      const currentState = state;
      state = null;
      initPromise = null;
      initializationReady = null;
      resolveSessionStartReady?.();
      resolveSessionStartReady = null;
      sessionStartReady = null;
      initializationError = null;

      try {
        await Promise.all([
          shutdownState(currentState, "session_shutdown"),
          shutdownOAuth(),
        ]);
      } catch (error) {
        console.error("MCP: session shutdown cleanup failed", error);
      }
    },

    async handleMcpCommand(args, ctx) {
      const currentState = await ensureState(ctx);
      if (!currentState) return;

      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];
      const rest = parts.slice(1).join(" ");

      switch (subcommand) {
        case "reconnect":
          await reconnectServers(currentState, ctx, targetServer);
          break;
        case "tools":
          await showTools(currentState, ctx);
          break;
        case "setup": {
          const result = await openMcpSetup(currentState, pi, ctx, earlyConfigPath, "setup");
          if (result?.configChanged) {
            await ctx.reload();
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
          const changed = await editSharedConfig(ctx, (targetServer as "project" | "global" | undefined) ?? "project");
          if (changed) {
            await ctx.reload();
            return;
          }
          break;
        }
        case "logout": {
          const serverName = rest;
          if (!serverName) {
            if (ctx.hasUI) ctx.ui.notify("Usage: /mcp logout <server>", "error");
            return;
          }
          await logoutServer(serverName, currentState, ctx);
          break;
        }
        case "status":
        case "":
        default:
          if (ctx.hasUI) {
            const panelGeneration = lifecycleGeneration;
            const result = await openMcpPanel(
              currentState,
              pi,
              ctx,
              earlyConfigPath,
              (changes) => applyDirectToolsConfigChanges(currentState, panelGeneration, ctx, changes),
            );
            if (result?.configChanged) {
              await ctx.reload();
              return;
            }
          } else {
            await showStatus(currentState, ctx);
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
        await openMcpAuthPanel(currentState, pi, ctx, earlyConfigPath);
        return;
      }

      await authenticateServer(serverName, currentState.config, ctx);
    },

    async executeProxyTool(_toolCallId, params, signal) {
      let parsedArgs: Record<string, unknown> | undefined;
      if (params.args) {
        try {
          parsedArgs = JSON.parse(params.args);
          if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
            const gotType = Array.isArray(parsedArgs) ? "array" : parsedArgs === null ? "null" : typeof parsedArgs;
            throw new Error(`Invalid args: expected a JSON object, got ${gotType}`);
          }
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new Error(`Invalid args JSON: ${error.message}`, { cause: error });
          }
          throw error;
        }
      }

      if (!state && (initPromise || initializationError !== null)) {
        try {
          const waitResult = await waitForInitialization(signal, DEFAULT_INITIALIZATION_WAIT_TIMEOUT_MS);
          if (waitResult === "timeout") {
            return {
              content: [{ type: "text" as const, text: "MCP initialization is still in progress. Try again shortly." }],
              details: { error: "init_timeout", timeoutMs: DEFAULT_INITIALIZATION_WAIT_TIMEOUT_MS },
            };
          }
        } catch (error) {
          throwIfAborted(signal);
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
            details: { error: "init_failed", message },
          };
        }
      }
      if (!state) {
        return {
          content: [{ type: "text" as const, text: "MCP not initialized" }],
          details: { error: "not_initialized" },
        };
      }

      if (params.action === "ui-messages") {
        return executeUiMessages(state);
      }
      if (params.action === "auth-start") {
        if (!params.server) {
          return {
            content: [{ type: "text" as const, text: "auth-start requires `server`. Example: mcp({ action: \"auth-start\", server: \"linear-server\" })" }],
            details: { mode: "auth-start", error: "missing_server" },
          };
        }
        return executeAuthStart(state, params.server);
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
        return executeAuthComplete(state, params.server, input);
      }
      if (params.tool) {
        return executeCall(state, params.tool, parsedArgs, params.server, () => pi.getAllTools(), signal);
      }
      if (params.connect) {
        return executeConnect(state, params.connect, signal);
      }
      if (params.describe) {
        return executeDescribe(state, params.describe);
      }
      if (params.search) {
        const result = executeSearch(state, params.search, params.regex, params.server, params.includeSchemas);
        const details = result.details;
        if (toolSurface && details && typeof details === "object" && "matches" in details && Array.isArray(details.matches)) {
          const matches = details.matches.filter((match): match is { server: string; tool: string } => (
            typeof match === "object" && match !== null
            && typeof (match as { server?: unknown }).server === "string"
            && typeof (match as { tool?: unknown }).tool === "string"
          ));
          toolSurface.activateSearchMatches(matches);
        }
        return result;
      }
      if (params.server) {
        return executeList(state, params.server);
      }
      return executeStatus(state);
    },

    async executeDirectTool(spec, toolCallId, params, signal, onUpdate, ctx) {
      const execute = createDirectToolExecutor(() => state, () => initPromise, spec);
      return execute(toolCallId, params, signal, onUpdate, ctx as ExtensionContext);
    },

    async executeScript(params, signal, ctx) {
      const currentState = ctx ? await ensureState(ctx) : state;
      if (!currentState) {
        return {
          content: [{ type: "text" as const, text: "MCP not initialized" }],
          details: { mode: "script", error: "not_initialized" },
        };
      }
      const { runMcpScript } = await import("./mcp-code.ts");
      return runMcpScript(currentState, params.code, params.timeoutMs, () => pi.getAllTools(), signal);
    },
  };
}
