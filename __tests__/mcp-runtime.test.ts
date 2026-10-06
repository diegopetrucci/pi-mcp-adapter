import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initializeMcp: vi.fn(),
  updateStatusBar: vi.fn(),
  flushMetadataCache: vi.fn(),
  initializeOAuth: vi.fn().mockResolvedValue(undefined),
  createOAuthRuntime: vi.fn((signal: AbortSignal) => ({ signal })),
  shutdownOAuth: vi.fn().mockResolvedValue(undefined),
  createDirectToolExecutor: vi.fn(),
  showStatus: vi.fn(),
  showTools: vi.fn(),
  reconnectServers: vi.fn(),
  authenticateServer: vi.fn(),
  logoutServer: vi.fn(),
  openMcpAuthPanel: vi.fn(),
  openMcpPanel: vi.fn(),
  openMcpSetup: vi.fn(),
  editSharedConfig: vi.fn(),
  executeAuthComplete: vi.fn(),
  executeAuthStart: vi.fn(),
  executeCall: vi.fn(),
  executeConnect: vi.fn(),
  executeDescribe: vi.fn(),
  executeList: vi.fn(),
  executeSearch: vi.fn(),
  executeStatus: vi.fn(),
  executeUiMessages: vi.fn(),
}));

vi.mock("../init.ts", () => ({
  initializeMcp: mocks.initializeMcp,
  updateStatusBar: mocks.updateStatusBar,
  flushMetadataCache: mocks.flushMetadataCache,
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  initializeOAuth: mocks.initializeOAuth,
  createOAuthRuntime: mocks.createOAuthRuntime,
  shutdownOAuth: mocks.shutdownOAuth,
}));

vi.mock("../direct-tools.ts", () => ({
  createDirectToolExecutor: mocks.createDirectToolExecutor,
}));

vi.mock("../commands.ts", () => ({
  showStatus: mocks.showStatus,
  showTools: mocks.showTools,
  reconnectServers: mocks.reconnectServers,
  authenticateServer: mocks.authenticateServer,
  logoutServer: mocks.logoutServer,
  openMcpAuthPanel: mocks.openMcpAuthPanel,
  openMcpPanel: mocks.openMcpPanel,
  openMcpSetup: mocks.openMcpSetup,
  editSharedConfig: mocks.editSharedConfig,
}));

vi.mock("../proxy-modes.ts", () => ({
  executeAuthComplete: mocks.executeAuthComplete,
  executeAuthStart: mocks.executeAuthStart,
  executeCall: mocks.executeCall,
  executeConnect: mocks.executeConnect,
  executeDescribe: mocks.executeDescribe,
  executeList: mocks.executeList,
  executeSearch: mocks.executeSearch,
  executeStatus: mocks.executeStatus,
  executeUiMessages: mocks.executeUiMessages,
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createState() {
  return {
    manager: { getAllConnections: () => new Map() },
    lifecycle: { gracefulShutdown: vi.fn().mockResolvedValue(undefined) },
    toolMetadata: new Map(),
    config: { mcpServers: {} },
    failureTracker: new Map(),
    uiResourceHandler: {},
    consentManager: {},
    uiServer: null,
    completedUiSessions: [],
    openBrowser: vi.fn(),
  } as any;
}

function createPi() {
  return {
    getAllTools: vi.fn(() => []),
  } as any;
}

describe("mcp runtime", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const value of Object.values(mocks)) {
      if (typeof value === "function" && "mockReset" in value) {
        value.mockReset();
      }
    }

    mocks.initializeOAuth.mockResolvedValue(undefined);
    mocks.createOAuthRuntime.mockImplementation((signal: AbortSignal) => ({ signal }));
    mocks.shutdownOAuth.mockResolvedValue(undefined);
    mocks.createDirectToolExecutor.mockReturnValue(vi.fn().mockResolvedValue({ content: [] }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("awaits predecessor cleanup before normal successor initialization", async () => {
    const firstState = createState();
    const cleanup = createDeferred<void>();
    firstState.lifecycle.gracefulShutdown.mockReturnValue(cleanup.promise);
    const secondState = createState();
    mocks.initializeMcp.mockResolvedValueOnce(firstState).mockResolvedValueOnce(secondState);

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), {});

    await runtime.handleSessionStart({}, {} as any);
    await runtime.waitForInitialization?.();

    const replacement = runtime.handleSessionStart({}, {} as any);
    await vi.waitFor(() => expect(firstState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1));
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);

    cleanup.resolve();
    await replacement;
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(mocks.updateStatusBar).toHaveBeenCalledWith(secondState);
  });

  it("allows one explicit first-use expedite without stale publication", async () => {
    const firstState = createState();
    const cleanup = createDeferred<void>();
    firstState.lifecycle.gracefulShutdown.mockReturnValue(cleanup.promise);
    const secondState = createState();
    mocks.initializeMcp.mockResolvedValueOnce(firstState).mockResolvedValueOnce(secondState);

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), {});

    await runtime.handleSessionStart({}, {} as any);
    await runtime.waitForInitialization?.();
    mocks.updateStatusBar.mockClear();
    const replacement = runtime.handleSessionStart({}, {} as any);
    await vi.waitFor(() => expect(firstState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1));

    expect(runtime.expediteSessionStart?.()).toBe(true);
    expect(runtime.expediteSessionStart?.()).toBe(false);
    await vi.waitFor(() => expect(mocks.initializeMcp).toHaveBeenCalledTimes(2));
    expect(firstState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1);
    expect(mocks.updateStatusBar).not.toHaveBeenCalledWith(firstState);

    cleanup.resolve();
    await replacement;
    expect(mocks.updateStatusBar).toHaveBeenCalledWith(secondState);
  });

  it("keeps replacement generations behind cleanup and initializes only the winner", async () => {
    const firstState = createState();
    const cleanup = createDeferred<void>();
    firstState.lifecycle.gracefulShutdown.mockReturnValue(cleanup.promise);
    const secondState = createState();
    mocks.initializeMcp.mockResolvedValueOnce(firstState).mockResolvedValueOnce(secondState);

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), {});

    await runtime.handleSessionStart({}, {} as any);
    await runtime.waitForInitialization?.();
    mocks.updateStatusBar.mockClear();
    const secondStart = runtime.handleSessionStart({}, {} as any);
    await vi.waitFor(() => expect(firstState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1));
    const thirdStart = runtime.handleSessionStart({}, {} as any);

    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await Promise.all([secondStart, thirdStart]);

    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(mocks.updateStatusBar).not.toHaveBeenCalledWith(firstState);
    expect(mocks.updateStatusBar).toHaveBeenCalledWith(secondState);
  });

  it("starts a replacement init immediately and shuts down stale init results", async () => {
    const first = createDeferred<any>();
    const second = createDeferred<any>();
    mocks.initializeMcp
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), {});

    await runtime.handleSessionStart({}, {} as any);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownOAuth).not.toHaveBeenCalled();

    await runtime.handleSessionStart({}, {} as any);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(1);
    const previousOAuthRuntime = mocks.createOAuthRuntime.mock.results[0].value;
    expect(mocks.shutdownOAuth).toHaveBeenCalledWith(previousOAuthRuntime);
    expect(previousOAuthRuntime.signal.aborted).toBe(true);

    const activeState = createState();
    second.resolve(activeState);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.updateStatusBar).toHaveBeenCalledWith(activeState);
    expect(activeState.lifecycle.gracefulShutdown).not.toHaveBeenCalled();

    const staleState = createState();
    first.resolve(staleState);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.updateStatusBar).not.toHaveBeenCalledWith(staleState);
    expect(mocks.flushMetadataCache).toHaveBeenCalledWith(staleState);
    expect(staleState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1);
  });

  it("shuts down current state and OAuth on session shutdown", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), {});

    await runtime.handleSessionStart({}, {} as any);
    await Promise.resolve();
    await Promise.resolve();

    mocks.shutdownOAuth.mockClear();
    mocks.flushMetadataCache.mockClear();

    await runtime.handleSessionShutdown();

    expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.flushMetadataCache).toHaveBeenCalledWith(state);
    expect(state.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1);
  });

  it("routes mcp commands through the existing command handlers", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.openMcpSetup.mockResolvedValue({ configChanged: true });

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), { earlyConfigPath: "/tmp/mcp.json" });
    const ctx = { hasUI: true, ui: { notify: vi.fn() }, reload: vi.fn().mockResolvedValue(undefined) } as any;

    await runtime.handleSessionStart({}, ctx);
    await Promise.resolve();
    await Promise.resolve();

    await runtime.handleMcpCommand("reconnect demo", ctx);
    await runtime.handleMcpCommand("tools", ctx);
    await runtime.handleMcpCommand("setup", ctx);
    mocks.editSharedConfig.mockResolvedValue(true);
    await runtime.handleMcpCommand("edit", ctx);
    await runtime.handleMcpCommand("edit global", ctx);
    await runtime.handleMcpCommand("logout oauth-server", ctx);
    await runtime.handleMcpCommand("", ctx);

    const ownerCtx = expect.objectContaining({ hasUI: true, signal: expect.any(AbortSignal), ui: ctx.ui });
    expect(mocks.reconnectServers).toHaveBeenCalledWith(state, ownerCtx, "demo");
    expect(mocks.showTools).toHaveBeenCalledWith(state, ownerCtx);
    expect(mocks.openMcpSetup).toHaveBeenCalledWith(state, expect.any(Object), ownerCtx, "/tmp/mcp.json", "setup");
    expect(ctx.reload).toHaveBeenCalledTimes(3);
    expect(mocks.editSharedConfig).toHaveBeenNthCalledWith(1, ownerCtx, "project");
    expect(mocks.editSharedConfig).toHaveBeenNthCalledWith(2, ownerCtx, "global");
    expect(mocks.logoutServer).toHaveBeenCalledWith("oauth-server", state, ownerCtx);
    expect(mocks.openMcpPanel).toHaveBeenCalledWith(state, expect.any(Object), ownerCtx, "/tmp/mcp.json", expect.any(Function));
  });

  it("routes mcp-auth commands through the existing auth handlers", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), { earlyConfigPath: "/tmp/mcp.json" });
    const ctx = { hasUI: true, ui: { notify: vi.fn() } } as any;

    await runtime.handleSessionStart({}, ctx);
    await Promise.resolve();
    await Promise.resolve();

    await runtime.handleMcpAuthCommand("", ctx);
    await runtime.handleMcpAuthCommand("github", ctx);

    expect(mocks.openMcpAuthPanel).toHaveBeenCalledWith(state, expect.any(Object), ctx, "/tmp/mcp.json");
    expect(mocks.authenticateServer).toHaveBeenCalledWith(
      "github",
      state.config,
      expect.objectContaining({ hasUI: true, signal: expect.any(AbortSignal) }),
      expect.any(AbortSignal),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("retains each session's script selection through initialization and refresh", async () => {
    const firstState = createState();
    firstState.config = { settings: { scriptMode: false }, mcpServers: { demo: { command: "demo" } } };
    const secondState = createState();
    secondState.config = { settings: { scriptMode: true }, mcpServers: { demo: { command: "demo" } } };
    mocks.initializeMcp.mockResolvedValueOnce(firstState).mockResolvedValueOnce(secondState);
    const sync = vi.fn();

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), {
      startupConfig: { settings: { scriptMode: false }, mcpServers: {} },
      toolSurface: { sync, activateSearchMatches: vi.fn() },
    });
    const ctx = { hasUI: false, cwd: "/session" } as any;

    await runtime.handleSessionStart({}, ctx, { scriptMode: true });
    await runtime.waitForInitialization?.();
    expect(firstState.scriptTool).toBe(true);
    expect(sync.mock.calls[0]?.[4]).toMatchObject({ scriptMode: true });

    await firstState.onToolMetadataUpdated?.("demo", "connect");
    expect(sync.mock.calls.at(-1)?.[4]).toMatchObject({ scriptMode: true });
    expect(sync.mock.calls.at(-1)?.[4]?.discoverDirectToolServers).toEqual(new Set(["demo"]));

    await runtime.handleSessionStart({}, ctx, { scriptMode: false });
    await runtime.waitForInitialization?.();
    expect(secondState.scriptTool).toBe(false);
    expect(sync.mock.calls.at(-1)?.[4]).toMatchObject({ scriptMode: false });

    await secondState.onToolMetadataUpdated?.("demo", "connect");
    expect(sync.mock.calls.at(-1)?.[4]).toMatchObject({ scriptMode: false });
    expect(sync.mock.calls.at(-1)?.[4]?.discoverDirectToolServers).toEqual(new Set(["demo"]));
  });

  it("refreshes direct tools after a persisted panel change even when direct tools are frozen", async () => {
    const state = createState();
    state.config = {
      settings: { freezeDirectTools: true },
      mcpServers: { demo: { command: "demo", directTools: false } },
    };
    mocks.initializeMcp.mockResolvedValue(state);
    const sync = vi.fn();
    const toolSurface = { sync, activateSearchMatches: vi.fn() };
    let applyChanges!: (changes: Map<string, true | string[] | false>) => void | Promise<void>;
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      applyChanges = args[4];
      return { configChanged: false };
    });

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), { toolSurface });
    const ctx = { hasUI: true, ui: { notify: vi.fn() } } as any;

    await runtime.handleSessionStart({}, ctx);
    await runtime.waitForInitialization?.();
    await runtime.handleMcpCommand("", ctx);

    expect(applyChanges).toBeTypeOf("function");
    await applyChanges(new Map([["demo", ["search"]]]));

    expect(state.config.mcpServers.demo.directTools).toEqual(["search"]);
    expect(sync).toHaveBeenNthCalledWith(
      2,
      state,
      expect.objectContaining({ hasUI: true, signal: expect.any(AbortSignal) }),
      false,
      expect.any(Object),
      { forceDirectTools: true, forceDirectToolServers: new Set(["demo"]), scriptMode: false },
    );
  });

  it("does not refresh for an empty or unrecognized panel change set", async () => {
    const state = createState();
    state.config = {
      settings: { freezeDirectTools: true },
      mcpServers: { demo: { command: "demo", directTools: false } },
    };
    mocks.initializeMcp.mockResolvedValue(state);
    const sync = vi.fn();
    const toolSurface = { sync, activateSearchMatches: vi.fn() };
    let applyChanges!: (changes: Map<string, true | string[] | false>) => void | Promise<void>;
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      applyChanges = args[4];
      return { configChanged: false };
    });

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), { toolSurface });
    const ctx = { hasUI: true, ui: { notify: vi.fn() } } as any;

    await runtime.handleSessionStart({}, ctx);
    await runtime.waitForInitialization?.();
    await runtime.handleMcpCommand("", ctx);
    const syncCalls = sync.mock.calls.length;

    await applyChanges(new Map());
    await applyChanges(new Map([["runtime-only", true]]));

    expect(sync).toHaveBeenCalledTimes(syncCalls);
    expect(state.config.mcpServers.demo.directTools).toBe(false);
  });

  it("ignores a panel refresh callback after the runtime session is replaced", async () => {
    const firstState = createState();
    firstState.config = { mcpServers: { demo: { command: "demo", directTools: false } } };
    const replacementState = createState();
    replacementState.config = { mcpServers: { demo: { command: "demo", directTools: false } } };
    mocks.initializeMcp.mockResolvedValueOnce(firstState).mockResolvedValueOnce(replacementState);
    const sync = vi.fn();
    let staleApply!: (changes: Map<string, true | string[] | false>) => void | Promise<void>;
    mocks.openMcpPanel.mockImplementationOnce(async (...args: any[]) => {
      staleApply = args[4];
      return { configChanged: false };
    });

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), {
      toolSurface: { sync, activateSearchMatches: vi.fn() },
    });
    const firstCtx = { hasUI: true, ui: { notify: vi.fn() } } as any;
    const replacementCtx = { hasUI: true, ui: { notify: vi.fn() } } as any;

    await runtime.handleSessionStart({}, firstCtx);
    await runtime.waitForInitialization?.();
    await runtime.handleMcpCommand("", firstCtx);

    await runtime.handleSessionStart({}, replacementCtx);
    await runtime.waitForInitialization?.();
    await staleApply(new Map([["demo", true]]));

    expect(firstState.config.mcpServers.demo.directTools).toBe(false);
    expect(replacementState.config.mcpServers.demo.directTools).toBe(false);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("discards failed connect attribution before a successor can consume it", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const firstAttribution = {};
    const secondAttribution = {};
    const beginDirectToolAttribution = vi.fn()
      .mockReturnValueOnce(firstAttribution)
      .mockReturnValueOnce(secondAttribution);
    const consumeDirectToolNames = vi.fn(() => ["demo_new"]);
    const discardDirectToolAttribution = vi.fn();
    const toolSurface = {
      sync: vi.fn(),
      activateSearchMatches: vi.fn(),
      beginDirectToolAttribution,
      consumeDirectToolNames,
      discardDirectToolAttribution,
    };
    const connectResult = { content: [{ type: "text", text: "connected" }] };
    mocks.executeConnect.mockRejectedValueOnce(new Error("cancelled"))
      .mockResolvedValueOnce(connectResult);

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), { toolSurface });
    await runtime.handleSessionStart({}, {} as any);
    await runtime.waitForInitialization?.();

    await expect(runtime.executeProxyTool("cancelled", { connect: "demo" })).rejects.toThrow("cancelled");
    const result = await runtime.executeProxyTool("success", { connect: "demo" });

    expect(result).toMatchObject({ addedToolNames: ["demo_new"] });
    expect(beginDirectToolAttribution).toHaveBeenNthCalledWith(1, "demo");
    expect(beginDirectToolAttribution).toHaveBeenNthCalledWith(2, "demo");
    expect(consumeDirectToolNames).toHaveBeenCalledTimes(1);
    expect(consumeDirectToolNames).toHaveBeenCalledWith("demo", secondAttribution);
    expect(discardDirectToolAttribution).toHaveBeenCalledWith(firstAttribution);
    expect(discardDirectToolAttribution).toHaveBeenCalledWith(secondAttribution);
  });

  it("routes proxy calls through the existing proxy handlers", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeAuthStart.mockResolvedValue({ content: [{ type: "text", text: "auth-start" }] });
    mocks.executeAuthComplete.mockResolvedValue({ content: [{ type: "text", text: "auth-complete" }] });
    mocks.executeCall.mockResolvedValue({ content: [{ type: "text", text: "tool" }] });
    mocks.executeConnect.mockResolvedValue({ content: [{ type: "text", text: "connect" }] });
    mocks.executeDescribe.mockResolvedValue({ content: [{ type: "text", text: "describe" }] });
    mocks.executeSearch.mockResolvedValue({ content: [{ type: "text", text: "search" }] });
    mocks.executeList.mockResolvedValue({ content: [{ type: "text", text: "list" }] });
    mocks.executeStatus.mockResolvedValue({ content: [{ type: "text", text: "status" }] });

    const pi = createPi();
    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(pi, {});

    await runtime.handleSessionStart({}, {} as any);
    await Promise.resolve();
    await Promise.resolve();

    const controller = new AbortController();

    await runtime.executeProxyTool("call-1", { action: "auth-start", server: "demo" });
    await runtime.executeProxyTool("call-2", {
      action: "auth-complete",
      server: "demo",
      args: '{"redirectUrl":"http://localhost/callback?code=abc"}',
    });
    await runtime.executeProxyTool("call-3", { tool: "demo_search", args: '{"q":"term"}', server: "demo" }, controller.signal);
    await runtime.executeProxyTool("call-4", { connect: "demo" }, controller.signal);
    await runtime.executeProxyTool("call-5", { describe: "demo_search" });
    await runtime.executeProxyTool("call-6", { search: "demo", regex: true, server: "demo", includeSchemas: false });
    await runtime.executeProxyTool("call-7", { server: "demo" });
    await runtime.executeProxyTool("call-8", {});

    expect(mocks.executeAuthStart).toHaveBeenCalledWith(state, "demo");
    expect(mocks.executeAuthComplete).toHaveBeenCalledWith(state, "demo", "http://localhost/callback?code=abc");
    expect(mocks.executeCall).toHaveBeenCalledWith(
      state,
      "demo_search",
      { q: "term" },
      "demo",
      expect.any(Function),
      controller.signal,
      undefined,
      undefined,
      "call-3",
    );
    expect(mocks.executeCall.mock.calls[0][4]()).toEqual(pi.getAllTools());
    expect(mocks.executeConnect).toHaveBeenCalledWith(state, "demo", controller.signal);
    expect(mocks.executeDescribe).toHaveBeenCalledWith(state, "demo_search", undefined);
    expect(mocks.executeSearch).toHaveBeenCalledWith(state, "demo", true, "demo", false, undefined, undefined, undefined, undefined);
    expect(mocks.executeList).toHaveBeenCalledWith(state, "demo");
    expect(mocks.executeStatus).toHaveBeenCalledWith(state);
  });

  it("keeps session_start non-blocking while initialization continues in the runtime", async () => {
    const pendingInit = createDeferred<any>();
    mocks.initializeMcp.mockReturnValue(pendingInit.promise);

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), {});

    await runtime.handleSessionStart({}, {} as any);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);

    pendingInit.resolve(createState());
    await expect(runtime.waitForInitialization?.()).resolves.toBe("ready");
    await runtime.handleSessionShutdown();
  });

  it("returns one stable timeout result from the runtime-owned initialization budget", async () => {
    vi.useFakeTimers();
    try {
      const pendingInit = createDeferred<any>();
      mocks.initializeMcp.mockReturnValue(pendingInit.promise);

      const { createMcpRuntime } = await import("../mcp-runtime.ts");
      const runtime = createMcpRuntime(createPi(), {});
      await runtime.handleSessionStart({}, {} as any);

      const resultPromise = runtime.executeProxyTool("call-timeout", { tool: "demo_search" });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(resultPromise).resolves.toMatchObject({
        content: [{ text: "MCP initialization is still in progress. Try again shortly." }],
        details: { error: "init_timeout", timeoutMs: 30_000 },
      });

      pendingInit.resolve(createState());
      await expect(runtime.waitForInitialization?.()).resolves.toBe("ready");
      await runtime.handleSessionShutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rethrows proxy-tool cancellation while initialization is still pending", async () => {
    const pendingInit = createDeferred<any>();
    mocks.initializeMcp.mockReturnValue(pendingInit.promise);

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), {});

    await runtime.handleSessionStart({}, {} as any);

    const controller = new AbortController();
    const resultPromise = runtime.executeProxyTool("call-1", { tool: "demo_search" }, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("user cancelled"));

    await expect(resultPromise).rejects.toThrow("user cancelled");
  });

  it("returns init_failed for genuine proxy-tool initialization failures", async () => {
    const pendingInit = createDeferred<any>();
    mocks.initializeMcp.mockReturnValue(pendingInit.promise);

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), {});

    await runtime.handleSessionStart({}, {} as any);

    const resultPromise = runtime.executeProxyTool("call-1", { tool: "demo_search" });
    pendingInit.reject(new Error("boom"));

    await expect(resultPromise).resolves.toMatchObject({
      details: { error: "init_failed", message: "boom" },
    });
  });

  it("delegates direct tool execution to createDirectToolExecutor with runtime state accessors", async () => {
    const state = createState();
    const directResult = { content: [{ type: "text", text: "ok" }] };
    const directExecutor = vi.fn().mockResolvedValue(directResult);
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.createDirectToolExecutor.mockReturnValue(directExecutor);

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), {});
    const spec = {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search demo",
    } as any;
    const ctx = { hasUI: false } as any;

    await runtime.handleSessionStart({}, ctx);
    await Promise.resolve();
    await Promise.resolve();

    const result = await runtime.executeDirectTool(spec, "call-1", { q: "term" }, undefined, undefined, ctx);

    expect(result).toBe(directResult);
    expect(mocks.createDirectToolExecutor).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), spec, false);
    expect(mocks.createDirectToolExecutor.mock.calls[0][0]()).toBe(state);
    expect(mocks.createDirectToolExecutor.mock.calls[0][1]()).toBeNull();
    expect(directExecutor).toHaveBeenCalledWith("call-1", { q: "term" }, undefined, undefined, ctx);
  });

  it("passes the in-flight init promise through direct tool delegation during startup", async () => {
    const pendingInit = createDeferred<any>();
    const directResult = { content: [{ type: "text", text: "ok" }] };
    const directExecutor = vi.fn().mockResolvedValue(directResult);
    mocks.initializeMcp.mockReturnValue(pendingInit.promise);
    mocks.createDirectToolExecutor.mockReturnValue(directExecutor);

    const { createMcpRuntime } = await import("../mcp-runtime.ts");
    const runtime = createMcpRuntime(createPi(), {});
    const spec = {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search demo",
    } as any;
    const ctx = { hasUI: false } as any;
    const signal = new AbortController().signal;
    const onUpdate = vi.fn();

    await runtime.handleSessionStart({}, ctx);
    const resultPromise = runtime.executeDirectTool(spec, "call-2", { q: "term" }, signal, onUpdate, ctx);

    expect(mocks.createDirectToolExecutor).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), spec, false);
    expect(mocks.createDirectToolExecutor.mock.calls[0][0]()).toBeNull();
    expect(mocks.createDirectToolExecutor.mock.calls[0][1]()).toBe(pendingInit.promise);

    pendingInit.resolve(createState());
    await expect(resultPromise).resolves.toBe(directResult);
    expect(directExecutor).toHaveBeenCalledWith("call-2", { q: "term" }, signal, onUpdate, ctx);
  });
});
