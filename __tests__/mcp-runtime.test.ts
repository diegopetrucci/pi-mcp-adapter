import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initializeMcp: vi.fn(),
  updateStatusBar: vi.fn(),
  flushMetadataCache: vi.fn(),
  initializeOAuth: vi.fn().mockResolvedValue(undefined),
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
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
    mocks.shutdownOAuth.mockResolvedValue(undefined);
    mocks.createDirectToolExecutor.mockReturnValue(vi.fn().mockResolvedValue({ content: [] }));
  });

  afterEach(() => {
    vi.clearAllMocks();
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
    expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(1);

    await runtime.handleSessionStart({}, {} as any);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(2);

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
    await runtime.handleMcpCommand("logout oauth-server", ctx);
    await runtime.handleMcpCommand("", ctx);

    expect(mocks.reconnectServers).toHaveBeenCalledWith(state, ctx, "demo");
    expect(mocks.showTools).toHaveBeenCalledWith(state, ctx);
    expect(mocks.openMcpSetup).toHaveBeenCalledWith(state, expect.any(Object), ctx, "/tmp/mcp.json", "setup");
    expect(ctx.reload).toHaveBeenCalledTimes(1);
    expect(mocks.logoutServer).toHaveBeenCalledWith("oauth-server", state, ctx);
    expect(mocks.openMcpPanel).toHaveBeenCalledWith(state, expect.any(Object), ctx, "/tmp/mcp.json");
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
    expect(mocks.authenticateServer).toHaveBeenCalledWith("github", state.config, ctx);
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

    await runtime.executeProxyTool("call-1", { action: "auth-start", server: "demo" });
    await runtime.executeProxyTool("call-2", {
      action: "auth-complete",
      server: "demo",
      args: '{"redirectUrl":"http://localhost/callback?code=abc"}',
    });
    await runtime.executeProxyTool("call-3", { tool: "demo_search", args: '{"q":"term"}', server: "demo" });
    await runtime.executeProxyTool("call-4", { connect: "demo" });
    await runtime.executeProxyTool("call-5", { describe: "demo_search" });
    await runtime.executeProxyTool("call-6", { search: "demo", regex: true, server: "demo", includeSchemas: false });
    await runtime.executeProxyTool("call-7", { server: "demo" });
    await runtime.executeProxyTool("call-8", {});

    expect(mocks.executeAuthStart).toHaveBeenCalledWith(state, "demo");
    expect(mocks.executeAuthComplete).toHaveBeenCalledWith(state, "demo", "http://localhost/callback?code=abc");
    expect(mocks.executeCall).toHaveBeenCalledWith(state, "demo_search", { q: "term" }, "demo", expect.any(Function));
    expect(mocks.executeCall.mock.calls[0][4]()).toEqual(pi.getAllTools());
    expect(mocks.executeConnect).toHaveBeenCalledWith(state, "demo");
    expect(mocks.executeDescribe).toHaveBeenCalledWith(state, "demo_search");
    expect(mocks.executeSearch).toHaveBeenCalledWith(state, "demo", true, "demo", false);
    expect(mocks.executeList).toHaveBeenCalledWith(state, "demo");
    expect(mocks.executeStatus).toHaveBeenCalledWith(state);
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
    expect(mocks.createDirectToolExecutor).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), spec);
    expect(mocks.createDirectToolExecutor.mock.calls[0][0]()).toBe(state);
    expect(mocks.createDirectToolExecutor.mock.calls[0][1]()).toBeNull();
    expect(directExecutor).toHaveBeenCalledWith("call-1", { q: "term" }, undefined, undefined, ctx);
  });
});
