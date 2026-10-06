import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { MCP_STATUS_EVENT, UI_STREAM_HOST_CONTEXT_KEY } from "../types.ts";
import { computeServerHash } from "../metadata-cache.ts";
import { ConsentManager } from "../consent-manager.ts";
import { MCP_APPROVAL_CUSTOM_TYPE, getToolApprovalIdentity, makeToolApprovalKey } from "../session-approvals.ts";

const mocks = vi.hoisted(() => ({
  initializeMcp: vi.fn(),
  lazyConnect: vi.fn(),
  holdProjectTrust: false,
  clearFailure: vi.fn(),
  updateStatusBar: vi.fn(),
  flushMetadataCache: vi.fn(),
  updateMetadataCache: vi.fn(),
  notifyToolMetadataUpdated: vi.fn(),
  initializeOAuth: vi.fn().mockResolvedValue(undefined),
  createOAuthRuntime: vi.fn((signal: AbortSignal) => ({ signal })),
  shutdownOAuth: vi.fn().mockResolvedValue(undefined),
  loadMcpConfig: vi.fn(() => ({ mcpServers: {} })),
  cloneMcpConfig: vi.fn((config: unknown) => structuredClone(config)),
  discoverConfiguredClaudePluginSkills: vi.fn(() => []),
  resolveConfiguredClaudePluginMcp: vi.fn((config: unknown) => structuredClone(config)),
  getLegacyMcpMigrationNotices: vi.fn(() => []),
  setPiMcpConfigEnabled: vi.fn(),
  loadMetadataCache: vi.fn(() => null),
  buildProxyDescription: vi.fn(() => "MCP gateway"),
  createDirectToolExecutor: vi.fn(() => vi.fn()),
  startUiServer: vi.fn(),
  prepareDirectToolArguments: vi.fn((_schema: unknown, args: unknown) => args),
  getMissingConfiguredDirectToolServers: vi.fn(() => []),
  resolveDirectTools: vi.fn(() => []),
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
  getPiGlobalConfigPath: vi.fn(() => "/tmp/agent/mcp-adapter.json"),
  getProjectConfigPath: vi.fn(() => "/tmp/project/.mcp.json"),
  writeSharedServerEntry: vi.fn((path: string) => path),
  writeProjectServerDisabledOverride: vi.fn(() => ({ path: "/tmp/project/.pi/mcp.json", changed: true })),
  executeAuthComplete: vi.fn(),
  executeAuthStart: vi.fn(),
  executeCall: vi.fn(),
  executeConnect: vi.fn(),
  executeDescribe: vi.fn(),
  executeList: vi.fn(),
  executeSearch: vi.fn(),
  executeStatus: vi.fn(),
  executeUiMessages: vi.fn(),
  coreModuleGate: null as Promise<void> | null,
  oauthModuleGate: null as Promise<void> | null,
  coreModuleStarted: vi.fn(),
  oauthModuleStarted: vi.fn(),
  commandsModuleGate: null as Promise<void> | null,
  proxyModuleGate: null as Promise<void> | null,
  directModuleGate: null as Promise<void> | null,
  codeModuleGate: null as Promise<void> | null,
  runMcpScript: vi.fn(),
  codeModuleStarted: vi.fn(),
  getConfigPathFromArgv: vi.fn(() => undefined),
  normalizeDirectToolInputSchema: vi.fn((schema: unknown) => schema && typeof schema === "object" && !Array.isArray(schema)
    ? Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema" && key !== "additionalProperties"))
    : { type: "object", properties: {} }),
  truncateAtWord: vi.fn((text: string) => text),
}));

// Real initialization resolves project-server trust before connecting servers.
const initializeMcpResolvingTrust = vi.hoisted(() => (...args: unknown[]) => {
  const initialization = mocks.initializeMcp(...args);
  if (!mocks.holdProjectTrust) (args[3] as { onProjectTrustResolved?: () => void } | undefined)?.onProjectTrustResolved?.();
  return initialization;
});

vi.mock("../init.ts", async () => {
  mocks.coreModuleStarted();
  if (mocks.coreModuleGate) await mocks.coreModuleGate;
  return {
    initializeMcp: initializeMcpResolvingTrust,
    lazyConnect: mocks.lazyConnect,
    clearFailure: mocks.clearFailure,
    updateStatusBar: mocks.updateStatusBar,
    flushMetadataCache: mocks.flushMetadataCache,
    updateMetadataCache: mocks.updateMetadataCache,
    notifyToolMetadataUpdated: mocks.notifyToolMetadataUpdated,
  };
});

vi.mock("../mcp-auth-flow.ts", async () => {
  mocks.oauthModuleStarted();
  if (mocks.oauthModuleGate) await mocks.oauthModuleGate;
  return {
    initializeOAuth: mocks.initializeOAuth,
    createOAuthRuntime: mocks.createOAuthRuntime,
    shutdownOAuth: mocks.shutdownOAuth,
  };
});

vi.mock("../config.ts", () => ({
  loadMcpConfig: mocks.loadMcpConfig,
  cloneMcpConfig: mocks.cloneMcpConfig,
  discoverConfiguredClaudePluginSkills: mocks.discoverConfiguredClaudePluginSkills,
  resolveConfiguredClaudePluginMcp: mocks.resolveConfiguredClaudePluginMcp,
  getLegacyMcpMigrationNotices: mocks.getLegacyMcpMigrationNotices,
  setPiMcpConfigEnabled: mocks.setPiMcpConfigEnabled,
  getPiGlobalConfigPath: mocks.getPiGlobalConfigPath,
  getProjectConfigPath: mocks.getProjectConfigPath,
  writeSharedServerEntry: mocks.writeSharedServerEntry,
  writeProjectServerDisabledOverride: mocks.writeProjectServerDisabledOverride,
}));

vi.mock("../metadata-cache.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../metadata-cache.ts")>()),
  loadMetadataCache: mocks.loadMetadataCache,
}));

vi.mock("../direct-tool-surface.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../direct-tool-surface.ts")>()),
  buildProxyDescription: mocks.buildProxyDescription,
  getMissingConfiguredDirectToolServers: mocks.getMissingConfiguredDirectToolServers,
  prepareDirectToolArguments: mocks.prepareDirectToolArguments,
  resolveDirectTools: mocks.resolveDirectTools,
}));

vi.mock("../direct-tools.ts", async () => {
  if (mocks.directModuleGate) await mocks.directModuleGate;
  return { createDirectToolExecutor: mocks.createDirectToolExecutor };
});

vi.mock("../ui-server.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui-server.ts")>()),
  startUiServer: mocks.startUiServer,
}));

vi.mock("../commands.ts", async () => {
  if (mocks.commandsModuleGate) await mocks.commandsModuleGate;
  return {
  showStatus: mocks.showStatus,
  showTools: mocks.showTools,
  showPrompts: mocks.showPrompts,
  reconnectServer: mocks.reconnectServer,
  reconnectServers: mocks.reconnectServers,
  authenticateServer: mocks.authenticateServer,
  logoutServer: mocks.logoutServer,
  openMcpAuthPanel: mocks.openMcpAuthPanel,
  openMcpPanel: mocks.openMcpPanel,
  openMcpSetup: mocks.openMcpSetup,
  };
});

vi.mock("../proxy-modes.ts", async () => {
  if (mocks.proxyModuleGate) await mocks.proxyModuleGate;
  return {
  executeAuthComplete: mocks.executeAuthComplete,
  executeAuthStart: mocks.executeAuthStart,
  executeCall: mocks.executeCall,
  executeConnect: mocks.executeConnect,
  executeDescribe: mocks.executeDescribe,
  executeList: mocks.executeList,
  executeSearch: mocks.executeSearch,
  executeStatus: mocks.executeStatus,
  executeUiMessages: mocks.executeUiMessages,
  };
});

vi.mock("../mcp-code.ts", async () => {
  mocks.codeModuleStarted();
  if (mocks.codeModuleGate) await mocks.codeModuleGate;
  return { runMcpScript: mocks.runMcpScript };
});

vi.mock("../utils.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.ts")>()),
  formatTerminalError: (error: unknown) => error instanceof Error ? error.message : String(error),
  getConfigPathFromArgv: mocks.getConfigPathFromArgv,
  interpolateEnvRecord: (value: Record<string, string> | undefined) => value,
  interpolateEnvVars: (value: string | undefined) => value,
  normalizeDirectToolInputSchema: mocks.normalizeDirectToolInputSchema,
  resolveBearerToken: (definition: { bearerToken?: string }) => definition.bearerToken,
  resolveConfigPath: (value: string | undefined) => value,
  resolveServerUrl: (definition: { url?: string }) => definition.url,
  sanitizeTerminalText: (text: string) => text,
  truncateAtWord: mocks.truncateAtWord,
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createState() {
  return {
    manager: { close: vi.fn().mockResolvedValue(undefined), getAllConnections: () => new Map(), getConnection: vi.fn(() => undefined) },
    lifecycle: {
      gracefulShutdown: vi.fn().mockResolvedValue(undefined),
      ensureConverged: vi.fn().mockResolvedValue(undefined),
      registerServer: vi.fn(),
      unregisterServer: vi.fn(),
    },
    toolMetadata: new Map(),
    promptMetadata: new Map(),
    promptMetadataLive: new Set(),
    serverInstructions: new Map(),
    resourceCounts: new Map(),
    directToolCounts: new Map(),
    config: { mcpServers: {} },
    oauthRuntime: { signal: new AbortController().signal },
    failureTracker: new Map(),
    uiResourceHandler: {},
    consentManager: {},
    uiServer: null,
    completedUiSessions: [],
    openBrowser: vi.fn(),
  } as any;
}

function createPi(options: { unregisterTool?: false | ((name: string) => boolean) } = {}) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let activeTools = ["bash", "mcp", "demo_search"];
  const unregisterTool =
    options.unregisterTool === false
      ? undefined
      : vi.fn(options.unregisterTool ?? (() => true));
  return {
    handlers,
    api: {
      registerTool: vi.fn(),
      ...(unregisterTool ? { unregisterTool } : {}),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler);
      }),
      events: { on: vi.fn(), emit: vi.fn() },
      getAllTools: vi.fn(() => []),
      getActiveTools: vi.fn(() => activeTools),
      setActiveTools: vi.fn((nextActiveTools: string[]) => {
        activeTools = nextActiveTools;
      }),
    } as any,
  };
}

async function loadAdapter(options: Parameters<typeof createPi>[0] = {}) {
  const { default: mcpAdapter } = await import("../index.ts");
  const pi = createPi(options);
  mcpAdapter(pi.api);
  return pi;
}

function registeredTool(api: ReturnType<typeof createPi>["api"], name: string) {
  return api.registerTool.mock.calls.find((call: any[]) => call[0].name === name)?.[0];
}

function registeredTools(api: ReturnType<typeof createPi>["api"], name: string) {
  return api.registerTool.mock.calls
    .filter((call: any[]) => call[0]?.name === name)
    .map((call: any[]) => call[0]);
}

function registeredCommand(api: ReturnType<typeof createPi>["api"], name: string) {
  return api.registerCommand.mock.calls.find((call: any[]) => call[0] === name)?.[1];
}

function cacheEntry(
  definition: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  defaultCwd = process.cwd(),
) {
  return { configHash: computeServerHash(definition, defaultCwd), cachedAt: Date.now(), tools: [{ name: "search" }], resources: [], ...extra };
}

function cacheLazyServer(definition: Record<string, unknown>, tools = [{ name: "search" }]) {
  const config = { mcpServers: { demo: definition } };
  mocks.loadMcpConfig.mockReturnValue(config);
  mocks.loadMetadataCache.mockReturnValue({ version: 1, servers: { demo: cacheEntry(definition, { tools }) } });
  return config;
}

const directToolSpec = {
  serverName: "demo",
  originalName: "search",
  prefixedName: "demo_search",
  description: "Search",
  inputSchema: { type: "object", properties: {} },
};

function largeDirectToolSpecs() {
  return Array.from({ length: 75 }, (_, index) => ({
    serverName: "demo",
    originalName: `tool_${index}`,
    prefixedName: `demo_tool_${index}`,
    description: `Tool ${index}`,
  }));
}

async function loadAfterFailedInitialization(state = createState()) {
  mocks.initializeMcp.mockRejectedValueOnce(new Error("first boom")).mockResolvedValueOnce(state);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const pi = await loadAdapter();
  await pi.handlers.get("session_start")?.({}, { hasUI: false });
  await new Promise((resolve) => setImmediate(resolve));
  return { ...pi, state };
}

function createStatusObservingPi() {
  const { api, handlers } = createPi();
  let activeTools = ["bash"];
  const connectedSurfaces: string[][] = [];

  api.registerTool.mockImplementation((tool: { name: string }) => {
    if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
  });
  api.unregisterTool.mockImplementation((toolName: string) => {
    const previousLength = activeTools.length;
    activeTools = activeTools.filter((name) => name !== toolName);
    return activeTools.length !== previousLength;
  });
  api.getActiveTools.mockImplementation(() => [...activeTools]);
  api.setActiveTools.mockImplementation((nextActiveTools: string[]) => {
    activeTools = [...nextActiveTools];
  });
  api.events = {
    on: vi.fn(),
    emit: vi.fn((channel: string, payload: { connectedCount?: number }) => {
      if (channel !== MCP_STATUS_EVENT || payload.connectedCount !== 1) return;
      connectedSurfaces.push(activeTools
        .filter((name) => name === "mcp" || name.startsWith("demo_"))
        .sort());
    }),
  };

  return { api, handlers, connectedSurfaces };
}

function connectedStatusSnapshot(toolCount: number) {
  return {
    version: 1,
    servers: [{
      name: "demo",
      status: "connected",
      toolCount,
      resourceCount: 0,
      disabled: false,
    }],
    totalTools: toolCount,
    totalResources: 0,
    connectedCount: 1,
    disabledCount: 0,
  };
}

// Models Pi's runtime tool registry: registering a name for the first time
// appends it to the active set, re-registering a known name does not, and
// unregisterTool (when the host has it) forgets the name again.
function trackRuntimeToolActivation(api: any, initialActiveTools: string[]): () => string[] {
  const registry = new Set(initialActiveTools);
  let activeTools = [...initialActiveTools];
  api.registerTool.mockImplementation((tool: { name: string }) => {
    if (registry.has(tool.name)) return;
    registry.add(tool.name);
    activeTools.push(tool.name);
  });
  api.unregisterTool?.mockImplementation((toolName: string) => {
    activeTools = activeTools.filter((name) => name !== toolName);
    return registry.delete(toolName);
  });
  api.getActiveTools.mockImplementation(() => [...activeTools]);
  api.setActiveTools.mockImplementation((nextActiveTools: string[]) => {
    activeTools = [...nextActiveTools];
  });
  return () => [...activeTools];
}

describe("mcpAdapter session lifecycle", () => {
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
  const originalUiViewer = process.env.MCP_UI_VIEWER;

  beforeEach(() => {
    delete process.env.MCP_DIRECT_TOOLS;
    vi.resetModules();
    vi.doUnmock("typebox");
    for (const value of Object.values(mocks)) {
      if (typeof value === "function" && "mockReset" in value) {
        value.mockReset();
      }
    }
    mocks.coreModuleGate = null;
    mocks.holdProjectTrust = false;
    mocks.oauthModuleGate = null;
    mocks.commandsModuleGate = null;
    mocks.proxyModuleGate = null;
    mocks.directModuleGate = null;
    mocks.codeModuleGate = null;

    mocks.initializeOAuth.mockResolvedValue(undefined);
    mocks.createOAuthRuntime.mockImplementation((signal: AbortSignal) => ({ signal }));
    mocks.shutdownOAuth.mockResolvedValue(undefined);
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {} });
    mocks.lazyConnect.mockResolvedValue(true);
    mocks.cloneMcpConfig.mockImplementation((config: unknown) => structuredClone(config));
    mocks.discoverConfiguredClaudePluginSkills.mockReturnValue([]);
    mocks.resolveConfiguredClaudePluginMcp.mockImplementation((config: unknown) => structuredClone(config));
    mocks.getLegacyMcpMigrationNotices.mockReturnValue([]);
    mocks.loadMetadataCache.mockReturnValue(null);
    mocks.buildProxyDescription.mockReturnValue("MCP gateway");
    mocks.createDirectToolExecutor.mockReturnValue(vi.fn());
    mocks.prepareDirectToolArguments.mockImplementation((_schema: unknown, args: unknown) => {
      const input = args as { filter?: unknown };
      return typeof input.filter === "string"
        ? { ...input, filter: JSON.parse(input.filter) }
        : args;
    });
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue([]);
    mocks.resolveDirectTools.mockReturnValue([]);
    mocks.getPiGlobalConfigPath.mockReturnValue("/tmp/agent/mcp-adapter.json");
    mocks.getProjectConfigPath.mockReturnValue("/tmp/project/.mcp.json");
    mocks.writeSharedServerEntry.mockImplementation((path: string) => path);
    mocks.getConfigPathFromArgv.mockReturnValue(undefined);
    mocks.normalizeDirectToolInputSchema.mockImplementation((schema: unknown) => schema && typeof schema === "object" && !Array.isArray(schema)
      ? Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema" && key !== "additionalProperties"))
      : { type: "object", properties: {} });
    mocks.truncateAtWord.mockImplementation((text: string) => text);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDirectTools === undefined) {
      delete process.env.MCP_DIRECT_TOOLS;
    } else {
      process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    }
    if (originalUiViewer === undefined) {
      delete process.env.MCP_UI_VIEWER;
    } else {
      process.env.MCP_UI_VIEWER = originalUiViewer;
    }
  });

  it("registers /mcp and /mcp-adapter during load", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { api, handlers } = await loadAdapter();

    let commandNames = api.registerCommand.mock.calls.map((call: any[]) => call[0]);
    expect(commandNames.filter((name: string) => name === "mcp-adapter")).toHaveLength(1);
    expect(commandNames.filter((name: string) => name === "mcp")).toHaveLength(1);
    expect(commandNames.filter((name: string) => name === "mcp-auth")).toHaveLength(1);

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/project" });
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/project" });
    commandNames = api.registerCommand.mock.calls.map((call: any[]) => call[0]);
    expect(commandNames.filter((name: string) => name === "mcp")).toHaveLength(1);
  });

  it("discovers configured Claude plugin skills on startup and reload", async () => {
    let generation = 0;
    mocks.loadMcpConfig.mockImplementation(() => ({
      mcpServers: {},
      settings: { scriptMode: false },
      claudePlugins: [{ path: `plugin-${++generation}`, skills: true }],
    }));
    mocks.discoverConfiguredClaudePluginSkills.mockImplementation((config: { claudePlugins?: Array<{ path: string }> }) =>
      config.claudePlugins?.map(plugin => `/skills/${plugin.path}`) ?? []);

    const { handlers } = await loadAdapter();
    const discover = handlers.get("resources_discover")!;

    expect(discover({ cwd: "/project", reason: "initial" })).toEqual({ skillPaths: ["/skills/plugin-2"] });
    expect(discover({ cwd: "/project", reason: "reload" })).toEqual({ skillPaths: ["/skills/plugin-3"] });
    expect(mocks.discoverConfiguredClaudePluginSkills).toHaveBeenCalledTimes(2);
  });

  it("keeps the bundled mcp-scripting skill aligned with install-time tool visibility after reload", async () => {
    let config = { mcpServers: {}, claudePlugins: [], settings: { scriptMode: true } } as { mcpServers: {}; claudePlugins: []; settings: { scriptMode: boolean } };
    mocks.loadMcpConfig.mockImplementation(() => structuredClone(config));
    mocks.discoverConfiguredClaudePluginSkills.mockReturnValue([]);

    const { api, handlers } = await loadAdapter();
    const discover = handlers.get("resources_discover")!;

    const expectedSkillPath = resolve("skills/mcp-scripting/SKILL.md");
    expect(registeredTool(api, "mcpScript")).toBeDefined();
    expect(discover({ cwd: "/project", reason: "initial" })).toEqual({ skillPaths: [expectedSkillPath] });

    config = { ...config, settings: { scriptMode: false } };
    expect(discover({ cwd: "/project", reason: "reload" })).toEqual({ skillPaths: [expectedSkillPath] });
  });

  it("keeps mcpScript guidance on the load-time scriptMode when the session config differs", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    const state = createState();
    state.config = { mcpServers: {}, settings: { scriptMode: true } };
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));

    expect(registeredTool(api, "mcpScript")).toBeUndefined();
    expect(state.scriptTool).toBe(false);
    expect(mocks.buildProxyDescription).toHaveBeenCalledWith(state.config, false);
    expect(mocks.buildProxyDescription).not.toHaveBeenCalledWith(expect.anything(), true);
  });

  it.each([
    ["omitted", undefined],
    ["manual", "manual"],
  ] as const)("script skill publication load model -> session %s publishes one no-pointer tool", async (
    _sessionKind,
    scriptSkill,
  ) => {
    const sessionCwd = "/session/script-skill-publication-no-pointer";
    const loadConfig = {
      settings: { scriptMode: true, scriptSkill: "model" as const },
      mcpServers: {},
    };
    const sessionConfig = {
      settings: { scriptMode: true, ...(scriptSkill === undefined ? {} : { scriptSkill }) },
      mcpServers: {},
    };
    mocks.loadMcpConfig.mockImplementation((_path?: string, cwd?: string) => structuredClone(
      cwd === sessionCwd ? sessionConfig : loadConfig,
    ));

    const { api, handlers } = await loadAdapter();
    const discover = handlers.get("resources_discover")!;
    expect(registeredTools(api, "mcpScript")).toHaveLength(0);

    discover({ cwd: sessionCwd, reason: "pre-session" });
    expect(registeredTools(api, "mcpScript")).toHaveLength(0);

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: sessionCwd });
    const scripts = registeredTools(api, "mcpScript");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].description).not.toContain("SKILL.md");
    expect(scripts[0].description).toContain("multiple MCP calls in one request");
    expect(scripts[0].description).toContain("data is the raw MCP result { content, structuredContent? }");
    expect(scripts[0].description).toContain("JSON.parse(data.content[0].text)");

    discover({ cwd: sessionCwd, reason: "post-session" });
    expect(registeredTools(api, "mcpScript")).toHaveLength(1);
  });

  it("script skill publication load model -> session model points once without resource re-registration", async () => {
    const sessionCwd = "/session/script-skill-publication-model";
    const config = { settings: { scriptMode: true, scriptSkill: "model" as const }, mcpServers: {} };
    mocks.loadMcpConfig.mockImplementation((_path?: string, cwd?: string) => structuredClone(
      cwd === sessionCwd ? config : config,
    ));

    const { api, handlers } = await loadAdapter();
    const discover = handlers.get("resources_discover")!;
    expect(registeredTools(api, "mcpScript")).toHaveLength(0);
    discover({ cwd: sessionCwd, reason: "pre-session" });
    expect(registeredTools(api, "mcpScript")).toHaveLength(0);

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: sessionCwd });
    const scripts = registeredTools(api, "mcpScript");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].description).toContain("skills/mcp-scripting/SKILL.md");
    expect(scripts[0].description).toContain("Before writing a script, read");

    discover({ cwd: sessionCwd, reason: "post-session" });
    expect(registeredTools(api, "mcpScript")).toHaveLength(1);
  });

  it("script skill publication load model -> session off removes true proxy hint after selection", async () => {
    const sessionCwd = "/session/script-skill-publication-off";
    const loadConfig = {
      settings: { scriptMode: true, scriptSkill: "model" as const },
      mcpServers: { demo: { command: "load-config" } },
    };
    const sessionConfig = {
      settings: { scriptMode: false, scriptSkill: "model" as const },
      mcpServers: { demo: { command: "session-config" } },
    };
    mocks.loadMcpConfig.mockImplementation((_path?: string, cwd?: string) => structuredClone(
      cwd === sessionCwd ? sessionConfig : loadConfig,
    ));
    mocks.buildProxyDescription.mockImplementation((_config: unknown, enabled: boolean) => enabled ? "SCRIPT-HINT" : "PLAIN");
    const state = createState();
    state.config = { ...structuredClone(sessionConfig), settings: { scriptMode: true, scriptSkill: "model" } };
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();
    const discover = handlers.get("resources_discover")!;
    const initialProxyDefinitions = registeredTools(api, "mcp");
    const firstProxyDefinition = initialProxyDefinitions.at(-1);
    expect(firstProxyDefinition?.description).toBe("SCRIPT-HINT");
    expect(firstProxyDefinition?.parameters).toEqual(expect.anything());
    expect(firstProxyDefinition?.execute).toEqual(expect.any(Function));
    expect(firstProxyDefinition?.renderCall).toEqual(expect.any(Function));
    discover({ cwd: sessionCwd, reason: "pre-session" });
    expect(registeredTools(api, "mcpScript")).toHaveLength(0);
    const initialProxyCount = registeredTools(api, "mcp").length;

    const started = handlers.get("session_start")?.({}, { hasUI: false, cwd: sessionCwd });
    expect(registeredTools(api, "mcp").at(-1)?.description).toBe("PLAIN");
    await started;
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));

    const postSessionProxyDefinitions = registeredTools(api, "mcp").slice(initialProxyCount);
    expect(postSessionProxyDefinitions.length).toBeGreaterThan(0);
    const lastProxyDefinition = postSessionProxyDefinitions.at(-1);
    expect(lastProxyDefinition?.description).toBe("PLAIN");
    expect(lastProxyDefinition?.name).toBe(firstProxyDefinition?.name);
    expect(lastProxyDefinition?.parameters).toBe(firstProxyDefinition?.parameters);
    expect(lastProxyDefinition?.execute).toEqual(expect.any(Function));
    expect(lastProxyDefinition?.renderCall).toEqual(expect.any(Function));
    expect(postSessionProxyDefinitions.every(definition => definition.description !== "SCRIPT-HINT")).toBe(true);
    expect(registeredTools(api, "mcpScript")).toHaveLength(0);
  });

  it("script skill publication load manual -> session model keeps the first definition immutable", async () => {
    const sessionCwd = "/session/script-skill-publication-manual-to-model";
    const loadConfig = { settings: { scriptMode: true, scriptSkill: "manual" as const }, mcpServers: {} };
    const sessionConfig = { settings: { scriptMode: true, scriptSkill: "model" as const }, mcpServers: {} };
    mocks.loadMcpConfig.mockImplementation((_path?: string, cwd?: string) => structuredClone(
      cwd === sessionCwd ? sessionConfig : loadConfig,
    ));

    const { api, handlers } = await loadAdapter();
    const discover = handlers.get("resources_discover")!;
    const first = registeredTools(api, "mcpScript");
    expect(first).toHaveLength(1);
    const firstDefinition = first[0];
    expect(firstDefinition.description).not.toContain("SKILL.md");
    const firstDescription = firstDefinition.description;
    const firstParameters = firstDefinition.parameters;
    const firstExecute = firstDefinition.execute;
    const firstRenderCall = firstDefinition.renderCall;

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: sessionCwd });
    discover({ cwd: sessionCwd, reason: "post-session" });

    const last = registeredTools(api, "mcpScript");
    expect(last).toHaveLength(1);
    expect(last[0]).toBe(firstDefinition);
    expect(last[0].description).toBe(firstDescription);
    expect(last[0].parameters).toBe(firstParameters);
    expect(last[0].execute).toBe(firstExecute);
    expect(last[0].renderCall).toBe(firstRenderCall);
  });

  it.each([
    ["load disabled/session enabled", false, true],
    ["load enabled/session disabled", true, false],
  ])("keeps the session scripting decision through runtime initialization and refresh (%s)", async (
    _caseName,
    loadScriptMode,
    sessionScriptMode,
  ) => {
    const sessionCwd = "/session/script-choice";
    const loadConfig = {
      settings: { scriptMode: loadScriptMode },
      mcpServers: { demo: { command: "load-config" } },
    };
    const sessionConfig = {
      settings: { scriptMode: sessionScriptMode },
      mcpServers: { demo: { command: "session-config" } },
    };
    mocks.loadMcpConfig.mockImplementation((_path?: string, cwd?: string) => structuredClone(
      cwd === sessionCwd ? sessionConfig : loadConfig,
    ));
    const state = createState();
    // Initialization must not be allowed to replace the session's selected
    // script mode with whatever this state happened to contain.
    state.config = {
      settings: { scriptMode: !sessionScriptMode },
      mcpServers: { demo: { command: "initialized-state" } },
    };
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash"]);
    mcpAdapter(api);
    mocks.buildProxyDescription.mockClear();

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: sessionCwd });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));

    expect(state.scriptTool).toBe(sessionScriptMode);
    expect(registeredTool(api, "mcpScript")).toBeDefined();
    expect(activeTools()).toEqual(sessionScriptMode ? ["bash", "mcp", "mcpScript"] : ["bash", "mcp"]);
    expect(mocks.buildProxyDescription.mock.calls.some(([config, enabled]) => (
      config === state.config && enabled === sessionScriptMode
    ))).toBe(true);

    mocks.buildProxyDescription.mockClear();
    await state.onToolMetadataUpdated?.("demo", "connect");

    expect(state.scriptTool).toBe(sessionScriptMode);
    expect(activeTools()).toEqual(sessionScriptMode ? ["bash", "mcp", "mcpScript"] : ["bash", "mcp"]);
    expect(mocks.buildProxyDescription.mock.calls.some(([config, enabled]) => (
      config === state.config && enabled === sessionScriptMode
    ))).toBe(true);
  });

  it.each([
    ["enabled to default off", false, true, false],
    ["disabled to default on", true, false, true],
  ])("refreshes a replacement session's scripting choice (%s)", async (
    _caseName,
    loadScriptMode,
    firstScriptMode,
    secondScriptMode,
  ) => {
    const firstCwd = "/session/first-script-choice";
    const secondCwd = "/session/second-script-choice";
    const loadConfig = { mcpServers: { demo: { command: "load-config" } }, settings: { scriptMode: loadScriptMode } };
    const firstConfig = { mcpServers: { demo: { command: "first-config" } }, settings: { scriptMode: firstScriptMode } };
    const secondConfig = { mcpServers: { demo: { command: "second-config" } }, settings: { scriptMode: secondScriptMode } };
    mocks.loadMcpConfig.mockImplementation((_path?: string, cwd?: string) => structuredClone(
      cwd === firstCwd ? firstConfig : cwd === secondCwd ? secondConfig : loadConfig,
    ));
    const firstState = createState();
    firstState.config = { mcpServers: { demo: { command: "first-state" } }, settings: { scriptMode: !firstScriptMode } };
    const secondState = createState();
    secondState.config = { mcpServers: { demo: { command: "second-state" } }, settings: { scriptMode: !secondScriptMode } };
    mocks.initializeMcp.mockResolvedValueOnce(firstState).mockResolvedValueOnce(secondState);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash"]);
    mcpAdapter(api);

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: firstCwd });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(firstState));
    expect(firstState.scriptTool).toBe(firstScriptMode);
    expect(activeTools()).toEqual(firstScriptMode ? ["bash", "mcp", "mcpScript"] : ["bash", "mcp"]);
    await firstState.onToolMetadataUpdated?.("demo", "connect");

    mocks.updateStatusBar.mockClear();
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: secondCwd });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(secondState));
    expect(secondState.scriptTool).toBe(secondScriptMode);
    expect(activeTools()).toEqual(secondScriptMode ? ["bash", "mcp", "mcpScript"] : ["bash", "mcp"]);

    mocks.buildProxyDescription.mockClear();
    await secondState.onToolMetadataUpdated?.("demo", "connect");
    expect(secondState.scriptTool).toBe(secondScriptMode);
    expect(activeTools()).toEqual(secondScriptMode ? ["bash", "mcp", "mcpScript"] : ["bash", "mcp"]);
    expect(mocks.buildProxyDescription.mock.calls.some(([config, enabled]) => (
      config === secondState.config && enabled === secondScriptMode
    ))).toBe(true);
  });

  it.each([
    ["enabled to disabled", true, false],
    ["disabled to enabled", false, true],
  ])("refreshes the registered proxy description for a warm deferred replacement session (%s)", async (
    _caseName,
    firstScriptMode,
    secondScriptMode,
  ) => {
    const firstCwd = "/session/proxy-hint-first";
    const secondCwd = "/session/proxy-hint-second";
    const definition = { url: "https://warm.example/mcp" };
    const loadConfig = { settings: { scriptMode: false }, mcpServers: { demo: definition } };
    const firstConfig = { settings: { scriptMode: firstScriptMode }, mcpServers: { demo: definition } };
    const secondConfig = { settings: { scriptMode: secondScriptMode }, mcpServers: { demo: definition } };
    let metadataCache: any = null;
    mocks.loadMcpConfig.mockImplementation((_path?: string, cwd?: string) => structuredClone(
      cwd === firstCwd ? firstConfig : cwd === secondCwd ? secondConfig : loadConfig,
    ));
    mocks.loadMetadataCache.mockImplementation(() => metadataCache);
    mocks.buildProxyDescription.mockImplementation((_config: unknown, enabled: boolean) => enabled ? "HINT" : "PLAIN");
    const state = createState();
    state.config = { ...structuredClone(firstConfig), settings: { scriptMode: !firstScriptMode } };
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    const lastMcpDefinition = () => api.registerTool.mock.calls
      .filter((call: any[]) => call[0]?.name === "mcp")
      .at(-1)?.[0];
    const descriptionFor = (enabled: boolean) => enabled ? "HINT" : "PLAIN";

    expect(lastMcpDefinition()?.description).toBe("PLAIN");
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: firstCwd });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));
    expect(state.scriptTool).toBe(firstScriptMode);
    expect(activeTools()).toEqual(firstScriptMode ? ["bash", "mcp", "mcpScript"] : ["bash", "mcp"]);
    expect(lastMcpDefinition()?.description).toBe(descriptionFor(firstScriptMode));

    await handlers.get("session_shutdown")?.({}, {});
    metadataCache = { version: 1, servers: { demo: cacheEntry(definition) } };
    const initializationCount = mocks.initializeMcp.mock.calls.length;
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: secondCwd });

    expect(mocks.initializeMcp).toHaveBeenCalledTimes(initializationCount);
    expect(activeTools()).toEqual(secondScriptMode ? ["bash", "mcp", "mcpScript"] : ["bash", "mcp"]);
    expect(lastMcpDefinition()?.description).toBe(descriptionFor(secondScriptMode));
  });

  it("rolls back a failed proxy registration so a retry is not skipped", async () => {
    const sessionCwd = "/session/proxy-registration-retry";
    const definition = { url: "https://retry.example/mcp" };
    const loadConfig = { settings: { scriptMode: false }, mcpServers: { demo: definition } };
    const sessionConfig = { settings: { scriptMode: true }, mcpServers: { demo: definition } };
    mocks.loadMcpConfig.mockImplementation((_path?: string, cwd?: string) => structuredClone(
      cwd === sessionCwd ? sessionConfig : loadConfig,
    ));
    mocks.loadMetadataCache.mockReturnValue({ version: 1, servers: { demo: cacheEntry(definition) } });
    mocks.buildProxyDescription.mockImplementation((_config: unknown, enabled: boolean) => enabled ? "HINT" : "PLAIN");

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    const lastMcpDefinition = () => api.registerTool.mock.calls
      .filter((call: any[]) => call[0]?.name === "mcp")
      .at(-1)?.[0];
    const initialMcpCalls = api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "mcp").length;
    const registrationError = new Error("proxy registration failed");
    let failRegistration = true;
    const registerExisting = api.registerTool.getMockImplementation()!;
    api.registerTool.mockImplementation((tool: any) => {
      if (tool.name === "mcp" && tool.description === "HINT" && failRegistration) throw registrationError;
      return registerExisting(tool);
    });

    await expect(handlers.get("session_start")?.({}, { hasUI: false, cwd: sessionCwd })).rejects.toBe(registrationError);
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "mcp").length).toBe(initialMcpCalls + 1);
    expect(activeTools()).toEqual(["bash", "mcp", "mcpScript"]);

    failRegistration = false;
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: sessionCwd });
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "mcp").length).toBe(initialMcpCalls + 2);
    expect(lastMcpDefinition()?.description).toBe("HINT");
    expect(activeTools()).toEqual(["bash", "mcp", "mcpScript"]);
    expect(mocks.initializeMcp).not.toHaveBeenCalled();
  });

  it.each([
    ["load off / A on / B off / C on", false, true, false, true],
    ["load on / A off / B on / C off", true, false, true, false],
  ])("preserves a nested newer proxy publication when the outer registration throws (%s)", async (
    _caseName,
    loadScriptMode,
    firstScriptMode,
    outerScriptMode,
    nestedScriptMode,
  ) => {
    const firstCwd = "/session/proxy-reentrant-first";
    const outerCwd = "/session/proxy-reentrant-outer";
    const nestedCwd = "/session/proxy-reentrant-nested";
    const loadDefinition = { url: "https://reentrant-load.example/mcp" };
    const firstDefinition = { url: "https://reentrant-first.example/mcp" };
    const outerDefinition = { url: "https://reentrant-outer.example/mcp" };
    const nestedDefinition = { url: "https://reentrant-nested.example/mcp" };
    const loadConfig = { settings: { scriptMode: loadScriptMode }, mcpServers: { load: loadDefinition } };
    const firstConfig = { settings: { scriptMode: firstScriptMode }, mcpServers: { first: firstDefinition } };
    const outerConfig = { settings: { scriptMode: outerScriptMode }, mcpServers: { outer: outerDefinition } };
    const nestedConfig = { settings: { scriptMode: nestedScriptMode }, mcpServers: { nested: nestedDefinition } };
    let metadataCache: any = null;
    mocks.loadMcpConfig.mockImplementation((_path?: string, cwd?: string) => structuredClone(
      cwd === firstCwd ? firstConfig : cwd === outerCwd ? outerConfig : cwd === nestedCwd ? nestedConfig : loadConfig,
    ));
    mocks.loadMetadataCache.mockImplementation(() => metadataCache);
    mocks.buildProxyDescription.mockImplementation((config: { mcpServers: Record<string, unknown> }, enabled: boolean) => {
      const marker = Object.keys(config.mcpServers)[0] ?? "unknown";
      return `${marker}:${enabled ? "on" : "off"}`;
    });
    const state = createState();
    state.config = { ...structuredClone(firstConfig), settings: { scriptMode: !firstScriptMode } };
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    const descriptionFor = (config: { mcpServers: Record<string, unknown> }, enabled: boolean) => {
      const marker = Object.keys(config.mcpServers)[0] ?? "unknown";
      return `${marker}:${enabled ? "on" : "off"}`;
    };
    const lastMcpDefinition = () => api.registerTool.mock.calls
      .filter((call: any[]) => call[0]?.name === "mcp")
      .at(-1)?.[0];

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: firstCwd });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));
    await handlers.get("session_shutdown")?.({}, {});
    metadataCache = {
      version: 1,
      servers: {
        first: cacheEntry(firstDefinition),
        outer: cacheEntry(outerDefinition),
        nested: cacheEntry(nestedDefinition),
      },
    };
    const initializationCount = mocks.initializeMcp.mock.calls.length;
    const successfulMcpDefinitions: any[] = [];
    const outerError = new Error("outer proxy registration failed");
    let nestedStart: Promise<unknown> | undefined;
    let enteredOuterCallback = false;
    const registerExisting = api.registerTool.getMockImplementation()!;
    api.registerTool.mockImplementation((tool: any) => {
      if (tool.name === "mcp" && tool.description === descriptionFor(outerConfig, outerScriptMode) && !enteredOuterCallback) {
        enteredOuterCallback = true;
        nestedStart = handlers.get("session_start")?.({}, { hasUI: false, cwd: nestedCwd }) as Promise<unknown>;
        throw outerError;
      }
      const result = registerExisting(tool);
      if (tool.name === "mcp") successfulMcpDefinitions.push(tool);
      return result;
    });

    await expect(handlers.get("session_start")?.({}, { hasUI: false, cwd: outerCwd })).rejects.toBe(outerError);
    await expect(nestedStart).resolves.toBeUndefined();

    expect(lastMcpDefinition()?.description).toBe(descriptionFor(nestedConfig, nestedScriptMode));
    expect(successfulMcpDefinitions.at(-1)?.description).toBe(descriptionFor(nestedConfig, nestedScriptMode));
    expect(activeTools()).toEqual(nestedScriptMode ? ["bash", "mcp", "mcpScript"] : ["bash", "mcp"]);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(initializationCount);

    const mcpRegistrationCount = api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "mcp").length;
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: nestedCwd });
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "mcp").length).toBe(mcpRegistrationCount);
    expect(successfulMcpDefinitions.at(-1)?.description).toBe(descriptionFor(nestedConfig, nestedScriptMode));
    expect(lastMcpDefinition()?.description).toBe(descriptionFor(nestedConfig, nestedScriptMode));
    expect(activeTools()).toEqual(nestedScriptMode ? ["bash", "mcp", "mcpScript"] : ["bash", "mcp"]);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(initializationCount);
  });

  it.each([
    ["load off / A on / B off / C on", false, true, false, true],
    ["load on / A off / B on / C off", true, false, true, false],
  ])("publishes the newest proxy description when a warm registration callback returns (%s)", async (
    _caseName,
    loadScriptMode,
    firstScriptMode,
    outerScriptMode,
    nestedScriptMode,
  ) => {
    const firstCwd = "/session/proxy-reentrant-return-first";
    const outerCwd = "/session/proxy-reentrant-return-outer";
    const nestedCwd = "/session/proxy-reentrant-return-nested";
    const loadDefinition = { url: "https://reentrant-return-load.example/mcp" };
    const firstDefinition = { url: "https://reentrant-return-first.example/mcp" };
    const outerDefinition = { url: "https://reentrant-return-outer.example/mcp" };
    const nestedDefinition = { url: "https://reentrant-return-nested.example/mcp" };
    const loadConfig = { settings: { scriptMode: loadScriptMode }, mcpServers: { load: loadDefinition } };
    const firstConfig = { settings: { scriptMode: firstScriptMode }, mcpServers: { first: firstDefinition } };
    const outerConfig = { settings: { scriptMode: outerScriptMode }, mcpServers: { outer: outerDefinition } };
    const nestedConfig = { settings: { scriptMode: nestedScriptMode }, mcpServers: { nested: nestedDefinition } };
    let metadataCache: any = null;
    mocks.loadMcpConfig.mockImplementation((_path?: string, cwd?: string) => structuredClone(
      cwd === firstCwd ? firstConfig : cwd === outerCwd ? outerConfig : cwd === nestedCwd ? nestedConfig : loadConfig,
    ));
    mocks.loadMetadataCache.mockImplementation(() => metadataCache);
    mocks.buildProxyDescription.mockImplementation((config: { mcpServers: Record<string, unknown> }, enabled: boolean) => {
      const marker = Object.keys(config.mcpServers)[0] ?? "unknown";
      return `${marker}:${enabled ? "on" : "off"}`;
    });
    const state = createState();
    state.config = { ...structuredClone(firstConfig), settings: { scriptMode: !firstScriptMode } };
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    const descriptionFor = (config: { mcpServers: Record<string, unknown> }, enabled: boolean) => {
      const marker = Object.keys(config.mcpServers)[0] ?? "unknown";
      return `${marker}:${enabled ? "on" : "off"}`;
    };
    const successfulMcpDefinitions: any[] = [];

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: firstCwd });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));
    await handlers.get("session_shutdown")?.({}, {});
    metadataCache = {
      version: 1,
      servers: {
        first: cacheEntry(firstDefinition),
        outer: cacheEntry(outerDefinition),
        nested: cacheEntry(nestedDefinition),
      },
    };
    const initializationCount = mocks.initializeMcp.mock.calls.length;
    let nestedStart: Promise<unknown> | undefined;
    let enteredOuterCallback = false;
    const registerExisting = api.registerTool.getMockImplementation()!;
    api.registerTool.mockImplementation((tool: any) => {
      if (tool.name === "mcp" && tool.description === descriptionFor(outerConfig, outerScriptMode) && !enteredOuterCallback) {
        enteredOuterCallback = true;
        const result = registerExisting(tool);
        successfulMcpDefinitions.push(tool);
        nestedStart = handlers.get("session_start")?.({}, { hasUI: false, cwd: nestedCwd }) as Promise<unknown>;
        return result;
      }
      const result = registerExisting(tool);
      if (tool.name === "mcp") successfulMcpDefinitions.push(tool);
      return result;
    });

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: outerCwd });
    await expect(nestedStart).resolves.toBeUndefined();

    expect(successfulMcpDefinitions.at(-1)?.description).toBe(descriptionFor(nestedConfig, nestedScriptMode));
    expect(activeTools()).toEqual(nestedScriptMode ? ["bash", "mcp", "mcpScript"] : ["bash", "mcp"]);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(initializationCount);
    const mcpRegistrationCount = api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "mcp").length;
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: nestedCwd });
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "mcp").length).toBe(mcpRegistrationCount);
    expect(successfulMcpDefinitions.at(-1)?.description).toBe(descriptionFor(nestedConfig, nestedScriptMode));
    expect(activeTools()).toEqual(nestedScriptMode ? ["bash", "mcp", "mcpScript"] : ["bash", "mcp"]);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(initializationCount);
  });

  it("unwinds nested and outer proxy failures before a later retry", async () => {
    const firstCwd = "/session/proxy-nested-failure-first";
    const outerCwd = "/session/proxy-nested-failure-outer";
    const nestedCwd = "/session/proxy-nested-failure-nested";
    const loadDefinition = { url: "https://nested-failure-load.example/mcp" };
    const firstDefinition = { url: "https://nested-failure-first.example/mcp" };
    const outerDefinition = { url: "https://nested-failure-outer.example/mcp" };
    const nestedDefinition = { url: "https://nested-failure-nested.example/mcp" };
    const loadConfig = { settings: { scriptMode: false }, mcpServers: { load: loadDefinition } };
    const firstConfig = { settings: { scriptMode: true }, mcpServers: { first: firstDefinition } };
    const outerConfig = { settings: { scriptMode: false }, mcpServers: { outer: outerDefinition } };
    const nestedConfig = { settings: { scriptMode: true }, mcpServers: { nested: nestedDefinition } };
    let metadataCache: any = null;
    mocks.loadMcpConfig.mockImplementation((_path?: string, cwd?: string) => structuredClone(
      cwd === firstCwd ? firstConfig : cwd === outerCwd ? outerConfig : cwd === nestedCwd ? nestedConfig : loadConfig,
    ));
    mocks.loadMetadataCache.mockImplementation(() => metadataCache);
    mocks.buildProxyDescription.mockImplementation((config: { mcpServers: Record<string, unknown> }, enabled: boolean) => {
      const marker = Object.keys(config.mcpServers)[0] ?? "unknown";
      return `${marker}:${enabled ? "on" : "off"}`;
    });
    const state = createState();
    state.config = { ...structuredClone(firstConfig), settings: { scriptMode: false } };
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    const descriptionFor = (config: { mcpServers: Record<string, unknown> }, enabled: boolean) => {
      const marker = Object.keys(config.mcpServers)[0] ?? "unknown";
      return `${marker}:${enabled ? "on" : "off"}`;
    };
    const registerExisting = api.registerTool.getMockImplementation()!;

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: firstCwd });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));
    await handlers.get("session_shutdown")?.({}, {});
    metadataCache = {
      version: 1,
      servers: {
        first: cacheEntry(firstDefinition),
        outer: cacheEntry(outerDefinition),
        nested: cacheEntry(nestedDefinition),
      },
    };
    const nestedError = new Error("nested proxy registration failed");
    const outerError = new Error("outer proxy registration failed");
    let nestedStart: Promise<unknown> | undefined;
    let enteredOuterCallback = false;
    let failOuterAttempt = true;
    const successfulMcpDefinitions: any[] = [];
    api.registerTool.mockImplementation((tool: any) => {
      if (tool.name === "mcp" && tool.description === descriptionFor(outerConfig, false) && failOuterAttempt && !enteredOuterCallback) {
        enteredOuterCallback = true;
        nestedStart = handlers.get("session_start")?.({}, { hasUI: false, cwd: nestedCwd }) as Promise<unknown>;
        throw outerError;
      }
      if (tool.name === "mcp" && tool.description === descriptionFor(nestedConfig, true) && failOuterAttempt) throw nestedError;
      const result = registerExisting(tool);
      if (tool.name === "mcp") successfulMcpDefinitions.push(tool);
      return result;
    });

    await expect(handlers.get("session_start")?.({}, { hasUI: false, cwd: outerCwd })).rejects.toBe(outerError);
    await expect(nestedStart).rejects.toBe(nestedError);
    expect(successfulMcpDefinitions).toHaveLength(0);
    expect(activeTools()).toEqual(["bash", "mcp", "mcpScript"]);

    failOuterAttempt = false;
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: outerCwd });
    expect(successfulMcpDefinitions.at(-1)?.description).toBe(descriptionFor(outerConfig, false));
    expect(activeTools()).toEqual(["bash", "mcp"]);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
  });

  it("keeps scripting off by default through initialized runtime state", async () => {
    const config = { mcpServers: { demo: { command: "demo" } } };
    mocks.loadMcpConfig.mockReturnValue(config);
    const state = createState();
    state.config = { ...config, settings: { scriptMode: true } };
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();
    const activeTools = trackRuntimeToolActivation(api, ["bash"]);
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/session/default-script-off" });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));

    expect(state.scriptTool).toBe(false);
    expect(registeredTool(api, "mcpScript")).toBeUndefined();
    expect(activeTools()).not.toContain("mcpScript");
  });

  it("keeps programmatic scripting isolated from ambient configuration", async () => {
    const ambientConfig = { settings: { scriptMode: false }, mcpServers: { ambient: { command: "ambient" } } };
    mocks.loadMcpConfig.mockReturnValue(ambientConfig);
    const config = { settings: { scriptMode: true }, mcpServers: { memory: { command: "memory" } } };
    const state = createState();
    state.config = { settings: { scriptMode: false }, mcpServers: { memory: { command: "initialized" } } };
    mocks.initializeMcp.mockResolvedValue(state);

    const { createMcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash"]);
    createMcpAdapter({ config })(api);

    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/ambient/session" });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));

    expect(state.scriptTool).toBe(true);
    expect(registeredTool(api, "mcpScript")).toBeDefined();
    expect(activeTools()).toContain("mcpScript");
  });

  it("keeps the proxy tool when direct tools are still missing from cache", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
      },
      settings: { disableProxyTool: true },
    });
    mocks.resolveDirectTools.mockReturnValue([
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search demo",
      },
    ]);
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["demo"]);

    const { api } = await loadAdapter();

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "demo_search",
      renderResult: expect.any(Function),
    }));
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "mcp",
      renderResult: expect.any(Function),
    }));
  });

  it("uses compact self-rendered rows for proxy and direct tools by default", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
      },
    });
    mocks.resolveDirectTools.mockReturnValue([
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search demo",
      },
    ]);

    const { api } = await loadAdapter();

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "demo_search",
      renderShell: "self",
    }));
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "mcp",
      renderShell: "self",
    }));
  });

  it("keeps legacy boxed rows when configured", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      settings: { toolResultRendering: "boxed" },
      mcpServers: {},
    });

    const { api } = await loadAdapter();

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "mcp",
      renderShell: "default",
    }));
  });

  it("does not leak TypeBox internal markers into registered tool parameter schemas", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {}, settings: { scriptMode: true } });
    const { api } = await loadAdapter();

    const collectTildeKeys = (value: unknown, path = "$", keys: string[] = []): string[] => {
      if (value === null || typeof value !== "object") return keys;
      if (Array.isArray(value)) {
        value.forEach((item, index) => collectTildeKeys(item, `${path}[${index}]`, keys));
        return keys;
      }
      for (const [key, child] of Object.entries(value)) {
        if (key.startsWith("~")) keys.push(`${path}.${key}`);
        collectTildeKeys(child, `${path}.${key}`, keys);
      }
      return keys;
    };

    for (const toolName of ["mcpScript", "mcp"]) {
      const tool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === toolName)?.[0];
      expect(tool, `expected ${toolName} to be registered`).toBeDefined();

      const serialized = JSON.parse(JSON.stringify(tool.parameters));
      expect(
        collectTildeKeys(serialized),
        `${toolName} parameters must not leak TypeBox internal markers (~optional etc.)`,
      ).toEqual([]);

      // Optional numeric fields must still be present with their options and not required.
      for (const key of toolName === "mcpScript" ? ["timeoutMs"] : ["limit", "offset"]) {
        expect(serialized.properties[key]).toMatchObject({ type: "number", description: expect.any(String) });
        expect(serialized.required ?? []).not.toContain(key);
      }
    }
  });

  it("registers direct MCP tools when the host TypeBox shim omits Unsafe", async () => {
    vi.doMock("typebox", () => ({
      Type: {
        Object: (properties: Record<string, unknown>, options?: Record<string, unknown>) => ({ type: "object", properties, ...options }),
        String: (options?: Record<string, unknown>) => ({ type: "string", ...options }),
        Boolean: (options?: Record<string, unknown>) => ({ type: "boolean", ...options }),
        Optional: (schema: Record<string, unknown>) => ({ ...schema, optional: true }),
        Union: (schemas: unknown[], options?: Record<string, unknown>) => ({ anyOf: schemas, ...options }),
      },
    }));
    mocks.resolveDirectTools.mockReturnValue([
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search demo",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);

    const { api } = await loadAdapter();

    const directTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "demo_search")?.[0];
    expect(directTool.parameters).toEqual({ type: "object", properties: { query: { type: "string" } } });
  });

  it("normalizes direct MCP tool schemas before registration", async () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        query: { type: "string" },
        nested: {
          type: "object",
          additionalProperties: false,
        },
      },
      required: ["query"],
      additionalProperties: false,
    };
    mocks.resolveDirectTools.mockReturnValue([
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search demo",
        inputSchema: schema,
      },
    ]);

    const { api } = await loadAdapter();

    expect(mocks.normalizeDirectToolInputSchema).toHaveBeenCalledWith(schema);
    const directTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "demo_search")?.[0];
    expect(directTool.parameters).toMatchObject({
      type: "object",
      properties: {
        query: { type: "string" },
        nested: {
          type: "object",
          additionalProperties: false,
        },
      },
      required: ["query"],
    });
    expect(directTool.parameters).not.toHaveProperty("$schema");
    expect(directTool.parameters).not.toHaveProperty("additionalProperties");
  });

  it("waits for env-selected cold-cache tools before session startup completes", async () => {
    process.env.MCP_DIRECT_TOOLS = "demo/search";
    const config = {
      mcpServers: {
        demo: { command: "demo-server" },
      },
    };
    const state = createState();
    state.config = config;
    const initialization = createDeferred(state);
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["demo"]);
    mocks.initializeMcp.mockReturnValue(initialization.promise);

    const { api, handlers } = await loadAdapter();

    let sessionStarted = false;
    const sessionStart = Promise.resolve(handlers.get("session_start")?.({}, { hasUI: false }))
      .then(() => { sessionStarted = true; });
    await new Promise(resolve => setImmediate(resolve));

    expect(sessionStarted).toBe(false);

    mocks.resolveDirectTools.mockReturnValue([{
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search demo",
    }]);
    initialization.resolve(state);
    await sessionStart;

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search" }));
  });

  it("restores approval state from the active session branch on session_tree", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    const sessionManager = {
      getBranch: vi.fn(),
    };
    const state = createState();
    const tool = {
      originalName: "search",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      uiResourceUri: "ui://demo/search",
    };
    const identity = getToolApprovalIdentity("demo", tool, { query: "safe" });
    const branch = [{
      type: "custom",
      customType: MCP_APPROVAL_CUSTOM_TYPE,
      data: {
        version: 1,
        kind: "tool",
        decision: "allow_for_session",
        serverName: "demo",
        originalToolName: "search",
        definitionHash: identity.definitionHash,
        argsHash: identity.argsHash,
      },
    }];
    sessionManager.getBranch.mockReturnValue(branch);
    state.sessionManager = sessionManager;
    state.approvedToolCalls = new Map([["stale", true]]);
    state.consentManager = new ConsentManager();
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();
    const context = { hasUI: false, sessionManager };
    await handlers.get("session_start")?.({}, context);
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));
    await handlers.get("session_tree")?.({}, context);

    expect(state.approvedToolCalls).toEqual(new Map([
      [makeToolApprovalKey("demo", "search", identity.definitionHash, identity.argsHash), true],
    ]));
  });

  it("ignores session_tree events from a stale session manager", async () => {
    const activeSessionManager = { getBranch: vi.fn().mockReturnValue([]) };
    const staleSessionManager = { getBranch: vi.fn().mockReturnValue([{
      type: "custom",
      customType: MCP_APPROVAL_CUSTOM_TYPE,
      data: {
        version: 1,
        kind: "iframe",
        decision: "allow",
        serverName: "stale",
      },
    }]) };
    const state = createState();
    state.sessionManager = activeSessionManager;
    state.consentManager = new ConsentManager();
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false, sessionManager: activeSessionManager });
    await handlers.get("session_tree")?.({}, { hasUI: false, sessionManager: staleSessionManager });

    expect(staleSessionManager.getBranch).not.toHaveBeenCalled();
    expect(state.consentManager.requiresPrompt("stale")).toBe(true);
  });

  it("waits for keep-alive convergence before Pi processes the next input", async () => {
    const config = {
      mcpServers: {
        demo: { url: "https://example.test/mcp", lifecycle: "keep-alive" },
      },
    };
    const state = createState();
    state.config = config;
    const convergence = createDeferred<void>();
    state.lifecycle.ensureConverged.mockReturnValue(convergence.promise);
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    let inputCompleted = false;
    const input = Promise.resolve(handlers.get("input")?.({ type: "input", text: "hello" }, {}))
      .then(() => { inputCompleted = true; });
    await new Promise(resolve => setImmediate(resolve));

    expect(inputCompleted).toBe(false);
    convergence.resolve();
    await input;
    expect(state.lifecycle.ensureConverged).toHaveBeenCalledTimes(1);
  });

  it("waits for pending lazy-keep-alive initialization before the first input", async () => {
    const config = {
      mcpServers: {
        demo: { url: "https://example.test/mcp", lifecycle: "lazy-keep-alive" },
      },
    };
    const state = createState();
    state.config = config;
    const initialization = createDeferred<typeof state>();
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(null);
    mocks.initializeMcp.mockReturnValue(initialization.promise);

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, {});

    let inputCompleted = false;
    const input = Promise.resolve(handlers.get("input")?.({ type: "input", text: "hello" }, {}))
      .then(() => { inputCompleted = true; });
    await new Promise(resolve => setImmediate(resolve));

    expect(inputCompleted).toBe(false);
    initialization.resolve(state);
    await input;
    expect(state.lifecycle.ensureConverged).toHaveBeenCalledTimes(1);
  });

  it("keeps session_start open until project-server approval is answered", async () => {
    mocks.holdProjectTrust = true;
    const config = {
      mcpServers: {
        demo: { url: "https://example.test/mcp", lifecycle: "keep-alive" },
      },
    };
    const state = createState();
    const initialization = createDeferred<typeof state>();
    let resolveProjectTrust: (() => void) | undefined;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.initializeMcp.mockImplementation((_pi: unknown, _ctx: unknown, _owner: unknown, options: { onProjectTrustResolved?: () => void }) => {
      resolveProjectTrust = options.onProjectTrustResolved;
      return initialization.promise;
    });

    const { handlers } = await loadAdapter();
    let sessionStarted = false;
    const sessionStart = Promise.resolve(handlers.get("session_start")?.({}, {}))
      .then(() => { sessionStarted = true; });
    await vi.waitFor(() => expect(resolveProjectTrust).toEqual(expect.any(Function)));
    expect(sessionStarted).toBe(false);

    resolveProjectTrust?.();
    await sessionStart;
    expect(sessionStarted).toBe(true);
  });

  it("bounds the first-input wait when initialization stalls", async () => {
    vi.useFakeTimers();
    try {
      const config = {
        mcpServers: {
          demo: { url: "https://example.test/mcp", lifecycle: "keep-alive" },
        },
      };
      const state = createState();
      const initialization = createDeferred<typeof state>();
      mocks.loadMcpConfig.mockReturnValue(config);
      mocks.initializeMcp.mockReturnValue(initialization.promise);

      const { api, handlers } = await loadAdapter();
      await handlers.get("session_start")?.({}, {});

      let inputCompleted = false;
      const input = Promise.resolve(handlers.get("input")?.({ type: "input", text: "hello" }, {}))
        .then(() => { inputCompleted = true; });
      await Promise.resolve();
      expect(inputCompleted).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      await input;
      expect(inputCompleted).toBe(true);
      expect(state.lifecycle.ensureConverged).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles direct tools during the keep-alive input barrier", async () => {
    const config = {
      settings: { freezeDirectTools: false },
      mcpServers: {
        demo: {
          url: "https://example.test/mcp",
          lifecycle: "keep-alive",
          directTools: true,
        },
      },
    };
    const oldTool = {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Old search",
    };
    const newTool = {
      serverName: "demo",
      originalName: "lookup",
      prefixedName: "demo_lookup",
      description: "New lookup",
    };
    const state = createState();
    state.config = config;
    state.lifecycle.ensureConverged.mockImplementation(async () => {
      await state.onToolMetadataUpdated?.("demo", "keep-alive-refresh");
    });
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue({ version: 1, servers: {} });
    mocks.resolveDirectTools
      .mockReturnValueOnce([oldTool])
      .mockReturnValueOnce([oldTool])
      .mockReturnValue([newTool]);
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    await handlers.get("input")?.({ type: "input", text: "hello" }, {});

    expect(api.unregisterTool).toHaveBeenCalledWith("demo_search");
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "demo_lookup",
      description: "New lookup",
    }));
  });

  it("hot-loads direct tools after session initialization refreshes metadata", async () => {
    const config = {
      settings: { freezeDirectTools: false },
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache
      .mockReturnValueOnce(null)
      .mockReturnValue({ version: 1, servers: {} });
    mocks.resolveDirectTools
      .mockReturnValueOnce([])
      .mockReturnValue([
        {
          serverName: "demo",
          originalName: "search",
          prefixedName: "demo_search",
          description: "Search demo",
        },
        {
          serverName: "demo",
          originalName: "read_doc",
          prefixedName: "demo_read_doc",
          description: "Read demo document",
          resourceUri: "mcp://demo/doc",
        },
      ]);
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();

    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search" }));

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search" }));
    expect(state.directToolCounts).toEqual(new Map([["demo", 2]]));
  });

  it("does not refresh frozen direct tools on failure-backoff metadata updates", async () => {
    const config = {
      settings: { freezeDirectTools: true },
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools.mockReturnValue([
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search demo",
      },
    ]);
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const callsAfterInitialSync = mocks.resolveDirectTools.mock.calls.length;
    state.onToolMetadataUpdated?.("demo", "failure-backoff-started");

    expect(mocks.resolveDirectTools).toHaveBeenCalledTimes(callsAfterInitialSync);
  });

  it("does not mutate frozen direct tools on explicit proxy connect or slash reconnect", async () => {
    const config = {
      settings: { freezeDirectTools: true },
      mcpServers: {
        demo: { command: "demo", directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools.mockReturnValue([{
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search demo",
    }]);
    mocks.initializeMcp.mockResolvedValue(state);
    const connectResult = { content: [{ type: "text", text: "connected" }] };
    mocks.executeConnect.mockResolvedValue(connectResult);

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));
    const callsAfterInitialSync = mocks.resolveDirectTools.mock.calls.length;
    const proxyTool = registeredTool(api, "mcp");

    expect(await proxyTool.execute("call-1", { connect: "demo" })).toBe(connectResult);
    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("reconnect demo", { hasUI: false });

    expect(mocks.executeConnect).toHaveBeenCalledWith(state, "demo", undefined);
    expect(mocks.reconnectServers).toHaveBeenCalledWith(state, expect.any(Object), "demo");
    expect(mocks.resolveDirectTools).toHaveBeenCalledTimes(callsAfterInitialSync);
  });

  it.each([0, 1000])("retains each session's discovered catalogue independently of shared disk metadata (TTL %i)", async (ttlMs) => {
    const dir = mkdtempSync(resolve(tmpdir(), "mcp-session-catalogue-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    try {
      const cache = await vi.importActual<typeof import("../metadata-cache.ts")>("../metadata-cache.ts");
      const core = await vi.importActual<typeof import("../init.ts")>("../init.ts");
      const direct = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
      mocks.loadMetadataCache.mockImplementation(cache.loadMetadataCache);
      mocks.resolveDirectTools.mockImplementation(direct.resolveDirectTools);
      mocks.getMissingConfiguredDirectToolServers.mockImplementation(direct.getMissingConfiguredDirectToolServers);
      const { default: mcpAdapter } = await import("../index.ts");
      const sessions = [];
      for (const allowed of ["review", "create"]) {
        const config = { settings: { freezeDirectTools: false }, mcpServers: { shared: {
          url: "https://shared.example/mcp", lifecycle: "eager" as const,
          directTools: true as const, includeTools: ["read", "read_record", allowed],
        } } };
        const connection = {
          status: "connected", definition: config.mcpServers.shared,
          tools: ["read", "review", "create"].map(name => ({ name, inputSchema: { type: "object" } })),
          resources: [{ name: "record", uri: `file:///${allowed}` }],
          resourceDiscoveryFailed: false, toolListHints: { ttlMs },
        };
        const state = createState();
        state.config = config;
        state.manager.getAllConnections = () => new Map([["shared", connection]]);
        state.manager.getConnection.mockReturnValue(connection);
        core.updateMetadataCache(state as any, "shared");
        mocks.loadMcpConfig.mockReturnValue(config);
        mocks.initializeMcp.mockResolvedValue(state);
        const { api, handlers } = createPi();
        const active = trackRuntimeToolActivation(api, ["bash", "mcp"]);
        mcpAdapter(api);
        await handlers.get("session_start")?.({}, {});
        await handlers.get("before_agent_start")?.({ systemPrompt: "test" }, {});
        await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
        sessions.push({ state, active, connection, handlers, allowed });
      }
      const assertCatalogue = (session: typeof sessions[number]) => {
        expect(session.active().filter(name => name.startsWith("shared_")).sort())
          .toEqual(["shared_read", "shared_read_record", `shared_${session.allowed}`].sort());
      };
      const diskBytes = readFileSync(cache.getMetadataCachePath(), "utf8");
      for (const session of sessions) {
        await session.state.onToolMetadataUpdated!("shared", "check");
        assertCatalogue(session);
      }
      expect(readFileSync(cache.getMetadataCachePath(), "utf8")).toBe(diskBytes);
      const reviewer = sessions[0];
      reviewer.connection.resources = [];
      reviewer.connection.resourceDiscoveryFailed = true;
      core.updateMetadataCache(reviewer.state as any, "shared");
      await reviewer.state.onToolMetadataUpdated!("shared", "resource-discovery-failed");
      assertCatalogue(reviewer);
      expect(reviewer.state.sessionMetadata?.get("shared")?.resources)
        .toEqual([{ name: "record", uri: "file:///review" }]);
      rmSync(cache.getMetadataCachePath());
      for (const session of sessions) {
        session.state.manager.getAllConnections = () => new Map();
        await session.state.onToolMetadataUpdated!("shared", "idle");
        assertCatalogue(session);
      }
      const writer = sessions[1];
      const originalDefinition = writer.state.config.mcpServers.shared;
      for (const definition of [
        { ...originalDefinition, disabled: true },
        { ...originalDefinition, url: "https://changed.example/mcp" },
        { ...originalDefinition, includeTools: ["review"] },
      ]) {
        writer.state.config.mcpServers.shared = definition;
        core.updateMetadataCache(writer.state as any, "shared");
        await writer.state.onToolMetadataUpdated!("shared", "config-change");
        expect(writer.active().filter(name => name.startsWith("shared_"))).toEqual([]);
        writer.state.config.mcpServers.shared = originalDefinition;
        await writer.state.onToolMetadataUpdated!("shared", "config-restored");
        assertCatalogue(writer);
      }
      reviewer.connection.tools = [];
      reviewer.connection.resourceDiscoveryFailed = false;
      core.updateMetadataCache(reviewer.state as any, "shared");
      await reviewer.state.onToolMetadataUpdated!("shared", "tools-list-changed");
      expect(reviewer.active().filter(name => name.startsWith("shared_"))).toEqual([]);
      await sessions[1].state.onToolMetadataUpdated!("shared", "peer-change");
      assertCatalogue(sessions[1]);
      for (const session of sessions) await session.handlers.get("session_shutdown")?.({}, {});
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hot-loads zero-TTL live tools and resources while leaving the disk entry non-cacheable", async () => {
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const actualCache = await vi.importActual<typeof import("../metadata-cache.ts")>("../metadata-cache.ts");
    const config = {
      settings: { disableProxyTool: true as const, scriptMode: false, deferWithMissingMetadata: true, freezeDirectTools: false },
      mcpServers: {
        demo: {
          url: "https://demo.example.com/mcp",
          directTools: ["lookup", "read_guide"],
        },
        fallback: {
          url: "https://fallback.example.com/mcp",
          directTools: ["read_manual"],
        },
      },
    };
    const diskEntry = {
      configHash: actualCache.computeServerHash(config.mcpServers.demo),
      cachedAt: Date.now(),
      ttlMs: 0,
      tools: [{ name: "lookup", description: "Lookup from disk" }],
      resources: [{ name: "guide", uri: "file://disk-guide" }],
    };
    const fallbackEntry = {
      configHash: actualCache.computeServerHash(config.mcpServers.fallback),
      cachedAt: Date.now(),
      tools: [],
      resources: [{ name: "manual", uri: "file://cached-manual", description: "Cached manual" }],
    };
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue({ version: 1, servers: { demo: diskEntry, fallback: fallbackEntry } });
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.getMissingConfiguredDirectToolServers.mockImplementation(actualDirectTools.getMissingConfiguredDirectToolServers);

    const connections = new Map<string, any>();
    const state = createState();
    state.config = config;
    state.manager.getAllConnections = () => new Map(connections);
    state.manager.getConnection.mockImplementation((name: string) => connections.get(name));
    mocks.initializeMcp.mockResolvedValue(state);
    const connectResult = { content: [{ type: "text", text: "connected" }], details: { mode: "connect" } };
    mocks.executeConnect.mockImplementation(async (currentState: any) => {
      connections.set("demo", {
        status: "connected",
        definition: config.mcpServers.demo,
        tools: [
          { name: "lookup", description: "Lookup live", inputSchema: { type: "object" } },
          { name: "unselected", description: "Not selected" },
        ],
        resources: [{ name: "guide", uri: "file://live-guide", description: "Live guide" }],
        toolListHints: { ttlMs: 0 },
      });
      connections.set("fallback", {
        status: "connected",
        definition: config.mcpServers.fallback,
        tools: [],
        resources: [],
        resourceDiscoveryFailed: true,
      });
      const liveEntry = {
        ...diskEntry,
        ttlMs: 5_000,
        cacheScope: "private" as const,
        tools: actualCache.serializeTools(connections.get("demo").tools),
        resources: actualCache.serializeResources(connections.get("demo").resources),
      };
      currentState.sessionMetadata = new Map([["demo", liveEntry]]);
      mocks.loadMetadataCache.mockReturnValue({
        version: 1,
        servers: { demo: liveEntry, fallback: fallbackEntry },
      });
      await currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
      return connectResult;
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});

    expect(actualCache.isServerCacheValid(diskEntry, config.mcpServers.demo)).toBe(false);
    expect(mocks.initializeMcp).not.toHaveBeenCalled();
    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "demo_lookup" }));
    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];

    const first = await proxyTool.execute("call-1", { connect: "demo" });
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    expect(first.addedToolNames).toEqual(["demo_lookup", "demo_read_guide"]);
    expect(activeTools()).toEqual(["bash", "fallback_read_manual", "demo_lookup", "demo_read_guide"]);
    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "demo_unselected" }));
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "demo_read_guide",
      description: "Live guide",
    }));
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "fallback_read_manual",
      description: "Cached manual",
    }));

    expect(actualCache.isServerCacheValid(diskEntry, config.mcpServers.demo)).toBe(false);
  });

  it("reports direct tools discovered by proxy connect as addedToolNames without rewriting active tools", async () => {
    const config = {
      settings: { freezeDirectTools: false },
      mcpServers: {
        demo: { url: "https://demo.example.com/mcp", directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValue([
        { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" },
        { serverName: "demo", originalName: "read", prefixedName: "demo_read", description: "Read demo" },
      ]);
    mocks.initializeMcp.mockResolvedValue(state);
    const connectResult = { content: [{ type: "text", text: "connected" }], details: { mode: "connect" } };
    mocks.executeConnect.mockImplementation(async (currentState: any) => {
      // A live connect refreshes metadata, which syncs the tool surface before executeConnect returns.
      currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
      return connectResult;
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();
    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    const activeBeforeConnect = activeTools();

    const result = await proxyTool.execute("call-1", { connect: "demo" }, undefined, undefined, { cwd: "/tmp/project" });

    expect(result).toMatchObject({ content: connectResult.content, details: connectResult.details });
    expect(result.addedToolNames).toEqual(["demo_search", "demo_read"]);
    expect(activeTools()).toEqual([...activeBeforeConnect, "demo_search", "demo_read"]);
    expect(api.setActiveTools).not.toHaveBeenCalled();
  });

  it("does not re-activate the mcp gateway tool after the host removed it from the active set", async () => {
    const config = {
      settings: { freezeDirectTools: false },
      mcpServers: {
        demo: { command: "demo", directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValue([
        { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" },
      ]);
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeConnect.mockImplementation(async (currentState: any) => {
      currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
      return { content: [{ type: "text", text: "connected" }] };
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();
    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];

    // The host (e.g. a code-mode extension that routes MCP through its own tool) hides the gateway.
    api.setActiveTools(["bash"]);
    api.setActiveTools.mockClear();

    await proxyTool.execute("call-1", { connect: "demo" });

    expect(activeTools()).toEqual(["bash", "demo_search"]);
    expect(api.setActiveTools).not.toHaveBeenCalled();
  });

  it.each([false, true])("restores only an owned gateway fallback, relinquishing ownership on observed reactivation (observed: %s)", async (observedReactivation) => {
    const config = {
      settings: { disableProxyTool: true, freezeDirectTools: false },
      mcpServers: {
        demo: { command: "demo", directTools: true },
      },
    };
    const search = { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" };
    let specs: Array<typeof search> = [];
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools.mockImplementation(() => specs);
    mocks.reconnectServers.mockImplementation(async (currentState: any) => {
      currentState.onToolMetadataUpdated?.("demo", "command-reconnect");
    });
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi({ unregisterTool: false });
    const tracked = trackRuntimeToolActivation(api, ["bash"]);
    const activeTools = () => tracked().filter((name) => name !== "mcpScript");
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();
    expect(activeTools()).toEqual(["bash", "mcp"]);
    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];

    // Direct tools cover the server: the adapter soft-deactivates the gateway.
    specs = [search];
    await commandDef.handler("reconnect demo", { hasUI: false });
    expect(activeTools()).toEqual(["bash", "demo_search"]);

    specs = [];
    if (observedReactivation) {
      // The host activates mcp; a sync needing the gateway observes this and
      // relinquishes the adapter's fallback ownership before host removal.
      api.setActiveTools(["bash", "mcp", "demo_search"]);
      await commandDef.handler("reconnect demo", { hasUI: false });
      expect(activeTools()).toEqual(["bash", "mcp"]);
      api.setActiveTools(["bash"]);
    }

    // Without reactivation, restore our fallback when direct tools disappear.
    // After observed reactivation, respect the host's subsequent removal.
    await commandDef.handler("reconnect demo", { hasUI: false });
    expect(activeTools()).toEqual(observedReactivation ? ["bash"] : ["bash", "mcp"]);
  });

  it("does not claim gateway fallback ownership when the host active set is empty", async () => {
    const config = {
      settings: { disableProxyTool: false, freezeDirectTools: false },
      mcpServers: { demo: { command: "demo", directTools: true } },
    };
    const search = { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" };
    let specs: Array<typeof search> = [];
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools.mockImplementation(() => specs);
    mocks.reconnectServers.mockImplementation(async (currentState: any) => {
      currentState.onToolMetadataUpdated?.("demo", "command-reconnect");
    });
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi({ unregisterTool: false });
    const activeTools = trackRuntimeToolActivation(api, ["bash"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();
    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];

    // Register the direct tool while the gateway remains enabled, then let
    // the host empty its active set before fallback suppression is requested.
    specs = [search];
    await commandDef.handler("reconnect demo", { hasUI: false });
    expect(activeTools()).toContain("mcp");
    expect(activeTools()).toContain("demo_search");
    api.setActiveTools([]);
    config.settings.disableProxyTool = true;
    api.setActiveTools.mockClear();
    await commandDef.handler("reconnect demo", { hasUI: false });
    expect(activeTools()).toEqual([]);
    expect(api.setActiveTools).not.toHaveBeenCalled();

    specs = [];
    await commandDef.handler("reconnect demo", { hasUI: false });
    expect(activeTools()).toEqual([]);
    expect(api.setActiveTools).not.toHaveBeenCalled();
  });

  it("unregisters and re-registers the gateway when unregisterTool is available", async () => {
    const config = {
      settings: { disableProxyTool: true, freezeDirectTools: false },
      mcpServers: { demo: { command: "demo", directTools: true } },
    };
    const search = { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" };
    let specs: Array<typeof search> = [];
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools.mockImplementation(() => specs);
    mocks.reconnectServers.mockImplementation(async (currentState: any) => {
      currentState.onToolMetadataUpdated?.("demo", "command-reconnect");
    });
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const tracked = trackRuntimeToolActivation(api, ["bash"]);
    const activeTools = () => tracked().filter((name) => name !== "mcpScript");
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();
    expect(activeTools()).toEqual(["bash", "mcp"]);
    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];

    specs = [search];
    await commandDef.handler("reconnect demo", { hasUI: false });
    expect(api.unregisterTool).toHaveBeenCalledWith("mcp");
    expect(activeTools()).toEqual(["bash", "demo_search"]);

    specs = [];
    await commandDef.handler("reconnect demo", { hasUI: false });
    expect(activeTools()).toEqual(["bash", "mcp"]);
  });


  async function setupRealConnectCatalog() {
    const definition = { command: "demo", directTools: true, lifecycle: "eager" };
    const config = { settings: { freezeDirectTools: false }, mcpServers: { demo: definition } };
    const cache: any = { version: 1, servers: {
      demo: { configHash: computeServerHash(definition, process.cwd()), cachedAt: Date.now(), tools: [], resources: [] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    return { config, cache, state, api, handlers, activeTools, proxy: registeredTool(api, "mcp") };
  }

  it("does not attribute a background eager addition or revive a user-deactivated tool to a later connect", async () => {
    const definition = { command: "demo", directTools: true, lifecycle: "eager" };
    const config = { settings: { freezeDirectTools: false }, mcpServers: { demo: definition } };
    const cache: any = { version: 1, servers: {
      demo: { configHash: computeServerHash(definition, process.cwd()), cachedAt: Date.now(), tools: [], resources: [] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);
    const connectResult = { content: [{ type: "text", text: "connected" }], details: { mode: "connect" } };
    mocks.executeConnect.mockResolvedValue(connectResult);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    const backgroundTool = { name: "background", inputSchema: { type: "object", properties: {} } };
    cache.servers.demo.tools = [backgroundTool];
    await state.onToolMetadataUpdated!("demo", "list-changed");
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_background" }));
    api.setActiveTools(activeTools().filter(name => name !== "demo_background"));

    const proxyTool = registeredTool(api, "mcp");
    const result = await proxyTool.execute("call-1", { connect: "demo" });

    expect(result).toBe(connectResult);
    expect(result).not.toHaveProperty("addedToolNames");
    expect(activeTools()).not.toContain("demo_background");
  });

  it("does not report a background eager addition removed before connect", async () => {
    const definition = { command: "demo", directTools: true, lifecycle: "eager" };
    const config = { settings: { freezeDirectTools: false }, mcpServers: { demo: definition } };
    const cache: any = { version: 1, servers: {
      demo: { configHash: computeServerHash(definition, process.cwd()), cachedAt: Date.now(), tools: [], resources: [] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);
    const connectResult = { content: [{ type: "text", text: "connected" }], details: { mode: "connect" } };
    mocks.executeConnect.mockResolvedValue(connectResult);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    cache.servers.demo.tools = [{ name: "removed", inputSchema: { type: "object", properties: {} } }];
    await state.onToolMetadataUpdated!("demo", "list-changed");
    expect(activeTools()).toContain("demo_removed");
    cache.servers.demo.tools = [];
    await state.onToolMetadataUpdated!("demo", "list-changed");

    const result = await registeredTool(api, "mcp").execute("call-1", { connect: "demo" });

    expect(result).toBe(connectResult);
    expect(result).not.toHaveProperty("addedToolNames");
    expect(activeTools()).not.toContain("demo_removed");
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0].name === "demo_removed")).toHaveLength(1);
  });

  it("allows one scoped cold search discovery without thawing applied servers", async () => {
    const a: any = { command: "a", directTools: "search", lifecycle: "eager", toolPrefix: "none" };
    const c: any = { command: "c", directTools: "search", lifecycle: "eager", toolPrefix: "none" };
    const b: any = { command: "b", directTools: true, lifecycle: "eager", toolPrefix: "none" };
    const config: any = { mcpServers: { a, c, b } };
    const schema = (property: string) => ({ type: "object", properties: { [property]: { type: "string" } } });
    const cache: any = { version: 1, servers: {
      c: { configHash: computeServerHash(c, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "c_keep", description: "C v1", inputSchema: schema("c1") }] },
      b: { configHash: computeServerHash(b, process.cwd()), cachedAt: Date.now(), resources: [], tools: [
        { name: "b_old", description: "B v1", inputSchema: schema("b1") },
        { name: "b_gone", description: "B gone", inputSchema: schema("gone") },
      ] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));

    const initialB = registeredTool(api, "b_old");
    const initialBGone = registeredTool(api, "b_gone");
    const initialC = registeredTool(api, "c_keep");
    const registrationCount = (name: string) => api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === name).length;
    const lastRegistered = (name: string) => api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === name).at(-1)?.[0];
    const initialBLast = lastRegistered("b_old");
    const initialBGoneLast = lastRegistered("b_gone");
    const initialCLast = lastRegistered("c_keep");
    const initialBExecute = initialB.execute;
    const initialBLastExecute = initialBLast.execute;
    const initialBGoneExecute = initialBGone.execute;
    const initialBGoneLastExecute = initialBGoneLast.execute;
    const initialCExecute = initialC.execute;
    const initialCLastExecute = initialCLast.execute;
    const initialBCount = registrationCount("b_old");
    const initialBGoneCount = registrationCount("b_gone");
    const initialCCount = registrationCount("c_keep");
    expect(initialB).toMatchObject({ description: "B v1", parameters: { properties: { b1: expect.anything() } } });
    expect(initialBLast).toMatchObject({ description: "B v1", parameters: { properties: { b1: expect.anything() } } });
    expect(initialBGone).toMatchObject({ description: "B gone", parameters: { properties: { gone: expect.anything() } } });
    expect(initialBGoneLast).toMatchObject({ description: "B gone", parameters: { properties: { gone: expect.anything() } } });
    expect(initialC).toMatchObject({ description: "C v1", parameters: { properties: { c1: expect.anything() } } });
    expect(initialCLast).toMatchObject({ description: "C v1", parameters: { properties: { c1: expect.anything() } } });
    expect(activeTools()).toEqual(expect.arrayContaining(["b_old", "b_gone"]));
    api.setActiveTools(activeTools().filter(name => name !== "b_old"));

    // Give the already-applied peers live v2 catalogs before A's first
    // discovery. Their declarations and executors must remain pinned.
    cache.servers.c.tools = [{ name: "c_keep", description: "C v2", inputSchema: schema("c2") }];
    cache.servers.b.tools = [
      { name: "b_old", description: "B v2", inputSchema: schema("b2") },
      { name: "b_gone", description: "B gone v2", inputSchema: schema("gone2") },
    ];
    await state.onToolMetadataUpdated!("c", "list-changed");
    await state.onToolMetadataUpdated!("b", "list-changed");
    expect(registrationCount("b_old")).toBe(initialBCount);
    expect(registrationCount("b_gone")).toBe(initialBGoneCount);
    expect(registrationCount("c_keep")).toBe(initialCCount);
    expect(lastRegistered("b_old")).toBe(initialBLast);
    expect(lastRegistered("b_gone")).toBe(initialBGoneLast);
    expect(lastRegistered("c_keep")).toBe(initialCLast);

    // A has no startup catalog. Its first live discovery is scoped to A and
    // must not re-resolve the already-applied search C or eager B surfaces.
    cache.servers.a = {
      configHash: computeServerHash(a, process.cwd()),
      cachedAt: Date.now(),
      resources: [],
      tools: [
        { name: "a_new", description: "A v1", inputSchema: schema("a1") },
        { name: "b_gone", description: "A collision", inputSchema: schema("collision") },
      ],
    };
    await state.onToolMetadataUpdated!("a", "proxy-connect");

    const discoveredA = registeredTool(api, "a_new");
    expect(discoveredA).toMatchObject({ description: "A v1", parameters: { properties: { a1: expect.anything() } } });
    expect(activeTools()).not.toContain("a_new");
    expect(registeredTool(api, "b_old")).toBe(initialB);
    expect(lastRegistered("b_old")).toBe(initialBLast);
    expect(registeredTool(api, "b_old").execute).toBe(initialBExecute);
    expect(lastRegistered("b_old").execute).toBe(initialBLastExecute);
    expect(registeredTool(api, "b_gone")).toBe(initialBGone);
    expect(lastRegistered("b_gone")).toBe(initialBGoneLast);
    expect(registeredTool(api, "b_gone").execute).toBe(initialBGoneExecute);
    expect(lastRegistered("b_gone").execute).toBe(initialBGoneLastExecute);
    expect(registeredTool(api, "c_keep")).toBe(initialC);
    expect(lastRegistered("c_keep")).toBe(initialCLast);
    expect(registeredTool(api, "c_keep").execute).toBe(initialCExecute);
    expect(lastRegistered("c_keep").execute).toBe(initialCLastExecute);
    expect(registrationCount("b_old")).toBe(initialBCount);
    expect(registrationCount("b_gone")).toBe(initialBGoneCount);
    expect(registrationCount("c_keep")).toBe(initialCCount);
    expect(activeTools()).not.toContain("a_new");
    expect(activeTools()).not.toContain("b_old");
    expect(activeTools()).toContain("b_gone");

    // A's later empty catalog and reconnect do not renew the one-time grant;
    // B's passive update is frozen independently of A's discovery.
    cache.servers.a.tools = [];
    await state.onToolMetadataUpdated!("a", "command-reconnect");
    expect(registrationCount("a_new")).toBe(1);
    cache.servers.b.tools = [
      { name: "b_old", description: "B v3", inputSchema: schema("b3") },
      { name: "b_gone", description: "B gone v3", inputSchema: schema("gone3") },
      { name: "b_new", description: "B new", inputSchema: schema("new") },
    ];
    await state.onToolMetadataUpdated!("b", "list-changed");
    expect(registeredTool(api, "b_old")).toBe(initialB);
    expect(lastRegistered("b_old")).toBe(initialBLast);
    expect(registeredTool(api, "b_old").execute).toBe(initialBExecute);
    expect(lastRegistered("b_old").execute).toBe(initialBLastExecute);
    expect(registrationCount("b_old")).toBe(initialBCount);
    expect(registeredTool(api, "b_gone")).toBe(initialBGone);
    expect(lastRegistered("b_gone")).toBe(initialBGoneLast);
    expect(registeredTool(api, "b_gone").execute).toBe(initialBGoneExecute);
    expect(lastRegistered("b_gone").execute).toBe(initialBGoneLastExecute);
    expect(registrationCount("b_gone")).toBe(initialBGoneCount);
    expect(registrationCount("b_new")).toBe(0);
    expect(registeredTool(api, "c_keep")).toBe(initialC);
    expect(lastRegistered("c_keep")).toBe(initialCLast);
    expect(registeredTool(api, "c_keep").execute).toBe(initialCExecute);
    expect(lastRegistered("c_keep").execute).toBe(initialCLastExecute);
  });

  it("keeps a runtime-initial valid-empty search catalog frozen", async () => {
    const definition: any = { command: "runtime-empty", directTools: "search", lifecycle: "eager", toolPrefix: "none" };
    const config: any = { mcpServers: { "runtime-empty": definition } };
    const cache: any = { version: 1, servers: {} };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockImplementation(async () => {
      cache.servers["runtime-empty"] = {
        configHash: computeServerHash(definition, process.cwd()),
        cachedAt: Date.now(),
        resources: [],
        tools: [],
      };
      return state;
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));

    cache.servers["runtime-empty"].tools = [{ name: "later" }];
    await state.onToolMetadataUpdated!("runtime-empty", "list-changed");
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "later")).toHaveLength(0);
  });

  it("treats a valid cached-empty search catalog as already applied", async () => {
    const definition: any = { command: "empty", directTools: "search", lifecycle: "eager", toolPrefix: "none" };
    const config: any = { mcpServers: { empty: definition } };
    const cache: any = { version: 1, servers: {
      empty: { configHash: computeServerHash(definition, process.cwd()), cachedAt: Date.now(), resources: [], tools: [] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));

    cache.servers.empty.tools = [{ name: "later" }];
    await state.onToolMetadataUpdated!("empty", "connect");
    await state.onToolMetadataUpdated!("empty", "command-reconnect");
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "later")).toHaveLength(0);
  });

  it("allows one first discovery for a never-applied search server", async () => {
    const definition: any = { command: "empty", directTools: "search", lifecycle: "eager", toolPrefix: "none" };
    const config: any = { mcpServers: { empty: definition } };
    const cache: any = { version: 1, servers: {} };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));

    cache.servers.empty = {
      configHash: computeServerHash(definition, process.cwd()),
      cachedAt: Date.now(),
      resources: [],
      tools: [{ name: "later", description: "later tool" }],
    };
    await state.onToolMetadataUpdated!("empty", "connect");
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "later")).toHaveLength(1);
  });

  it("consumes a cold discovery grant even when its first catalog is empty", async () => {
    const definition: any = { command: "empty", directTools: "search", lifecycle: "eager", toolPrefix: "none" };
    const config: any = { mcpServers: { empty: definition } };
    const cache: any = { version: 1, servers: {} };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));

    cache.servers.empty = {
      configHash: computeServerHash(definition, process.cwd()),
      cachedAt: Date.now(),
      resources: [],
      tools: [],
    };
    await state.onToolMetadataUpdated!("empty", "proxy-connect");
    cache.servers.empty.tools = [{ name: "later", description: "later tool" }];
    await state.onToolMetadataUpdated!("empty", "command-reconnect");
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "later")).toHaveLength(0);
  });

  it("does not grant cold search discovery to a direct-tools server", async () => {
    const definition: any = { command: "direct", directTools: true, lifecycle: "eager", toolPrefix: "none" };
    const config: any = { mcpServers: { direct: definition } };
    const cache: any = { version: 1, servers: {} };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));

    cache.servers.direct = {
      configHash: computeServerHash(definition, process.cwd()),
      cachedAt: Date.now(),
      resources: [],
      tools: [{ name: "later", description: "later tool" }],
    };
    await state.onToolMetadataUpdated!("direct", "connect");
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "later")).toHaveLength(0);
  });

  it("does not use the search exception when an environment selection overrides config", async () => {
    process.env.MCP_DIRECT_TOOLS = "env/later";
    const definition: any = { command: "env", directTools: "search", lifecycle: "eager", toolPrefix: "none" };
    const config: any = { mcpServers: { env: definition } };
    // Start genuinely cold; the valid catalog is acquired only after the
    // session/runtime are ready, so the env override cannot be masked by a
    // startup-applied empty catalog.
    const cache: any = { version: 1, servers: {} };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));

    cache.servers.env = {
      configHash: computeServerHash(definition, process.cwd()),
      cachedAt: Date.now(),
      resources: [],
      tools: [{ name: "later", description: "later tool" }],
    };
    await state.onToolMetadataUpdated!("env", "list-changed");
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "later")).toHaveLength(0);
  });

  it("excludes a cold project search server through production provenance and trust filtering", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-cold-project-search-"));
    const home = join(root, "home");
    const cwd = join(root, "project");
    const agentDir = join(home, ".pi", "agent");
    const definition: any = { command: "project-search", directTools: "search", lifecycle: "eager", toolPrefix: "short" };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, ".mcp.json"), `${JSON.stringify({ mcpServers: { project: definition } })}\n`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_PACKAGE_DIR", "");
    vi.stubEnv("PI_MCP_CONFIG_MODE", "merge");
    vi.stubEnv("MCP_DIRECT_TOOLS", undefined);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);

    try {
      const actualConfig = await vi.importActual<typeof import("../config.ts")>("../config.ts");
      const actualTrust = await vi.importActual<typeof import("../project-server-trust.ts")>("../project-server-trust.ts");
      const loaded = actualConfig.loadMcpConfigWithSources(undefined, cwd);
      expect(loaded.projectServers.get("project")?.path).toBe(join(cwd, ".mcp.json"));
      expect(loaded.config.mcpServers.project).toEqual(definition);
      expect(actualTrust.excludeProjectServersAtLoadTime(loaded).mcpServers.project).toBeUndefined();

      const cache: any = { version: 1, servers: {} };
      const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
      const state = createState();
      mocks.loadMcpConfig.mockImplementation((path?: string, selectedCwd?: string) => (
        actualConfig.loadMcpConfig(path, selectedCwd ?? cwd)
      ));
      mocks.loadMetadataCache.mockReturnValue(cache);
      mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
      mocks.initializeMcp.mockImplementation(async (_pi: unknown, context: any, _owner: unknown, options: any) => {
        expect(options.config).toBeUndefined();
        const rawConfig = actualConfig.loadMcpConfig(options.configPath, context.cwd);
        const trustResult = await actualTrust.applyProjectServerTrustToConfig(rawConfig, context);
        expect(actualTrust.hasProjectServerDefinitions(rawConfig)).toBe(true);
        expect(trustResult.blockedServers.get("project")?.reason).toBe("untrusted");
        state.config = trustResult.config;
        return state;
      });

      const { default: mcpAdapter } = await import("../index.ts");
      const { api, handlers } = createPi();
      mcpAdapter(api);
      const context = {
        hasUI: false,
        mode: "rpc",
        cwd,
        isProjectTrusted: () => false,
        ui: { select: vi.fn() },
      };
      await handlers.get("session_start")?.({}, context);
      await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));

      cache.servers.project = {
        configHash: computeServerHash(definition, cwd),
        cachedAt: Date.now(),
        resources: [],
        tools: [{ name: "lookup", description: "project lookup", inputSchema: { type: "object", properties: {} } }],
      };
      await state.onToolMetadataUpdated!("project", "connect");
      expect(registeredTool(api, "project_lookup")).toBeUndefined();
    } finally {
      cwdSpy.mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps ambient cold search servers outside a programmatic configuration snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-cold-programmatic-search-"));
    const home = join(root, "home");
    const cwd = join(root, "project");
    const agentDir = join(home, ".pi", "agent");
    const ambientDefinition: any = { command: "ambient-search", directTools: "search", lifecycle: "lazy", toolPrefix: "short" };
    const explicitDefinition: any = { command: "explicit-search", directTools: "search", lifecycle: "lazy", toolPrefix: "short" };
    const explicitConfig: any = { mcpServers: { owned: explicitDefinition } };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, ".mcp.json"), `${JSON.stringify({ mcpServers: { ambient: ambientDefinition } })}\n`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_PACKAGE_DIR", "");
    vi.stubEnv("PI_MCP_CONFIG_MODE", "merge");
    vi.stubEnv("MCP_DIRECT_TOOLS", undefined);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);

    try {
      const actualConfig = await vi.importActual<typeof import("../config.ts")>("../config.ts");
      const ambientLoaded = actualConfig.loadMcpConfigWithSources(undefined, cwd);
      expect(ambientLoaded.config.mcpServers.ambient).toEqual(ambientDefinition);
      expect(ambientLoaded.projectServers.get("ambient")?.path).toBe(join(cwd, ".mcp.json"));
      const cache: any = { version: 1, servers: {} };
      const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
      const state = createState();
      mocks.loadMcpConfig.mockImplementation((path?: string, selectedCwd?: string) => (
        actualConfig.loadMcpConfig(path, selectedCwd ?? cwd)
      ));
      mocks.loadMetadataCache.mockReturnValue(cache);
      mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
      mocks.cloneMcpConfig.mockImplementation((config: unknown) => actualConfig.cloneMcpConfig(config as any));
      mocks.initializeMcp.mockImplementation(async (_pi: unknown, _context: unknown, _owner: unknown, options: any) => {
        expect(options.config).toEqual(explicitConfig);
        state.config = structuredClone(options.config);
        return state;
      });

      const { createMcpAdapter } = await import("../index.ts");
      const { api, handlers } = createPi();
      createMcpAdapter({ config: explicitConfig })(api);
      await handlers.get("session_start")?.({}, { hasUI: false, mode: "rpc", cwd });
      await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
      expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
      expect(mocks.initializeMcp.mock.calls.at(-1)?.[3]?.config?.mcpServers).toEqual({ owned: explicitDefinition });

      cache.servers.owned = {
        configHash: computeServerHash(explicitDefinition, cwd),
        cachedAt: Date.now(),
        resources: [],
        tools: [{ name: "lookup", description: "explicit lookup", inputSchema: { type: "object", properties: {} } }],
      };
      await state.onToolMetadataUpdated!("owned", "connect");
      expect(registeredTool(api, "owned_lookup")).toBeDefined();

      cache.servers.ambient = {
        configHash: computeServerHash(ambientDefinition, cwd),
        cachedAt: Date.now(),
        resources: [],
        tools: [{ name: "lookup", description: "ambient lookup", inputSchema: { type: "object", properties: {} } }],
      };
      await state.onToolMetadataUpdated!("ambient", "connect");
      expect(registeredTool(api, "ambient_lookup")).toBeUndefined();
    } finally {
      cwdSpy.mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not consume a cold grant when first metadata acquisition is missing", async () => {
    const definition: any = { command: "missing", directTools: "search", lifecycle: "eager", toolPrefix: "none" };
    const config: any = { mcpServers: { missing: definition } };
    const cache: any = { version: 1, servers: {} };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));

    await state.onToolMetadataUpdated!("missing", "connect");
    cache.servers.missing = {
      configHash: computeServerHash(definition, process.cwd()),
      cachedAt: Date.now(),
      resources: [],
      tools: [{ name: "later", description: "later tool" }],
    };
    await state.onToolMetadataUpdated!("missing", "command-reconnect");
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "later")).toHaveLength(1);
  });

  it("reserves a cold discovery against a reentrant metadata callback", async () => {
    const definition: any = { command: "overlap", directTools: "search", lifecycle: "eager", toolPrefix: "none" };
    const config: any = { mcpServers: { overlap: definition } };
    const cache: any = { version: 1, servers: {} };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    cache.servers.overlap = {
      configHash: computeServerHash(definition, process.cwd()),
      cachedAt: Date.now(),
      resources: [],
      tools: [{ name: "later", description: "later tool" }],
    };
    let nested: Promise<void> | undefined;
    api.registerTool.mockImplementation((tool: any) => {
      if (tool.name === "later" && !nested) nested = state.onToolMetadataUpdated!("overlap", "list-changed");
    });

    await state.onToolMetadataUpdated!("overlap", "proxy-connect");
    await nested;
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "later")).toHaveLength(1);
  });

  it("releases an old cold-discovery owner before its successor can discover", async () => {
    const definition: any = { command: "replace", directTools: "search", lifecycle: "eager", toolPrefix: "none" };
    const oldConfig: any = { mcpServers: { replace: definition } };
    const successorConfig: any = { mcpServers: { replace: { ...definition } } };
    const cache: any = { version: 1, servers: {} };
    let activeConfig = oldConfig;
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const oldState = createState();
    oldState.config = oldConfig;
    const successorState = createState();
    successorState.config = successorConfig;
    mocks.loadMcpConfig.mockImplementation(() => activeConfig);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValueOnce(oldState).mockResolvedValue(successorState);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(oldState.onToolMetadataUpdated).toBeTypeOf("function"));
    cache.servers.replace = {
      configHash: computeServerHash(definition, process.cwd()),
      cachedAt: Date.now(),
      resources: [],
      tools: [{ name: "old", description: "old" }],
    };
    let replacement: Promise<unknown> | undefined;
    let replaced = false;
    api.registerTool.mockImplementation((tool: any) => {
      if (tool.name !== "old" || replaced) return;
      replaced = true;
      delete cache.servers.replace;
      activeConfig = successorConfig;
      replacement = handlers.get("session_start")?.({ replacement: true }, {});
    });

    await oldState.onToolMetadataUpdated!("replace", "proxy-connect").catch(() => undefined);
    await replacement;
    await vi.waitFor(() => expect(successorState.onToolMetadataUpdated).toBeTypeOf("function"));
    cache.servers.replace = {
      configHash: computeServerHash(successorConfig.mcpServers.replace, process.cwd()),
      cachedAt: Date.now(),
      resources: [],
      tools: [{ name: "successor", description: "successor" }],
    };
    await successorState.onToolMetadataUpdated!("replace", "proxy-connect");
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "successor")).toHaveLength(1);
  });

  it("clears a cold-discovery reservation when shutdown interrupts its owner", async () => {
    const definition: any = { command: "shutdown", directTools: "search", lifecycle: "eager", toolPrefix: "none" };
    const config: any = { mcpServers: { shutdown: definition } };
    const cache: any = { version: 1, servers: {} };
    const state = createState();
    const successorState = createState();
    state.config = config;
    successorState.config = config;
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValueOnce(state).mockResolvedValue(successorState);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    cache.servers.shutdown = {
      configHash: computeServerHash(definition, process.cwd()),
      cachedAt: Date.now(),
      resources: [],
      tools: [{ name: "old", description: "old" }],
    };
    let shutdown: Promise<unknown> | undefined;
    api.registerTool.mockImplementation((tool: any) => {
      if (tool.name === "old" && !shutdown) shutdown = handlers.get("session_shutdown")?.();
    });

    await state.onToolMetadataUpdated!("shutdown", "proxy-connect").catch(() => undefined);
    await shutdown;
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "old")).toHaveLength(1);

    delete cache.servers.shutdown;
    await handlers.get("session_start")?.({ successor: true }, {});
    await vi.waitFor(() => expect(successorState.onToolMetadataUpdated).toBeTypeOf("function"));
    cache.servers.shutdown = {
      configHash: computeServerHash(definition, process.cwd()),
      cachedAt: Date.now(),
      resources: [],
      tools: [{ name: "later", description: "later" }],
    };
    await successorState.onToolMetadataUpdated!("shutdown", "proxy-connect");
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "later")).toHaveLength(1);
  });

  it.each([
    ["default freeze", undefined],
    ["explicit freeze", true],
  ] as const)("keeps an applied catalog frozen across keep-alive input (%s)", async (_label, freezeDirectTools) => {
    const definition: any = { command: "input", directTools: true, lifecycle: "keep-alive", toolPrefix: "none" };
    const config: any = {
      ...(freezeDirectTools === undefined ? {} : { settings: { freezeDirectTools } }),
      mcpServers: { input: definition },
    };
    const cache: any = { version: 1, servers: {
      input: {
        configHash: computeServerHash(definition, process.cwd()),
        cachedAt: Date.now(),
        resources: [],
        tools: [{ name: "get_x", description: "v1" }],
      },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    const before = api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "get_x").length;

    cache.servers.input.tools = [
      { name: "get_x", description: "v2" },
      { name: "new_y", description: "new" },
    ];
    await handlers.get("input")?.({ type: "input", text: "hello" }, { cwd: process.cwd() });

    expect(state.lifecycle.ensureConverged).toHaveBeenCalled();
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "get_x")).toHaveLength(before);
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "new_y")).toHaveLength(0);
  });

  it("keeps unfrozen keep-alive input reconciliation global", async () => {
    const definition: any = { command: "input", directTools: true, lifecycle: "keep-alive", toolPrefix: "none" };
    const config: any = { settings: { freezeDirectTools: false }, mcpServers: { input: definition } };
    const cache: any = { version: 1, servers: {
      input: {
        configHash: computeServerHash(definition, process.cwd()),
        cachedAt: Date.now(),
        resources: [],
        tools: [{ name: "get_x", description: "v1" }],
      },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    const before = api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "get_x").length;

    cache.servers.input.tools = [
      { name: "get_x", description: "v2" },
      { name: "new_y", description: "new" },
    ];
    await handlers.get("input")?.({ type: "input", text: "hello" }, { cwd: process.cwd() });

    expect(state.lifecycle.ensureConverged).toHaveBeenCalled();
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "get_x").length).toBeGreaterThan(before);
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "new_y")).toHaveLength(1);
  });

  it("scopes an A-only persisted panel refresh and preserves B's applied declaration, executor, and active choice", async () => {
    const a = { command: "a", directTools: true, lifecycle: "eager" };
    const b = { command: "b", directTools: true, lifecycle: "eager" };
    const config: any = { mcpServers: { a, b } }; // freezeDirectTools defaults on
    const schema = (property: string) => ({ type: "object", properties: { [property]: { type: "string" } } });
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: Date.now(), resources: [],
        tools: [{ name: "one", inputSchema: schema("x") }, { name: "two", inputSchema: schema("y") }] },
      b: { configHash: computeServerHash(b, process.cwd()), cachedAt: Date.now(), resources: [],
        tools: [{ name: "old", description: "old desc", inputSchema: schema("v1") }, { name: "gone", inputSchema: schema("g") }] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));

    const lastDefinition = (name: string) => [...api.registerTool.mock.calls]
      .reverse().find((call: any[]) => call[0]?.name === name)?.[0];
    const registrationCount = (name: string) => api.registerTool.mock.calls
      .filter((call: any[]) => call[0]?.name === name).length;
    const initialB = {
      description: lastDefinition("b_old")?.description,
      schema: Object.keys(lastDefinition("b_old")?.parameters?.properties ?? {}),
      registrations: registrationCount("b_old"),
    };
    expect(initialB).toMatchObject({ description: "old desc", schema: ["v1"] });
    expect(initialB.registrations).toBeGreaterThan(0);
    expect(activeTools()).toEqual(expect.arrayContaining(["a_one", "a_two", "b_old", "b_gone"]));

    // B changes passively while frozen. A's persisted Save must not consume
    // this newer shared-cache object for B.
    cache.servers.b.tools = [
      { name: "old", description: "new desc", inputSchema: schema("v2") },
      { name: "new", inputSchema: schema("n") },
    ];
    await state.onToolMetadataUpdated!("b", "list-changed");
    expect(lastDefinition("b_old")?.description).toBe(initialB.description);
    expect(registrationCount("b_new")).toBe(0);

    // A user deactivation is another part of B's applied surface and must
    // survive the scoped A refresh.
    api.setActiveTools(activeTools().filter(name => name !== "b_old"));
    let panelCallback: ((changes: Map<string, true | string[] | false>) => Promise<void>) | undefined;
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      panelCallback = args[4];
      await panelCallback!(new Map([["a", ["one"]]]));
      return { configChanged: false };
    });
    const notify = vi.fn();
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify, setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });

    expect(panelCallback).toBeTypeOf("function");
    expect(activeTools()).toContain("a_one");
    expect(activeTools()).not.toContain("a_two");
    expect(activeTools()).not.toContain("b_old");
    expect(activeTools()).toContain("b_gone");
    expect(lastDefinition("b_old")?.description).toBe(initialB.description);
    expect(Object.keys(lastDefinition("b_old")?.parameters?.properties ?? {})).toEqual(initialB.schema);
    expect(registrationCount("b_old")).toBe(initialB.registrations);
    expect(registrationCount("b_new")).toBe(0);
  });

  it("executes retained B and refreshed A registrations with their owning metadata", async () => {
    // The real UI-session path is exercised below, but its lower transport is
    // a local mock so this proof cannot open a browser or bind a listener.
    process.env.MCP_UI_VIEWER = "none";
    const a = { command: "a", directTools: true, lifecycle: "eager" };
    const b = { command: "b", directTools: true, lifecycle: "eager" };
    const config: any = { settings: { freezeDirectTools: true }, mcpServers: { a, b } };
    const schema = (property: string) => ({ type: "object", properties: { [property]: { type: "string" } } });
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: Date.now(), resources: [{ name: "old", uri: "docs://a/old" }], tools: [{ name: "old", description: "A old", inputSchema: schema("a1"), uiResourceUri: "ui://a/old", uiStreamMode: "eager" }] },
      b: { configHash: computeServerHash(b, process.cwd()), cachedAt: Date.now(), resources: [{ name: "keep", uri: "docs://b/keep" }], tools: [{ name: "keep", description: "B kept", inputSchema: schema("b1"), uiResourceUri: "ui://b/keep", uiStreamMode: "stream-first" }] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const actualDirectExecutor = await vi.importActual<typeof import("../direct-tools.ts")>("../direct-tools.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    const executorSpecs: any[] = [];
    const executorModes = new Map<string, boolean | undefined>();
    const connections = new Map<string, any>();
    const makeConnection = (serverName: string) => {
      const connection = { status: "connected", client: { callTool: vi.fn(), readResource: vi.fn() } };
      connections.set(serverName, connection);
      return connection;
    };
    const aConnection = makeConnection("a");
    const bConnection = makeConnection("b");
    const uiResources: Record<string, any> = {
      "ui://b/keep": {
        uri: "ui://b/keep",
        html: "<main>B kept</main>",
        mimeType: "text/html",
        meta: { domain: "b.example", permissions: { clipboardWrite: {} } },
      },
      "ui://a/new": {
        uri: "ui://a/new",
        html: "<main>A new</main>",
        mimeType: "text/html",
        meta: { domain: "a.example", prefersBorder: true, permissions: { camera: {} } },
      },
      "ui://b/v2": {
        uri: "ui://b/v2",
        html: "<main>B current v2</main>",
        mimeType: "text/html",
        meta: { domain: "b-v2.example", permissions: { microphone: {} } },
      },
    };
    const uiStarts: Array<{ options: any; handle: any }> = [];
    mocks.startUiServer.mockImplementation(async (options: any) => {
      const handle = {
        serverName: options.serverName,
        toolName: options.toolName,
        url: `http://ui.test/${options.serverName}/${options.toolName}`,
        port: 1,
        proxyUrl: "http://ui.test/proxy",
        proxyPort: 2,
        sessionToken: `ui-${options.serverName}-${options.toolName}`,
        close: vi.fn(),
        sendToolInput: vi.fn(),
        sendToolResult: vi.fn(),
        sendResultPatch: vi.fn(),
        sendToolCancelled: vi.fn(),
        sendResourceUpdated: vi.fn(),
        sendHostContext: vi.fn(),
        getSessionMessages: () => ({ prompts: [], intents: [], notifications: [], contexts: [] }),
        getStreamSummary: () => undefined,
      };
      uiStarts.push({ options, handle });
      return handle;
    });
    state.manager.getConnection = vi.fn((serverName: string) => connections.get(serverName));
    state.manager.getRequestOptions = vi.fn(() => undefined);
    state.manager.ensureListen = vi.fn();
    state.manager.touch = vi.fn();
    state.manager.prepareResourceUse = vi.fn();
    state.manager.incrementInFlight = vi.fn();
    state.manager.decrementInFlight = vi.fn();
    state.manager.registerUiStreamListener = vi.fn();
    state.manager.removeUiStreamListener = vi.fn();
    state.manager.registerResourceUpdatedListener = vi.fn();
    state.manager.removeResourceUpdatedListener = vi.fn();
    state.ui = { notify: vi.fn() };
    state.uiResourceHandler = {
      readUiResource: vi.fn(async (_server: string, uri: string) => {
        const resource = uiResources[uri];
        if (!resource) throw new Error(`unexpected UI resource ${uri}`);
        return resource;
      }),
    };
    mocks.createDirectToolExecutor.mockImplementation((getState: unknown, getInitPromise: unknown, spec: any, structured?: boolean) => {
      executorSpecs.push(spec);
      executorModes.set(`${spec.serverName}:${spec.originalName}`, structured);
      return actualDirectExecutor.createDirectToolExecutor(getState as any, getInitPromise as any, spec, structured);
    });
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));

    const lastRegistered = (name: string) => [...api.registerTool.mock.calls]
      .reverse()
      .find((call: any[]) => call[0]?.name === name)?.[0];
    const retainedB = registeredTool(api, "b_keep");
    const retainedBResource = registeredTool(api, "b_read_keep");
    const originalBDefinition = retainedB;
    const originalBResourceDefinition = retainedBResource;
    const initialLastBDefinition = lastRegistered("b_keep");
    const initialLastBResourceDefinition = lastRegistered("b_read_keep");
    expect(initialLastBDefinition).toBeDefined();
    expect(initialLastBResourceDefinition).toBeDefined();
    const originalBExecute = originalBDefinition.execute;
    const originalBResourceExecute = originalBResourceDefinition.execute;
    const initialLastBExecute = initialLastBDefinition.execute;
    const initialLastBResourceExecute = initialLastBResourceDefinition.execute;
    const initialBRegistrations = api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "b_keep").length;
    const initialBResourceRegistrations = api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "b_read_keep").length;
    expect(retainedB).toMatchObject({ description: "B kept", parameters: { type: "object" } });
    expect(retainedBResource).toMatchObject({ name: "b_read_keep", parameters: { type: "object" } });
    bConnection.client.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "B call" }],
      structuredContent: { owner: "b", revision: 1 },
    });
    const retainedBResult = await retainedB.execute("b-call", {}, undefined, undefined, { hasUI: false, cwd: process.cwd() });
    expect(retainedBResult).toMatchObject({
      content: expect.arrayContaining([{ type: "text", text: "B call" }]),
      details: { server: "b", tool: "keep" },
    });
    // Eager tools deliberately retain their existing public result contract;
    // the raw SDK structured payload is asserted independently on the real
    // deferred branch in the companion proof below.
    expect(retainedBResult).not.toHaveProperty("structuredContent");
    expect(bConnection.client.callTool).toHaveBeenCalledWith(
      { name: "keep", arguments: {}, _meta: expect.objectContaining({ "pi-mcp-adapter/toolCallId": "b-call" }) },
      expect.objectContaining({ onprogress: expect.any(Function), resetTimeoutOnProgress: true }),
    );
    expect(aConnection.client.callTool).not.toHaveBeenCalled();
    expect(state.manager.getConnection).toHaveBeenCalledWith("b");
    expect(state.uiResourceHandler.readUiResource).toHaveBeenNthCalledWith(
      1,
      "b",
      "ui://b/keep",
      expect.objectContaining({ config: state.config, signal: expect.any(AbortSignal), onNeedsAuth: expect.any(Function) }),
    );
    expect(mocks.startUiServer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        serverName: "b",
        toolName: "keep",
        toolArgs: {},
        resource: uiResources["ui://b/keep"],
        hostContext: expect.objectContaining({
          [UI_STREAM_HOST_CONTEXT_KEY]: expect.objectContaining({ mode: "stream-first", intermediateResultPatches: true }),
        }),
        onMessage: expect.any(Function),
        onContextUpdate: expect.any(Function),
        onComplete: expect.any(Function),
      }),
    );
    expect(state.manager.registerResourceUpdatedListener).toHaveBeenCalledWith(
      expect.any(String), "b", "ui://b/keep", expect.any(Function),
    );
    const originalBExecutorSpec = executorSpecs.find(spec => spec.serverName === "b" && spec.originalName === "keep");
    expect(originalBExecutorSpec).toMatchObject({
      originalName: "keep", inputSchema: schema("b1"), uiResourceUri: "ui://b/keep", uiStreamMode: "stream-first",
    });
    expect(executorModes.get("b:keep")).toBe(false);

    bConnection.client.readResource.mockResolvedValueOnce({ contents: [{ uri: "docs://b/keep", text: "B resource" }] });
    const retainedBResourceResult = await retainedBResource.execute("b-resource", {}, undefined, undefined, { hasUI: false, cwd: process.cwd() });
    expect(retainedBResourceResult).toMatchObject({
      content: [{ type: "text", text: "B resource" }],
      details: { server: "b", resourceUri: "docs://b/keep" },
    });
    expect(bConnection.client.readResource).toHaveBeenCalledWith({ uri: "docs://b/keep" }, undefined);
    const originalBResourceExecutorSpec = executorSpecs.find(
      spec => spec.serverName === "b" && spec.resourceUri === "docs://b/keep",
    );
    expect(originalBResourceExecutorSpec).toMatchObject({
      originalName: "read_keep", resourceUri: "docs://b/keep",
    });

    // Make B's live catalog newer before the A-only Save. The real metadata
    // hook observes this v2 entry under the frozen surface, while the applied
    // B declaration and executor remain the original v1 objects.
    cache.servers.b.tools = [{
      name: "keep",
      description: "B newer",
      inputSchema: schema("b2"),
      uiResourceUri: "ui://b/v2",
      uiStreamMode: "stream-first",
    }];
    cache.servers.b.resources = [{ name: "keep", uri: "docs://b/v2" }];
    await state.onToolMetadataUpdated!("b", "list-changed");
    expect(cache.servers.b.tools).toEqual([expect.objectContaining({
      name: "keep", description: "B newer", inputSchema: schema("b2"), uiResourceUri: "ui://b/v2",
    })]);
    expect(cache.servers.b.resources).toEqual([{ name: "keep", uri: "docs://b/v2" }]);
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "b_keep")).toHaveLength(initialBRegistrations);
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "b_read_keep")).toHaveLength(initialBResourceRegistrations);
    expect(registeredTool(api, "b_keep")).toBe(originalBDefinition);
    expect(registeredTool(api, "b_keep").execute).toBe(originalBExecute);
    expect(registeredTool(api, "b_read_keep")).toBe(originalBResourceDefinition);
    expect(registeredTool(api, "b_read_keep").execute).toBe(originalBResourceExecute);
    expect(lastRegistered("b_keep")).toBe(initialLastBDefinition);
    expect(lastRegistered("b_keep").execute).toBe(initialLastBExecute);
    expect(lastRegistered("b_read_keep")).toBe(initialLastBResourceDefinition);
    expect(lastRegistered("b_read_keep").execute).toBe(initialLastBResourceExecute);
    expect(originalBDefinition).toMatchObject({ description: "B kept", parameters: { properties: { b1: expect.anything() } } });
    expect(originalBResourceDefinition).toMatchObject({ name: "b_read_keep", parameters: { type: "object" } });
    expect(originalBExecutorSpec).toMatchObject({
      inputSchema: schema("b1"), uiResourceUri: "ui://b/keep", uiStreamMode: "stream-first",
    });
    expect(originalBResourceExecutorSpec).toMatchObject({ resourceUri: "docs://b/keep" });

    cache.servers.a.tools = [{ name: "new", description: "A current", inputSchema: schema("a2"), uiResourceUri: "ui://a/new", uiStreamMode: "stream-first" }];
    cache.servers.a.resources = [{ name: "new", uri: "docs://a/new" }];
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      await args[4](new Map([["a", ["new", "read_new"]]]));
      return { configChanged: false };
    });
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });

    const refreshedA = registeredTool(api, "a_new");
    expect(refreshedA).toMatchObject({ description: "A current" });
    expect(Object.keys(refreshedA.parameters.properties)).toEqual(["a2"]);
    aConnection.client.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "A call" }],
      structuredContent: { owner: "a", revision: 2 },
    });
    const refreshedAResult = await refreshedA.execute("a-call", {}, undefined, undefined, { hasUI: false, cwd: process.cwd() });
    expect(refreshedAResult).toMatchObject({
      content: expect.arrayContaining([{ type: "text", text: "A call" }]),
      details: { server: "a", tool: "new" },
    });
    expect(refreshedAResult).not.toHaveProperty("structuredContent");
    expect(aConnection.client.callTool).toHaveBeenCalledWith(
      { name: "new", arguments: {}, _meta: expect.objectContaining({ "pi-mcp-adapter/toolCallId": "a-call" }) },
      expect.objectContaining({ onprogress: expect.any(Function), resetTimeoutOnProgress: true }),
    );
    expect(bConnection.client.callTool).toHaveBeenCalledTimes(1);
    expect(state.manager.getConnection).toHaveBeenCalledWith("a");
    expect(state.uiResourceHandler.readUiResource).toHaveBeenNthCalledWith(
      2,
      "a",
      "ui://a/new",
      expect.objectContaining({ config: state.config, signal: expect.any(AbortSignal), onNeedsAuth: expect.any(Function) }),
    );
    expect(mocks.startUiServer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        serverName: "a",
        toolName: "new",
        toolArgs: {},
        resource: uiResources["ui://a/new"],
        hostContext: expect.objectContaining({
          [UI_STREAM_HOST_CONTEXT_KEY]: expect.objectContaining({ mode: "stream-first", intermediateResultPatches: true }),
        }),
        onMessage: expect.any(Function),
        onContextUpdate: expect.any(Function),
        onComplete: expect.any(Function),
      }),
    );
    expect(state.manager.registerResourceUpdatedListener).toHaveBeenNthCalledWith(
      2,
      expect.any(String), "a", "ui://a/new", expect.any(Function),
    );
    const refreshedAResource = registeredTool(api, "a_read_new");
    aConnection.client.readResource.mockResolvedValueOnce({ contents: [{ uri: "docs://a/new", text: "A resource" }] });
    const refreshedAResourceResult = await refreshedAResource.execute("a-resource", {}, undefined, undefined, { hasUI: false, cwd: process.cwd() });
    expect(refreshedAResourceResult).toMatchObject({
      content: [{ type: "text", text: "A resource" }],
      details: { server: "a", resourceUri: "docs://a/new" },
    });
    expect(aConnection.client.readResource).toHaveBeenCalledWith({ uri: "docs://a/new" }, undefined);
    expect(executorSpecs.find(spec => spec.serverName === "a" && spec.originalName === "new")).toMatchObject({
      inputSchema: schema("a2"), uiResourceUri: "ui://a/new", uiStreamMode: "stream-first",
    });
    expect(executorModes.get("a:new")).toBe(false);
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "b_keep")).toHaveLength(initialBRegistrations);
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "b_read_keep")).toHaveLength(initialBResourceRegistrations);
    expect(registeredTool(api, "b_keep")).toBe(originalBDefinition);
    expect(registeredTool(api, "b_keep").execute).toBe(originalBExecute);
    expect(registeredTool(api, "b_read_keep")).toBe(originalBResourceDefinition);
    expect(registeredTool(api, "b_read_keep").execute).toBe(originalBResourceExecute);
    expect(lastRegistered("b_keep")).toBe(initialLastBDefinition);
    expect(lastRegistered("b_keep").execute).toBe(initialLastBExecute);
    expect(lastRegistered("b_read_keep")).toBe(initialLastBResourceDefinition);
    expect(lastRegistered("b_read_keep").execute).toBe(initialLastBResourceExecute);
    expect(originalBDefinition).toMatchObject({
      description: "B kept",
      parameters: { type: "object", properties: { b1: { type: "string" } } },
    });
    expect(originalBResourceDefinition).toMatchObject({
      name: "b_read_keep", parameters: { type: "object", properties: {} },
    });
    expect(originalBExecutorSpec).toMatchObject({
      serverName: "b", originalName: "keep", inputSchema: schema("b1"),
      uiResourceUri: "ui://b/keep", uiStreamMode: "stream-first",
    });
    expect(originalBResourceExecutorSpec).toMatchObject({
      serverName: "b", originalName: "read_keep", resourceUri: "docs://b/keep",
    });

    bConnection.client.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "B again" }],
      structuredContent: { owner: "b", revision: 3 },
    });
    const retainedBAgainResult = await retainedB.execute("b-again", {}, undefined, undefined, { hasUI: false, cwd: process.cwd() });
    expect(retainedBAgainResult).toMatchObject({
      content: expect.arrayContaining([{ type: "text", text: "B again" }]),
      details: { server: "b", tool: "keep" },
    });
    expect(retainedBAgainResult).not.toHaveProperty("structuredContent");
    expect(bConnection.client.callTool).toHaveBeenCalledTimes(2);
    expect(bConnection.client.callTool).toHaveBeenNthCalledWith(
      2,
      { name: "keep", arguments: {}, _meta: expect.objectContaining({ "pi-mcp-adapter/toolCallId": "b-again" }) },
      expect.objectContaining({ onprogress: expect.any(Function), resetTimeoutOnProgress: true }),
    );
    expect(aConnection.client.callTool).toHaveBeenCalledTimes(1);
    expect(state.manager.getConnection).toHaveBeenLastCalledWith("b");
    expect(state.uiResourceHandler.readUiResource).toHaveBeenNthCalledWith(
      3,
      "b",
      "ui://b/keep",
      expect.objectContaining({ config: state.config, signal: expect.any(AbortSignal), onNeedsAuth: expect.any(Function) }),
    );
    expect(mocks.startUiServer).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        serverName: "b",
        toolName: "keep",
        toolArgs: {},
        resource: uiResources["ui://b/keep"],
        manager: state.manager,
        config: state.config,
        state,
        hostContext: expect.objectContaining({
          [UI_STREAM_HOST_CONTEXT_KEY]: expect.objectContaining({ mode: "stream-first", intermediateResultPatches: true }),
        }),
        onNeedsAuth: expect.any(Function),
        onMessage: expect.any(Function),
        onContextUpdate: expect.any(Function),
        onComplete: expect.any(Function),
      }),
    );
    expect(state.manager.registerUiStreamListener).toHaveBeenNthCalledWith(
      3,
      expect.any(String), expect.any(Function),
    );
    expect(state.manager.registerResourceUpdatedListener).toHaveBeenNthCalledWith(
      3,
      expect.any(String), "b", "ui://b/keep", expect.any(Function),
    );
    const bToolExecutions = executorSpecs.filter(spec => spec.serverName === "b" && spec.originalName === "keep");
    expect(bToolExecutions).toHaveLength(2);
    expect(bToolExecutions[0]).toBe(originalBExecutorSpec);
    expect(bToolExecutions[1]).toBe(originalBExecutorSpec);

    bConnection.client.readResource.mockResolvedValueOnce({
      contents: [{ uri: "docs://b/keep", text: "B resource after Save" }],
    });
    const retainedBResourceAfterSaveResult = await retainedBResource.execute(
      "b-resource-after-save", {}, undefined, undefined, { hasUI: false, cwd: process.cwd() },
    );
    expect(retainedBResourceAfterSaveResult.content).toEqual([{ type: "text", text: "B resource after Save" }]);
    expect(retainedBResourceAfterSaveResult.details).toMatchObject({
      server: "b", resourceUri: "docs://b/keep",
    });
    expect(bConnection.client.readResource).toHaveBeenNthCalledWith(2, { uri: "docs://b/keep" }, undefined);
    expect(aConnection.client.readResource).toHaveBeenCalledTimes(1);
    const bResourceExecutions = executorSpecs.filter(spec => spec.serverName === "b" && spec.resourceUri === "docs://b/keep");
    expect(bResourceExecutions).toHaveLength(2);
    expect(bResourceExecutions[0]).toBe(originalBResourceExecutorSpec);
    expect(bResourceExecutions[1]).toBe(originalBResourceExecutorSpec);
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "b_keep")).toHaveLength(initialBRegistrations);
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "b_read_keep")).toHaveLength(initialBResourceRegistrations);
    expect(uiStarts.map(({ options }) => `${options.serverName}:${options.toolName}`)).toEqual(["b:keep", "a:new", "b:keep"]);
  });

  it("preserves an SDK structured payload through a real registered deferred search executor", async () => {
    const definition = { command: "search", directTools: "search", lifecycle: "eager" };
    const config: any = { settings: { freezeDirectTools: true }, mcpServers: { search: definition } };
    const inputSchema = { type: "object", properties: { query: { type: "string" } } };
    const outputSchema = { type: "object", properties: { rows: { type: "array" }, source: { type: "string" } } };
    const cache: any = { version: 1, servers: {
      search: {
        configHash: computeServerHash(definition, process.cwd()),
        cachedAt: Date.now(),
        resources: [],
        tools: [{ name: "find", description: "Find search rows", inputSchema, outputSchema }],
      },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const actualDirectExecutor = await vi.importActual<typeof import("../direct-tools.ts")>("../direct-tools.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);
    const connection = { status: "connected", client: { callTool: vi.fn(), readResource: vi.fn() } };
    state.manager.getConnection = vi.fn((serverName: string) => serverName === "search" ? connection : undefined);
    state.manager.getRequestOptions = vi.fn(() => undefined);
    state.manager.ensureListen = vi.fn();
    state.manager.touch = vi.fn();
    state.manager.prepareResourceUse = vi.fn();
    state.manager.incrementInFlight = vi.fn();
    state.manager.decrementInFlight = vi.fn();
    mocks.createDirectToolExecutor.mockImplementation((getState: unknown, getInitPromise: unknown, spec: any, structured?: boolean) => (
      actualDirectExecutor.createDirectToolExecutor(getState as any, getInitPromise as any, spec, structured)
    ));

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    api.registerMcpServer = vi.fn();
    trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));

    const deferred = registeredTool(api, "search_find");
    expect(deferred).toMatchObject({
      exposure: "deferred",
      outputSchema: { properties: { structuredContent: outputSchema } },
    });
    const rawContent = [{ type: "text", text: "seven search rows" }];
    const expectedSdkStructuredContent = { rows: [{ id: 7, label: "seven" }], source: "search-server" };
    const expectedContent = [
      ...rawContent,
      { type: "text", text: `structuredContent:\n${JSON.stringify(expectedSdkStructuredContent, null, 2)}` },
    ];
    connection.client.callTool.mockResolvedValueOnce({
      content: rawContent,
      structuredContent: expectedSdkStructuredContent,
    });

    const result = await deferred.execute("search-call", { query: "seven" }, undefined, undefined, { hasUI: false, cwd: process.cwd() });

    expect(result.content).toEqual(expectedContent);
    expect(result.structuredContent).toEqual({
      content: expectedContent,
      structuredContent: expectedSdkStructuredContent,
    });
    const parsed = CallToolResultSchema.parse(result.structuredContent);
    expect(parsed.content).toEqual(expectedContent);
    expect(parsed.isError).toBeUndefined();
    expect(result.structuredContent.structuredContent).toStrictEqual({ rows: [{ id: 7, label: "seven" }], source: "search-server" });
    expect(mocks.createDirectToolExecutor).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ serverName: "search", originalName: "find", lazy: true }),
      true,
    );
    expect(state.manager.getConnection).toHaveBeenCalledWith("search");
    expect(connection.client.callTool).toHaveBeenCalledWith(
      { name: "find", arguments: { query: "seven" }, _meta: expect.objectContaining({ "pi-mcp-adapter/toolCallId": "search-call" }) },
      expect.objectContaining({ onprogress: expect.any(Function), resetTimeoutOnProgress: true }),
    );
  });

  it("leaves A's frozen surface unchanged for a reciprocal B-only persisted save", async () => {
    const a = { command: "a", directTools: true, lifecycle: "eager" };
    const b = { command: "b", directTools: true, lifecycle: "eager" };
    const config: any = { mcpServers: { a, b } };
    const schema = (property: string) => ({ type: "object", properties: { [property]: { type: "string" } } });
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: Date.now(), resources: [],
        tools: [{ name: "keep", description: "A old", inputSchema: schema("a1") }, { name: "drop", inputSchema: schema("d") }] },
      b: { configHash: computeServerHash(b, process.cwd()), cachedAt: Date.now(), resources: [],
        tools: [{ name: "keep", description: "B old", inputSchema: schema("b1") }, { name: "drop", inputSchema: schema("g") }] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    const lastDefinition = (name: string) => [...api.registerTool.mock.calls]
      .reverse().find((call: any[]) => call[0]?.name === name)?.[0];
    const aBefore = {
      description: lastDefinition("a_keep")?.description,
      schema: Object.keys(lastDefinition("a_keep")?.parameters?.properties ?? {}),
    };

    cache.servers.a.tools = [
      { name: "keep", description: "A new", inputSchema: schema("a2") },
      { name: "new", inputSchema: schema("new") },
    ];
    await state.onToolMetadataUpdated!("a", "list-changed");
    expect(lastDefinition("a_keep")?.description).toBe(aBefore.description);

    let panelCallback: ((changes: Map<string, true | string[] | false>) => Promise<void>) | undefined;
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      panelCallback = args[4];
      await panelCallback!(new Map([["b", ["keep"]]]));
      return { configChanged: false };
    });
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });

    expect(panelCallback).toBeTypeOf("function");
    expect(activeTools()).toContain("b_keep");
    expect(activeTools()).not.toContain("b_drop");
    expect(activeTools()).toContain("a_keep");
    expect(activeTools()).toContain("a_drop");
    expect(activeTools()).not.toContain("a_new");
    expect(lastDefinition("a_keep")?.description).toBe(aBefore.description);
    expect(Object.keys(lastDefinition("a_keep")?.parameters?.properties ?? {})).toEqual(aBefore.schema);
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "a_new")).toHaveLength(0);
  });

  it("preserves retained direct names against affected additions and keeps a noncolliding addition", async () => {
    const a = { command: "a", directTools: true, lifecycle: "eager", toolPrefix: "none" };
    const b = { command: "b", directTools: true, lifecycle: "eager", toolPrefix: "none" };
    const config: any = { mcpServers: { a, b } };
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "old" }] },
      b: { configHash: computeServerHash(b, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "keep", description: "B owner" }] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    const registrationCount = (name: string) => api.registerTool.mock.calls
      .filter((call: any[]) => call[0]?.name === name).length;
    const lastDefinition = (name: string) => [...api.registerTool.mock.calls]
      .reverse().find((call: any[]) => call[0]?.name === name)?.[0];
    expect(activeTools()).toEqual(expect.arrayContaining(["old", "keep"]));
    const keepRegistrations = registrationCount("keep");

    cache.servers.a.tools = [{ name: "keep", description: "A collision" }, { name: "fresh" }];
    let panelCallback: ((changes: Map<string, true | string[] | false>) => Promise<void>) | undefined;
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      panelCallback = args[4];
      await panelCallback!(new Map([["a", ["keep", "fresh"]]]));
      return { configChanged: false };
    });
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });

    expect(panelCallback).toBeTypeOf("function");
    expect(activeTools()).toContain("keep");
    expect(activeTools()).toContain("fresh");
    expect(activeTools()).not.toContain("old");
    expect(registrationCount("keep")).toBe(keepRegistrations);
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "fresh")).toHaveLength(1);
    expect(lastDefinition("keep")?.description).toBe("B owner");
  });

  it("retains full reconciliation for an unfrozen panel refresh", async () => {
    const a = { command: "a", directTools: true, lifecycle: "eager" };
    const b = { command: "b", directTools: true, lifecycle: "eager" };
    const config: any = { settings: { freezeDirectTools: false }, mcpServers: { a, b } };
    const schema = (property: string) => ({ type: "object", properties: { [property]: { type: "string" } } });
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "one" }, { name: "two" }] },
      b: { configHash: computeServerHash(b, process.cwd()), cachedAt: Date.now(), resources: [],
        tools: [{ name: "old", description: "old desc", inputSchema: schema("v1") }, { name: "gone" }] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    cache.servers.b.tools = [
      { name: "old", description: "new desc", inputSchema: schema("v2") },
      { name: "new" },
    ];
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      await args[4](new Map([["a", ["one"]]]));
      return { configChanged: false };
    });
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });

    const lastDefinition = (name: string) => [...api.registerTool.mock.calls]
      .reverse().find((call: any[]) => call[0]?.name === name)?.[0];
    expect(activeTools()).toContain("a_one");
    expect(activeTools()).not.toContain("a_two");
    expect(activeTools()).toContain("b_old");
    expect(activeTools()).toContain("b_new");
    expect(activeTools()).not.toContain("b_gone");
    expect(lastDefinition("b_old")?.description).toBe("new desc");
    expect(Object.keys(lastDefinition("b_old")?.parameters?.properties ?? {})).toEqual(["v2"]);
  });

  it("does not refresh a frozen surface for empty or runtime-only panel maps", async () => {
    const a = { command: "a", directTools: true, lifecycle: "eager" };
    const config: any = { mcpServers: { a } };
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: Date.now(), resources: [{ name: "one", uri: "docs://a/one" }], tools: [{ name: "one", description: "A one", inputSchema: { type: "object", properties: { value: { type: "string" } } }, uiResourceUri: "ui://a/one" }] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    const resolvesAfterStart = mocks.resolveDirectTools.mock.calls.length;
    const before = {
      registrations: api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "a_one").length,
      active: activeTools(),
      description: registeredTool(api, "a_one")?.description,
      schema: registeredTool(api, "a_one")?.parameters,
    };

    let panelCallback!: (changes: Map<string, true | string[] | false>) => Promise<void>;
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      panelCallback = args[4];
      return { configChanged: false };
    });
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });
    await panelCallback(new Map());
    await panelCallback(new Map([["runtime-only", true]]));

    expect(mocks.resolveDirectTools).toHaveBeenCalledTimes(resolvesAfterStart);
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "a_one")).toHaveLength(before.registrations);
    expect(registeredTool(api, "a_one")).toMatchObject({ description: before.description, parameters: before.schema });
    expect(activeTools()).toEqual(before.active);
  });

  it("uses the session catalog snapshot instead of a newer private or expired shared entry for unaffected B", async () => {
    const a = { command: "a", directTools: true, lifecycle: "eager" };
    const b = { command: "b", directTools: true, lifecycle: "eager" };
    const config: any = { mcpServers: { a, b } };
    const schema = (property: string) => ({ type: "object", properties: { [property]: { type: "string" } } });
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "one" }] },
      b: { configHash: computeServerHash(b, process.cwd()), cachedAt: Date.now(), resources: [],
        tools: [{ name: "old", description: "session old", inputSchema: schema("v1") }] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    state.sessionMetadata = new Map([["b", {
      ...cache.servers.b,
      cacheScope: "private",
      ttlMs: 0,
    }]]);
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    const lastDefinition = (name: string) => [...api.registerTool.mock.calls]
      .reverse().find((call: any[]) => call[0]?.name === name)?.[0];
    expect(lastDefinition("b_old")?.description).toBe("session old");

    // Shared disk now has a newer/expired catalogue, while the live session
    // still owns its private zero-TTL metadata. A-only Save must not resolve B
    // from either disk change or an expired cache entry.
    cache.servers.b = {
      ...cache.servers.b,
      cachedAt: Date.now() - 60_000,
      tools: [{ name: "old", description: "disk newer", inputSchema: schema("v2") }, { name: "new" }],
    };
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      await args[4](new Map([["a", ["one"]]]));
      return { configChanged: false };
    });
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });

    expect(activeTools()).toContain("b_old");
    expect(activeTools()).not.toContain("b_new");
    expect(lastDefinition("b_old")?.description).toBe("session old");
    expect(Object.keys(lastDefinition("b_old")?.parameters?.properties ?? {})).toEqual(["v1"]);
  });

  it.each([600_000, 30])("keeps selector ambiguity owned by an applied server after disk TTL expiry (%i ms)", async (ttlMs) => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const a: any = { command: "a", directTools: false, lifecycle: "eager", includeTools: ["get_x", "plain"] };
    const b = { command: "b", directTools: true, lifecycle: "eager" };
    const config: any = { mcpServers: { a, b } };
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: now, resources: [], tools: [{ name: "get-x" }, { name: "plain" }] },
      b: { configHash: computeServerHash(b, process.cwd()), cachedAt: now, ttlMs, resources: [], tools: [{ name: "get_x" }] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    expect(activeTools()).toContain("b_get_x");

    now += 80;
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      await args[4](new Map([["a", true]]));
      return { configChanged: false };
    });
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });

    expect(activeTools()).toContain("b_get_x");
    expect(activeTools()).toContain("a_plain");
    expect(activeTools()).not.toContain("a_get-x");
  });

  it("uses a cloned session catalog for selector ambiguity after in-place private metadata mutation", async () => {
    const a: any = { command: "a", directTools: false, lifecycle: "eager", includeTools: ["get_x", "plain"] };
    const b = { command: "b", directTools: true, lifecycle: "eager" };
    const config: any = { mcpServers: { a, b } };
    const bEntry: any = {
      configHash: computeServerHash(b, process.cwd()),
      cachedAt: Date.now(),
      resources: [],
      tools: [{ name: "get_x", description: "session B" }],
    };
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "get-x" }, { name: "plain" }] },
      b: bEntry,
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    state.sessionMetadata = new Map([["b", { ...bEntry, cacheScope: "private", ttlMs: 0 }]]);
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    expect(activeTools()).toContain("b_get_x");

    // The live/session catalog changes in place after B was applied. A's
    // selector ambiguity must still be judged against the saved B catalog.
    state.sessionMetadata.get("b").tools.splice(0, 1, { name: "newer" });
    cache.servers.b.tools.splice(0, 1, { name: "newer" });
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      await args[4](new Map([["a", true]]));
      return { configChanged: false };
    });
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });

    expect(activeTools()).toContain("b_get_x");
    expect(activeTools()).toContain("a_plain");
    expect(activeTools()).not.toContain("a_get-x");
  });

  it("does not publish a stale scoped catalog into a successor session during reentrant replacement", async () => {
    const a: any = { command: "a", directTools: false, lifecycle: "eager", toolPrefix: "none" };
    const b: any = { command: "b", directTools: false, lifecycle: "eager", toolPrefix: "none" };
    const config: any = { mcpServers: { a, b } };
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "shared" }] },
      b: { configHash: computeServerHash(b, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "shared" }] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});

    const previousRegister = api.registerTool.getMockImplementation()!;
    let replacement: Promise<unknown> | undefined;
    let replaced = false;
    api.registerTool.mockImplementation((tool: any) => {
      previousRegister(tool);
      if (!replaced && tool.name === "shared") {
        replaced = true;
        config.mcpServers.a.directTools = false;
        delete cache.servers.a;
        replacement = handlers.get("session_start")?.({ replacement: true }, {}) as Promise<unknown>;
      }
    });
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      await args[4](new Map([["a", ["shared"]]]));
      return { configChanged: false };
    });
    await expect(registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    })).rejects.toThrow(/stale session/);
    await replacement?.catch(() => undefined);

    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      await args[4](new Map([["b", ["shared"]]]));
      return { configChanged: false };
    });
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });

    expect(activeTools()).toContain("shared");
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "shared").at(-1)?.[0]?.description)
      .toBe("(no description)");
  });

  it("does not publish a panel catalog into a successor session during reentrant refresh", async () => {
    const a: any = { command: "a", directTools: true, lifecycle: "eager" };
    const b: any = { command: "b", directTools: false, lifecycle: "eager", includeTools: ["get_x", "plain"] };
    const config: any = { mcpServers: { a, b } };
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "get_x", description: "v1" }] },
    } };
    let diskCache: any = cache;
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const oldState = createState();
    oldState.config = config;
    const newState = createState();
    newState.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockImplementation(() => diskCache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValueOnce(oldState).mockResolvedValue(newState);
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(oldState.onToolMetadataUpdated).toBeTypeOf("function"));
    expect(activeTools()).toContain("a_get_x");

    cache.servers.a.tools = [{ name: "get_x", description: "v2" }];
    const previousRegister = api.registerTool.getMockImplementation()!;
    let replacement: Promise<unknown> | undefined;
    let replaced = false;
    api.registerTool.mockImplementation((tool: any) => {
      previousRegister(tool);
      if (!replaced && tool.name === "a_get_x" && tool.description === "v2") {
        replaced = true;
        diskCache = null;
        replacement = handlers.get("session_start")?.({ replacement: true }, {}) as Promise<unknown>;
      }
    });
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      await args[4](new Map([["a", true]]));
      return { configChanged: false };
    });
    await expect(registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    })).rejects.toThrow(/stale session/);
    expect(replaced).toBe(true);
    await replacement?.catch(() => undefined);
    await vi.waitFor(() => expect(newState.onToolMetadataUpdated).toBeTypeOf("function"));

    newState.sessionMetadata = new Map([[
      "b",
      { configHash: computeServerHash(b, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "get-x" }, { name: "plain" }] },
    ]]);
    await newState.onToolMetadataUpdated!("b", "list-changed");
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      await args[4](new Map([["b", true]]));
      return { configChanged: false };
    });
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });
    expect(activeTools()).toContain("b_plain");
    expect(activeTools()).toContain("b_get-x");
  });

  it("captures an applied catalog before a registration callback mutates live metadata", async () => {
    const a: any = { command: "a", directTools: true, lifecycle: "eager" };
    const b: any = { command: "b", directTools: false, lifecycle: "eager", includeTools: ["get_x", "plain"] };
    const config: any = { mcpServers: { a, b } };
    const schema = { type: "object", properties: {} };
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "get_x", description: "A old" }] },
      b: { configHash: computeServerHash(b, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "get-x" }, { name: "plain", inputSchema: schema }] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    expect(activeTools()).toContain("a_get_x");

    cache.servers.a.tools = [{ name: "get_x", description: "A current" }];
    const previousRegister = api.registerTool.getMockImplementation()!;
    let mutated = false;
    api.registerTool.mockImplementation((tool: any) => {
      previousRegister(tool);
      if (!mutated && tool.name === "a_get_x" && tool.description === "A current") {
        mutated = true;
        cache.servers.a.tools = [{ name: "other" }];
      }
    });
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      await args[4](new Map([["a", ["get_x"]]]));
      return { configChanged: false };
    });
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });
    expect(mutated).toBe(true);

    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      await args[4](new Map([["b", true]]));
      return { configChanged: false };
    });
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });
    expect(activeTools()).toContain("b_plain");
    expect(activeTools()).not.toContain("b_get-x");
  });

  it("does not let an input keep-alive sync commit an old catalog into a successor session", async () => {
    // FIXTURE3: the old session is explicitly unfrozen so input may enter the
    // real sync path; the distinct successor keeps the default freeze. The
    // config handoff occurs inside the registration callback before restart.
    const a: any = { command: "a", directTools: true, lifecycle: "keep-alive", toolPrefix: "none" };
    const b: any = { command: "b", directTools: false, lifecycle: "eager", includeTools: ["get_x", "plain"] };
    const oldConfig: any = { settings: { freezeDirectTools: false }, mcpServers: { a, b } };
    const successorConfig: any = {
      mcpServers: {
        a: { ...a },
        b: { ...b },
      },
    };
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "get_x", description: "v1" }] },
    } };
    let diskCache: any = cache;
    let activeConfig = oldConfig;
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const oldState = createState();
    oldState.config = oldConfig;
    const newState = createState();
    newState.config = successorConfig;
    mocks.loadMcpConfig.mockImplementation(() => activeConfig);
    mocks.loadMetadataCache.mockImplementation(() => diskCache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValueOnce(oldState).mockResolvedValue(newState);
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(oldState.onToolMetadataUpdated).toBeTypeOf("function"));
    expect(activeTools()).toContain("get_x");

    cache.servers.a.tools = [{ name: "get_x", description: "v2" }];
    const previousRegister = api.registerTool.getMockImplementation()!;
    let replacement: Promise<unknown> | undefined;
    let replaced = false;
    api.registerTool.mockImplementation((tool: any) => {
      previousRegister(tool);
      if (!replaced && tool.name === "get_x" && tool.description?.includes?.("v2")) {
        replaced = true;
        diskCache = null;
        activeConfig = successorConfig;
        replacement = handlers.get("session_start")?.({ replacement: true }, {}) as Promise<unknown>;
      }
    });
    await handlers.get("input")?.({ type: "input", text: "hello" }, {});
    expect(oldState.lifecycle.ensureConverged).toHaveBeenCalled();
    expect(replaced).toBe(true);
    await replacement?.catch(() => undefined);
    await vi.waitFor(() => expect(newState.onToolMetadataUpdated).toBeTypeOf("function"));

    newState.sessionMetadata = new Map([[
      "b",
      { configHash: computeServerHash(b, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "get-x" }, { name: "plain" }] },
    ]]);
    await newState.onToolMetadataUpdated!("b", "list-changed");
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      await args[4](new Map([["b", true]]));
      return { configChanged: false };
    });
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });

    expect(activeTools()).toContain("b_plain");
    expect(activeTools()).toContain("b_get-x");
  });

  it("keeps unfrozen reconciliation from reserving a failed server's old direct name", async () => {
    const a: any = { command: "a", directTools: true, lifecycle: "eager", toolPrefix: "none" };
    const b: any = { command: "b", directTools: true, lifecycle: "eager", toolPrefix: "none" };
    const config: any = { settings: { freezeDirectTools: false }, mcpServers: { a, b } };
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: Date.now(), resources: [], tools: [] },
      b: { configHash: computeServerHash(b, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "shared", description: "B" }] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    expect(activeTools()).toContain("shared");

    state.failureTracker.set("b", Date.now());
    cache.servers.b.tools = [];
    cache.servers.a.tools = [{ name: "shared", description: "A" }];
    await state.onToolMetadataUpdated!("a", "tools-list-changed");

    const sharedDefinitions = api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "shared");
    expect(sharedDefinitions.at(-1)?.[0]?.description).toBe("A");
    expect(activeTools()).toContain("shared");
  });

  it("releases an unavailable direct name for a proxy namespace during unfrozen refresh", async () => {
    const b: any = { command: "b", directTools: true, lifecycle: "eager", toolPrefix: "none" };
    const c: any = { url: "https://c.example/mcp", lifecycle: "eager" };
    const config: any = { settings: { freezeDirectTools: false, namespaceProxyTools: true }, mcpServers: { b, c } };
    const cache: any = { version: 1, servers: {
      b: { configHash: computeServerHash(b, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "mcp__c", description: "B direct" }] },
      c: { configHash: computeServerHash(c, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "call", description: "C proxy" }] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    expect(activeTools()).toContain("mcp__c");
    expect(registeredTool(api, "mcp__c")?.description).toContain("B direct");

    state.failureTracker.set("b", Date.now());
    cache.servers.b.tools = [];
    await state.onToolMetadataUpdated!("b", "failure-backoff");

    const namespace = [...api.registerTool.mock.calls]
      .reverse().find((call: any[]) => call[0]?.name === "mcp__c")?.[0];
    expect(namespace?.description).toContain("Namespace-proxy");
    const cResult = { content: [{ type: "text", text: "C result" }], details: { server: "c" } };
    mocks.executeCall.mockResolvedValue(cResult);
    await expect(namespace.execute("c-call", { tool: "call", args: {} }, undefined, undefined, { hasUI: false, cwd: process.cwd }))
      .resolves.toBe(cResult);
    expect(mocks.executeCall).toHaveBeenCalledWith(
      expect.anything(), "call", {}, "c", expect.any(Function), undefined, "proxy", undefined, "c-call",
    );
  });

  it("keeps a frozen affected addition blocked by an unavailable retained name", async () => {
    const a: any = { command: "a", directTools: false, lifecycle: "eager", toolPrefix: "none" };
    const b: any = { command: "b", directTools: true, lifecycle: "eager", toolPrefix: "none" };
    const config: any = { mcpServers: { a, b } };
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: Date.now(), resources: [], tools: [] },
      b: { configHash: computeServerHash(b, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "shared" }] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    expect(activeTools()).toContain("shared");
    const initialSharedRegistrations = api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "shared").length;

    state.failureTracker.set("b", Date.now());
    cache.servers.a.tools = [{ name: "shared", description: "A" }];
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      await args[4](new Map([["a", ["shared"]]]));
      return { configChanged: false };
    });
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });

    expect(activeTools()).not.toContain("shared");
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "shared")).toHaveLength(initialSharedRegistrations);
    expect(api.registerTool.mock.calls.filter((call: any[]) => (
      call[0]?.name === "shared" && call[0]?.description === "A"
    ))).toHaveLength(0);
  });

  it("does not let a retained namespace reservation be stolen by an affected direct addition", async () => {
    const a = { command: "a", directTools: true, lifecycle: "eager", toolPrefix: "none" };
    const b = { command: "b", lifecycle: "eager" };
    const config: any = { settings: { namespaceProxyTools: true }, mcpServers: { a, b } };
    const cache: any = { version: 1, servers: {
      a: { configHash: computeServerHash(a, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "old" }] },
      b: { configHash: computeServerHash(b, process.cwd()), cachedAt: Date.now(), resources: [], tools: [{ name: "tool" }] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    expect(activeTools()).toContain("mcp__b");
    const namespaceRegistrations = api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "mcp__b").length;

    cache.servers.a.tools = [{ name: "mcp__b" }, { name: "fresh" }];
    mocks.openMcpPanel.mockImplementation(async (...args: any[]) => {
      await args[4](new Map([["a", ["mcp__b", "fresh"]]]));
      return { configChanged: false };
    });
    await registeredCommand(api, "mcp").handler("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: vi.fn(), setStatus: vi.fn(), theme: {} },
      reload: vi.fn(),
    });

    expect(activeTools()).toContain("mcp__b");
    expect(activeTools()).toContain("fresh");
    expect(api.registerTool.mock.calls.filter((call: any[]) => call[0]?.name === "mcp__b").length)
      .toBeGreaterThanOrEqual(namespaceRegistrations);
    expect(api.registerTool.mock.calls.filter((call: any[]) => (
      call[0]?.name === "mcp__b" && call[0]?.promptSnippet === "MCP tool from a"
    ))).toHaveLength(0);

    const bResult = {
      content: [{ type: "text", text: "B namespace result" }],
      structuredContent: { owner: "b" },
      details: { server: "b", canonicalTool: "tool" },
    };
    mocks.executeCall.mockResolvedValue(bResult);
    const namespace = registeredTool(api, "mcp__b");
    await expect(namespace.execute("namespace-b", { tool: "tool", args: {} }, undefined, undefined, { hasUI: false, cwd: process.cwd() }))
      .resolves.toBe(bResult);
    expect(mocks.executeCall).toHaveBeenCalledWith(
      expect.anything(), "tool", {}, "b", expect.any(Function), undefined, "proxy", undefined, "namespace-b",
    );
  });

  it("does not attribute an unrelated same-server background refresh during connect", async () => {
    const definition = { command: "demo", directTools: true, lifecycle: "eager" };
    const config = { settings: { freezeDirectTools: false }, mcpServers: { demo: definition } };
    const cache: any = { version: 1, servers: {
      demo: { configHash: computeServerHash(definition, process.cwd()), cachedAt: Date.now(), tools: [], resources: [] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);
    const connectResult = { content: [{ type: "text", text: "connected" }], details: { mode: "connect" } };
    const connect = createDeferred<typeof connectResult>();
    mocks.executeConnect.mockImplementation(() => connect.promise);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(state.onToolMetadataUpdated).toBeTypeOf("function"));
    const proxyTool = registeredTool(api, "mcp");
    const pending = proxyTool.execute("call-1", { connect: "demo" });
    await vi.waitFor(() => expect(mocks.executeConnect).toHaveBeenCalledOnce());

    cache.servers.demo.tools = [{ name: "background", inputSchema: { type: "object", properties: {} } }];
    await state.onToolMetadataUpdated!("demo", "list-changed");
    connect.resolve(connectResult);
    const result = await pending;

    expect(result).toBe(connectResult);
    expect(result).not.toHaveProperty("addedToolNames");
    expect(activeTools()).toContain("demo_background");
  });

  it.each(["throw", "error-result"] as const)(
    "attributes later same-server discovery to its emitting connect when the earlier %s operation settles after it",
    async (mode) => {
      const { cache, state, api, activeTools, proxy } = await setupRealConnectCatalog();
      const earlierGate = createDeferred<void>();
      const earlierStarted = createDeferred<void>();
      const callerAbort = new AbortController();
      let firstConnect = true;
      mocks.executeConnect.mockImplementation(async (currentState: any, _server: string, signal?: AbortSignal) => {
        if (firstConnect) {
          firstConnect = false;
          earlierStarted.resolve();
          await earlierGate.promise;
          if (mode === "throw") {
            expect(signal).toBe(callerAbort.signal);
            expect(signal?.aborted).toBe(true);
            const reason = signal?.reason;
            throw reason instanceof Error ? reason : new Error("A cancelled");
          }
          return {
            content: [{ type: "text", text: "aborted" }],
            details: { mode: "connect", error: "aborted" },
          };
        }
        cache.servers.demo.tools = [{ name: "search", inputSchema: { type: "object", properties: {} } }];
        await currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
        return { content: [{ type: "text", text: "connected B" }], details: { mode: "connect" } };
      });

      const earlierCall = mode === "throw"
        ? proxy.execute("A", { connect: "demo" }, callerAbort.signal)
        : proxy.execute("A", { connect: "demo" });
      const earlierOutcome = earlierCall.then(
        value => ({ status: "fulfilled" as const, value }),
        error => ({ status: "rejected" as const, error }),
      );
      await earlierStarted.promise;
      if (mode === "throw") callerAbort.abort(new Error("A cancelled"));

      const later = await proxy.execute("B", { connect: "demo" });
      expect(later.addedToolNames).toEqual(["demo_search"]);
      expect(later.addedToolNames).toHaveLength(1);
      expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search" }));
      expect(activeTools()).toContain("demo_search");

      earlierGate.resolve();
      const earlier = await earlierOutcome;
      if (mode === "throw") {
        expect(earlier.status).toBe("rejected");
      } else {
        expect(earlier.status).toBe("fulfilled");
        if (earlier.status === "fulfilled") {
          expect(earlier.value).toMatchObject({ details: { error: "aborted" } });
          expect(earlier.value).not.toHaveProperty("addedToolNames");
        }
      }
      expect(activeTools()).toContain("demo_search");
    },
  );

  it("excludes a queued connect addition removed before consumption", async () => {
    const { cache, state, api, activeTools, proxy } = await setupRealConnectCatalog();
    const connectResult = { content: [{ type: "text", text: "connected" }], details: { mode: "connect" } };
    mocks.executeConnect.mockImplementation(async (currentState: any) => {
      cache.servers.demo.tools = [{ name: "gone", inputSchema: { type: "object", properties: {} } }];
      await currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
      cache.servers.demo.tools = [];
      await currentState.onToolMetadataUpdated?.("demo", "list-changed");
      return connectResult;
    });

    const result = await proxy.execute("call-1", { connect: "demo" });

    expect(result).toBe(connectResult);
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_gone" }));
    expect(activeTools()).not.toContain("demo_gone");
  });

  it("excludes a queued connect addition made unavailable by backoff before consumption", async () => {
    const { cache, state, api, activeTools, proxy } = await setupRealConnectCatalog();
    const connectResult = { content: [{ type: "text", text: "connected" }], details: { mode: "connect" } };
    mocks.executeConnect.mockImplementation(async (currentState: any) => {
      cache.servers.demo.tools = [{ name: "flaky", inputSchema: { type: "object", properties: {} } }];
      await currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
      state.failureTracker.set("demo", Date.now());
      return connectResult;
    });

    const result = await proxy.execute("call-1", { connect: "demo" });

    expect(result).toBe(connectResult);
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_flaky" }));
    expect(activeTools()).not.toContain("demo_flaky");
  });

  it("does not let a replaced in-flight connect clear successor attribution", async () => {
    const definition = { command: "demo", directTools: true, lifecycle: "eager" };
    const config = { settings: { freezeDirectTools: false }, mcpServers: { demo: definition } };
    const cache: any = { version: 1, servers: {
      demo: { configHash: computeServerHash(definition, process.cwd()), cachedAt: Date.now(), tools: [], resources: [] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const firstState = createState();
    const successorState = createState();
    firstState.config = config;
    successorState.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValueOnce(firstState).mockResolvedValueOnce(successorState);
    const oldConnect = createDeferred<{ content: { type: "text"; text: string }[]; details: { mode: string } }>();
    const oldStarted = createDeferred<void>();
    mocks.executeConnect.mockImplementation(async (currentState: any) => {
      if (currentState === firstState) {
        oldStarted.resolve();
        return oldConnect.promise;
      }
      cache.servers.demo.tools = [{ name: "successor", inputSchema: { type: "object", properties: {} } }];
      await currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
      return { content: [{ type: "text", text: "successor connected" }], details: { mode: "connect" } };
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(firstState.onToolMetadataUpdated).toBeTypeOf("function"));
    const oldCall = registeredTool(api, "mcp").execute("old", { connect: "demo" });
    await oldStarted.promise;

    await handlers.get("session_start")?.({ replacement: true }, {});
    await vi.waitFor(() => expect(successorState.onToolMetadataUpdated).toBeTypeOf("function"));
    const successor = await registeredTool(api, "mcp").execute("successor", { connect: "demo" });

    expect(successor.addedToolNames).toEqual(["demo_successor"]);
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_successor" }));
    expect(activeTools()).toContain("demo_successor");

    oldConnect.resolve({ content: [{ type: "text", text: "old connected" }], details: { mode: "connect" } });
    await expect(oldCall).rejects.toThrow(/restarted|stale/);
    expect(activeTools()).toContain("demo_successor");
  });

  it("hardens replacement cleanup while successor attribution is queued before consume", async () => {
    const definition = { command: "demo", directTools: true, lifecycle: "eager" };
    const config = { settings: { freezeDirectTools: false }, mcpServers: { demo: definition } };
    const cache: any = { version: 1, servers: {
      demo: { configHash: computeServerHash(definition, process.cwd()), cachedAt: Date.now(), tools: [], resources: [] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const firstState = createState();
    const successorState = createState();
    firstState.config = config;
    successorState.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValueOnce(firstState).mockResolvedValueOnce(successorState);
    const oldConnect = createDeferred<any>();
    const oldStarted = createDeferred<void>();
    const queued = createDeferred<void>();
    const release = createDeferred<void>();
    mocks.executeConnect.mockImplementation(async (currentState: any) => {
      if (currentState === firstState) {
        oldStarted.resolve();
        return oldConnect.promise;
      }
      cache.servers.demo.tools = [{ name: "successor", inputSchema: { type: "object", properties: {} } }];
      await currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
      queued.resolve();
      await release.promise;
      return { content: [{ type: "text", text: "successor connected" }], details: { mode: "connect" } };
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(firstState.onToolMetadataUpdated).toBeTypeOf("function"));
    const oldCall = registeredTool(api, "mcp").execute("old", { connect: "demo" });
    await oldStarted.promise;

    await handlers.get("session_start")?.({ replacement: true }, {});
    await vi.waitFor(() => expect(successorState.onToolMetadataUpdated).toBeTypeOf("function"));
    const successorCall = registeredTool(api, "mcp").execute("successor", { connect: "demo" });
    await queued.promise;
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_successor" }));
    expect(activeTools()).toContain("demo_successor");

    oldConnect.resolve({ content: [{ type: "text", text: "old" }], details: { mode: "connect" } });
    await expect(oldCall).rejects.toThrow(/restarted|stale/);
    release.resolve();
    const successor = await successorCall;
    expect(successor.addedToolNames).toEqual(["demo_successor"]);
    expect(activeTools()).toContain("demo_successor");
  });

  it.each(["throw", "error-result"] as const)(
    "hardens overlap cleanup while later %s discovery is queued before consume",
    async (mode) => {
      const { cache, api, activeTools, proxy } = await setupRealConnectCatalog();
      const earlierGate = createDeferred<void>();
      const earlierStarted = createDeferred<void>();
      const queued = createDeferred<void>();
      const release = createDeferred<void>();
      const callerAbort = new AbortController();
      let firstConnect = true;
      mocks.executeConnect.mockImplementation(async (currentState: any, _server: string, signal?: AbortSignal) => {
        if (firstConnect) {
          firstConnect = false;
          earlierStarted.resolve();
          await earlierGate.promise;
          if (mode === "throw") {
            expect(signal).toBe(callerAbort.signal);
            expect(signal?.aborted).toBe(true);
            const reason = signal?.reason;
            throw reason instanceof Error ? reason : new Error("A cancelled");
          }
          return { content: [{ type: "text", text: "aborted" }], details: { mode: "connect", error: "aborted" } };
        }
        cache.servers.demo.tools = [{ name: "search", inputSchema: { type: "object", properties: {} } }];
        await currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
        queued.resolve();
        await release.promise;
        return { content: [{ type: "text", text: "connected B" }], details: { mode: "connect" } };
      });

      const earlierCall = mode === "throw"
        ? proxy.execute("A", { connect: "demo" }, callerAbort.signal)
        : proxy.execute("A", { connect: "demo" });
      const earlierOutcome = earlierCall.then(
        value => ({ value }),
        error => ({ error }),
      );
      await earlierStarted.promise;
      const laterCall = proxy.execute("B", { connect: "demo" });
      await queued.promise;
      if (mode === "throw") callerAbort.abort(new Error("A cancelled"));
      earlierGate.resolve();
      const earlier: any = await earlierOutcome;
      if (mode === "throw") {
        expect(earlier.error).toBeDefined();
      } else {
        expect(earlier.value).not.toHaveProperty("addedToolNames");
        expect(earlier.value).toMatchObject({ details: { error: "aborted" } });
      }
      release.resolve();
      const later = await laterCall;
      expect(later.addedToolNames).toEqual(["demo_search"]);
      expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search" }));
      expect(activeTools()).toContain("demo_search");
    },
  );

  it("returns the proxy connect result untouched when no direct tools were added", async () => {
    const config = {
      mcpServers: {
        demo: { command: "demo", directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools.mockReturnValue([
      { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" },
    ]);
    mocks.initializeMcp.mockResolvedValue(state);
    const connectResult = { content: [{ type: "text", text: "connected" }] };
    mocks.executeConnect.mockImplementation(async (currentState: any) => {
      currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
      return connectResult;
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();
    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];

    expect(await proxyTool.execute("call-1", { connect: "demo" })).toBe(connectResult);
    expect(api.setActiveTools).not.toHaveBeenCalled();
  });

  it("attributes only the connected server's direct tools when another server registers during the connect", async () => {
    const config = {
      settings: { freezeDirectTools: false },
      mcpServers: {
        demo: { command: "demo", directTools: true },
        other: { command: "other", directTools: true },
      },
    };
    const cache: any = { version: 1, servers: {
      demo: { configHash: computeServerHash(config.mcpServers.demo, process.cwd()), cachedAt: Date.now(), tools: [], resources: [] },
      other: { configHash: computeServerHash(config.mcpServers.other, process.cwd()), cachedAt: Date.now(), tools: [], resources: [] },
    } };
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(cache);
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);
    mocks.initializeMcp.mockResolvedValue(state);
    const connectResult = { content: [{ type: "text", text: "connected" }], details: { mode: "connect" } };
    mocks.executeConnect.mockImplementation(async (currentState: any) => {
      // Another server's observed catalog refresh lands while this connect is in flight.
      cache.servers.other.tools = [{ name: "list", description: "List other" }];
      currentState.onToolMetadataUpdated?.("other", "list-changed");
      cache.servers.demo.tools = [{ name: "search", description: "Search demo" }];
      currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
      return connectResult;
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();
    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];

    const result = await proxyTool.execute("call-1", { connect: "demo" });

    expect(result.addedToolNames).toEqual(["demo_search"]);
    expect(api.setActiveTools).not.toHaveBeenCalled();
  });

  it("reports same-server overlapping connect discovery only once", async () => {
    const config = {
      settings: { freezeDirectTools: false },
      mcpServers: {
        demo: { command: "demo", directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValue([
        { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" },
      ]);
    mocks.initializeMcp.mockResolvedValue(state);
    const firstStarted = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    const discovery = createDeferred<void>();
    let connectCount = 0;
    const connectResult = { content: [{ type: "text", text: "connected" }] };
    mocks.executeConnect.mockImplementation(async (currentState: any) => {
      const started = connectCount++ === 0 ? firstStarted : secondStarted;
      started.resolve();
      await discovery.promise;
      currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
      return connectResult;
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();
    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];

    const firstConnect = proxyTool.execute("call-1", { connect: "demo" });
    await firstStarted.promise;
    const secondConnect = proxyTool.execute("call-2", { connect: "demo" });
    await secondStarted.promise;
    discovery.resolve();

    const [firstResult, secondResult] = await Promise.all([firstConnect, secondConnect]);

    expect(firstResult.addedToolNames).toEqual(["demo_search"]);
    expect(secondResult).not.toHaveProperty("addedToolNames");
  });

  it("reports same-server overlapping connect reactivation only once", async () => {
    const config = {
      settings: { freezeDirectTools: false },
      mcpServers: {
        demo: { command: "demo", directTools: true },
      },
    };
    const search = { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" };
    const restoredSearch = { ...search, description: "Search demo restored" };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools
      .mockReturnValueOnce([search])
      .mockReturnValueOnce([search])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([restoredSearch])
      .mockReturnValue([restoredSearch]);
    mocks.initializeMcp.mockResolvedValue(state);
    const firstStarted = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    const discovery = createDeferred<void>();
    let connectCount = 0;
    const connectResult = { content: [{ type: "text", text: "connected" }] };
    mocks.executeConnect.mockImplementation(async (currentState: any) => {
      const started = connectCount++ === 0 ? firstStarted : secondStarted;
      started.resolve();
      await discovery.promise;
      if (connectCount === 2) {
        currentState.onToolMetadataUpdated?.("demo", "list-changed");
        currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
      }
      return connectResult;
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi({ unregisterTool: false });
    trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();
    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];

    const firstConnect = proxyTool.execute("call-1", { connect: "demo" });
    await firstStarted.promise;
    const secondConnect = proxyTool.execute("call-2", { connect: "demo" });
    await secondStarted.promise;
    discovery.resolve();

    const results = await Promise.all([firstConnect, secondConnect]);

    expect(results.map((result) => result.addedToolNames).filter(Boolean)).toEqual([["demo_search"]]);
  });

  it("keeps stale direct tools out of addedToolNames and deactivates them explicitly without unregisterTool", async () => {
    const config = {
      settings: { freezeDirectTools: false },
      mcpServers: {
        demo: { command: "demo", directTools: true },
      },
    };
    const search = { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" };
    const lookup = { serverName: "demo", originalName: "lookup", prefixedName: "demo_lookup", description: "Lookup demo" };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools
      .mockReturnValueOnce([search])
      .mockReturnValueOnce([search])
      .mockReturnValueOnce([lookup])
      .mockReturnValueOnce([lookup])
      .mockReturnValue([search]);
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeConnect.mockImplementation(async (currentState: any) => {
      currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
      return { content: [{ type: "text", text: "connected" }] };
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi({ unregisterTool: false });
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();
    const activeBeforeConnect = activeTools();
    expect(activeBeforeConnect).toContain("demo_search");
    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];

    // Metadata replaced demo_search with demo_lookup: the removal is an explicit
    // active-set rewrite, the addition rides on the result.
    const replaced = await proxyTool.execute("call-1", { connect: "demo" });
    const activeAfterReplace = [...activeBeforeConnect.filter((name) => name !== "demo_search"), "demo_lookup"];
    expect(api.unregisterTool).toBeUndefined();
    expect(replaced.addedToolNames).toEqual(["demo_lookup"]);
    expect(api.setActiveTools).toHaveBeenCalledWith(activeAfterReplace);
    expect(activeTools()).toEqual(activeAfterReplace);

    // demo_search comes back: Pi does not re-activate a name it already knows,
    // so the adapter re-adds it and reports it on this result too.
    const restored = await proxyTool.execute("call-2", { connect: "demo" });
    expect(restored.addedToolNames).toEqual(["demo_search"]);
    expect(activeTools()).toEqual([...activeAfterReplace.filter((name) => name !== "demo_lookup"), "demo_search"]);
  });

  it("keeps hidden direct tool names reserved against namespace proxies during backoff", async () => {
    const { computeServerHash } = await import("../metadata-cache.ts");
    const failedDefinition = { command: "failed", directTools: true };
    const proxyDefinition = { command: "foo" };
    const config = {
      settings: { toolPrefix: "mcp", namespaceProxyTools: true },
      mcpServers: {
        failed: failedDefinition,
        foo: proxyDefinition,
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue({
      version: 1,
      servers: {
        foo: {
          configHash: computeServerHash(proxyDefinition),
          cachedAt: Date.now(),
          tools: [{ name: "run" }],
          resources: [],
        },
      },
    });
    mocks.resolveDirectTools.mockImplementation((_config, _cache, _prefix, _env, _cwd, unavailableServers, reservedNames) => {
      reservedNames?.add("mcp__foo");
      if (unavailableServers?.has("failed")) {
        return [];
      }
      return [{
        serverName: "failed",
        originalName: "foo",
        prefixedName: "mcp__foo",
        description: "Failed direct",
      }];
    });
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    state.failureTracker.set("failed", Date.now());
    state.onToolMetadataUpdated?.("failed", "failure-backoff-started");

    expect(state.directToolCounts).toEqual(new Map());
    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({
      name: "mcp__foo",
      description: expect.stringContaining("Namespace-proxy"),
    }));
  });

  it("re-activates namespace proxies hidden during failure backoff without unregisterTool", async () => {
    const demoDefinition = { command: "demo" };
    // An eager server makes session_start initialize instead of deferring.
    const otherDefinition = { command: "other", lifecycle: "eager" };
    const config = { settings: { freezeDirectTools: false, namespaceProxyTools: true }, mcpServers: { demo: demoDefinition, other: otherDefinition } };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue({
      version: 1,
      servers: { demo: cacheEntry(demoDefinition), other: cacheEntry(otherDefinition) },
    });
    mocks.resolveDirectTools.mockReturnValue([]);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi({ unregisterTool: false });
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));
    expect(activeTools()).toEqual(expect.arrayContaining(["mcp__demo", "mcp__other"]));

    // The host deactivates mcp__other itself; the adapter must not undo that.
    api.setActiveTools(activeTools().filter((name) => name !== "mcp__other"));

    state.failureTracker.set("demo", Date.now());
    state.failureTracker.set("other", Date.now());
    state.onToolMetadataUpdated?.("demo", "failure-backoff-started");
    expect(api.unregisterTool).toBeUndefined();
    expect(activeTools()).not.toContain("mcp__demo");

    state.failureTracker.delete("demo");
    state.failureTracker.delete("other");
    state.onToolMetadataUpdated?.("demo", "failure-backoff-expired");

    expect(activeTools()).toContain("mcp__demo");
    expect(activeTools()).not.toContain("mcp__other");
  });

  it("publishes connected status only after replacing stale cached direct tools", async () => {
    const config = {
      settings: { disableProxyTool: true },
      mcpServers: {
        demo: { command: "demo-server", lifecycle: "keep-alive", directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue({ version: 1, servers: { demo: {} } });
    mocks.resolveDirectTools
      .mockReturnValueOnce([{
        serverName: "demo",
        originalName: "stale",
        prefixedName: "demo_stale",
        description: "Cached stale tool",
      }])
      .mockReturnValue([{
        serverName: "demo",
        originalName: "current",
        prefixedName: "demo_current",
        description: "Authoritative current tool",
      }]);
    mocks.initializeMcp.mockImplementation(async (_pi, _ctx, _owner, options) => {
      state.statusEvents = options.statusEvents;
      state.statusEvents?.emit(MCP_STATUS_EVENT, connectedStatusSnapshot(1));
      return state;
    });
    mocks.updateStatusBar.mockImplementation((currentState) => {
      currentState.statusEvents?.emit(MCP_STATUS_EVENT, connectedStatusSnapshot(1));
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, connectedSurfaces } = createStatusObservingPi();
    mcpAdapter(api);

    await handlers.get("session_start")?.({}, { hasUI: false });
    await new Promise((resolve) => setImmediate(resolve));

    expect(connectedSurfaces).toEqual([["demo_current"]]);
  });

  it("publishes an authoritative empty catalog only after removing stale cached direct tools", async () => {
    const config = {
      settings: { disableProxyTool: true },
      mcpServers: {
        demo: { command: "demo-server", lifecycle: "keep-alive", directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue({ version: 1, servers: { demo: {} } });
    mocks.resolveDirectTools
      .mockReturnValueOnce([{
        serverName: "demo",
        originalName: "stale",
        prefixedName: "demo_stale",
        description: "Cached stale tool",
      }])
      .mockReturnValue([]);
    mocks.initializeMcp.mockImplementation(async (_pi, _ctx, _owner, options) => {
      state.statusEvents = options.statusEvents;
      state.statusEvents?.emit(MCP_STATUS_EVENT, connectedStatusSnapshot(0));
      return state;
    });
    mocks.updateStatusBar.mockImplementation((currentState) => {
      currentState.statusEvents?.emit(MCP_STATUS_EVENT, connectedStatusSnapshot(0));
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, connectedSurfaces } = createStatusObservingPi();
    mcpAdapter(api);

    await handlers.get("session_start")?.({}, { hasUI: false });
    await new Promise((resolve) => setImmediate(resolve));

    expect(connectedSurfaces).toEqual([["mcp"]]);
  });

  it("removes stale direct tools and registers the proxy after metadata refresh", async () => {
    const config = {
      settings: { disableProxyTool: true, freezeDirectTools: false },
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools
      .mockReturnValueOnce([
        { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" },
      ])
      .mockReturnValueOnce([
        { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" },
      ])
      .mockReturnValue([]);
    mocks.reconnectServers.mockImplementation(async (currentState: any) => {
      currentState.onToolMetadataUpdated?.("demo", "command-reconnect");
    });
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("reconnect demo", { hasUI: false });

    expect(api.unregisterTool).toHaveBeenCalledWith("demo_search");
    expect(api.setActiveTools).not.toHaveBeenCalled();
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
  });

  it("falls back to active-tool deactivation and reactivates re-added tools when unregisterTool is unavailable", async () => {
    const config = {
      settings: { disableProxyTool: true, freezeDirectTools: false },
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools
      .mockReturnValueOnce([
        { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" },
      ])
      .mockReturnValueOnce([
        { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" },
      ])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo v2" },
      ]);
    mocks.reconnectServers.mockImplementation(async (currentState: any) => {
      currentState.onToolMetadataUpdated?.("demo", "command-reconnect");
    });
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter({ unregisterTool: false });

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("reconnect demo", { hasUI: false });

    expect(api.unregisterTool).toBeUndefined();
    expect(api.setActiveTools).toHaveBeenCalledWith(["bash", "mcp"]);

    await commandDef.handler("reconnect demo", { hasUI: false });

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "demo_search",
      description: "Search demo v2",
    }));
    expect(api.setActiveTools).toHaveBeenCalledWith(["bash", "mcp", "demo_search"]);
  });

  it("skips the proxy tool once direct tools are fully available", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
      },
      settings: { disableProxyTool: true },
    });
    mocks.resolveDirectTools.mockReturnValue([
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search demo",
      },
    ]);

    const { api } = await loadAdapter();

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "demo_search",
      renderResult: expect.any(Function),
    }));
    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
  });

  it("registers proxy args as string or object without patternProperties", async () => {
    const { api } = await loadAdapter();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    expect(proxyTool).toBeDefined();

    const argsSchema = proxyTool.parameters.properties.args;
    expect(argsSchema.anyOf).toEqual([
      expect.objectContaining({ type: "string" }),
      expect.objectContaining({ type: "object", additionalProperties: true }),
    ]);
    expect(JSON.stringify(argsSchema)).not.toContain("patternProperties");
    expect(proxyTool.parameters.properties.server.description).toContain("describe operations");
    expect(proxyTool.parameters.properties.searchMode).toBeUndefined();
  });

  it("uses lexical search for model-facing proxy calls and forwards the request signal", async () => {
    const state = createState();
    const result = { content: [{ type: "text", text: "lexical results" }], details: { mode: "search", matches: [] } };
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeSearch.mockResolvedValue(result);
    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    const signal = new AbortController().signal;

    await expect(registeredTool(api, "mcp").execute("search-1", {
      search: "find by words",
    }, signal)).resolves.toBe(result);
    expect(mocks.executeSearch).toHaveBeenCalledWith(
      state, "find by words", undefined, undefined, undefined, undefined, undefined, undefined, signal,
    );
  });

  it("forwards the server selector for describe operations", async () => {
    const state = createState();
    const describeResult = {
      content: [{ type: "text", text: "description" }],
      details: { mode: "describe", server: "codegraph" },
    };
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeDescribe.mockReturnValue(describeResult);

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const gateway = registeredTool(api, "mcp");
    expect(await gateway.execute("describe-1", {
      describe: "codegraph_explore",
      server: "codegraph",
    })).toBe(describeResult);

    expect(mocks.executeDescribe).toHaveBeenCalledWith(state, "codegraph_explore", "codegraph");
  });

  it("forwards native object proxy args into executeCall", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeCall.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const { api, handlers } = await loadAdapter();

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    expect(proxyTool).toBeDefined();

    await proxyTool.execute("call-1", { tool: "demo_search", args: { q: "hello", limit: 10 } });

    expect(mocks.executeCall).toHaveBeenCalledWith(
      state,
      "demo_search",
      { q: "hello", limit: 10 },
      undefined,
      expect.any(Function),
      undefined,
      undefined,
      undefined,
      "call-1",
    );
  });

  it("rejects gateway params nested inside proxy args", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeCall.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    mocks.executeSearch.mockResolvedValue({ content: [{ type: "text", text: "results" }] });

    const { api, handlers } = await loadAdapter();

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    await expect(proxyTool.execute("call-1", { args: '{"search":"screenshot","limit":3}' })).rejects.toThrow(
      "Gateway params were nested inside `args`; pass them top-level",
    );
    await expect(proxyTool.execute("call-2", { args: { tool: "demo_search", args: { q: "hello" }, server: "demo" } })).rejects.toThrow(
      "Gateway params were nested inside `args`; pass them top-level",
    );

    expect(mocks.executeSearch).not.toHaveBeenCalled();
    expect(mocks.executeCall).not.toHaveBeenCalled();
    expect(mocks.executeStatus).not.toHaveBeenCalled();
  });

  it("rejects non-gateway params nested inside proxy args", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    await expect(proxyTool.execute("call-1", { args: '{"query":"screenshot"}' })).rejects.toThrow(
      "Gateway params were nested inside `args`; pass them top-level",
    );
    await expect(proxyTool.execute("call-2", { args: "" })).rejects.toThrow(
      "Gateway params were nested inside `args`; pass them top-level",
    );
    expect(mocks.executeStatus).not.toHaveBeenCalled();
  });

  it("routes manual auth actions through the proxy tool", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeAuthStart.mockResolvedValue({ content: [{ type: "text", text: "auth url" }] });
    mocks.executeAuthComplete.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const { api, handlers } = await loadAdapter();

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    expect(proxyTool).toBeDefined();

    await proxyTool.execute("call-1", { action: "auth-start", server: "demo" });
    await proxyTool.execute("call-2", {
      action: "auth-complete",
      server: "demo",
      args: '{"redirectUrl":"http://localhost:19876/callback?code=abc&state=state"}',
    });

    expect(mocks.executeAuthStart).toHaveBeenCalledWith(state, "demo");
    expect(mocks.executeAuthComplete).toHaveBeenCalledWith(
      state,
      "demo",
      "http://localhost:19876/callback?code=abc&state=state",
    );
  });

  it("forwards the proxy tool AbortSignal into executeCall", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeCall.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const { api, handlers } = await loadAdapter();

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    expect(proxyTool).toBeDefined();

    const controller = new AbortController();
    await proxyTool.execute(
      "call-1",
      { tool: "demo_search", args: '{"q":"hello"}' },
      controller.signal,
    );

    expect(mocks.executeCall).toHaveBeenCalledWith(
      state,
      "demo_search",
      { q: "hello" },
      undefined,
      expect.any(Function),
      controller.signal,
      undefined,
      undefined,
      "call-1",
    );
  });

  it("exports createMcpAdapter while retaining the default adapter export", async () => {
    const adapterModule = await import("../index.ts");
    expect(adapterModule.createMcpAdapter).toBeTypeOf("function");
    expect(adapterModule.default).toBeTypeOf("function");

    const { api } = createPi();
    adapterModule.default(api);
    expect(mocks.loadMcpConfig).toHaveBeenCalledWith(undefined);
  });

  it("uses only the supplied config for early registration and session initialization", async () => {
    const config = {
      mcpServers: {
        memory: { url: "https://memory.example.com/mcp", directTools: true },
      },
      settings: { disableProxyTool: true as const },
    };
    mocks.getConfigPathFromArgv.mockReturnValue("/ambient/argv.json");
    mocks.resolveDirectTools.mockReturnValue([{
      serverName: "memory",
      originalName: "search",
      prefixedName: "memory_search",
      description: "Search",
    }]);
    const state = createState();
    state.config = structuredClone(config);
    mocks.initializeMcp.mockResolvedValue(state);

    const { createMcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    createMcpAdapter({ config })(api);

    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    expect(mocks.getConfigPathFromArgv).not.toHaveBeenCalled();
    expect(mocks.resolveDirectTools).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServers: { memory: config.mcpServers.memory } }),
      null,
      "server",
      undefined,
      process.cwd(),
      expect.any(Set),
      expect.any(Set),
    );
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "memory_search" }));
    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));

    await handlers.get("session_start")?.({}, { hasUI: false });
    expect(mocks.initializeMcp).toHaveBeenCalledWith(
      api,
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ config: expect.objectContaining({ mcpServers: config.mcpServers }) }),
    );
    expect(mocks.initializeMcp.mock.calls[0][3].config).not.toBe(config);
  });

  it("keeps programmatic relative Claude plugin paths stable when the session cwd differs", async () => {
    const processCwd = "/process-project";
    const sessionCwd = "/active-project";
    vi.spyOn(process, "cwd").mockReturnValue(processCwd);
    const config = {
      mcpServers: {},
      claudePlugins: [{ path: "./plugins/local", mcp: true, skills: true }],
    };
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { createMcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    createMcpAdapter({ config })(api);

    const expectedPath = resolve(processCwd, "./plugins/local");
    expect(mocks.resolveConfiguredClaudePluginMcp.mock.calls[0]?.[0]).toEqual({
      mcpServers: {},
      claudePlugins: [{ path: expectedPath, mcp: true, skills: true }],
    });

    await handlers.get("session_start")?.({}, { hasUI: false, mode: "print", cwd: sessionCwd });
    await Promise.resolve();
    const runtimeConfig = mocks.initializeMcp.mock.calls[0]?.[3].config;
    expect(runtimeConfig.claudePlugins[0].path).toBe(expectedPath);
    expect(mocks.initializeMcp.mock.calls[0]?.[1].cwd).toBe(sessionCwd);

    const discover = handlers.get("resources_discover")!;
    discover({ cwd: sessionCwd, reason: "reload" });
    expect(mocks.discoverConfiguredClaudePluginSkills.mock.calls[0]?.[0].claudePlugins[0].path).toBe(expectedPath);
    expect(mocks.discoverConfiguredClaudePluginSkills.mock.calls[0]?.[1]).toBe(sessionCwd);
  });

  it("adds strict direct-tool argument preparation only when configured", async () => {
    const inputSchema = {
      type: "object",
      required: ["filter"],
      properties: {
        filter: {
          type: "object",
          required: ["site"],
          properties: { site: { type: "string" } },
        },
      },
    };
    mocks.resolveDirectTools.mockReturnValue([{
      serverName: "memory",
      originalName: "search",
      prefixedName: "memory_search",
      description: "Search",
      inputSchema,
    }]);
    const { createMcpAdapter } = await import("../index.ts");
    const strictPi = createPi();
    createMcpAdapter({
      config: {
        mcpServers: { memory: { command: "memory", directTools: true } },
        settings: { strictDirectToolArguments: true },
      },
    })(strictPi.api);
    const strictTool = strictPi.api.registerTool.mock.calls.find(
      ([tool]: [Record<string, unknown>]) => tool.name === "memory_search",
    )?.[0];

    expect(strictTool.prepareArguments({ filter: '{"site":"north"}' })).toEqual({
      filter: { site: "north" },
    });

    const leanPi = createPi();
    createMcpAdapter({
      config: { mcpServers: { memory: { command: "memory", directTools: true } } },
    })(leanPi.api);
    const leanTool = leanPi.api.registerTool.mock.calls.find(
      ([tool]: [Record<string, unknown>]) => tool.name === "memory_search",
    )?.[0];
    expect(leanTool).not.toHaveProperty("prepareArguments");
  });

  it("snapshots caller config and isolates separate factories", async () => {
    const firstConfig = { mcpServers: { first: { url: "https://first.example.com/mcp" } } };
    const secondConfig = { mcpServers: { second: { url: "https://second.example.com/mcp" } } };
    const firstAdapter = (await import("../index.ts")).createMcpAdapter({ config: firstConfig });
    const secondAdapter = (await import("../index.ts")).createMcpAdapter({ config: secondConfig });
    firstConfig.mcpServers.first.url = "https://mutated.example.com/mcp";

    const firstPi = createPi();
    const secondPi = createPi();
    firstAdapter(firstPi.api);
    secondAdapter(secondPi.api);

    expect(mocks.resolveDirectTools.mock.calls.at(-2)?.[0]).toEqual({
      mcpServers: { first: { url: "https://first.example.com/mcp" } },
    });
    expect(mocks.resolveDirectTools.mock.calls.at(-1)?.[0]).toEqual(secondConfig);
  });

  it("reads Pi's mcp.json files only when Pi supports MCP, decided before the first config load", async () => {
    const { createMcpAdapter, default: defaultAdapter } = await import("../index.ts");
    defaultAdapter({ ...createPi().api, registerMcpServer: vi.fn() });
    expect(mocks.setPiMcpConfigEnabled.mock.calls).toEqual([[true]]);
    expect(mocks.setPiMcpConfigEnabled.mock.invocationCallOrder[0]).toBeLessThan(mocks.loadMcpConfig.mock.invocationCallOrder[0]!);

    defaultAdapter(createPi().api);
    expect(mocks.setPiMcpConfigEnabled.mock.calls).toEqual([[true], [false]]);

    // An in-memory config reads no files, so it leaves the setting alone.
    createMcpAdapter({ config: { mcpServers: {} } })({ ...createPi().api, registerMcpServer: vi.fn() });
    expect(mocks.setPiMcpConfigEnabled.mock.calls).toEqual([[true], [false]]);
  });

  it("gives configPath precedence without changing the default argv path", async () => {
    mocks.getConfigPathFromArgv.mockReturnValue("/argv.json");
    const { createMcpAdapter, default: defaultAdapter } = await import("../index.ts");
    const configured = createMcpAdapter({ configPath: "/factory.json" });
    configured(createPi().api);
    expect(mocks.loadMcpConfig).toHaveBeenCalledWith("/factory.json");
    expect(mocks.getConfigPathFromArgv).not.toHaveBeenCalled();

    mocks.loadMcpConfig.mockClear();
    mocks.getConfigPathFromArgv.mockClear();
    defaultAdapter(createPi().api);
    expect(mocks.getConfigPathFromArgv).toHaveBeenCalledTimes(1);
    expect(mocks.loadMcpConfig).toHaveBeenCalledWith("/argv.json");
  });

  it("warns once at session start and surfaces the legacy-config notice in status", async () => {
    const notice = "pi-mcp-adapter no longer reads /project/.pi/mcp.json. Move it with: mv old new";
    mocks.getLegacyMcpMigrationNotices.mockReturnValue([notice]);
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { api, handlers } = await loadAdapter();
    const ui = { notify: vi.fn() };

    await handlers.get("session_start")?.({}, { hasUI: true, ui, cwd: "/project" });
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.notify).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledWith(notice, "warning");

    await registeredTool(api, "mcp").execute("status", {});
    expect(mocks.executeStatus).toHaveBeenCalledWith(expect.objectContaining({ migrationNotices: [notice] }));
  });

  it("uses status notifications instead of ambient panels in memory-config mode", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { createMcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    createMcpAdapter({ config: { mcpServers: { memory: { url: "https://memory.example.com/mcp" } } } })(api);
    const ui = { notify: vi.fn() };
    await handlers.get("session_start")?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("setup", { hasUI: true, ui });
    await commandDef.handler("disable memory", { hasUI: true, ui });
    await commandDef.handler("status", { hasUI: true, ui });
    const authDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    await authDef.handler("", { hasUI: true, ui });

    expect(mocks.openMcpSetup).not.toHaveBeenCalled();
    expect(mocks.openMcpPanel).not.toHaveBeenCalled();
    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
    expect(mocks.writeProjectServerDisabledOverride).not.toHaveBeenCalled();
    expect(mocks.showStatus).toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("in-memory"), "info");
  });

  it("starts a replacement init immediately and shuts down stale init results", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    const first = createDeferred<any>();
    const second = createDeferred<any>();
    mocks.initializeMcp
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { api, handlers } = await loadAdapter();

    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");

    await sessionStart?.({}, {});
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownOAuth).not.toHaveBeenCalled();
    const firstRuntime = mocks.createOAuthRuntime.mock.results[0].value;

    await sessionStart?.({}, {});
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownOAuth).toHaveBeenCalledWith(firstRuntime);

    const activeState = createState();
    second.resolve(activeState);
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(activeState));

    expect(activeState.lifecycle.gracefulShutdown).not.toHaveBeenCalled();

    const staleState = createState();
    first.resolve(staleState);
    await vi.waitFor(() => expect(mocks.flushMetadataCache).toHaveBeenCalledWith(staleState));

    expect(mocks.updateStatusBar).not.toHaveBeenCalledWith(staleState);
    expect(staleState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1);
  });

  it("does not let stale init finalization publish status or clear a newer init promise", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    const first = createDeferred<any>();
    const second = createDeferred<any>();
    mocks.initializeMcp.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mocks.executeStatus.mockReturnValue({ content: [{ type: "text", text: "ready" }] });

    const { api, handlers } = await loadAdapter();
    const sessionStart = handlers.get("session_start")!;
    await sessionStart({}, {});
    await sessionStart({}, {});

    const gateway = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    const pendingGateway = gateway.execute("pending", {}, undefined, undefined, { hasUI: false, cwd: "/two" });
    api.events.emit.mockClear();
    const staleState = createState();
    staleState.statusEvents = api.events;
    first.resolve(staleState);
    await vi.waitFor(() => expect(mocks.flushMetadataCache).toHaveBeenCalledWith(staleState));

    expect(mocks.updateStatusBar).not.toHaveBeenCalledWith(staleState);
    expect(api.events.emit).not.toHaveBeenCalledWith(MCP_STATUS_EVENT, expect.objectContaining({ connectedCount: 0 }));
    expect(mocks.executeStatus).not.toHaveBeenCalled();

    const activeState = createState();
    second.resolve(activeState);
    await expect(pendingGateway).resolves.toEqual({ content: [{ type: "text", text: "ready" }] });
    expect(mocks.updateStatusBar).toHaveBeenCalledWith(activeState);
  });

  it("initializes MCP at extension load when a server requests startup connection", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { url: "http://localhost:3999/mcp", lifecycle: "eager" },
      },
    });
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeStatus.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const { api } = await loadAdapter();

    await vi.waitFor(() => expect(mocks.initializeMcp).toHaveBeenCalledTimes(1));
    const loadCtx = mocks.initializeMcp.mock.calls[0][1];
    expect(loadCtx.hasUI).toBe(false);
    expect(loadCtx.mode).toBe("print");
    expect(loadCtx.cwd).toBe(process.cwd());

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    expect(proxyTool).toBeDefined();

    await proxyTool.execute("call-1", {});
    expect(mocks.executeStatus).toHaveBeenCalledWith(state);
  });

  it("does not fail load-time tool sync before Pi action methods are bound", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { url: "http://localhost:3999/mcp", lifecycle: "eager" },
      },
    });
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { default: mcpAdapter } = await import("../index.ts");
    const { api } = createPi();
    api.getActiveTools.mockImplementation(() => {
      throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
    });
    mcpAdapter(api);

    await vi.waitFor(() => expect(mocks.initializeMcp).toHaveBeenCalledTimes(1));
    expect(mocks.updateStatusBar).toHaveBeenCalledWith(state);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not initialize at load when startup servers are absent or disabled", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        lazy: { command: "npx", args: ["-y", "demo-server"] },
        disabledEager: { url: "http://localhost:3999/mcp", lifecycle: "eager", disabled: true },
      },
    });

    const { api } = await loadAdapter();

    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.initializeMcp).not.toHaveBeenCalled();
  });

  it("reuses first-use initialization started while session_start awaits prior cleanup", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    const firstState = createState();
    const cleanup = createDeferred<void>();
    firstState.lifecycle.gracefulShutdown.mockReturnValue(cleanup.promise);
    const secondInitialization = createDeferred<any>();
    const secondState = createState();
    mocks.initializeMcp
      .mockResolvedValueOnce(firstState)
      .mockReturnValueOnce(secondInitialization.promise);
    mocks.executeStatus.mockReturnValue({ content: [{ type: "text", text: "ready" }] });

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/one" });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(firstState));

    const restarting = Promise.resolve(handlers.get("session_start")?.({}, { hasUI: false, cwd: "/two" }));
    await vi.waitFor(() => expect(firstState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1));
    const gateway = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    const firstUse = gateway.execute("racing", {}, undefined, undefined, { hasUI: false, cwd: "/two" });
    await vi.waitFor(() => expect(mocks.initializeMcp).toHaveBeenCalledTimes(2));

    cleanup.resolve(undefined);
    await restarting;
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);

    secondInitialization.resolve(secondState);
    await expect(firstUse).resolves.toEqual({ content: [{ type: "text", text: "ready" }] });
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(mocks.updateStatusBar).toHaveBeenCalledWith(secondState);
  });

  it.each(["core", "OAuth"])("rejects delayed %s import work after shutdown", async (moduleName) => {
    vi.resetModules();
    const gate = createDeferred<void>();
    if (moduleName === "core") {
      vi.doMock("../init.ts", async () => {
        mocks.coreModuleStarted();
        await gate.promise;
        return {
          initializeMcp: initializeMcpResolvingTrust,
          clearFailure: mocks.clearFailure,
          updateStatusBar: mocks.updateStatusBar,
          flushMetadataCache: mocks.flushMetadataCache,
          updateMetadataCache: mocks.updateMetadataCache,
          notifyToolMetadataUpdated: mocks.notifyToolMetadataUpdated,
        };
      });
    } else {
      vi.doMock("../mcp-auth-flow.ts", async () => {
        mocks.oauthModuleStarted();
        await gate.promise;
        return {
          initializeOAuth: mocks.initializeOAuth,
          createOAuthRuntime: mocks.createOAuthRuntime,
          shutdownOAuth: mocks.shutdownOAuth,
        };
      });
    }

    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    try {
      const { api, handlers } = await loadAdapter();
      const starting = Promise.resolve(handlers.get("session_start")?.({}, { hasUI: false }));
      await vi.waitFor(() => expect(
        moduleName === "core" ? mocks.coreModuleStarted : mocks.oauthModuleStarted,
      ).toHaveBeenCalledTimes(1));

      const shutdown = Promise.resolve(handlers.get("session_shutdown")?.());
      gate.resolve(undefined);
      await Promise.all([starting, shutdown]);

      expect(mocks.initializeMcp).not.toHaveBeenCalled();
      expect(mocks.createOAuthRuntime).not.toHaveBeenCalled();
    } finally {
      gate.resolve(undefined);
    }
  });

  it("defers a cache-backed lazy runtime and coalesces concurrent first operations", async () => {
    const definition = { command: "demo" };
    const config = cacheLazyServer(definition);
    const initializing = createDeferred<any>();
    const state = createState();
    state.config = config;
    mocks.initializeMcp.mockReturnValue(initializing.promise);
    mocks.executeStatus.mockReturnValue({ content: [{ type: "text", text: "ready" }] });

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.initializeMcp).not.toHaveBeenCalled();

    const gateway = registeredTool(api, "mcp");
    const ctx = { hasUI: false, cwd: "/tmp", mode: "print" };
    const first = gateway.execute("one", {}, undefined, undefined, ctx);
    const second = gateway.execute("two", {}, undefined, undefined, ctx);
    await vi.waitFor(() => expect(mocks.initializeMcp).toHaveBeenCalledTimes(1));

    initializing.resolve(state);
    await Promise.all([first, second]);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    expect(mocks.executeStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps the gateway for a valid direct server plus an invalid proxy-only server", async () => {
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const validDirect = { command: "valid-direct", directTools: true };
    const invalidProxy = { command: "invalid-proxy" };
    const config = {
      settings: { deferWithMissingMetadata: true, disableProxyTool: true },
      mcpServers: { validDirect, invalidProxy },
    };
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue({
      version: 1,
      servers: { validDirect: cacheEntry(validDirect), invalidProxy: cacheEntry(invalidProxy, { ttlMs: 0 }) },
    });
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });

    expect(mocks.initializeMcp).not.toHaveBeenCalled();
    expect(registeredTool(api, "mcp")).toBeDefined();
    expect(registeredTool(api, "validDirect_search")).toBeDefined();
    expect(registeredTool(api, "mcp__invalidProxy")).toBeUndefined();
  });

  it("renders the large direct-tools advisory once without writing it to the UI console", async () => {
    const config = { mcpServers: { demo: { command: "demo", directTools: true } } };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools.mockReturnValueOnce([]).mockReturnValue(largeDirectToolSpecs());
    mocks.initializeMcp.mockResolvedValue(state);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const notify = vi.fn();

    const { handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: true, ui: { notify } });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));
    state.onToolMetadataUpdated?.("demo", "resync");

    expect(notify.mock.calls.filter(([, level]) => level === "warning")).toEqual([
      [expect.stringContaining("75+ direct tools"), "warning"],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not pre-deliver the previous runtime's advisory after session config suppresses it", async () => {
    const config = { mcpServers: { demo: { command: "demo", directTools: true } } };
    const suppressedConfig = { ...config, settings: { warnOnLargeDirectTools: false } };
    const firstState = createState();
    firstState.config = config;
    const secondState = createState();
    secondState.config = suppressedConfig;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools.mockReturnValue(largeDirectToolSpecs());
    mocks.initializeMcp.mockResolvedValueOnce(firstState).mockResolvedValueOnce(secondState);
    const firstNotify = vi.fn();

    const { handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: true, ui: { notify: firstNotify } });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(firstState));
    expect(firstNotify).toHaveBeenCalledWith(expect.stringContaining("75+ direct tools"), "warning");

    mocks.loadMcpConfig.mockReturnValue(suppressedConfig);
    const secondNotify = vi.fn();
    await handlers.get("session_start")?.({}, { hasUI: true, ui: { notify: secondNotify } });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(secondState));

    expect(secondNotify.mock.calls.filter(([, level]) => level === "warning")).toEqual([]);
  });

  it("renders the advisory from fresh cache-backed deferred config without initializing", async () => {
    const definition = { command: "demo", directTools: true };
    const config = cacheLazyServer(definition);
    mocks.resolveDirectTools.mockReturnValue(largeDirectToolSpecs());
    const notify = vi.fn();
    const setStatus = vi.fn();

    const { handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: true, ui: { notify, setStatus } });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("75+ direct tools"), "warning");
    expect(mocks.initializeMcp).not.toHaveBeenCalled();

    mocks.loadMcpConfig.mockReturnValue({ ...config, settings: { warnOnLargeDirectTools: false } });
    const secondNotify = vi.fn();
    await handlers.get("session_start")?.({}, { hasUI: true, ui: { notify: secondNotify, setStatus } });

    expect(secondNotify).not.toHaveBeenCalled();
    expect(mocks.initializeMcp).not.toHaveBeenCalled();
  });

  it("suppresses the session advisory when warnOnLargeDirectTools is false", async () => {
    const definition = { command: "demo", directTools: true };
    const config = cacheLazyServer(definition);
    config.settings = { warnOnLargeDirectTools: false };
    mocks.resolveDirectTools.mockReturnValue(largeDirectToolSpecs());
    const notify = vi.fn();

    const { handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: true, ui: { notify, setStatus: vi.fn() } });

    expect(notify).not.toHaveBeenCalled();
  });

  it("writes the large direct-tools advisory to the console once in a non-UI session", async () => {
    const config = { mcpServers: { demo: { command: "demo", directTools: true } } };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools.mockReturnValueOnce([]).mockReturnValue(largeDirectToolSpecs());
    mocks.initializeMcp.mockResolvedValue(state);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));
    state.onToolMetadataUpdated?.("demo", "resync");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("75+ direct tools"));
  });

  it("stops deferred startup when advisory notification synchronously shuts down the session", async () => {
    const definition = { command: "demo", directTools: true };
    cacheLazyServer(definition);
    mocks.resolveDirectTools.mockReturnValue(largeDirectToolSpecs());
    const setStatus = vi.fn();
    const { handlers } = await loadAdapter();
    let shutdown: Promise<unknown> | undefined;
    const notify = vi.fn(() => {
      shutdown = Promise.resolve(handlers.get("session_shutdown")?.());
    });

    await handlers.get("session_start")?.({}, { hasUI: true, ui: { notify, setStatus } });
    await shutdown;

    expect(notify).toHaveBeenCalledTimes(1);
    expect(setStatus).not.toHaveBeenCalled();
    expect(mocks.initializeMcp).not.toHaveBeenCalled();
  });

  it("publishes a dim zero-connected footer while keeping the cached runtime deferred", async () => {
    const enabled = { command: "demo" };
    const config = {
      settings: { showStatusIcon: false },
      mcpServers: { demo: enabled, paused: { command: "paused", disabled: true } },
    };
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue({
      version: 1,
      servers: { demo: { configHash: computeServerHash(enabled, process.cwd()), cachedAt: Date.now(), tools: [], resources: [] } },
    });
    const setStatus = vi.fn();
    const theme = { fg: vi.fn((_color: string, text: string) => `styled:${text}`) };

    const { handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: true, ui: { setStatus, theme } });

    expect(setStatus).toHaveBeenCalledWith("mcp", "styled:MCP: 0/1 servers");
    expect(theme.fg).toHaveBeenCalledWith("dim", "MCP: 0/1 servers");
    expect(mocks.initializeMcp).not.toHaveBeenCalled();
    expect(mocks.coreModuleStarted).not.toHaveBeenCalled();
  });

  it.each([
    ["compact", "MCP 0/1"],
    ["off", undefined],
  ])("publishes the %s deferred footer without initializing", async (mcpFooterStatus, expected) => {
    const definition = { command: "demo" };
    const config = cacheLazyServer(definition);
    config.settings = { mcpFooterStatus };
    const setStatus = vi.fn();

    const { handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: true, ui: { setStatus } });

    expect(setStatus).toHaveBeenCalledWith("mcp", expected);
  });

  it("clears a stale footer for a cache-backed config with no servers", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {} });
    mocks.loadMetadataCache.mockReturnValue({ version: 1, servers: {} });
    const setStatus = vi.fn();

    const { handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: true, ui: { setStatus } });

    expect(setStatus).toHaveBeenCalledWith("mcp", undefined);
  });

  it("lets live runtime status overwrite the provisional deferred footer on first use", async () => {
    const definition = { command: "demo" };
    cacheLazyServer(definition);
    const initializedState = createState();
    mocks.initializeMcp.mockResolvedValue(initializedState);
    mocks.executeStatus.mockReturnValue({ content: [{ type: "text", text: "ready" }] });
    const setStatus = vi.fn();
    mocks.updateStatusBar.mockImplementation(() => setStatus("mcp", "live"));

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: true, ui: { setStatus } });
    await registeredTool(api, "mcp").execute("one", {}, undefined, undefined, { hasUI: false, cwd: "/tmp" });

    expect(setStatus.mock.calls).toEqual([
      ["mcp", "MCP: 0/1 servers"],
      ["mcp", "live"],
    ]);
  });

  it.each([
    ["lazy-keep-alive with valid cache", { lifecycle: "lazy-keep-alive" }, undefined],
    ["an env-selected tool already present in valid cache", { lifecycle: "lazy" }, "demo/search"],
  ])("defers %s", async (_label, definition, envSelection) => {
    if (envSelection) process.env.MCP_DIRECT_TOOLS = envSelection;
    cacheLazyServer(definition);

    const { handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.initializeMcp).not.toHaveBeenCalled();
  });

  it("initializes by default when any enabled server has zero-TTL metadata", async () => {
    const cachedDefinition = { command: "cached" };
    const invalidDefinition = { command: "invalid" };
    const config = { mcpServers: { cached: cachedDefinition, invalid: invalidDefinition } };
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue({
      version: 1,
      servers: { cached: cacheEntry(cachedDefinition, { tools: [] }), invalid: cacheEntry(invalidDefinition, { tools: [], ttlMs: 0 }) },
    });
    mocks.initializeMcp.mockResolvedValue(createState());

    const { handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });

    await vi.waitFor(() => expect(mocks.initializeMcp).toHaveBeenCalledTimes(1));
  });

  it.each(["eager", "keep-alive"] as const)("starts for %s lifecycle despite metadata deferral", async (lifecycle) => {
    mocks.loadMcpConfig.mockReturnValue({
      settings: { deferWithMissingMetadata: true },
      mcpServers: { demo: { command: "demo", lifecycle } },
    });
    mocks.initializeMcp.mockResolvedValue(createState());

    const { handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });

    await vi.waitFor(() => expect(mocks.initializeMcp).toHaveBeenCalledTimes(1));
  });

  it("starts for a cold environment-selected direct tool despite metadata deferral", async () => {
    process.env.MCP_DIRECT_TOOLS = "demo/search";
    mocks.loadMcpConfig.mockReturnValue({
      settings: { deferWithMissingMetadata: true },
      mcpServers: { demo: { command: "demo" } },
    });
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["demo"]);
    mocks.initializeMcp.mockResolvedValue(createState());

    const { handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });

    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
  });

  it("lets the session cwd opt into deferral when the early config cannot defer", async () => {
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const earlyConfig = { mcpServers: { early: { command: "early" } } };
    const direct = { command: "cwd-direct", directTools: true };
    const sessionConfig = {
      settings: { deferWithMissingMetadata: true },
      mcpServers: { direct, missing: { command: "missing" } },
    };
    mocks.loadMcpConfig.mockReturnValueOnce(earlyConfig).mockReturnValue(sessionConfig);
    mocks.loadMetadataCache.mockReturnValue({ version: 1, servers: { direct: cacheEntry(direct, {}, "/session/project") } });
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);

    const { api, handlers } = await loadAdapter();
    expect(registeredTool(api, "direct_search")).toBeUndefined();

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/session/project" });

    expect(mocks.initializeMcp).not.toHaveBeenCalled();
    expect(registeredTool(api, "direct_search")).toBeDefined();
    expect(registeredTool(api, "mcp")).toBeDefined();
  });

  it("removes early cached surfaces when the session cwd removes their servers", async () => {
    const actualDirectTools = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
    const direct = { command: "direct", directTools: true };
    const proxy = { command: "proxy" };
    const earlyConfig = { settings: { namespaceProxyTools: true }, mcpServers: { direct, proxy } };
    mocks.loadMcpConfig
      .mockReturnValueOnce(earlyConfig)
      .mockReturnValue({ settings: { deferWithMissingMetadata: true }, mcpServers: {} });
    mocks.loadMetadataCache.mockReturnValue({
      version: 1,
      servers: { direct: cacheEntry(direct), proxy: cacheEntry(proxy, { prompts: [{ name: "brief" }] }) },
    });
    mocks.resolveDirectTools.mockImplementation(actualDirectTools.resolveDirectTools);

    const { api, handlers } = await loadAdapter();
    expect(registeredTool(api, "direct_search")).toBeDefined();
    expect(registeredTool(api, "mcp__proxy")).toBeDefined();
    expect(registeredCommand(api, "mcp__proxy__brief")).toBeUndefined();

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/session/project" });

    expect(mocks.loadMcpConfig).toHaveBeenLastCalledWith(undefined, "/session/project");
    expect(mocks.initializeMcp).not.toHaveBeenCalled();
    expect(api.unregisterTool).toHaveBeenCalledWith("direct_search");
    expect(api.unregisterTool).toHaveBeenCalledWith("mcp__proxy");
    expect(registeredCommand(api, "mcp__proxy__brief")).toBeUndefined();
  });

  it("registers cached prompt commands at session start without metadata deferral", async () => {
    const definition = { command: "demo" };
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: definition } });
    mocks.loadMetadataCache.mockReturnValue({ version: 1, servers: { demo: cacheEntry(definition, { tools: [], prompts: [{ name: "brief" }] }) } });

    const { api, handlers } = await loadAdapter();

    expect(registeredCommand(api, "mcp__demo__brief")).toBeUndefined();
    await handlers.get("session_start")?.({}, { hasUI: false });

    expect(registeredCommand(api, "mcp__demo__brief")).toBeDefined();
  });

  it.each([
    ["mcp", "status"],
    ["mcp-auth", "demo"],
  ])("passes the complete first-use context from /%s into deferred initialization", async (commandName, args) => {
    const definition = { command: "demo" };
    const config = cacheLazyServer(definition, []);
    const initializedState = createState();
    initializedState.config = config;
    mocks.initializeMcp.mockResolvedValue(initializedState);
    mocks.authenticateServer.mockResolvedValue({ ok: false });

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });

    const model = { id: "model" };
    const modelRegistry = { find: vi.fn() };
    const sessionManager = { getBranch: vi.fn(() => []) };
    const ctx = {
      hasUI: false,
      cwd: "/deferred",
      mode: "print",
      model,
      modelRegistry,
      sessionManager,
      signal: new AbortController().signal,
      customHostField: { preserved: true },
    } as any;
    const command = registeredCommand(api, commandName);
    await command.handler(args, ctx);

    const startupContext = mocks.initializeMcp.mock.calls[0][1];
    expect(startupContext).not.toBe(ctx);
    expect(startupContext).toMatchObject({ model, modelRegistry, sessionManager, customHostField: { preserved: true } });
    expect(startupContext.signal).toBeUndefined();
  });

  it("gates a delayed proxy loader across session restart", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    const gate = createDeferred<void>();
    mocks.proxyModuleGate = gate.promise;
    const firstState = createState();
    const secondState = createState();
    mocks.initializeMcp.mockResolvedValueOnce(firstState).mockResolvedValueOnce(secondState);
    mocks.executeStatus.mockReturnValue({ content: [{ type: "text", text: "ready" }] });

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(firstState));
    const gateway = registeredTool(api, "mcp");
    const staleExecution = gateway.execute("stale", {}, undefined, undefined, { hasUI: false, cwd: "/one" });
    const staleRejection = expect(staleExecution).rejects.toThrow(/restarted|stale session/);
    await Promise.resolve();

    await handlers.get("session_start")?.({}, { hasUI: false });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(secondState));
    gate.resolve(undefined);

    await staleRejection;
    expect(mocks.executeStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["mcp", "status"],
    ["mcp-auth", "demo"],
  ])("returns from a delayed /%s loader after shutdown without invoking it", async (commandName, args) => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    const gate = createDeferred<void>();
    mocks.commandsModuleGate = gate.promise;
    const initializedState = createState();
    mocks.initializeMcp.mockResolvedValue(initializedState);

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(initializedState));
    const command = registeredCommand(api, commandName);
    const pending = command.handler(args, { hasUI: false, cwd: "/one", mode: "print" });
    await Promise.resolve();

    await handlers.get("session_shutdown")?.();
    gate.resolve(undefined);
    await expect(pending).resolves.toBeUndefined();
    expect(mocks.showStatus).not.toHaveBeenCalled();
    expect(mocks.authenticateServer).not.toHaveBeenCalled();
  });

  it("returns structured init_failed details when deferred direct initialization rejects", async () => {
    const definition = { command: "demo", directTools: true };
    cacheLazyServer(definition);
    mocks.resolveDirectTools.mockReturnValue([directToolSpec]);
    mocks.initializeMcp.mockRejectedValue(new Error("startup failed"));

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });
    const directTool = registeredTool(api, "demo_search");

    await expect(directTool.execute("failed", {}, undefined, undefined, { hasUI: false, cwd: "/one" }))
      .resolves.toMatchObject({ details: { error: "init_failed", server: "demo", message: "startup failed" } });
  });

  it("keeps delayed direct-tool loading lifecycle-gated and structured", async () => {
    const gate = createDeferred<void>();
    mocks.directModuleGate = gate.promise;
    mocks.resolveDirectTools.mockReturnValue([directToolSpec]);
    const initializedState = createState();
    mocks.initializeMcp.mockResolvedValue(initializedState);

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(initializedState));
    const directTool = registeredTool(api, "demo_search");
    const pending = directTool.execute("stale", {}, undefined, undefined, { hasUI: false, cwd: "/one" });
    await Promise.resolve();

    await handlers.get("session_shutdown")?.();
    gate.resolve(undefined);
    await expect(pending).rejects.toThrow(/shutdown|stale session/);
    expect(mocks.createDirectToolExecutor).not.toHaveBeenCalled();
  });

  it("gates a delayed code loader after shutdown", async () => {
    const codeGate = createDeferred<void>();
    mocks.codeModuleGate = codeGate.promise;
    const initializedState = createState();
    mocks.initializeMcp.mockResolvedValue(initializedState);
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } }, settings: { scriptMode: true } });

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: false });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(initializedState));
    const script = registeredTool(api, "mcpScript");
    const scriptExecution = script.execute("script", { code: "emit(1)" }, undefined, undefined, { hasUI: false, cwd: "/one" });
    const scriptRejection = expect(scriptExecution).rejects.toThrow(/shutdown|stale session/);
    await vi.waitFor(() => expect(mocks.codeModuleStarted).toHaveBeenCalledTimes(1));

    await handlers.get("session_shutdown")?.();
    codeGate.resolve(undefined);

    await scriptRejection;
    expect(mocks.runMcpScript).not.toHaveBeenCalled();
  });

  it("lets session_start supersede an in-flight load-time init", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { url: "http://localhost:3999/mcp", lifecycle: "keep-alive" },
      },
    });
    const loadInit = createDeferred<any>();
    const sessionInit = createDeferred<any>();
    mocks.initializeMcp
      .mockReturnValueOnce(loadInit.promise)
      .mockReturnValueOnce(sessionInit.promise);

    const { api, handlers } = await loadAdapter();

    await vi.waitFor(() => expect(mocks.initializeMcp).toHaveBeenCalledTimes(1));
    const loadRuntime = mocks.createOAuthRuntime.mock.results[0].value;

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: false });
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(loadRuntime.signal.aborted).toBe(true);
    expect(mocks.shutdownOAuth).toHaveBeenCalledWith(loadRuntime);

    const sessionState = createState();
    sessionInit.resolve(sessionState);
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(sessionState));

    const staleState = createState();
    loadInit.resolve(staleState);
    await vi.waitFor(() => expect(mocks.flushMetadataCache).toHaveBeenCalledWith(staleState));
    expect(mocks.updateStatusBar).not.toHaveBeenCalledWith(staleState);
    expect(staleState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1);
  });

  it("skips load-time initialization when session_start fires first", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { url: "http://localhost:3999/mcp", lifecycle: "eager" },
      },
    });
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: false });
    await vi.waitFor(() => expect(mocks.initializeMcp).toHaveBeenCalledTimes(1));
  });

  it("shuts down an unresolved load-time initialization during session_shutdown", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { url: "http://localhost:3999/mcp", lifecycle: "eager" },
      },
    });
    const loadInit = createDeferred<any>();
    mocks.initializeMcp.mockReturnValue(loadInit.promise);

    const { api, handlers } = await loadAdapter();

    await vi.waitFor(() => expect(mocks.initializeMcp).toHaveBeenCalledTimes(1));
    const loadRuntime = mocks.createOAuthRuntime.mock.results[0].value;

    const sessionShutdown = handlers.get("session_shutdown");
    await sessionShutdown?.();
    expect(loadRuntime.signal.aborted).toBe(true);
    expect(mocks.shutdownOAuth).toHaveBeenCalledWith(loadRuntime);

    const staleState = createState();
    loadInit.resolve(staleState);
    await vi.waitFor(() => expect(mocks.flushMetadataCache).toHaveBeenCalledWith(staleState));

    expect(mocks.updateStatusBar).not.toHaveBeenCalledWith(staleState);
    expect(staleState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1);
  });

  it("bounds the proxy tool wait when initialization stalls", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { url: "http://localhost:3999/mcp", lifecycle: "eager" },
      },
    });
    const never = createDeferred<any>();
    mocks.initializeMcp.mockReturnValue(never.promise);

    const { api } = await loadAdapter();

    await vi.waitFor(() => expect(mocks.initializeMcp).toHaveBeenCalledTimes(1));

    vi.useFakeTimers();
    try {
      const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
      expect(proxyTool).toBeDefined();

      const resultPromise = proxyTool.execute("call-1", { search: "demo" });
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await resultPromise;

      expect(result.details).toEqual({ error: "init_timeout", timeoutMs: 30_000 });
      expect(mocks.executeSearch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries initialization from the proxy tool after an initialization failure", async () => {
    mocks.executeSearch.mockResolvedValue({ content: [{ type: "text", text: "results" }] });
    const { api, state } = await loadAfterFailedInitialization();
    const callCtx = { hasUI: false, cwd: "/tmp/retry", mode: "print" };
    const result = await registeredTool(api, "mcp").execute("call-1", { search: "demo" }, undefined, undefined, callCtx);

    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    const startupContext = mocks.initializeMcp.mock.calls[1][1];
    expect(startupContext).not.toBe(callCtx);
    expect(startupContext).toMatchObject(callCtx);
    expect(startupContext.signal).toBeUndefined();
    expect(result).toEqual({ content: [{ type: "text", text: "results" }] });
    expect(mocks.executeSearch).toHaveBeenCalledWith(state, "demo", undefined, undefined, undefined, undefined, undefined, undefined, undefined);
  });

  it("refreshes the command owner and context after retrying failed initialization", async () => {
    const { api, state } = await loadAfterFailedInitialization();
    await registeredCommand(api, "mcp").handler("status", { hasUI: false, cwd: "/tmp/retry-command" });

    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(mocks.showStatus).toHaveBeenCalledTimes(1);
    expect(mocks.showStatus.mock.calls[0][0]).toBe(state);
    expect(mocks.showStatus.mock.calls[0][1].signal.aborted).toBe(false);
  });

  it("refreshes the auth command owner and context after retrying failed initialization", async () => {
    mocks.authenticateServer.mockResolvedValue({ ok: false });
    const { api } = await loadAfterFailedInitialization();
    await registeredCommand(api, "mcp-auth").handler("demo", { hasUI: false, cwd: "/tmp/retry-auth" });

    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(mocks.authenticateServer).toHaveBeenCalledTimes(1);
    expect(mocks.authenticateServer.mock.calls[0][0]).toBe("demo");
    expect(mocks.authenticateServer.mock.calls[0][2].signal.aborted).toBe(false);
  });

  it("refreshes the script owner after retrying failed initialization", async () => {
    mocks.runMcpScript.mockResolvedValue({ content: [{ type: "text", text: "script ok" }] });
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {}, settings: { scriptMode: true } });
    const { api } = await loadAfterFailedInitialization();
    const result = await registeredTool(api, "mcpScript").execute(
      "call-1", { code: "emit('ok')" }, undefined, undefined, { hasUI: false, cwd: "/tmp/retry-script" },
    );

    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(mocks.runMcpScript).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ content: [{ type: "text", text: "script ok" }] });
  });

  it("returns retry guidance when proxy retry initialization also fails", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    mocks.initializeMcp
      .mockRejectedValueOnce(new Error("first boom"))
      .mockRejectedValueOnce(new Error("retry boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { api, handlers } = await loadAdapter();

    await handlers.get("session_start")?.({}, { hasUI: false });
    await new Promise((resolve) => setImmediate(resolve));

    const result = await registeredTool(api, "mcp").execute(
      "call-1", { search: "demo" }, undefined, undefined, { hasUI: false },
    );
    const text = result.content[0].text;

    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(text).not.toBe("MCP not initialized");
    expect(text).toContain("retry boom");
    expect(text).toContain("call mcp(...) again to retry initialization");
    expect(result.details).toEqual({ error: "init_failed", message: "retry boom" });
    expect(mocks.executeSearch).not.toHaveBeenCalled();
  });

  it("does not turn a shutdown-aborted initialization into retry guidance", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    const initializing = createDeferred<any>();
    mocks.initializeMcp.mockReturnValue(initializing.promise);

    const { api, handlers } = await loadAdapter();

    await handlers.get("session_start")?.({}, { hasUI: false });

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    const resultPromise = proxyTool.execute("call-1", { search: "demo" }, undefined, undefined, { hasUI: false });

    await handlers.get("session_shutdown")?.();
    initializing.reject(new Error("network down"));

    await expect(resultPromise).rejects.toThrow("network down");
    expect(mocks.executeSearch).not.toHaveBeenCalled();
  });

  it("shuts down OAuth on session_shutdown", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();

    const sessionStart = handlers.get("session_start");
    const sessionShutdown = handlers.get("session_shutdown");

    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    mocks.shutdownOAuth.mockClear();

    await sessionShutdown?.();

    expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(1);
  });

  it("completes current `/mcp-adapter` subcommands and server arguments", async () => {
    mocks.loadMcpConfig
      .mockReturnValueOnce({ mcpServers: {} })
      .mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    const state = createState();
    state.config.mcpServers = {
      github: { command: "github-mcp" },
      gitlab: { command: "gitlab-mcp" },
      notion: { command: "notion-mcp" },
    };
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-adapter")?.[1];
    expect(commandDef.getArgumentCompletions("reconnect ")).toBeNull();

    await handlers.get("session_start")?.({}, { hasUI: false });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));

    expect(commandDef.getArgumentCompletions("").map(({ value }: { value: string }) => value)).toEqual([
      "reconnect",
      "tools",
      "prompts",
      "setup",
      "edit",
      "logout",
      "token",
      "disable",
      "enable",
      "status",
    ]);
    expect(commandDef.getArgumentCompletions("st")).toEqual([
      { value: "status", label: "status — Show server status" },
    ]);
    expect(commandDef.getArgumentCompletions("reconnect ")).toEqual([
      { value: "reconnect github", label: "github" },
      { value: "reconnect gitlab", label: "gitlab" },
      { value: "reconnect notion", label: "notion" },
    ]);
    expect(commandDef.getArgumentCompletions("  logout git")).toEqual([
      { value: "logout github", label: "github" },
      { value: "logout gitlab", label: "gitlab" },
    ]);
    expect(commandDef.getArgumentCompletions("disable git")).toEqual([
      { value: "disable github", label: "github" },
      { value: "disable gitlab", label: "gitlab" },
    ]);
    expect(commandDef.getArgumentCompletions("enable not")).toEqual([
      { value: "enable notion", label: "notion" },
    ]);
// Jev setup is excluded from this build.
    expect(commandDef.getArgumentCompletions("tools anything")).toBeNull();
    expect(api.registerCommand.mock.calls.some((call: any[]) => call[0] === "mcp-reconnect")).toBe(false);
  });

  it("hot-registers prompt commands after live prompt metadata refresh", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    const state = createState();
    state.promptMetadata = new Map();
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();

    await handlers.get("session_start")?.({}, { hasUI: false });
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(state));

    api.registerCommand.mockClear();
    state.promptMetadata.set("demo", [{
      serverName: "demo",
      originalName: "brief",
      commandName: "mcp__demo__brief",
      description: "Brief",
      arguments: [],
    }]);
    state.onToolMetadataUpdated?.("demo", "prompts-list-changed");

    expect(api.registerCommand).toHaveBeenCalledWith("mcp__demo__brief", expect.objectContaining({
      description: expect.stringContaining("Brief"),
      handler: expect.any(Function),
    }));
  });

  it("routes `/mcp setup` to the onboarding flow", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui: { notify: vi.fn() } });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    expect(commandDef).toBeDefined();

    await commandDef.handler("setup", { hasUI: true, ui: { notify: vi.fn() } });

    expect(mocks.openMcpSetup).toHaveBeenCalledWith(state, api, expect.any(Object), undefined, "setup");
  });

  it("routes `/mcp logout <server>` to credential logout", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();

    const ui = { notify: vi.fn() };
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("logout oauth-server", { hasUI: true, ui });

    expect(mocks.logoutServer).toHaveBeenCalledWith("oauth-server", state, expect.any(Object));
  });

  it("writes project-local disabled overrides and rejects unknown servers", async () => {
    const state = createState();
    state.config.mcpServers = { global: { url: "https://example.test/mcp" } };
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();
    await handlers.get("session_start")?.({}, { hasUI: true, cwd: "/tmp/project", ui: { notify: vi.fn() } });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    const ui = { notify: vi.fn() };
    await commandDef.handler("disable global", { hasUI: true, cwd: "/tmp/project", ui });
    expect(mocks.writeProjectServerDisabledOverride).toHaveBeenCalledWith(undefined, "/tmp/project", "global", true);
    await commandDef.handler("disable missing", { hasUI: true, cwd: "/tmp/project", ui });
    expect(ui.notify).toHaveBeenCalledWith("Server \"missing\" not found in effective config", "error");
  });

  it("shows usage for `/mcp logout` without a server", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();

    const ui = { notify: vi.fn() };
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("logout", { hasUI: true, ui });

    expect(mocks.logoutServer).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Usage: /mcp-adapter logout <server>", "error");
  });

  it("triggers core reload after setup changes config", async () => {
    const initialState = createState();
    mocks.initializeMcp.mockResolvedValue(initialState);
    mocks.openMcpSetup.mockResolvedValue({ configChanged: true });

    const { api, handlers } = await loadAdapter();

    const ui = { notify: vi.fn() };
    const reload = vi.fn().mockResolvedValue(undefined);
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("setup", { hasUI: true, ui, reload });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    expect(mocks.flushMetadataCache).not.toHaveBeenCalledWith(initialState);
  });

  it("opens the auth picker for `/mcp-auth` without args in UI sessions", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { api, handlers } = await loadAdapter();

    const ui = { notify: vi.fn() };
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    await commandDef.handler("", { hasUI: true, ui });

    expect(mocks.openMcpAuthPanel).toHaveBeenCalledWith(state, api, expect.any(Object), undefined);
    expect(mocks.authenticateServer).not.toHaveBeenCalled();
  });

  it("reconnects after explicit `/mcp-auth <server>` succeeds", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.authenticateServer.mockResolvedValue({ ok: true });

    const { api, handlers } = await loadAdapter();

    const ui = { notify: vi.fn() };
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    await commandDef.handler("github", { hasUI: true, ui });

    expect(mocks.authenticateServer).toHaveBeenCalledWith(
      "github",
      state.config,
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.reconnectServer).toHaveBeenCalledWith(state, expect.any(Object), "github");
    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
  });

  it("does not reconnect after explicit `/mcp-auth <server>` fails", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.authenticateServer.mockResolvedValue({ ok: false });

    const { api, handlers } = await loadAdapter();

    const ui = { notify: vi.fn() };
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    await commandDef.handler("github", { hasUI: true, ui });

    expect(mocks.authenticateServer).toHaveBeenCalledWith(
      "github",
      state.config,
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.reconnectServer).not.toHaveBeenCalled();
    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
  });

  it("documents that no-arg `/mcp-auth` has no non-UI picker or command feedback path", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { api } = await loadAdapter();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    await commandDef.handler("", { hasUI: false });

    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
    expect(mocks.authenticateServer).not.toHaveBeenCalled();
  });

  it("stops the runtime when initialization rejects before publishing state", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    mocks.initializeMcp.mockRejectedValue(new Error("init boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { handlers } = await loadAdapter();

    await handlers.get("session_start")?.({}, {});
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.createOAuthRuntime.mock.results[0].value.signal.aborted).toBe(true);
  });

  it("rolls back commit registrations when registerTool synchronously shuts down the session", async () => {
    mocks.resolveDirectTools
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValue([directToolSpec]);
    const initializedState = createState();
    const initializedConfig = { mcpServers: { demo: { command: "demo", directTools: true } } };
    initializedState.sessionMetadata = new Map([["demo", {
      configHash: computeServerHash(initializedConfig.mcpServers.demo),
      tools: [{ name: "search" }],
      resources: [],
    }]]);
    mocks.loadMcpConfig.mockReturnValue(initializedConfig);
    mocks.initializeMcp.mockResolvedValue(initializedState);

    const { api, handlers } = await loadAdapter();
    let shutdown: Promise<unknown> | undefined;
    api.registerTool.mockImplementation((tool: { name: string }) => {
      if (tool.name === "demo_search" && !shutdown) {
        shutdown = Promise.resolve(handlers.get("session_shutdown")?.());
      }
    });

    await handlers.get("session_start")?.({}, { hasUI: false });
    await vi.waitFor(() => expect(shutdown).toBeDefined());
    await shutdown;
    await vi.waitFor(() => expect(initializedState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1));

    expect(api.unregisterTool).toHaveBeenCalledWith("demo_search");
    expect(mocks.updateStatusBar).not.toHaveBeenCalledWith(initializedState);
  });

  it("stops commit after a UI callback synchronously shuts down the session", async () => {
    mocks.resolveDirectTools
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValue([directToolSpec]);
    const initializedState = createState();
    const initializedConfig = { mcpServers: { demo: { command: "demo", directTools: true } } };
    initializedState.sessionMetadata = new Map([["demo", {
      configHash: computeServerHash(initializedConfig.mcpServers.demo),
      tools: [{ name: "search" }],
      resources: [],
    }]]);
    mocks.loadMcpConfig.mockReturnValue(initializedConfig);
    mocks.initializeMcp.mockResolvedValue(initializedState);

    const { api, handlers } = await loadAdapter();
    let shutdown: Promise<unknown> | undefined;
    const ui = {
      notify: vi.fn(() => {
        shutdown ??= Promise.resolve(handlers.get("session_shutdown")?.());
      }),
    };

    await handlers.get("session_start")?.({}, { hasUI: true, ui });
    await vi.waitFor(() => expect(shutdown).toBeDefined());
    await shutdown;
    await vi.waitFor(() => expect(initializedState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1));

    expect(api.unregisterTool).toHaveBeenCalledWith("demo_search");
    expect(mocks.updateStatusBar).not.toHaveBeenCalledWith(initializedState);
  });

  it("does not let a status callback's synchronous session replacement retain stale commit state", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    const staleState = createState();
    const replacementState = createState();
    mocks.initializeMcp.mockResolvedValueOnce(staleState).mockResolvedValueOnce(replacementState);

    const { api, handlers } = await loadAdapter();
    let replacement: Promise<unknown> | undefined;
    mocks.updateStatusBar.mockImplementationOnce(() => {
      replacement = Promise.resolve(handlers.get("session_start")?.({}, { hasUI: false, cwd: "/replacement" }));
    });

    await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/stale" });
    await vi.waitFor(() => expect(replacement).toBeDefined());
    await replacement;
    await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(replacementState));

    expect(staleState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    const gateway = registeredTool(api, "mcp");
    mocks.executeStatus.mockReturnValue({ content: [{ type: "text", text: "replacement" }] });
    await expect(gateway.execute("current", {}, undefined, undefined, { hasUI: false }))
      .resolves.toEqual({ content: [{ type: "text", text: "replacement" }] });
    expect(mocks.executeStatus).toHaveBeenCalledWith(replacementState);
  });

  it.each(["session_start", "session_shutdown"])("publishes one shutdown status when status finalization reentrantly triggers %s", async (eventName) => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    const firstState = createState();
    const replacementState = createState();
    if (eventName === "session_start") {
      mocks.initializeMcp.mockResolvedValueOnce(firstState).mockResolvedValueOnce(replacementState);
    } else {
      mocks.initializeMcp.mockResolvedValueOnce(firstState);
    }

    const { api, handlers } = await loadAdapter();
    let reentrant: Promise<unknown> | undefined;
    mocks.updateStatusBar.mockImplementationOnce(() => {
      reentrant = Promise.resolve(handlers.get(eventName)?.({}, { hasUI: false }));
    });

    const starting = Promise.resolve(handlers.get("session_start")?.({}, { hasUI: false }));
    api.events.emit.mockClear();
    await starting;
    await vi.waitFor(() => expect(reentrant).toBeDefined());
    await reentrant;
    if (eventName === "session_start") {
      await vi.waitFor(() => expect(mocks.updateStatusBar).toHaveBeenCalledWith(replacementState));
    }

    expect(api.events.emit).toHaveBeenCalledTimes(1);
    expect(api.events.emit).toHaveBeenCalledWith(MCP_STATUS_EVENT, expect.objectContaining({ connectedCount: 0 }));
  });

  it("logs initialization errors when updateStatusBar throws", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo" } } });
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.updateStatusBar.mockImplementation(() => {
      throw new Error("status boom");
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { handlers } = await loadAdapter();
    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");

    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    expect(consoleError).toHaveBeenCalledWith("MCP initialization failed: status boom");
  });

  it("registers a tool_result handler that re-flags returned MCP tool failures (and leaves other results alone)", async () => {
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const toolResult = handlers.get("tool_result");
    expect(toolResult).toBeDefined();

    // server returned an error result (direct path) -> tagged tool_error
    expect(toolResult?.({ details: { error: "tool_error", server: "demo" } })).toEqual({ isError: true });
    // the call itself threw and was caught (proxy path) -> tagged call_failed
    expect(toolResult?.({ details: { mode: "call", error: "call_failed", message: "boom" } })).toEqual({ isError: true });
    expect(toolResult?.({ details: { mode: "call", error: "input_required_needs_ui", server: "demo" } })).toEqual({ isError: true });
    expect(toolResult?.({
      details: { mode: "script", calls: [{ path: "demo_needs_ui", ok: false, error: "input_required_needs_ui" }] },
    })).toEqual({ isError: true });
    // a precondition code is not a tool-execution failure -> left untouched
    expect(toolResult?.({ details: { error: "auth_required", server: "demo" } })).toBeUndefined();
  });
});

describe("directTools: \"search\" — registered inactive, activated by search or a proxy call", () => {
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
  beforeEach(() => {
    delete process.env.MCP_DIRECT_TOOLS;
    vi.resetModules();
    vi.doUnmock("typebox");
    for (const value of Object.values(mocks)) {
      if (typeof value === "function" && "mockReset" in value) value.mockReset();
    }
    mocks.cloneMcpConfig.mockImplementation((config: unknown) => structuredClone(config));
    mocks.resolveConfiguredClaudePluginMcp.mockImplementation((config: unknown) => structuredClone(config));
    mocks.getLegacyMcpMigrationNotices.mockReturnValue([]);
    mocks.discoverConfiguredClaudePluginSkills.mockReturnValue([]);
    mocks.createOAuthRuntime.mockImplementation((signal: AbortSignal) => ({ signal }));
    mocks.initializeOAuth.mockResolvedValue(undefined);
    mocks.shutdownOAuth.mockResolvedValue(undefined);
    mocks.buildProxyDescription.mockReturnValue("MCP gateway");
    mocks.createDirectToolExecutor.mockImplementation(() => vi.fn(async () => ({ content: [] })));
    mocks.prepareDirectToolArguments.mockImplementation((_schema: unknown, args: unknown) => args);
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue([]);
    mocks.normalizeDirectToolInputSchema.mockImplementation((schema: unknown) => schema ?? { type: "object", properties: {} });
    mocks.truncateAtWord.mockImplementation((text: string) => text);
    mocks.loadMetadataCache.mockReturnValue({ servers: { demo: { tools: [], resources: [] } } });
  });
  afterEach(() => {
    if (originalDirectTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
    else process.env.MCP_DIRECT_TOOLS = originalDirectTools;
  });

  const lazySpec = (name: string) => ({ lazy: true, serverName: "demo", originalName: name, prefixedName: `demo_${name}`, description: `${name} tool` });
  const searchResult = (...names: string[]) => ({
    content: [
      { type: "text", text: `Found ${names.length}` },
      { type: "text", text: "Query: q" },
    ],
    details: { mode: "search", matches: names.map((tool) => ({ server: "demo", tool: `demo_${tool}`, score: 1 })), count: names.length, hasMore: false, nextOffset: null, query: "q" },
  });

  async function boot(settings: Record<string, unknown> = {}, specs = [lazySpec("alpha"), lazySpec("beta"), lazySpec("gamma"), lazySpec("delta")]) {
    const config = { settings: { scriptMode: false, ...settings }, mcpServers: { demo: { command: "demo", directTools: "search" } } };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools.mockReturnValue(specs);
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    let actionMethodsReady = false;
    api.getActiveTools.mockImplementation(() => {
      if (!actionMethodsReady) throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
      return activeTools();
    });
    mcpAdapter(api);
    const activeToolsBeforeSession = activeTools();
    actionMethodsReady = true;
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();
    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    return { api, handlers, activeTools, activeToolsBeforeSession, proxyTool };
  }

  it("holds registered lazy tools at session start", async () => {
    const { activeTools, activeToolsBeforeSession } = await boot();
    expect(activeToolsBeforeSession).toEqual(expect.arrayContaining(["demo_alpha", "demo_beta"]));
    expect(activeTools()).toEqual(["bash", "mcp"]);
  });

  it("re-holds unsearched tools reactivated before a request", async () => {
    const { api, handlers, activeTools } = await boot();
    api.setActiveTools([...activeTools(), "demo_alpha"]);
    await handlers.get("before_agent_start")?.({}, {});
    expect(activeTools()).toEqual(["bash", "mcp"]);
  });

  it("keeps the gateway when disableProxyTool is set, or search-mode tools can never be activated", async () => {
    const { activeTools, proxyTool } = await boot({ disableProxyTool: true });
    expect(activeTools()).toContain("mcp");
    expect(proxyTool).toBeDefined();
  });

  it("keeps search activations until the next session", async () => {
    const { handlers, activeTools, proxyTool } = await boot();
    mocks.executeSearch.mockReturnValue(searchResult("alpha", "gamma"));
    const result = await proxyTool.execute("call-1", { search: "q" });
    expect(activeTools()).toEqual(["bash", "mcp", "demo_alpha", "demo_gamma"]);
    expect(result.addedToolNames).toEqual(["demo_alpha", "demo_gamma"]);
    expect(result.content[0].text).toContain("Activated as direct tools: demo_alpha, demo_gamma");
    expect(result.content[0].text).toContain("Found 2"); // the search text is kept
    expect(result.content).toEqual([{ type: "text", text: "Activated as direct tools: demo_alpha, demo_gamma.\n\nFound 2\nQuery: q" }]);
    expect(result.details).toEqual({
      mode: "search",
      matches: [
        { server: "demo", tool: "demo_alpha", score: 1 },
        { server: "demo", tool: "demo_gamma", score: 1 },
      ],
      count: 2,
      hasMore: false,
      nextOffset: null,
      query: "q",
      activated: ["demo_alpha", "demo_gamma"],
    });
    await handlers.get("before_agent_start")?.({}, {});
    expect(activeTools()).toEqual(["bash", "mcp", "demo_alpha", "demo_gamma"]);
    await handlers.get("session_start")?.({}, {});
    expect(activeTools()).toEqual(["bash", "mcp"]);
  });

  it("does not let a search from a replaced session reactivate tools", async () => {
    const { handlers, activeTools, proxyTool } = await boot();
    const pendingSearch = createDeferred<ReturnType<typeof searchResult>>();
    mocks.executeSearch.mockReturnValue(pendingSearch.promise);
    const execution = proxyTool.execute("call-1", { search: "q" });
    await vi.waitFor(() => expect(mocks.executeSearch).toHaveBeenCalledOnce());

    await handlers.get("session_start")?.({}, {});
    pendingSearch.resolve(searchResult("alpha"));

    await expect(execution).rejects.toThrow("MCP extension session restarted");
    expect(activeTools()).toEqual(["bash", "mcp"]);
  });

  it("a search-mode tool selected eagerly becomes active, even if search never activated it", async () => {
    const { activeTools, proxyTool } = await boot({ freezeDirectTools: false });
    expect(activeTools()).toEqual(["bash", "mcp"]);
    mocks.resolveDirectTools.mockReturnValue([{ ...lazySpec("alpha"), lazy: false }, lazySpec("gamma")]);
    mocks.executeConnect.mockResolvedValue({ content: [{ type: "text", text: "connected" }] });
    await proxyTool.execute("call-1", { connect: "demo" });
    expect(activeTools()).toEqual(["bash", "mcp", "demo_alpha"]);
    mocks.executeSearch.mockReturnValue(searchResult("alpha", "gamma"));
    const search = await proxyTool.execute("call-3", { search: "q" });
    expect(activeTools()).toEqual(["bash", "mcp", "demo_alpha", "demo_gamma"]);
    expect(search.addedToolNames).toEqual(["demo_gamma"]);
  });

  it("an eager direct tool switched to search mode is held again until a search matches it", async () => {
    const { activeTools, proxyTool } = await boot({ freezeDirectTools: false }, [{ ...lazySpec("alpha"), lazy: false }]);
    expect(activeTools()).toEqual(["bash", "mcp", "demo_alpha"]);
    mocks.resolveDirectTools.mockReturnValue([lazySpec("alpha")]);
    mocks.executeConnect.mockResolvedValue({ content: [{ type: "text", text: "connected" }] });
    await proxyTool.execute("call-1", { connect: "demo" });
    expect(activeTools()).toEqual(["bash", "mcp"]);
    mocks.executeSearch.mockReturnValue(searchResult("alpha"));
    const search = await proxyTool.execute("call-2", { search: "q" });
    expect(activeTools()).toEqual(["bash", "mcp", "demo_alpha"]);
    expect(search.addedToolNames).toEqual(["demo_alpha"]);
  });

  it("a search that matches only already-active tools reports no additions", async () => {
    const { activeTools, proxyTool } = await boot();
    mocks.executeSearch.mockReturnValue(searchResult("alpha"));
    await proxyTool.execute("c1", { search: "q" });
    const plain = searchResult("alpha");
    mocks.executeSearch.mockReturnValue(plain);
    const again = await proxyTool.execute("c2", { search: "q" });
    expect(again).toBe(plain);
    expect(again.addedToolNames).toBeUndefined();
    expect(activeTools()).toEqual(["bash", "mcp", "demo_alpha"]);
  });

  const callResult = (details: Record<string, unknown>) => ({ content: [{ type: "text", text: "ok" }], details: { mode: "call", ...details } });

  it("a successful proxy call for a held tool activates it and reports it as addedToolNames", async () => {
    const { handlers, activeTools, proxyTool } = await boot();
    mocks.executeCall.mockResolvedValue(callResult({ server: "demo", tool: "alpha", canonicalTool: "demo_alpha" }));
    const result = await proxyTool.execute("call-1", { tool: "demo_alpha", args: {} });
    expect(activeTools()).toEqual(["bash", "mcp", "demo_alpha"]);
    expect(result.addedToolNames).toEqual(["demo_alpha"]);
    // The call's output comes back untouched (already sized to the output limits).
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(result.details.activated).toEqual(["demo_alpha"]);
    // Calling an already-active tool through the proxy changes nothing.
    const again = await proxyTool.execute("call-2", { tool: "demo_alpha", args: {} });
    expect(again.addedToolNames).toBeUndefined();
    // Same lifetime as a search hit: kept across turns, cleared by the next session.
    await handlers.get("before_agent_start")?.({}, {});
    expect(activeTools()).toEqual(["bash", "mcp", "demo_alpha"]);
    await handlers.get("session_start")?.({}, {});
    expect(activeTools()).toEqual(["bash", "mcp"]);
  });

  it("a proxy call for a held resource reader activates it", async () => {
    const reader = { ...lazySpec("read_notes"), resourceUri: "file:///notes.md" };
    const { activeTools, proxyTool } = await boot({}, [reader, lazySpec("beta")]);
    mocks.executeCall.mockResolvedValue(callResult({ server: "demo", resourceUri: "file:///notes.md", canonicalTool: "demo_read_notes" }));
    const result = await proxyTool.execute("call-1", { tool: "demo_read_notes", args: {} });
    expect(activeTools()).toEqual(["bash", "mcp", "demo_read_notes"]);
    expect(result.addedToolNames).toEqual(["demo_read_notes"]);
  });

  it.each([
    ["tool_not_found", { error: "tool_not_found", requestedTool: "demo_alpha" }],
    ["a tool error", { error: "tool_error", server: "demo", tool: "alpha", canonicalTool: "demo_alpha" }],
    ["an approval denial", { error: "approval_denied", server: "demo", tool: "alpha", canonicalTool: "demo_alpha" }],
  ])("a proxy call that fails with %s activates nothing", async (_label, details) => {
    const { activeTools, proxyTool } = await boot();
    mocks.executeCall.mockResolvedValue(callResult(details));
    const result = await proxyTool.execute("call-1", { tool: "demo_alpha", args: {} });
    expect(activeTools()).toEqual(["bash", "mcp"]);
    expect(result.addedToolNames).toBeUndefined();
  });

  it("a proxy call naming another server's tool activates nothing", async () => {
    const { activeTools, proxyTool } = await boot();
    mocks.executeCall.mockResolvedValue(callResult({ server: "other", tool: "alpha", canonicalTool: "demo_alpha" }));
    const result = await proxyTool.execute("call-1", { tool: "demo_alpha", args: {} });
    expect(activeTools()).toEqual(["bash", "mcp"]);
    expect(result.addedToolNames).toBeUndefined();
  });

  it("does not let a proxy call from a replaced session activate tools", async () => {
    const { handlers, activeTools, proxyTool } = await boot();
    const pendingCall = createDeferred<ReturnType<typeof callResult>>();
    mocks.executeCall.mockReturnValue(pendingCall.promise);
    const execution = proxyTool.execute("call-1", { tool: "demo_alpha", args: {} });
    await vi.waitFor(() => expect(mocks.executeCall).toHaveBeenCalledOnce());

    await handlers.get("session_start")?.({}, {});
    pendingCall.resolve(callResult({ server: "demo", tool: "alpha", canonicalTool: "demo_alpha" }));

    await expect(execution).rejects.toThrow("MCP extension session restarted");
    expect(activeTools()).toEqual(["bash", "mcp"]);
  });

  it("connect does not report held-inactive search-mode tools as loaded", async () => {
    const config = { settings: { scriptMode: false }, mcpServers: { demo: { url: "https://demo.example/mcp", directTools: "search" } } };
    const state = createState();
    let catalogAvailable = false;
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools.mockImplementation(() => catalogAvailable ? [lazySpec("alpha"), lazySpec("beta")] : []);
    mocks.initializeMcp.mockResolvedValue(state);
    const connectResult = { content: [{ type: "text", text: "connected" }], details: { mode: "connect" } };
    mocks.executeConnect.mockImplementation(async (currentState: any) => {
      // The live catalog becomes available only because this connect completed.
      catalogAvailable = true;
      currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
      return connectResult;
    });
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    const activeTools = trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();
    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    const result = await proxyTool.execute("call-1", { connect: "demo" }, undefined, undefined, { cwd: "/tmp/project" });
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_alpha" }));
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_beta" }));
    expect(result.addedToolNames).toBeUndefined(); // registration is not loading — search is the load point
    expect(activeTools()).toEqual(["bash", "mcp"]); // registered, held inactive

    mocks.executeSearch.mockReturnValue(searchResult("alpha"));
    const search = await proxyTool.execute("call-2", { search: "q" });
    expect(search.addedToolNames).toEqual(["demo_alpha"]);
    expect(activeTools()).toEqual(["bash", "mcp", "demo_alpha"]);
  });

  it("leaves a search result untouched when no server is in search mode", async () => {
    const config = { mcpServers: { demo: { command: "demo", directTools: true } } };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools.mockReturnValue([{ serverName: "demo", originalName: "alpha", prefixedName: "demo_alpha", description: "alpha" }]);
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    trackRuntimeToolActivation(api, ["bash", "mcp"]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();
    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    const plain = searchResult("alpha");
    mocks.executeSearch.mockReturnValue(plain);
    expect(await proxyTool.execute("c1", { search: "q" })).toBe(plain);
  });

  it("registers search-mode tools as plain direct tools without Pi 0.99's registerMcpServer", async () => {
    const { api } = await boot();
    expect(Object.keys(registeredTool(api, "demo_alpha"))).toEqual(
      ["name", "label", "description", "promptSnippet", "parameters", "execute", "renderShell", "renderCall", "renderResult"],
    );
  });

  describe("on Pi 0.99+, as Pi deferred tools", () => {
    const searchConfig = { settings: { scriptMode: false }, mcpServers: { demo: { command: "demo", directTools: "search" } } };

    // Pi 0.99: registering a direct tool activates it, a deferred one stays inactive, and a hidden one leaves the active set.
    function trackPiToolExposure(api: any): () => string[] {
      const exposures = new Map([["bash", "direct"], ["mcp", "direct"]]);
      let active = ["bash", "mcp"];
      api.registerTool.mockImplementation((tool: { name: string; exposure?: string }) => {
        const known = exposures.has(tool.name);
        const exposure = tool.exposure ?? "direct";
        exposures.set(tool.name, exposure);
        if (exposure === "hidden") active = active.filter((name) => name !== tool.name);
        else if (!known && exposure === "direct") active.push(tool.name);
      });
      api.getActiveTools.mockImplementation(() => [...active]);
      api.setActiveTools.mockImplementation((next: string[]) => {
        active = next.filter((name) => exposures.has(name) && exposures.get(name) !== "hidden");
      });
      return () => [...active];
    }

    async function bootPi099(specs?: unknown[], config: Record<string, any> = searchConfig, mirrorRegisteredTools = false) {
      if (specs) mocks.resolveDirectTools.mockReturnValue(specs);
      const state = createState();
      state.config = config;
      mocks.loadMcpConfig.mockReturnValue(config);
      mocks.initializeMcp.mockResolvedValue(state);
      const { default: mcpAdapter } = await import("../index.ts");
      const { api, handlers } = createPi({ unregisterTool: false });
      api.registerMcpServer = vi.fn();
      api.getMcpServers = vi.fn(() => []);
      if (mirrorRegisteredTools) {
        api.getAllTools.mockImplementation(() => api.registerTool.mock.calls.map((call: any[]) => call[0]));
      }
      const activeTools = trackPiToolExposure(api);
      mcpAdapter(api);
      await handlers.get("session_start")?.({}, {});
      await Promise.resolve();
      await Promise.resolve();
      return { api, handlers, activeTools, proxyTool: registeredTool(api, "mcp") };
    }

    async function installPi099() {
      const { default: mcpAdapter } = await import("../index.ts");
      const { api, handlers } = createPi({ unregisterTool: false });
      api.registerMcpServer = vi.fn();
      api.getMcpServers = vi.fn(() => []);
      const activeTools = trackPiToolExposure(api);
      mcpAdapter(api);
      return { api, handlers, activeTools };
    }

    function assertDeferredCallToolResult(tool: any, result: any, isError: boolean) {
      expect(tool.outputSchema).toMatchObject({
        type: "object",
        properties: {
          content: { type: "array", items: { type: "object" } },
          isError: { type: "boolean" },
          _meta: { type: "object" },
        },
        required: ["content"],
      });
      expect(result.structuredContent).toHaveProperty("content", result.content);
      if (isError) expect(result.structuredContent).toHaveProperty("isError", true);
      else expect(result.structuredContent).not.toHaveProperty("isError");
      const parsed = CallToolResultSchema.parse(result.structuredContent);
      expect(parsed.content).toEqual(result.content);
      expect(parsed.isError).toBe(isError ? true : undefined);
    }

    it("registers search-mode tools inactive and deferred, with their server's namespace, annotations and a CallToolResult output schema", async () => {
      const { resolveDirectTools } = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
      mocks.resolveDirectTools.mockImplementation(resolveDirectTools);
      const docs = { command: "docs", directTools: "search", description: " Team docs " };
      const proxyOnly = { command: "other" };
      const rowsSchema = { type: "object", properties: { rows: { type: "array" } } };
      mocks.loadMetadataCache.mockReturnValue({
        version: 1,
        servers: {
          "team-docs": cacheEntry(docs, {
            instructions: "Search before reading.",
            tools: [{ name: "find", description: "Find docs", outputSchema: rowsSchema, annotations: { title: "Find", readOnlyHint: true } }],
          }),
          other: cacheEntry(proxyOnly, { tools: [{ name: "run" }] }),
        },
      });

      const { api, activeTools } = await bootPi099(undefined, { settings: { scriptMode: false }, mcpServers: { "team-docs": docs, other: proxyOnly } });

      const names = api.registerTool.mock.calls.map((call: any[]) => call[0].name);
      expect(names).toContain("team-docs_find");
      expect(names).not.toContain("other_run"); // the proxy-only server's tools stay behind the proxy
      expect(registeredTool(api, "team-docs_find")).toMatchObject({
        exposure: "deferred",
        namespace: { name: "mcp__team_docs", description: "Team docs", instructions: "Search before reading." },
        annotations: { readOnlyHint: true },
        outputSchema: {
          type: "object",
          properties: {
            content: { type: "array", items: { type: "object" } },
            structuredContent: rowsSchema,
            isError: { type: "boolean" },
            _meta: { type: "object" },
          },
          required: ["content"],
        },
      });
      expect(registeredTool(api, "team-docs_find").annotations).not.toHaveProperty("title");
      expect(activeTools()).not.toContain("team-docs_find");
    });

    it("declares none of the tools a lazy search-mode server registers when it connects", async () => {
      const { api, activeTools, proxyTool } = await bootPi099([]);
      api.setActiveTools.mockClear();
      const { resolveDirectTools } = await vi.importActual<typeof import("../direct-tool-surface.ts")>("../direct-tool-surface.ts");
      const definition = searchConfig.mcpServers.demo;
      mocks.loadMetadataCache.mockReturnValue({
        version: 1,
        servers: {
          demo: {
            configHash: computeServerHash(definition, process.cwd()),
            cachedAt: Date.now(),
            resources: [],
            tools: [
              { name: "alpha", description: "alpha tool" },
              { name: "beta", description: "beta tool" },
            ],
          },
        },
      });
      mocks.resolveDirectTools.mockImplementation(resolveDirectTools);
      mocks.executeConnect.mockImplementation(async (currentState: any) => {
        // proxy-modes.ts emits this notification after its live metadata update.
        await currentState.onToolMetadataUpdated?.("demo", "proxy-connect");
        return { content: [{ type: "text", text: "connected" }] };
      });

      const result = await proxyTool.execute("c1", { connect: "demo" });

      expect(result).not.toHaveProperty("addedToolNames");
      expect(registeredTool(api, "demo_alpha")).toMatchObject({ exposure: "deferred" });
      expect(api.setActiveTools).not.toHaveBeenCalled();
      expect(activeTools()).toEqual(["bash", "mcp"]);
    });

    it("leaves activation to Pi: a tool_search activation survives the next request and a resume", async () => {
      const { api, handlers, activeTools, proxyTool } = await bootPi099([lazySpec("alpha"), lazySpec("beta")]);
      api.setActiveTools([...activeTools(), "demo_alpha"]); // what tool_search does

      await handlers.get("before_agent_start")?.({}, {});
      await handlers.get("session_start")?.({}, {}); // Pi restores the branch's active tools on resume
      await Promise.resolve();
      await Promise.resolve();
      expect(activeTools()).toEqual(["bash", "mcp", "demo_alpha"]);

      mocks.executeSearch.mockReturnValue(searchResult("beta"));
      const search = await proxyTool.execute("c1", { search: "q" });
      expect(search.addedToolNames).toEqual(["demo_beta"]);
      expect(activeTools()).toEqual(["bash", "mcp", "demo_alpha", "demo_beta"]);
    });

    it("re-registers a search-mode tool that no longer resolves as hidden, since Pi can't unregister it", async () => {
      const rowsSchema = { type: "object", properties: { rows: { type: "number" } } };
      mocks.loadMetadataCache.mockReturnValue({
        version: 1,
        servers: {
          demo: {
            tools: [{
              name: "alpha",
              outputSchema: rowsSchema,
              annotations: { title: "Alpha", readOnlyHint: true },
            }],
            resources: [],
          },
        },
      });
      const { api, activeTools, proxyTool } = await bootPi099([lazySpec("alpha"), lazySpec("beta")], {
        settings: { ...searchConfig.settings, freezeDirectTools: false },
        mcpServers: { demo: { ...searchConfig.mcpServers.demo } },
      }, true);
      api.setActiveTools([...activeTools(), "demo_alpha"]);
      // Its server was disabled or removed, or includeTools/excludeTools now filter it out.
      mocks.resolveDirectTools.mockReturnValue([lazySpec("beta")]);
      mocks.executeConnect.mockResolvedValue({ content: [{ type: "text", text: "connected" }] });

      await proxyTool.execute("c1", { connect: "demo" });

      const alpha = api.registerTool.mock.calls.filter((call: any[]) => call[0].name === "demo_alpha").map((call: any[]) => call[0]);
      const original = alpha[0];
      const hidden = alpha.at(-1);
      expect(original).toBeDefined();
      expect(hidden).toMatchObject({
        name: "demo_alpha",
        label: "MCP: alpha",
        description: "alpha tool",
        promptSnippet: "alpha tool",
        parameters: original.parameters,
        exposure: "hidden",
        namespace: original.namespace,
        outputSchema: original.outputSchema,
        annotations: original.annotations,
        renderShell: original.renderShell,
        renderCall: original.renderCall,
        renderResult: original.renderResult,
        execute: original.execute,
      });
      expect(hidden?.namespace).toEqual({ name: "mcp__demo" });
      expect(hidden?.annotations).toEqual({ readOnlyHint: true });
      expect(hidden?.outputSchema).toEqual({
        type: "object",
        properties: {
          content: { type: "array", items: { type: "object" } },
          structuredContent: rowsSchema,
          isError: { type: "boolean" },
          _meta: { type: "object" },
        },
        required: ["content"],
      });
      expect(hidden).not.toBe(original);
      expect(registeredTool(api, "demo_beta")).toMatchObject({ exposure: "deferred" });
      expect(activeTools()).toEqual(["bash", "mcp"]);
    });

    it("switches an eager direct tool off once when its server moves to search mode", async () => {
      const { activeTools, proxyTool } = await bootPi099([{ ...lazySpec("alpha"), lazy: false }], {
        settings: { ...searchConfig.settings, freezeDirectTools: false },
        mcpServers: { demo: { ...searchConfig.mcpServers.demo } },
      });
      expect(activeTools()).toEqual(["bash", "mcp", "demo_alpha"]);
      mocks.resolveDirectTools.mockReturnValue([lazySpec("alpha")]);
      mocks.executeConnect.mockResolvedValue({ content: [{ type: "text", text: "connected" }] });

      await proxyTool.execute("c1", { connect: "demo" });

      expect(activeTools()).toEqual(["bash", "mcp"]);
    });

    it("returns every result of a deferred tool to codemode scripts as an SDK CallToolResult", async () => {
      const text = (value: string) => [{ type: "text", text: value }];
      const outputSchema = { type: "object", properties: { rows: { type: "number" } } };
      const definition = searchConfig.mcpServers.demo;
      mocks.loadMetadataCache.mockReturnValue({
        version: 1,
        servers: { demo: cacheEntry(definition, { tools: [{ name: "alpha", outputSchema }] }) },
      });
      const executor = vi.fn()
        .mockResolvedValueOnce({ content: text("7 rows"), details: { server: "demo" }, structuredContent: { rows: 7 } })
        .mockResolvedValueOnce({ content: text("Error: boom"), details: { error: "tool_error", server: "demo" } })
        .mockResolvedValueOnce({ content: text("MCP initialization failed: retry"), details: { error: "init_failed", message: "retry" } });
      mocks.createDirectToolExecutor.mockReturnValue(executor);
      const { api } = await bootPi099([lazySpec("alpha")]);
      const tool = registeredTool(api, "demo_alpha");
      const ctx = { hasUI: false, cwd: "/one" };

      const ok = await tool.execute("c1", {}, undefined, undefined, ctx);
      const failed = await tool.execute("c2", {}, undefined, undefined, ctx);
      const initFailed = await tool.execute("c3", {}, undefined, undefined, ctx);

      expect(ok).toMatchObject({ content: text("7 rows"), structuredContent: { content: text("7 rows"), structuredContent: { rows: 7 } } });
      assertDeferredCallToolResult(tool, ok, false);
      expect(failed).toMatchObject({ content: text("Error: boom"), details: { error: "tool_error" } });
      assertDeferredCallToolResult(tool, failed, true);
      expect(initFailed).toMatchObject({ content: text("MCP initialization failed: retry"), details: { error: "init_failed" } });
      assertDeferredCallToolResult(tool, initFailed, true);
      expect(mocks.createDirectToolExecutor).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), expect.objectContaining({ prefixedName: "demo_alpha" }), true);
      expect(executor).toHaveBeenNthCalledWith(1, "c1", {}, undefined, undefined, ctx);
      expect(executor).toHaveBeenNthCalledWith(2, "c2", {}, undefined, undefined, ctx);
      expect(executor).toHaveBeenNthCalledWith(3, "c3", {}, undefined, undefined, ctx);
    });

    it("wraps a deferred initialization failure returned by the registered tool", async () => {
      const outputSchema = { type: "object", properties: { rows: { type: "number" } } };
      const definition = { command: "demo", directTools: "search" };
      const config = { settings: { scriptMode: false }, mcpServers: { demo: definition } };
      mocks.loadMcpConfig.mockReturnValue(config);
      mocks.loadMetadataCache.mockReturnValue({
        version: 1,
        servers: { demo: cacheEntry(definition, { tools: [{ name: "alpha", outputSchema }] }) },
      });
      mocks.resolveDirectTools.mockReturnValue([lazySpec("alpha")]);
      mocks.initializeMcp.mockRejectedValue(new Error("boom-init"));
      const { api, handlers } = await installPi099();
      await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/one" });

      const tool = registeredTool(api, "demo_alpha");
      const result = await tool.execute("init-failed", {}, undefined, undefined, { hasUI: false, cwd: "/one" });

      expect(result).toMatchObject({
        details: { error: "init_failed", server: "demo", message: "boom-init" },
        content: [{ type: "text", text: expect.stringContaining("boom-init") }],
      });
      expect(tool.outputSchema.properties.structuredContent).toEqual(outputSchema);
      assertDeferredCallToolResult(tool, result, true);
    });

    it("wraps a deferred pending initialization deadline without sleeping", async () => {
      const outputSchema = { type: "object", properties: { rows: { type: "number" } } };
      const definition = { command: "demo", directTools: "search" };
      const config = { settings: { scriptMode: false }, mcpServers: { demo: definition } };
      const initializing = createDeferred<any>();
      const initialized = createState();
      initialized.config = config;
      mocks.loadMcpConfig.mockReturnValue(config);
      mocks.loadMetadataCache.mockReturnValue({
        version: 1,
        servers: { demo: cacheEntry(definition, { tools: [{ name: "alpha", outputSchema }] }) },
      });
      mocks.resolveDirectTools.mockReturnValue([lazySpec("alpha")]);
      mocks.initializeMcp.mockReturnValue(initializing.promise);
      const { api, handlers } = await installPi099();
      await handlers.get("session_start")?.({}, { hasUI: false, cwd: "/one" });
      await vi.waitFor(() => expect(mocks.initializeMcp).toHaveBeenCalledOnce());
      const tool = registeredTool(api, "demo_alpha");

      let result: any;
      vi.useFakeTimers();
      try {
        const execution = tool.execute("pending", {}, undefined, undefined, { hasUI: false, cwd: "/one" });
        await vi.advanceTimersByTimeAsync(30_000);
        result = await execution;
      } finally {
        initializing.resolve(initialized);
        vi.useRealTimers();
      }

      expect(result).toMatchObject({ details: { error: "init_timeout", mode: "direct", timeoutMs: 30_000 } });
      assertDeferredCallToolResult(tool, result, true);
      await handlers.get("session_shutdown")?.();
    });

    it("wraps a deferred runtime execution failure without changing the call signal", async () => {
      const outputSchema = { type: "object", properties: { rows: { type: "number" } } };
      const definition = searchConfig.mcpServers.demo;
      const config = { ...searchConfig, mcpServers: { demo: definition } };
      mocks.loadMetadataCache.mockReturnValue({
        version: 1,
        servers: { demo: cacheEntry(definition, { tools: [{ name: "alpha", outputSchema }] }) },
      });
      const signal = new AbortController().signal;
      const execution = vi.fn(async (_toolCallId: string, _params: Record<string, unknown>, receivedSignal: AbortSignal | undefined) => {
        expect(receivedSignal).toBe(signal);
        throw new Error("transport boom");
      });
      mocks.createDirectToolExecutor.mockReturnValue(execution);
      const { api } = await bootPi099([lazySpec("alpha")], config);
      const tool = registeredTool(api, "demo_alpha");

      const result = await tool.execute("execution-failed", {}, signal, undefined, { hasUI: false, cwd: "/one" });

      expect(result).toMatchObject({
        details: { error: "init_failed", server: "demo", message: "transport boom" },
        content: [{ type: "text", text: expect.stringContaining("transport boom") }],
      });
      expect(execution).toHaveBeenCalledWith("execution-failed", {}, signal, undefined, expect.objectContaining({ hasUI: false, cwd: "/one" }));
      expect(mocks.createDirectToolExecutor).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), expect.objectContaining({ prefixedName: "demo_alpha" }), true);
      assertDeferredCallToolResult(tool, result, true);
    });
  });
});
