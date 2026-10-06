import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeServerHash } from "../metadata-cache.ts";
import { UI_STREAM_HOST_CONTEXT_KEY } from "../types.ts";

const mocks = vi.hoisted(() => ({
  initializeMcp: vi.fn(),
  flushMetadataCache: vi.fn(),
  updateStatusBar: vi.fn(),
  notifyToolMetadataUpdated: vi.fn(),
  updateMetadataCache: vi.fn(),
  updateServerMetadata: vi.fn(),
  markKeepAliveAfterConnect: vi.fn(),
  getFailureAgeSeconds: vi.fn(() => null),
  clearFailure: vi.fn(),
  recordFailure: vi.fn(),
  lazyConnect: vi.fn(),
  loadMetadataCache: vi.fn(),
  startUiServer: vi.fn(),
}));

vi.mock("../init.ts", () => ({
  initializeMcp: mocks.initializeMcp,
  flushMetadataCache: mocks.flushMetadataCache,
  updateStatusBar: mocks.updateStatusBar,
  notifyToolMetadataUpdated: mocks.notifyToolMetadataUpdated,
  updateMetadataCache: mocks.updateMetadataCache,
  updateServerMetadata: mocks.updateServerMetadata,
  markKeepAliveAfterConnect: mocks.markKeepAliveAfterConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
  clearFailure: mocks.clearFailure,
  recordFailure: mocks.recordFailure,
  lazyConnect: mocks.lazyConnect,
}));

vi.mock("../config.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../config.ts")>()),
  cloneMcpConfig: (config: unknown) => structuredClone(config),
  resolveConfiguredClaudePluginMcp: (config: unknown) => config,
  discoverConfiguredClaudePluginSkills: () => [],
  getLegacyMcpMigrationNotices: () => [],
  setPiMcpConfigEnabled: vi.fn(),
  writeProjectServerDisabledOverride: vi.fn(),
}));

vi.mock("../metadata-cache.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../metadata-cache.ts")>()),
  loadMetadataCache: mocks.loadMetadataCache,
}));

vi.mock("../commands.ts", () => ({
  showStatus: vi.fn(),
  showTools: vi.fn(),
  showPrompts: vi.fn(),
  reconnectServer: vi.fn(),
  reconnectServers: vi.fn(),
  authenticateServer: vi.fn(),
  logoutServer: vi.fn(),
  openMcpAuthPanel: vi.fn(),
  openMcpPanel: vi.fn(),
  openMcpSetup: vi.fn(),
  editSharedConfig: vi.fn(),
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  authenticate: vi.fn(),
  completeAuthFromInput: vi.fn(),
  createOAuthRuntime: vi.fn((signal: AbortSignal) => ({ signal })),
  getAuthStatus: vi.fn(),
  initializeOAuth: vi.fn().mockResolvedValue(undefined),
  shutdownOAuth: vi.fn().mockResolvedValue(undefined),
  startAuth: vi.fn(),
  supportsOAuth: vi.fn(() => false),
}));

vi.mock("../ui-server.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../ui-server.ts")>()),
  startUiServer: mocks.startUiServer,
}));

type ToolDefinition = Record<string, any> & { name: string };

type Fixture = {
  config: any;
  cache: any;
  state: any;
  connection: any;
  api: any;
  handlers: Map<string, (...args: any[]) => unknown>;
  tools: Map<string, ToolDefinition>;
  activeTools: () => string[];
  refresh: (tools: any[], resources: any[]) => Promise<void>;
};

function createPi() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const tools = new Map<string, ToolDefinition>();
  let active = ["bash"];

  const api: any = {
    // This fixture models only the adapter-reached direct/deferred/hidden
    // exposures; model-only and defaultActive semantics are not exercised.
    registerTool: vi.fn((tool: ToolDefinition) => {
      const previous = tools.get(tool.name);
      const exposure = tool.exposure ?? "direct";
      tools.set(tool.name, tool);
      if (exposure === "hidden") {
        active = active.filter(name => name !== tool.name);
      } else if (!previous) {
        // The SDK activates a new direct declaration, but not a new deferred one.
        if (exposure === "direct") active.push(tool.name);
      } else if (exposure !== "direct" || (previous.exposure ?? "direct") !== "direct") {
        // Refreshing a known deferred declaration preserves its current loadout;
        // changing deferred/hidden to direct follows the SDK's new-declaration path.
        if (exposure === "direct" && !active.includes(tool.name)) active.push(tool.name);
      }
      // A known direct refresh deliberately leaves active/inactive selection alone.
    }),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
      handlers.set(event, handler);
    }),
    events: { on: vi.fn(), emit: vi.fn() },
    getAllTools: vi.fn(() => [...tools.values()]),
    getActiveTools: vi.fn(() => [...active]),
    setActiveTools: vi.fn((next: string[]) => {
      active = next.filter(name => tools.get(name)?.exposure !== "hidden");
    }),
    registerMcpServer: vi.fn(),
    getMcpServers: vi.fn(() => []),
  };

  return { api, handlers, tools, activeTools: () => [...active] };
}

function metadataFor(cacheTools: any[], cacheResources: any[]): any[] {
  return [
    ...cacheTools.map(tool => ({
      name: `demo_${tool.name}`,
      originalName: tool.name,
      description: tool.description ?? "",
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      ...(tool.uiResourceUri !== undefined ? { uiResourceUri: tool.uiResourceUri } : {}),
      ...(tool.uiStreamMode !== undefined ? { uiStreamMode: tool.uiStreamMode } : {}),
    })),
    ...cacheResources.map(resource => ({
      name: `demo_read_${resource.name}`,
      originalName: `read_${resource.name}`,
      description: resource.description ?? `Read resource: ${resource.uri}`,
      resourceUri: resource.uri,
    })),
  ];
}

function textPayload(result: any): any {
  const block = result.content.filter((item: any) => item.type === "text").at(-1);
  if (!block) throw new Error("expected a text mcpScript payload");
  return JSON.parse(block.text);
}

async function bootFixture(): Promise<Fixture> {
  const cwd = process.cwd();
  const definition = { command: "refresh-fixture", directTools: true, lifecycle: "eager" };
  const config = {
    settings: { freezeDirectTools: false, scriptMode: true },
    mcpServers: { demo: definition },
  };
  const inputSchema = { type: "object", properties: { query: { type: "string" } } };
  const initialTools = [
    {
      name: "run",
      description: "Run old",
      inputSchema,
      outputSchema: { type: "object", properties: { value: { type: "string" } } },
      annotations: { title: "Run old", readOnlyHint: true },
    },
    {
      name: "manual",
      description: "Manual tool",
      inputSchema,
    },
    {
      name: "app",
      description: "Old app",
      inputSchema,
      uiResourceUri: "ui://old/app",
      uiStreamMode: "eager",
    },
  ];
  const initialResources = [{ name: "handbook", uri: "docs://old/handbook", description: "Old handbook" }];
  const cache = {
    version: 1,
    servers: {
      demo: {
        configHash: computeServerHash(definition as any, cwd),
        cachedAt: Date.now(),
        tools: initialTools,
        resources: initialResources,
      },
    },
  };
  mocks.loadMetadataCache.mockReturnValue(cache);
  mocks.lazyConnect.mockResolvedValue(true);

  const callTool = vi.fn();
  const readResource = vi.fn();
  const connection = {
    status: "connected",
    client: { callTool, readResource },
    tools: [],
    resources: [],
  };
  const uiResourceHandler = {
    readUiResource: vi.fn(async (_server: string, uri: string) => ({
      uri,
      html: `<main>${uri}</main>`,
      mimeType: "text/html",
      meta: uri === "ui://new/app"
        ? { domain: "new.example", prefersBorder: true }
        : { domain: "old.example" },
    })),
  };
  const state: any = {
    manager: {
      close: vi.fn().mockResolvedValue(undefined),
      getConnection: vi.fn(() => connection),
      getAllConnections: vi.fn(() => new Map([["demo", connection]])),
      getRequestOptions: vi.fn(() => undefined),
      ensureListen: vi.fn().mockResolvedValue(undefined),
      prepareResourceUse: vi.fn().mockResolvedValue(undefined),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      registerUiStreamListener: vi.fn(),
      removeUiStreamListener: vi.fn(),
      registerResourceUpdatedListener: vi.fn(),
      removeResourceUpdatedListener: vi.fn(),
    },
    lifecycle: {
      gracefulShutdown: vi.fn().mockResolvedValue(undefined),
      ensureConverged: vi.fn().mockResolvedValue(undefined),
      registerServer: vi.fn(),
      unregisterServer: vi.fn(),
    },
    toolMetadata: new Map([["demo", metadataFor(initialTools, initialResources)]]),
    promptMetadata: new Map(),
    promptMetadataLive: new Set(),
    serverInstructions: new Map(),
    resourceCounts: new Map(),
    directToolCounts: new Map(),
    config,
    sessionCwd: cwd,
    failureTracker: new Map(),
    uiResourceHandler,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    uiServer: null,
    completedUiSessions: [],
    openBrowser: vi.fn(),
    sendMessage: vi.fn(),
    observedOutputs: new WeakMap(),
  };

  mocks.initializeMcp.mockImplementation(async (_pi: unknown, _ctx: unknown, owner: any, options: any) => {
    state.owner = owner;
    state.config = options?.config ?? config;
    options?.onProjectTrustResolved?.();
    return state;
  });

  const { createMcpAdapter } = await import("../index.ts");
  const { api, handlers, tools, activeTools } = createPi();
  createMcpAdapter({ config })(api);
  await handlers.get("session_start")?.({}, { hasUI: false, cwd });
  await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));

  const refresh = async (nextTools: any[], nextResources: any[]) => {
    cache.servers.demo.tools = nextTools;
    cache.servers.demo.resources = nextResources;
    state.toolMetadata.set("demo", metadataFor(nextTools, nextResources));
    await state.onToolMetadataUpdated("demo", "metadata-refresh");
  };

  return { config, cache, state, connection, api, handlers, tools, activeTools, refresh };
}

describe("production direct-tool refresh execution", () => {
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
  const originalUiViewer = process.env.MCP_UI_VIEWER;
  let fixture: Fixture | undefined;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.MCP_DIRECT_TOOLS;
    process.env.MCP_UI_VIEWER = "none";
    fixture = undefined;
    for (const value of Object.values(mocks)) {
      if (typeof value === "function" && "mockReset" in value) value.mockReset();
    }
    mocks.getFailureAgeSeconds.mockReturnValue(null);
    mocks.startUiServer.mockImplementation(async (options: any) => ({
      serverName: options.serverName,
      toolName: options.toolName,
      url: `http://ui.test/${options.serverName}/${options.toolName}`,
      port: 1,
      proxyUrl: "http://ui.test/proxy",
      proxyPort: 2,
      sessionToken: "ui-token",
      close: vi.fn(),
      sendToolInput: vi.fn(),
      sendToolResult: vi.fn(),
      sendResultPatch: vi.fn(),
      sendToolCancelled: vi.fn(),
      sendResourceUpdated: vi.fn(),
      sendHostContext: vi.fn(),
      getSessionMessages: () => ({ prompts: [], intents: [], notifications: [], contexts: [] }),
      getStreamSummary: () => undefined,
    }));
  });

  afterEach(async () => {
    try {
      await fixture?.handlers.get("session_shutdown")?.({}, {});
    } finally {
      if (originalDirectTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
      else process.env.MCP_DIRECT_TOOLS = originalDirectTools;
      if (originalUiViewer === undefined) delete process.env.MCP_UI_VIEWER;
      else process.env.MCP_UI_VIEWER = originalUiViewer;
      vi.restoreAllMocks();
    }
  });

  it("reconciles live declarations, executes current metadata, and hides removed deferred tools", async () => {
    fixture = await bootFixture();
    const { api, tools, activeTools, state, connection, refresh } = fixture;
    const inputSchema = { type: "object", properties: { query: { type: "string" } } };

    const initialRun = tools.get("demo_run")!;
    const initialManual = tools.get("demo_manual")!;
    expect(initialRun).not.toHaveProperty("exposure");
    expect(initialRun.execute).toBeTypeOf("function");
    expect(activeTools()).toContain("demo_manual");

    // This models a host-owned loadout choice; setActiveTools does not run
    // tool_search. The live refresh must not resurrect the disabled tool.
    api.setActiveTools(activeTools().filter(name => name !== "demo_manual"));

    const currentRunOutputSchema = { type: "object", properties: { rows: { type: "number" } } };
    const currentTools = [
      {
        name: "run",
        description: "Run current",
        inputSchema,
        outputSchema: currentRunOutputSchema,
        annotations: { title: "Run current", readOnlyHint: true },
      },
      {
        name: "manual",
        description: "Manual current",
        inputSchema,
      },
      {
        name: "app",
        description: "New app",
        inputSchema,
        uiResourceUri: "ui://new/app",
        uiStreamMode: "stream-first",
      },
      {
        name: "gone",
        description: "Removed after search",
        inputSchema,
        outputSchema: { type: "object", properties: { gone: { type: "boolean" } } },
        annotations: { title: "Gone", readOnlyHint: true },
      },
    ];
    const currentResources = [{ name: "handbook", uri: "docs://new/handbook", description: "New handbook" }];
    const eagerTools = currentTools.filter(tool => tool.name !== "gone");
    const registrationsBeforeEagerRefresh = api.registerTool.mock.calls.filter((call: any[]) => call[0].name === "demo_manual").length;
    await refresh(eagerTools, currentResources);

    const eagerManual = tools.get("demo_manual")!;
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0].name === "demo_manual")).toHaveLength(registrationsBeforeEagerRefresh + 1);
    expect(eagerManual).not.toHaveProperty("exposure");
    expect(eagerManual.description).toBe("Manual current");
    expect(eagerManual.execute).not.toBe(initialManual.execute);
    expect(tools.get("demo_run")).not.toHaveProperty("exposure");
    expect(tools.get("demo_run")).toMatchObject({ description: "Run current" });
    expect(tools.get("demo_run")?.execute).not.toBe(initialRun.execute);
    expect(activeTools()).toEqual(expect.arrayContaining(["demo_run", "demo_app"]));
    expect(activeTools()).not.toContain("demo_manual");

    state.config.mcpServers.demo.directTools = "search";
    await refresh(currentTools, currentResources);

    expect(tools.get("demo_run")).toMatchObject({
      exposure: "deferred",
      description: "Run current",
      annotations: { readOnlyHint: true },
      outputSchema: {
        properties: { structuredContent: currentRunOutputSchema },
      },
    });
    expect(activeTools()).not.toContain("demo_run");
    expect(activeTools()).not.toContain("demo_manual");
    expect(tools.get("demo_manual")?.exposure).toBe("deferred");
    // Model the host selecting the deferred declaration. This direct loadout
    // mutation stands in for host selection; it does not execute tool_search.
    api.setActiveTools([...activeTools(), "demo_run"]);
    expect(activeTools()).toContain("demo_run");

    const runResult = {
      content: [{ type: "text", text: "current run" }],
      structuredContent: { rows: 2 },
    };
    connection.client.callTool.mockResolvedValueOnce(runResult);
    const run = await tools.get("demo_run")!.execute("run-1", { query: "new" }, undefined, undefined, { hasUI: false, cwd: process.cwd() });
    expect(run.content[0]).toEqual(runResult.content[0]);
    expect(run.content).toEqual(expect.arrayContaining(runResult.content));
    expect(run).toMatchObject({
      structuredContent: { content: run.content, structuredContent: runResult.structuredContent },
      details: { server: "demo", tool: "run" },
    });
    expect(run.structuredContent).not.toHaveProperty("isError");
    expect(connection.client.callTool).toHaveBeenCalledWith(
      { name: "run", arguments: { query: "new" }, _meta: { "pi-mcp-adapter/toolCallId": "run-1" } },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onprogress: expect.any(Function),
      }),
    );

    const resourceResult = {
      contents: [{ uri: "docs://new/handbook", mimeType: "text/plain", text: "new handbook" }],
    };
    connection.client.readResource.mockResolvedValueOnce(resourceResult);
    const resource = await tools.get("demo_read_handbook")!.execute("resource-1", {}, undefined, undefined, { hasUI: false, cwd: process.cwd() });
    expect(connection.client.readResource).toHaveBeenCalledWith(
      { uri: "docs://new/handbook" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(resource).toMatchObject({
      content: [{ type: "text", text: "new handbook" }],
      structuredContent: { content: [{ type: "text", text: "new handbook" }] },
      details: { server: "demo", resourceUri: "docs://new/handbook" },
    });

    const uiResult = {
      content: [{ type: "text", text: "new app result" }],
      structuredContent: { rendered: true },
    };
    connection.client.callTool.mockResolvedValueOnce(uiResult);
    const ui = await tools.get("demo_app")!.execute("ui-1", { query: "new" }, undefined, undefined, { hasUI: false, cwd: process.cwd() });
    expect(state.uiResourceHandler.readUiResource).toHaveBeenCalledWith("demo", "ui://new/app", expect.any(Object));
    expect(mocks.startUiServer).toHaveBeenCalledWith(expect.objectContaining({
      resource: expect.objectContaining({
        uri: "ui://new/app",
        meta: { domain: "new.example", prefersBorder: true },
      }),
      hostContext: expect.objectContaining({
        [UI_STREAM_HOST_CONTEXT_KEY]: expect.objectContaining({
          mode: "stream-first",
          intermediateResultPatches: true,
        }),
      }),
    }));
    expect(ui.content[0]).toEqual(uiResult.content[0]);
    expect(ui.content).toEqual(expect.arrayContaining(uiResult.content));
    expect(ui).toMatchObject({
      structuredContent: { content: ui.content, structuredContent: uiResult.structuredContent },
    });

    // Model the host selecting a newly discovered deferred declaration. This
    // direct loadout mutation does not execute tool_search. Removal must hide
    // it without changing that stored declaration's executor or contract fields.
    const gone = tools.get("demo_gone")!;
    api.setActiveTools([...activeTools(), "demo_gone"]);
    expect(activeTools()).toContain("demo_gone");

    const remainingTools = currentTools.filter(tool => tool.name !== "gone");
    await refresh(remainingTools, currentResources);

    const hiddenGone = tools.get("demo_gone")!;
    expect(hiddenGone).toMatchObject({
      name: "demo_gone",
      exposure: "hidden",
      label: gone.label,
      description: gone.description,
      promptSnippet: gone.promptSnippet,
      parameters: gone.parameters,
      namespace: gone.namespace,
      outputSchema: gone.outputSchema,
      annotations: gone.annotations,
      renderShell: gone.renderShell,
      renderCall: gone.renderCall,
      renderResult: gone.renderResult,
      execute: gone.execute,
    });
    expect(hiddenGone.execute).toBe(gone.execute);
    expect(activeTools()).not.toContain("demo_gone");
    // The modeled SDK host loadout ignores a hidden declaration even when an
    // activation attempt names it explicitly.
    api.setActiveTools([...activeTools(), "demo_gone"]);
    expect(activeTools()).not.toContain("demo_gone");

    const clientCallsBeforeRemovedCheck = connection.client.callTool.mock.calls.length;
    const { runMcpScript } = await import("../mcp-code.ts");
    const removedCall = await runMcpScript(
      state,
      'return { search: await tools.search({ query: "gone" }), call: await tools.call("demo_gone", {}) };',
      5_000,
      () => api.getAllTools(),
    );
    const removedPayload = textPayload(removedCall);
    expect(removedPayload.search.items).toEqual([]);
    // This native_tool refusal comes from removing live adapter metadata before
    // codemode resolution; it is not evidence that hidden exposure caused it.
    expect(removedPayload.call).toMatchObject({ ok: false, error: { code: "native_tool" } });
    expect(connection.client.callTool).toHaveBeenCalledTimes(clientCallsBeforeRemovedCheck);
  });
});
