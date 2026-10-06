import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtime: null as any,
  createMcpRuntime: vi.fn(() => mocks.runtime),
  loadMcpConfig: vi.fn(() => ({ mcpServers: {} })),
  cloneMcpConfig: vi.fn((config: unknown) => structuredClone(config)),
  resolveConfiguredClaudePluginMcp: vi.fn((config: unknown) => structuredClone(config)),
  getLegacyMcpMigrationNotices: vi.fn(() => []),
  setPiMcpConfigEnabled: vi.fn(),
  discoverConfiguredClaudePluginSkills: vi.fn(() => []),
  loadMetadataCache: vi.fn(() => null),
  getMissingConfiguredDirectToolServers: vi.fn(() => []),
  resolveDirectTools: vi.fn(() => []),
}));

vi.mock("../mcp-runtime.ts", () => ({ createMcpRuntime: mocks.createMcpRuntime }));
vi.mock("../config.ts", () => ({
  loadMcpConfig: mocks.loadMcpConfig,
  cloneMcpConfig: mocks.cloneMcpConfig,
  resolveConfiguredClaudePluginMcp: mocks.resolveConfiguredClaudePluginMcp,
  getLegacyMcpMigrationNotices: mocks.getLegacyMcpMigrationNotices,
  setPiMcpConfigEnabled: mocks.setPiMcpConfigEnabled,
  discoverConfiguredClaudePluginSkills: mocks.discoverConfiguredClaudePluginSkills,
}));
vi.mock("../metadata-cache.ts", () => ({ loadMetadataCache: mocks.loadMetadataCache }));
vi.mock("../direct-tool-surface.ts", () => ({
  buildProxyDescription: vi.fn(() => "MCP gateway"),
  getLargeDirectToolsAdvisory: vi.fn(() => undefined),
  getMissingConfiguredDirectToolServers: mocks.getMissingConfiguredDirectToolServers,
  prepareDirectToolArguments: vi.fn((_schema: unknown, args: unknown) => args),
  resolveDirectTools: mocks.resolveDirectTools,
}));
vi.mock("../startup-mcp-facade.ts", () => ({
  createMcpDirectToolCallRenderer: vi.fn(() => vi.fn()),
  getDirectToolParametersSchema: vi.fn(() => ({ type: "object", properties: {} })),
  MCP_PROXY_TOOL_PARAMETERS_SCHEMA: { type: "object", properties: {} },
  renderMcpToolResult: vi.fn(),
}));
vi.mock("../tool-result-renderer.ts", () => ({
  createMcpProxyToolCallRenderer: vi.fn(() => vi.fn()),
  createMcpScriptToolCallRenderer: vi.fn(() => vi.fn()),
  resolveMcpToolRenderOptions: vi.fn(() => ({ resultRendering: "compact" })),
}));
vi.mock("../namespace-tools.ts", () => ({
  syncNamespaceProxyTools: vi.fn(() => ({ added: [], updated: [], deactivated: [] })),
}));
vi.mock("../prompts.ts", () => ({
  createPromptCommand: vi.fn(() => ({ handler: vi.fn() })),
  McpInitializationPendingError: class McpInitializationPendingError extends Error {},
  MCP_INITIALIZATION_PENDING_MESSAGE: "MCP initialization is still in progress. Try again shortly.",
  resolveCachedPrompts: vi.fn(() => []),
}));
vi.mock("../utils.ts", () => ({
  formatMcpFooterStatus: vi.fn(() => undefined),
  getConfigPathFromArgv: vi.fn(() => undefined),
  truncateAtWord: vi.fn((text: string) => text),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createPi() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  let activeTools: string[] = [];
  const api = {
    registerTool: vi.fn((tool: any) => {
      tools.set(tool.name, tool);
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    }),
    registerFlag: vi.fn(),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    on: vi.fn((event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler)),
    getAllTools: vi.fn(() => [...tools.values()].map(tool => ({ name: tool.name }))),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((next: string[]) => { activeTools = [...next]; }),
    events: { on: vi.fn(), emit: vi.fn() },
  } as any;
  return { api, handlers, tools, commands };
}

async function loadAdapter() {
  const { default: adapter } = await import("../index.ts");
  const pi = createPi();
  adapter(pi.api);
  return pi;
}

function makeRuntime() {
  return {
    handleSessionStart: vi.fn().mockResolvedValue(undefined),
    waitForInitialization: vi.fn().mockResolvedValue("ready" as const),
    handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
    handleMcpCommand: vi.fn().mockResolvedValue(undefined),
    handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
    executeProxyTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
    executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
  };
}

describe("facade startup request budget", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.runtime = makeRuntime();
    mocks.createMcpRuntime.mockReset().mockImplementation(() => mocks.runtime);
    mocks.loadMcpConfig.mockReset().mockReturnValue({ mcpServers: {} });
    mocks.cloneMcpConfig.mockReset().mockImplementation((config: unknown) => structuredClone(config));
    mocks.resolveConfiguredClaudePluginMcp.mockReset().mockImplementation((config: unknown) => structuredClone(config));
    mocks.loadMetadataCache.mockReset().mockReturnValue(null);
    mocks.getMissingConfiguredDirectToolServers.mockReset().mockReturnValue([]);
    mocks.resolveDirectTools.mockReset().mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("uses one 30000ms budget across startup and initialization", async () => {
    vi.useFakeTimers();
    const startup = deferred<void>();
    const initialization = deferred<"ready">();
    mocks.runtime.handleSessionStart.mockReturnValue(startup.promise);
    mocks.runtime.waitForInitialization.mockReturnValue(initialization.promise);

    const { api, handlers, tools } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });
    const resultPromise = tools.get("mcp").execute("budget", {}, undefined, undefined, { hasUI: false });

    await vi.waitFor(() => expect(mocks.runtime.handleSessionStart).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10_000);
    startup.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.runtime.waitForInitialization.mock.calls[0][1]).toBeGreaterThan(19_000);
    expect(mocks.runtime.waitForInitialization.mock.calls[0][1]).toBeLessThanOrEqual(20_000);

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(resultPromise).resolves.toMatchObject({ details: { error: "init_timeout", timeoutMs: 30_000 } });
    expect(mocks.runtime.executeProxyTool).not.toHaveBeenCalled();
    initialization.resolve("ready");
    void api;
  });

  it("returns pending when retry trust remains unanswered within the remaining budget", async () => {
    vi.useFakeTimers();
    const retryStartup = deferred<void>();
    const retryInitialization = deferred<"ready">();
    mocks.runtime.handleSessionStart
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => retryStartup.promise);
    mocks.runtime.waitForInitialization
      .mockRejectedValueOnce(new Error("first initialization failed"))
      .mockReturnValueOnce(retryInitialization.promise);

    const { handlers, tools } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });
    const resultPromise = tools.get("mcp").execute("retry-budget", {}, undefined, undefined, { hasUI: false });

    await vi.waitFor(() => expect(mocks.runtime.handleSessionStart).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(20_000);
    retryStartup.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.runtime.waitForInitialization).toHaveBeenNthCalledWith(2, undefined, Number.POSITIVE_INFINITY);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(resultPromise).resolves.toMatchObject({ details: { error: "init_timeout", timeoutMs: 30_000 } });
    expect((await resultPromise).details.error).not.toBe("init_failed");
    retryInitialization.resolve("ready");
  });

  it("shares startup while giving concurrent requests independent deadlines", async () => {
    vi.useFakeTimers();
    const startup = deferred<void>();
    const initialization = deferred<"ready">();
    mocks.runtime.handleSessionStart.mockReturnValue(startup.promise);
    mocks.runtime.waitForInitialization.mockReturnValue(initialization.promise);

    const { handlers, tools } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });
    const first = tools.get("mcp").execute("first", {}, undefined, undefined, { hasUI: false });
    await vi.waitFor(() => expect(mocks.runtime.handleSessionStart).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10_000);
    const second = tools.get("mcp").execute("second", {}, undefined, undefined, { hasUI: false });
    await vi.advanceTimersByTimeAsync(10_000);
    startup.resolve();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(first).resolves.toMatchObject({ details: { error: "init_timeout" } });
    expect(second).toBeDefined();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(second).resolves.toMatchObject({ details: { error: "init_timeout" } });

    expect(mocks.runtime.handleSessionStart).toHaveBeenCalledTimes(1);
    const waitBudgets = mocks.runtime.waitForInitialization.mock.calls.map((call: any[]) => call[1]).sort((a: number, b: number) => a - b);
    expect(waitBudgets[0]).toBeGreaterThan(9_000);
    expect(waitBudgets[0]).toBeLessThanOrEqual(10_000);
    expect(waitBudgets[1]).toBeGreaterThan(19_000);
    expect(waitBudgets[1]).toBeLessThanOrEqual(20_000);
    initialization.resolve("ready");
  });

  it("rethrows caller abort without cancelling shared startup", async () => {
    const startup = deferred<void>();
    mocks.runtime.handleSessionStart.mockReturnValue(startup.promise);

    const { handlers, tools } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });
    const controller = new AbortController();
    const cancelled = tools.get("mcp").execute("cancelled", {}, controller.signal, undefined, { hasUI: false });
    await vi.waitFor(() => expect(mocks.runtime.handleSessionStart).toHaveBeenCalledTimes(1));
    controller.abort(new Error("caller cancelled"));
    await expect(cancelled).rejects.toThrow("caller cancelled");

    const survivor = tools.get("mcp").execute("survivor", {}, undefined, undefined, { hasUI: false });
    startup.resolve();
    await expect(survivor).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(mocks.runtime.handleSessionStart).toHaveBeenCalledTimes(1);
  });

  it("keeps zero-server null-cache startup lightweight", async () => {
    const { handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });
    expect(mocks.createMcpRuntime).not.toHaveBeenCalled();
  });
});
