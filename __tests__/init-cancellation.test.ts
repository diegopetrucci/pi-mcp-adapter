import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  loadMcpConfig: vi.fn(),
  managerFactory: vi.fn(),
  lifecycleFactory: vi.fn(),
  saveMetadataCache: vi.fn(),
  loadMetadataCache: vi.fn(() => ({ version: 1, servers: {} })),
  isServerCacheValid: vi.fn(() => false),
  reconstructToolMetadata: vi.fn(() => []),
  buildToolMetadata: vi.fn(() => ({ metadata: [], failedTools: [] })),
  totalToolCount: vi.fn(() => 0),
  getMissingConfiguredDirectToolServers: vi.fn(() => []),
  parallelLimit: vi.fn(async (items: any[], _limit: number, mapper: (item: any) => Promise<any>) => Promise.all(items.map(mapper))),
  loggerDebug: vi.fn(),
}));

vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("../config.ts", () => ({ loadMcpConfig: mocks.loadMcpConfig }));
vi.mock("../server-manager.ts", () => ({ McpServerManager: mocks.managerFactory }));
vi.mock("../lifecycle.ts", () => ({ McpLifecycleManager: mocks.lifecycleFactory }));
vi.mock("../ui-resource-handler.ts", () => ({ UiResourceHandler: vi.fn(() => ({})) }));
vi.mock("../consent-manager.ts", () => ({ ConsentManager: vi.fn(() => ({})) }));
vi.mock("../metadata-cache.ts", () => ({
  computeServerHash: vi.fn(),
  getMetadataCachePath: vi.fn(() => "/tmp/mcp-cache.json"),
  isServerCacheValid: mocks.isServerCacheValid,
  loadMetadataCache: mocks.loadMetadataCache,
  reconstructToolMetadata: mocks.reconstructToolMetadata,
  saveMetadataCache: mocks.saveMetadataCache,
  serializeResources: vi.fn(() => []),
  serializeTools: vi.fn(() => []),
}));
vi.mock("../tool-metadata.ts", () => ({
  buildToolMetadata: mocks.buildToolMetadata,
  totalToolCount: mocks.totalToolCount,
}));
vi.mock("../utils.ts", () => ({
  openUrl: vi.fn(),
  parallelLimit: mocks.parallelLimit,
}));
vi.mock("../direct-tools.ts", () => ({
  getMissingConfiguredDirectToolServers: mocks.getMissingConfiguredDirectToolServers,
}));
vi.mock("../logger.ts", () => ({ logger: { debug: mocks.loggerDebug } }));

function createManager(connectImpl: (name: string, definition: unknown, signal?: AbortSignal) => Promise<unknown>) {
  return {
    setDefaultRequestTimeoutMs: vi.fn(),
    setSamplingConfig: vi.fn(),
    setElicitationConfig: vi.fn(),
    connect: vi.fn(connectImpl),
    getConnection: vi.fn(() => undefined),
    getAllConnections: vi.fn(() => new Map()),
    touch: vi.fn(),
    incrementInFlight: vi.fn(),
    decrementInFlight: vi.fn(),
  };
}

function createLifecycle() {
  return {
    setGlobalIdleTimeout: vi.fn(),
    registerServer: vi.fn(),
    markKeepAlive: vi.fn(),
    setReconnectCallback: vi.fn(),
    setIdleShutdownCallback: vi.fn(),
    startHealthChecks: vi.fn(),
  };
}

function extensionApi() {
  return { getFlag: vi.fn() } as any;
}

describe("initializeMcp cancellation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.MCP_DIRECT_TOOLS;
    mocks.existsSync.mockReturnValue(true);
    mocks.loadMetadataCache.mockReturnValue({ version: 1, servers: {} });
    mocks.isServerCacheValid.mockReturnValue(false);
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue([]);
    mocks.buildToolMetadata.mockReturnValue({ metadata: [], failedTools: [] });
    mocks.totalToolCount.mockReturnValue(0);
  });

  it("rethrows startup connect aborts without failure notifications or console errors", async () => {
    const controller = new AbortController();
    const abortError = new Error("user cancelled");
    const manager = createManager(async (_name, _definition, signal) => {
      controller.abort(abortError);
      signal?.throwIfAborted();
      return { status: "connected", tools: [], resources: [] };
    });
    const lifecycle = createLifecycle();
    mocks.managerFactory.mockImplementation(() => manager);
    mocks.lifecycleFactory.mockImplementation(() => lifecycle);
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: { demo: { command: "node", args: ["server.js"], lifecycle: "eager" } },
      settings: {},
    });

    const ui = { setStatus: vi.fn(), notify: vi.fn() };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { initializeMcp } = await import("../init.ts");

    await expect(initializeMcp(extensionApi(), { cwd: "/tmp", hasUI: true, ui, signal: controller.signal } as any)).rejects.toThrow("user cancelled");
    expect(ui.notify).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("rethrows direct-bootstrap aborts without logging bootstrap failures", async () => {
    process.env.MCP_DIRECT_TOOLS = "1";
    const controller = new AbortController();
    const abortError = new Error("user cancelled");
    const manager = createManager(async (_name, _definition, signal) => {
      controller.abort(abortError);
      signal?.throwIfAborted();
      return { status: "connected", tools: [], resources: [] };
    });
    const lifecycle = createLifecycle();
    mocks.managerFactory.mockImplementation(() => manager);
    mocks.lifecycleFactory.mockImplementation(() => lifecycle);
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["demo"]);
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: { demo: { command: "node", args: ["server.js"], lifecycle: "lazy" } },
      settings: {},
    });

    const ui = { setStatus: vi.fn(), notify: vi.fn() };
    const { initializeMcp } = await import("../init.ts");

    await expect(initializeMcp(extensionApi(), { cwd: "/tmp", hasUI: true, ui, signal: controller.signal } as any)).rejects.toThrow("user cancelled");
    expect(mocks.loggerDebug).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("direct tools"), "info");
  });
});
