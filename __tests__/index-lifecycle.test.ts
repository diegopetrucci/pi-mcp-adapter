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

function trackActiveTools(api: any, initial: string[] = ["bash"]): () => string[] {
  const registered = new Set<string>();
  let active = [...initial];
  api.registerTool.mockImplementation((tool: { name: string }) => {
    if (registered.has(tool.name)) return;
    registered.add(tool.name);
    active.push(tool.name);
  });
  api.getAllTools.mockImplementation(() => [...registered].map(name => ({ name })));
  api.getActiveTools = vi.fn(() => [...active]);
  api.setActiveTools = vi.fn((names: string[]) => {
    active = [...names];
  });
  return () => [...active];
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
    cache = { servers: {} },
    missingConfiguredDirectToolServers = [],
    directSpecs = [{
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search demo",
    }],
    loadMcpConfigImpl,
    loadMetadataCacheImpl,
    getMissingConfiguredDirectToolServersImpl,
    resolveDirectToolsImpl,
  }: {
    config?: any;
    cache?: any;
    missingConfiguredDirectToolServers?: string[];
    directSpecs?: any[];
    loadMcpConfigImpl?: (...args: any[]) => any;
    loadMetadataCacheImpl?: (...args: any[]) => any;
    getMissingConfiguredDirectToolServersImpl?: (...args: any[]) => any;
    resolveDirectToolsImpl?: (...args: any[]) => any;
  } = {}) {
    const loadMcpConfig = vi.fn(loadMcpConfigImpl ?? (() => config));
    const loadMetadataCache = vi.fn(loadMetadataCacheImpl ?? (() => cache));
    const getMissingConfiguredDirectToolServers = vi.fn(
      getMissingConfiguredDirectToolServersImpl ?? (() => missingConfiguredDirectToolServers),
    );

    vi.doMock("../config.ts", () => ({
      loadMcpConfig,
      discoverConfiguredClaudePluginSkills: vi.fn(() => []),
    }));
    vi.doMock("../metadata-cache.ts", () => ({
      loadMetadataCache,
      getMissingConfiguredDirectToolServers,
    }));
    const resolveDirectTools = vi.fn(resolveDirectToolsImpl ?? (() => directSpecs));
    vi.doMock("../startup-mcp-facade.ts", () => ({
      buildProxyDescription: vi.fn(() => "MCP gateway"),
      createMcpDirectToolCallRenderer: vi.fn(() => vi.fn()),
      getDirectToolParametersSchema: vi.fn(() => ({ type: "object", properties: {} })),
      MCP_PROXY_TOOL_PARAMETERS_SCHEMA: { type: "object", properties: {} },
      renderMcpProxyToolCall: vi.fn(),
      renderMcpToolResult: vi.fn(),
      resolveDirectTools,
    }));
    vi.doMock("../utils.ts", () => ({
      getConfigPathFromArgv: vi.fn(() => "/tmp/custom-mcp.json"),
      truncateAtWord: vi.fn((text: string) => text),
    }));

    return {
      loadMcpConfig,
      loadMetadataCache,
      getMissingConfiguredDirectToolServers,
      resolveDirectTools,
    };
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
    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "mcpScript" }));
    expect(imported).toEqual({
      runtime: false,
      commands: false,
      init: false,
      proxyModes: false,
      directTools: false,
      authFlow: false,
    });
  });

  it("registers scripting only when explicitly enabled and keeps its skill opt-in", async () => {
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
      executeScript: vi.fn().mockResolvedValue({ content: [] }),
    };
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime: vi.fn(() => runtime) }));
    mockCommonModules({ config: { settings: { scriptMode: true }, mcpServers: {} } });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const script = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcpScript")?.[0];
    expect(script).toBeDefined();
    expect(script.description).not.toMatch(/URL|install|Jev|TypeSafe|server list|disabled/i);
    expect(await handlers.get("resources_discover")?.({ cwd: "/repo/session" })).toEqual({
      skillPaths: [expect.stringContaining("skills/mcp-scripting/SKILL.md")],
    });
    await script.execute("script-1", { code: "return 1;" }, undefined, undefined, { hasUI: false } as any);
    expect(runtime.executeScript).toHaveBeenCalledWith({ code: "return 1;" }, undefined, expect.anything());
  });

  it("hides the scripting skill when scripting is disabled", async () => {
    mockCommonModules({ config: { settings: {}, mcpServers: {} } });
    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "mcpScript" }));
    expect(await handlers.get("resources_discover")?.({ cwd: "/repo/session" })).toBeUndefined();
  });

  it("synchronizes scripting registration and active state to each session cwd", async () => {
    const disabledConfig = { settings: {}, mcpServers: {} };
    const enabledConfig = { settings: { scriptMode: true }, mcpServers: {} };
    const { loadMcpConfig } = mockCommonModules({
      config: disabledConfig,
      directSpecs: [],
      loadMcpConfigImpl: (_overridePath?: string, cwd?: string) => cwd === "/repo/enabled" ? enabledConfig : disabledConfig,
    });
    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    const activeTools = trackActiveTools(api);
    mcpAdapter(api);

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/enabled" });
    expect(activeTools()).toContain("mcpScript");
    expect(api.registerTool.mock.calls.filter(([tool]: any[]) => tool.name === "mcpScript")).toHaveLength(1);
    expect(await handlers.get("resources_discover")?.({ cwd: "/repo/enabled" })).toEqual({
      skillPaths: [expect.stringContaining("skills/mcp-scripting/SKILL.md")],
    });

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/disabled" });
    expect(activeTools()).not.toContain("mcpScript");
    expect(await handlers.get("resources_discover")?.({ cwd: "/repo/disabled" })).toBeUndefined();

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/enabled" });
    expect(activeTools()).toContain("mcpScript");
    expect(api.registerTool.mock.calls.filter(([tool]: any[]) => tool.name === "mcpScript")).toHaveLength(1);
    expect(loadMcpConfig).toHaveBeenCalledWith("/tmp/custom-mcp.json", "/repo/enabled");
  });

  it("forces index direct-tool sync for panel refreshes while passive freeze remains intact", async () => {
    const config = {
      settings: { freezeDirectTools: true },
      mcpServers: { demo: { command: "demo", lifecycle: "eager", directTools: false } },
    };
    const directSpec = {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search demo",
    };
    let resolvedSpecs: any[] = [];
    const { resolveDirectTools } = mockCommonModules({
      config,
      directSpecs: [],
      loadMcpConfigImpl: () => config,
      resolveDirectToolsImpl: () => resolvedSpecs,
    });
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    let toolSurface: any;
    vi.doMock("../mcp-runtime.ts", () => ({
      createMcpRuntime: vi.fn((_api: unknown, options: any) => {
        toolSurface = options.toolSurface;
        return runtime;
      }),
    }));

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    trackActiveTools(api);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/session" });

    const state = {
      config,
      manager: { getConnection: () => undefined },
      failureTracker: new Map(),
      promptMetadata: new Map(),
      sessionCwd: "/repo/session",
    } as any;
    const helpers = {
      getState: () => state,
      getInitPromise: () => null,
      ensureState: vi.fn(),
      getPiTools: () => api.getAllTools(),
      updateStatusBar: vi.fn(),
      executeCall: vi.fn(),
    } as any;
    const ctx = { hasUI: false, cwd: "/repo/session" } as any;
    const baselineResolveCalls = resolveDirectTools.mock.calls.length;

    await toolSurface.sync(state, ctx, false, helpers);
    expect(resolveDirectTools).toHaveBeenCalledTimes(baselineResolveCalls);

    resolvedSpecs = [directSpec];
    await toolSurface.sync(state, ctx, false, helpers, { forceDirectTools: true });

    expect(resolveDirectTools).toHaveBeenCalledTimes(baselineResolveCalls + 1);
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search" }));
  });

  it("resets search activation and reactivates direct tools after removal and eager re-addition", async () => {
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    let toolSpec: any = {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search demo",
      lazy: true,
    };
    const config = {
      settings: { directTools: "search" },
      mcpServers: { demo: { command: "demo", directTools: "search", lifecycle: "lazy" } },
    };
    let toolSurface: any;
    vi.doMock("../mcp-runtime.ts", () => ({
      createMcpRuntime: vi.fn((_api: unknown, options: any) => {
        toolSurface = options.toolSurface;
        return runtime;
      }),
    }));
    mockCommonModules({
      config,
      directSpecs: [],
      loadMcpConfigImpl: () => config,
      resolveDirectToolsImpl: () => [toolSpec],
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    const activeTools = trackActiveTools(api);
    mcpAdapter(api);

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/session" });
    expect(activeTools()).not.toContain("demo_search");
    toolSurface.activateSearchMatches([{ server: "demo", tool: "search" }]);
    expect(activeTools()).toContain("demo_search");

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/session" });
    expect(activeTools()).not.toContain("demo_search");

    toolSpec = { ...toolSpec, description: "Search demo eager", lazy: false };
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/session" });
    expect(activeTools()).toContain("demo_search");
    expect(activeTools().filter(name => name === "demo_search")).toHaveLength(1);
  });

  it("reports one stable command notification when runtime initialization times out", async () => {
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      waitForInitialization: vi.fn().mockResolvedValue("timeout" as const),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime: vi.fn(() => runtime) }));
    mockCommonModules({ config: { mcpServers: { demo: { command: "demo", lifecycle: "eager" } } }, directSpecs: [] });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);
    const sessionCtx = { hasUI: false, cwd: "/repo/session" } as any;
    await handlers.get("session_start")?.({}, sessionCtx);

    const notify = vi.fn();
    const command = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await command.handler("status", { hasUI: true, ui: { notify }, signal: undefined });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("MCP initialization is still in progress. Try again shortly.", "info");
    expect(runtime.handleMcpCommand).not.toHaveBeenCalled();
  });

  it("lets the first input continue after a successful cold direct-tool gate", async () => {
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      waitForInitialization: vi.fn().mockResolvedValue("ready" as const),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime: vi.fn(() => runtime) }));
    mockCommonModules({
      config: { mcpServers: { demo: { command: "demo", directTools: true } } },
      missingConfiguredDirectToolServers: ["demo"],
      directSpecs: [],
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/session" });

    const notify = vi.fn();
    const result = await handlers.get("input")?.({ text: "hello" }, {
      hasUI: true,
      ui: { notify },
      cwd: "/repo/session",
    } as any);

    expect(result).toEqual({ action: "continue" });
    expect(runtime.waitForInitialization).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("continues user input and reports a stable pending warning after a gate timeout", async () => {
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      waitForInitialization: vi.fn().mockResolvedValue("timeout" as const),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime: vi.fn(() => runtime) }));
    mockCommonModules({
      config: { mcpServers: { demo: { command: "demo", directTools: true } } },
      missingConfiguredDirectToolServers: ["demo"],
      directSpecs: [],
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/session" });

    const notify = vi.fn();
    const result = await handlers.get("input")?.({ text: "hello" }, {
      hasUI: true,
      ui: { notify },
      cwd: "/repo/session",
    } as any);

    expect(result).toEqual({ action: "continue" });
    expect(notify).toHaveBeenCalledWith("MCP initialization is still in progress. Try again shortly.", "info");
  });

  it("continues user input and reports initialization failure from the gate", async () => {
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      waitForInitialization: vi.fn().mockRejectedValue(new Error("boom")),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime: vi.fn(() => runtime) }));
    mockCommonModules({
      config: { mcpServers: { demo: { command: "demo", directTools: true } } },
      missingConfiguredDirectToolServers: ["demo"],
      directSpecs: [],
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/session" });

    const notify = vi.fn();
    const result = await handlers.get("input")?.({ text: "hello" }, {
      hasUI: true,
      ui: { notify },
      cwd: "/repo/session",
    } as any);

    expect(result).toEqual({ action: "continue" });
    expect(notify).toHaveBeenCalledWith("MCP initialization failed: boom", "error");
  });

  it("reports the pending gate warning in headless mode without consuming input", async () => {
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      waitForInitialization: vi.fn().mockResolvedValue("timeout" as const),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime: vi.fn(() => runtime) }));
    mockCommonModules({
      config: { mcpServers: { demo: { command: "demo", directTools: true } } },
      missingConfiguredDirectToolServers: ["demo"],
      directSpecs: [],
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/session" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await handlers.get("input")?.({ text: "hello" }, {
        hasUI: false,
        cwd: "/repo/session",
      } as any);
      expect(result).toEqual({ action: "continue" });
      expect(warn).toHaveBeenCalledWith("MCP initialization is still in progress. Try again shortly.");
    } finally {
      warn.mockRestore();
    }
  });

  it("reports initialization failure in headless mode without consuming input", async () => {
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      waitForInitialization: vi.fn().mockRejectedValue(new Error("headless boom")),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime: vi.fn(() => runtime) }));
    mockCommonModules({
      config: { mcpServers: { demo: { command: "demo", directTools: true } } },
      missingConfiguredDirectToolServers: ["demo"],
      directSpecs: [],
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/session" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await handlers.get("input")?.({ text: "hello" }, {
        hasUI: false,
        cwd: "/repo/session",
      } as any);
      expect(result).toEqual({ action: "continue" });
      expect(warn).toHaveBeenCalledWith("MCP initialization failed: headless boom");
    } finally {
      warn.mockRestore();
    }
  });

  it("retires the input gate after one bounded attempt", async () => {
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      waitForInitialization: vi.fn().mockResolvedValue("timeout" as const),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime: vi.fn(() => runtime) }));
    mockCommonModules({
      config: { mcpServers: { demo: { command: "demo", directTools: true } } },
      missingConfiguredDirectToolServers: ["demo"],
      directSpecs: [],
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/session" });

    const notify = vi.fn();
    const ctx = { hasUI: true, ui: { notify }, cwd: "/repo/session" } as any;
    expect(await handlers.get("input")?.({ text: "first" }, ctx)).toEqual({ action: "continue" });
    expect(await handlers.get("input")?.({ text: "second" }, ctx)).toEqual({ action: "continue" });
    expect(runtime.waitForInitialization).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("continues input from a stale generation and does not retire the replacement gate", async () => {
    const staleReady = deferred<"ready">();
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      waitForInitialization: vi.fn(() => staleReady.promise),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
    };
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime: vi.fn(() => runtime) }));
    mockCommonModules({
      config: { mcpServers: { demo: { command: "demo", directTools: true } } },
      missingConfiguredDirectToolServers: ["demo"],
      directSpecs: [],
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);
    const firstCtx = { hasUI: false, cwd: "/repo/first" } as any;
    await handlers.get("session_start")?.({ reason: "first" }, firstCtx);

    const notify = vi.fn();
    const firstInput = handlers.get("input")?.({ text: "first" }, {
      hasUI: true,
      ui: { notify },
      cwd: "/repo/first",
    } as any);
    await vi.waitFor(() => expect(runtime.waitForInitialization).toHaveBeenCalledTimes(1));

    await handlers.get("session_start")?.({ reason: "replacement" }, { hasUI: false, cwd: "/repo/second" } as any);
    staleReady.resolve("ready");

    expect(await firstInput).toEqual({ action: "continue" });
    expect(notify).toHaveBeenCalledWith("MCP initialization is still in progress. Try again shortly.", "info");

    runtime.waitForInitialization.mockResolvedValue("ready" as const);
    expect(await handlers.get("input")?.({ text: "replacement" }, {
      hasUI: false,
      cwd: "/repo/second",
    } as any)).toEqual({ action: "continue" });
    expect(runtime.waitForInitialization).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect user-deactivated direct or scripting tools", async () => {
    const config = {
      settings: { scriptMode: true, directTools: true },
      mcpServers: { demo: { command: "demo", directTools: true } },
    };
    const runtime = {
      handleSessionStart: vi.fn().mockResolvedValue(undefined),
      handleSessionShutdown: vi.fn().mockResolvedValue(undefined),
      handleMcpCommand: vi.fn().mockResolvedValue(undefined),
      handleMcpAuthCommand: vi.fn().mockResolvedValue(undefined),
      executeProxyTool: vi.fn().mockResolvedValue({ content: [] }),
      executeDirectTool: vi.fn().mockResolvedValue({ content: [] }),
      executeScript: vi.fn().mockResolvedValue({ content: [] }),
    };
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime: vi.fn(() => runtime) }));
    mockCommonModules({
      config,
      directSpecs: [{
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search demo",
      }],
      loadMcpConfigImpl: () => config,
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    const activeTools = trackActiveTools(api);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/session" });
    expect(activeTools()).toEqual(["bash", "demo_search", "mcpScript", "mcp"]);

    // A user edit of the authoritative Pi loadout must survive the next
    // adapter sync; neither tool was removed by the adapter itself.
    api.setActiveTools(["bash"]);
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/session" });
    expect(activeTools()).toEqual(["bash"]);
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

  it.each(["eager", "keep-alive"])("imports and starts the runtime on %s session_start from the session cwd config", async (lifecycle) => {
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
    const { loadMcpConfig } = mockCommonModules({
      loadMcpConfigImpl: (_overridePath?: string, cwd?: string) => {
        if (cwd === "/repo/session") {
          return {
            mcpServers: {
              demo: { command: "npx", args: ["-y", "demo-server"], lifecycle },
            },
          };
        }

        return { mcpServers: {} };
      },
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ctx = { hasUI: false, cwd: "/repo/session" } as any;
    await handlers.get("session_start")?.({ reason: lifecycle }, ctx);

    expect(loadMcpConfig).toHaveBeenNthCalledWith(1, "/tmp/custom-mcp.json");
    expect(loadMcpConfig).toHaveBeenNthCalledWith(2, "/tmp/custom-mcp.json", "/repo/session");
    expect(createMcpRuntime).toHaveBeenCalledWith(api, expect.objectContaining({ earlyConfigPath: "/tmp/custom-mcp.json" }));
    expect(createMcpRuntime.mock.calls[0][1]).toEqual(expect.objectContaining({
      toolSurface: expect.objectContaining({
        sync: expect.any(Function),
        activateSearchMatches: expect.any(Function),
      }),
    }));
    expect(runtime.handleSessionStart).toHaveBeenCalledWith({ reason: lifecycle }, ctx);
  });

  it("keeps an empty zero-server cache miss on the lightweight startup path", async () => {
    const createMcpRuntime = vi.fn();
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime }));
    mockCommonModules({
      config: { mcpServers: {} },
      cache: null,
      loadMetadataCacheImpl: () => null,
      directSpecs: [],
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/repo/empty" });

    expect(createMcpRuntime).not.toHaveBeenCalled();
  });

  it("initializes configured servers on a cache miss so prompt discovery can run", async () => {
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
    const config = {
      mcpServers: {
        prompts: { command: "prompt-server", lifecycle: "lazy" },
      },
    };
    mockCommonModules({
      config,
      cache: null,
      loadMetadataCacheImpl: () => null,
      directSpecs: [],
      loadMcpConfigImpl: () => config,
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ctx = { hasUI: false, cwd: "/repo/prompts" } as any;
    await handlers.get("session_start")?.({ reason: "prompt-cache-miss" }, ctx);

    expect(createMcpRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.handleSessionStart).toHaveBeenCalledWith({ reason: "prompt-cache-miss" }, ctx);
  });

  it("imports and starts the runtime on session_start when session-cwd direct-tool metadata is missing", async () => {
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
    const sessionConfig = {
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], lifecycle: "lazy", directTools: true },
      },
    };
    const { getMissingConfiguredDirectToolServers } = mockCommonModules({
      loadMcpConfigImpl: (_overridePath?: string, cwd?: string) => (
        cwd === "/repo/session" ? sessionConfig : { mcpServers: {} }
      ),
      getMissingConfiguredDirectToolServersImpl: (config: any) => (
        config === sessionConfig ? ["demo"] : []
      ),
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ctx = { hasUI: false, cwd: "/repo/session" } as any;
    await handlers.get("session_start")?.({ reason: "cache-miss" }, ctx);

    expect(getMissingConfiguredDirectToolServers).toHaveBeenNthCalledWith(1, { mcpServers: {} }, { servers: {} }, undefined, process.cwd());
    expect(getMissingConfiguredDirectToolServers).toHaveBeenNthCalledWith(2, sessionConfig, { servers: {} }, undefined, "/repo/session");
    expect(createMcpRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.handleSessionStart).toHaveBeenCalledWith({ reason: "cache-miss" }, ctx);
  });

  it("does not import the runtime on session_start for session-cwd metadata misses when direct-tool bootstrap is disabled", async () => {
    process.env.MCP_DIRECT_TOOLS = "__none__";

    const createMcpRuntime = vi.fn();
    vi.doMock("../mcp-runtime.ts", () => ({ createMcpRuntime }));
    const sessionConfig = {
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], lifecycle: "lazy", directTools: true },
      },
    };
    const { getMissingConfiguredDirectToolServers } = mockCommonModules({
      loadMcpConfigImpl: (_overridePath?: string, cwd?: string) => (
        cwd === "/repo/session" ? sessionConfig : { mcpServers: {} }
      ),
      getMissingConfiguredDirectToolServersImpl: (config: any) => (
        config === sessionConfig ? ["demo"] : []
      ),
    });

    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ctx = { hasUI: false, cwd: "/repo/session" } as any;
    await handlers.get("session_start")?.({ reason: "cache-miss" }, ctx);

    expect(getMissingConfiguredDirectToolServers).toHaveBeenNthCalledWith(2, sessionConfig, { servers: {} }, undefined, "/repo/session");
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
      waitForInitialization: vi.fn(() => startup.promise.then(() => "ready" as const)),
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

  it("registers a tool_result handler that re-flags returned MCP tool failures", async () => {
    const mcpAdapter = await importFacade();
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const toolResult = handlers.get("tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult?.({ details: { error: "tool_error", server: "demo" } })).toEqual({ isError: true });
    expect(toolResult?.({ details: { mode: "call", error: "call_failed", message: "boom" } })).toEqual({ isError: true });
    expect(toolResult?.({ details: { error: "auth_required", server: "demo" } })).toBeUndefined();
  });

});
