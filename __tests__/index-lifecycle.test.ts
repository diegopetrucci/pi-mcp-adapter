import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  return {
    handlers,
    api: {
      registerTool: vi.fn(),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler);
      }),
      getAllTools: vi.fn(() => []),
    } as any,
  };
}

async function importFacade() {
  const mod = await import("../index.ts");
  return mod.default;
}

describe("index facade lifecycle", () => {
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.MCP_DIRECT_TOOLS;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unmock("../mcp-runtime.ts");
    vi.unmock("../commands.ts");
    vi.unmock("../init.ts");
    vi.unmock("../proxy-modes.ts");
    vi.unmock("../direct-tools.ts");
    vi.unmock("../mcp-auth-flow.ts");
    if (originalDirectTools === undefined) {
      delete process.env.MCP_DIRECT_TOOLS;
    } else {
      process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    }
  });

  function mockCommonModules({
    config = { mcpServers: {} },
    missingConfiguredDirectToolServers = [],
    directSpecs = [{
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search demo",
    }],
  }: {
    config?: any;
    missingConfiguredDirectToolServers?: string[];
    directSpecs?: any[];
  } = {}) {
    vi.doMock("../config.ts", () => ({
      loadMcpConfig: vi.fn(() => config),
    }));
    vi.doMock("../metadata-cache.ts", () => ({
      loadMetadataCache: vi.fn(() => ({ servers: {} })),
    }));
    vi.doMock("../startup-mcp-facade.ts", () => ({
      buildProxyDescription: vi.fn(() => "MCP gateway"),
      createMcpDirectToolCallRenderer: vi.fn(() => vi.fn()),
      getDirectToolParametersSchema: vi.fn(() => ({ type: "object", properties: {} })),
      getMissingConfiguredDirectToolServers: vi.fn(() => missingConfiguredDirectToolServers),
      MCP_PROXY_TOOL_PARAMETERS_SCHEMA: { type: "object", properties: {} },
      renderMcpProxyToolCall: vi.fn(),
      renderMcpToolResult: vi.fn(),
      resolveDirectTools: vi.fn(() => directSpecs),
    }));
    vi.doMock("../utils.ts", () => ({
      getConfigPathFromArgv: vi.fn(() => "/tmp/custom-mcp.json"),
      truncateAtWord: vi.fn((text: string) => text),
    }));
  }

  it("registers commands and tools without statically importing the heavy runtime graph", async () => {
    const imported = {
      runtime: false,
      commands: false,
      init: false,
      proxyModes: false,
      directTools: false,
      authFlow: false,
    };

    vi.doMock("../commands.ts", () => {
      imported.commands = true;
      return {};
    });
    vi.doMock("../init.ts", () => {
      imported.init = true;
      return {};
    });
    vi.doMock("../proxy-modes.ts", () => {
      imported.proxyModes = true;
      return {};
    });
    vi.doMock("../direct-tools.ts", () => {
      imported.directTools = true;
      return {};
    });
    vi.doMock("../mcp-auth-flow.ts", () => {
      imported.authFlow = true;
      return {};
    });
    vi.doMock("../mcp-runtime.ts", () => {
      imported.runtime = true;
      return {
        createMcpRuntime: vi.fn(() => ({
          handleSessionStart: vi.fn(),
          handleSessionShutdown: vi.fn(),
          handleMcpCommand: vi.fn(),
          handleMcpAuthCommand: vi.fn(),
          executeProxyTool: vi.fn(),
          executeDirectTool: vi.fn(),
        })),
      };
    });
    mockCommonModules({
      config: {
        mcpServers: {
          demo: { command: "npx", args: ["-y", "demo-server"], directTools: true, lifecycle: "lazy" },
        },
      },
      missingConfiguredDirectToolServers: ["demo"],
    });

    const mcpAdapter = await importFacade();
    const { api } = createPi();
    mcpAdapter(api);

    expect(api.registerFlag).toHaveBeenCalledWith("mcp-config", expect.any(Object));
    expect(api.registerCommand).toHaveBeenCalledWith("mcp", expect.any(Object));
    expect(api.registerCommand).toHaveBeenCalledWith("mcp-auth", expect.any(Object));
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search" }));
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
    expect(imported).toEqual({
      runtime: false,
      commands: false,
      init: false,
      proxyModes: false,
      directTools: false,
      authFlow: false,
    });
  });

  it("does not import the runtime on default all-lazy cached session_start and skips shutdown import", async () => {
    const createMcpRuntime = vi.fn();
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime }));
    mockCommonModules({
      config: {
        mcpServers: {
          demo: { command: "npx", args: ["-y", "demo-server"], lifecycle: "lazy", directTools: true },
        },
      },
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    await handlers.get("session_start")?.({ reason: "test" }, { hasUI: false });
    await handlers.get("session_shutdown")?.();

    expect(createMcpRuntime).not.toHaveBeenCalled();
  });

  it.each(["eager", "keep-alive"])("imports and starts the runtime on %s session_start", async (lifecycle) => {
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    const createMcpRuntime = vi.fn(() => runtime);
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime }));
    mockCommonModules({
      config: {
        mcpServers: {
          demo: { command: "npx", args: ["-y", "demo-server"], lifecycle },
        },
      },
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ctx = { hasUI: false } as any;
    await handlers.get("session_start")?.({ reason: lifecycle }, ctx);

    expect(createMcpRuntime).toHaveBeenCalledWith(api, { earlyConfigPath: "/tmp/custom-mcp.json" });
    expect(runtime.handleSessionStart).toHaveBeenCalledWith({ reason: lifecycle }, ctx);
  });

  it("imports and starts the runtime on session_start when configured direct-tool metadata is missing", async () => {
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    const createMcpRuntime = vi.fn(() => runtime);
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime }));
    mockCommonModules({
      config: {
        mcpServers: {
          demo: { command: "npx", args: ["-y", "demo-server"], lifecycle: "lazy", directTools: true },
        },
      },
      missingConfiguredDirectToolServers: ["demo"],
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ctx = { hasUI: false } as any;
    await handlers.get("session_start")?.({ reason: "cache-miss" }, ctx);

    expect(createMcpRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.handleSessionStart).toHaveBeenCalledWith({ reason: "cache-miss" }, ctx);
  });

  it("does not import the runtime on session_start for missing direct-tool metadata when direct-tool bootstrap is disabled", async () => {
    process.env.MCP_DIRECT_TOOLS = "__none__";

    const createMcpRuntime = vi.fn();
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime }));
    mockCommonModules({
      config: {
        mcpServers: {
          demo: { command: "npx", args: ["-y", "demo-server"], lifecycle: "lazy", directTools: true },
        },
      },
      missingConfiguredDirectToolServers: ["demo"],
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ctx = { hasUI: false } as any;
    await handlers.get("session_start")?.({ reason: "cache-miss" }, ctx);

    expect(createMcpRuntime).not.toHaveBeenCalled();
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
  });

  it("initializes on demand using the saved session_start context before routing commands", async () => {
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    const createMcpRuntime = vi.fn(() => runtime);
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime }));
    mockCommonModules({
      config: {
        mcpServers: {
          demo: { command: "npx", args: ["-y", "demo-server"], lifecycle: "lazy", directTools: true },
        },
      },
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionCtx = { hasUI: false, marker: "session" } as any;
    await handlers.get("session_start")?.({ reason: "saved" }, sessionCtx);

    const mcpCommand = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    const commandCtx = { hasUI: false, marker: "command" } as any;
    await mcpCommand.handler("status", commandCtx);

    expect(runtime.handleSessionStart).toHaveBeenCalledWith({ reason: "saved" }, sessionCtx);
    expect(runtime.handleMcpCommand).toHaveBeenCalledWith("status", commandCtx);
    expect(runtime.handleSessionStart.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.handleMcpCommand.mock.invocationCallOrder[0],
    );
  });

  it("reuses the loaded runtime on a second all-lazy session_start without re-importing it", async () => {
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    const createMcpRuntime = vi.fn(() => runtime);
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime }));
    mockCommonModules({
      config: {
        mcpServers: {
          demo: { command: "npx", args: ["-y", "demo-server"], lifecycle: "lazy", directTools: true },
        },
      },
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const firstCtx = { hasUI: false, marker: "first-session" } as any;
    await handlers.get("session_start")?.({ reason: "saved" }, firstCtx);

    const mcpCommand = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await mcpCommand.handler("status", { hasUI: false, marker: "command" });

    const secondCtx = { hasUI: false, marker: "second-session" } as any;
    await handlers.get("session_start")?.({ reason: "replacement" }, secondCtx);

    expect(createMcpRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.handleSessionStart).toHaveBeenCalledTimes(2);
    expect(runtime.handleSessionStart).toHaveBeenNthCalledWith(1, { reason: "saved" }, firstCtx);
    expect(runtime.handleSessionStart).toHaveBeenNthCalledWith(2, { reason: "replacement" }, secondCtx);
  });

  it("does not import or start the runtime for no-arg mcp-auth without UI", async () => {
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    const createMcpRuntime = vi.fn(() => runtime);
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime }));
    mockCommonModules({
      config: {
        mcpServers: {
          demo: { command: "npx", args: ["-y", "demo-server"], lifecycle: "lazy", directTools: true },
        },
      },
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionCtx = { hasUI: false, marker: "session" } as any;
    await handlers.get("session_start")?.({ reason: "saved" }, sessionCtx);

    const mcpAuthCommand = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    const commandCtx = { hasUI: false, marker: "command" } as any;
    await mcpAuthCommand.handler("   ", commandCtx);

    expect(createMcpRuntime).not.toHaveBeenCalled();
    expect(runtime.handleSessionStart).not.toHaveBeenCalled();
    expect(runtime.handleMcpAuthCommand).not.toHaveBeenCalled();
  });

  it("shares one on-demand startup across concurrent command, proxy, and direct-tool calls", async () => {
    const startup = deferred<void>();
    const runtime = {
      handleSessionStart: vi.fn(() => startup.promise),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    const createMcpRuntime = vi.fn(() => runtime);
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime }));
    mockCommonModules({
      config: {
        mcpServers: {
          demo: { command: "npx", args: ["-y", "demo-server"], lifecycle: "lazy", directTools: true },
        },
      },
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ctx = { hasUI: false } as any;
    await handlers.get("session_start")?.({ reason: "saved" }, ctx);

    const mcpCommand = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    const directTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "demo_search")?.[0];

    const pending = [
      mcpCommand.handler("status", ctx),
      proxyTool.execute("call-1", { tool: "demo_search", args: "{}" }, undefined, undefined, ctx),
      directTool.execute("call-2", { q: "value" }, undefined, undefined, ctx),
    ];

    await vi.waitFor(() => {
      expect(runtime.handleSessionStart).toHaveBeenCalledTimes(1);
    });
    expect(runtime.handleMcpCommand).not.toHaveBeenCalled();
    expect(runtime.executeProxyTool).not.toHaveBeenCalled();
    expect(runtime.executeDirectTool).not.toHaveBeenCalled();

    startup.resolve();
    await Promise.all(pending);

    expect(runtime.handleSessionStart).toHaveBeenCalledTimes(1);
    expect(runtime.handleMcpCommand).toHaveBeenCalledTimes(1);
    expect(runtime.executeProxyTool).toHaveBeenCalledTimes(1);
    expect(runtime.executeDirectTool).toHaveBeenCalledTimes(1);
  });

  it("delegates shutdown cleanup once the runtime has been loaded", async () => {
    const startup = deferred<void>();
    const runtime = {
      handleSessionStart: vi.fn(() => startup.promise),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    const createMcpRuntime = vi.fn(() => runtime);
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime }));
    mockCommonModules({
      config: {
        mcpServers: {
          demo: { command: "npx", args: ["-y", "demo-server"], lifecycle: "lazy", directTools: true },
        },
      },
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ctx = { hasUI: false } as any;
    await handlers.get("session_start")?.({ reason: "saved" }, ctx);

    const mcpCommand = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    const commandPromise = mcpCommand.handler("status", ctx);
    await vi.waitFor(() => {
      expect(runtime.handleSessionStart).toHaveBeenCalledTimes(1);
    });

    const shutdownPromise = handlers.get("session_shutdown")?.();
    startup.resolve();

    await Promise.all([commandPromise, shutdownPromise]);

    expect(createMcpRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.handleSessionShutdown).toHaveBeenCalledTimes(1);
  });

  it("starts the new session after shutdown even if a stale startup promise resolves later", async () => {
    const firstStartup = deferred<void>();
    const runtime = {
      handleSessionStart: vi.fn()
        .mockImplementationOnce(() => firstStartup.promise)
        .mockResolvedValue(undefined),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    const createMcpRuntime = vi.fn(() => runtime);
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime }));
    mockCommonModules({
      config: {
        mcpServers: {
          demo: { command: "npx", args: ["-y", "demo-server"], lifecycle: "lazy", directTools: true },
        },
      },
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const mcpCommand = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    const firstSessionCtx = { hasUI: false, marker: "session-1" } as any;
    await handlers.get("session_start")?.({ reason: "session-1" }, firstSessionCtx);

    const firstCommandPromise = mcpCommand.handler("status-1", firstSessionCtx);
    await vi.waitFor(() => {
      expect(runtime.handleSessionStart).toHaveBeenCalledTimes(1);
    });

    await handlers.get("session_shutdown")?.();

    const secondSessionCtx = { hasUI: false, marker: "session-2" } as any;
    await handlers.get("session_start")?.({ reason: "session-2" }, secondSessionCtx);

    firstStartup.resolve();
    await firstCommandPromise;

    await mcpCommand.handler("status-2", secondSessionCtx);

    expect(runtime.handleSessionStart).toHaveBeenCalledTimes(2);
    expect(runtime.handleSessionStart).toHaveBeenNthCalledWith(1, { reason: "session-1" }, firstSessionCtx);
    expect(runtime.handleSessionStart).toHaveBeenNthCalledWith(2, { reason: "session-2" }, secondSessionCtx);
    expect(runtime.handleMcpCommand).toHaveBeenNthCalledWith(2, "status-2", secondSessionCtx);
    expect(runtime.handleSessionStart.mock.invocationCallOrder[1]).toBeLessThan(
      runtime.handleMcpCommand.mock.invocationCallOrder[1],
    );
  });

  it("skips the proxy tool once direct tools are fully available", async () => {
    mockCommonModules({
      config: {
        mcpServers: {
          demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
        },
        settings: { disableProxyTool: true },
      },
    });

    const mcpAdapter = await importFacade();
    const { api } = createPi();
    mcpAdapter(api);

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search" }));
    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
  });
});
