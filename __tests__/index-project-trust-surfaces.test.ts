import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeServerHash } from "../metadata-cache.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const managerMocks = vi.hoisted(() => ({
  instances: [] as any[],
  connect: vi.fn(),
}));

vi.mock("../server-manager.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server-manager.ts")>();
  return {
    ...actual,
    McpServerManager: vi.fn().mockImplementation(function (this: any) {
      const connections = new Map<string, any>();
      managerMocks.instances.push(this);
      this.setRuntimeSignal = vi.fn();
      this.setOAuthRuntime = vi.fn();
      this.setDefaultRequestTimeoutMs = vi.fn();
      this.setTraceConfig = vi.fn();
      this.setAuthStorageOptions = vi.fn();
      this.setSamplingConfig = vi.fn();
      this.setElicitationConfig = vi.fn();
      this.setMetadataListChangedListener = vi.fn();
      this.setListenStateChangedListener = vi.fn();
      this.getConnection = vi.fn((name: string) => connections.get(name));
      this.getAllConnections = vi.fn(() => new Map(connections));
      this.isConnecting = vi.fn(() => false);
      this.isIdle = vi.fn(() => false);
      this.ensureListen = vi.fn(async () => {});
      this.refreshTools = vi.fn(async () => "unchanged");
      this.close = vi.fn(async (name: string) => {
        connections.delete(name);
      });
      this.closeAll = vi.fn(async () => {
        connections.clear();
      });
      this.connect = vi.fn(async (name: string, definition: unknown, signal?: AbortSignal) => {
        const connection = await managerMocks.connect(name, definition, signal);
        connections.set(name, connection);
        return connection;
      });
      this.reconnect = vi.fn(async (name: string, definition: unknown, _old: unknown, signal?: AbortSignal) => {
        const connection = await managerMocks.connect(name, definition, signal);
        connections.set(name, connection);
        return connection;
      });
    }),
  };
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function serverConnection(name: string, definition: any): any {
  return {
    client: {},
    transport: {},
    definition,
    tools: [{
      name: "lookup",
      description: `${name} lookup`,
      inputSchema: { type: "object", properties: {} },
    }],
    resources: [],
    prompts: [{ name: "brief", description: `${name} brief`, arguments: [] }],
    lastUsedAt: Date.now(),
    inFlight: 0,
    status: "connected",
    listenState: "ready",
  };
}

function createPi() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  let activeTools = ["bash"];
  const api: any = {
    registerTool: vi.fn((tool: any) => {
      tools.set(tool.name, tool);
      if (tool.exposure !== "hidden" && !activeTools.includes(tool.name)) activeTools.push(tool.name);
    }),
    unregisterTool: vi.fn((name: string) => {
      const removed = tools.delete(name);
      activeTools = activeTools.filter(item => item !== name);
      return removed;
    }),
    registerFlag: vi.fn(),
    registerCommand: vi.fn((name: string, command: unknown) => commands.set(name, command)),
    getFlag: vi.fn(),
    getCommands: vi.fn(() => [...commands.keys()]),
    on: vi.fn((event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler)),
    getAllTools: vi.fn(() => [...tools.values()]),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((next: string[]) => {
      activeTools = [...next];
    }),
    events: { on: vi.fn(), emit: vi.fn() },
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
  return { api, handlers, tools, commands };
}

type Fixture = {
  root: string;
  home: string;
  cwd: string;
  globalDefinition: Record<string, unknown>;
  projectDefinition: Record<string, unknown>;
};

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mcp-index-project-trust-surfaces-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  const globalDefinition = { command: "global-fixture-server", directTools: true };
  const projectDefinition = { command: "project-fixture-server", directTools: true };
  writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), {
    settings: {},
    mcpServers: { global: globalDefinition },
  });
  writeJson(join(cwd, ".mcp.json"), { mcpServers: { project: projectDefinition } });
  writeJson(join(home, ".pi", "agent", "mcp-cache.json"), {
    version: 1,
    servers: {
      global: cachedEntry("global", globalDefinition, cwd),
      project: cachedEntry("project", projectDefinition, cwd),
    },
  });
  return { root, home, cwd, globalDefinition, projectDefinition };
}

function cachedEntry(name: string, definition: Record<string, unknown>, cwd: string): Record<string, unknown> {
  return {
    configHash: computeServerHash(definition as any, cwd),
    cacheScope: "shared",
    cachedAt: Date.now(),
    tools: [{
      name: "lookup",
      description: `${name} cached lookup`,
      inputSchema: { type: "object", properties: {} },
    }],
    resources: [],
    prompts: [{ name: "brief", description: `${name} cached brief`, arguments: [] }],
  };
}

function context(cwd: string, trusted: boolean, hasUI = false): any {
  return {
    cwd,
    hasUI,
    mode: hasUI ? "tui" : "rpc",
    isProjectTrusted: () => trusted,
    ui: {
      select: vi.fn(),
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: undefined,
    },
    modelRegistry: {},
    signal: undefined,
  };
}

async function settleSurface(pi: ReturnType<typeof createPi>, name: string, command: string): Promise<void> {
  await vi.waitFor(() => {
    expect(pi.tools.has(name)).toBe(true);
    expect(pi.commands.has(command)).toBe(true);
  });
}

function statusFor(pi: ReturnType<typeof createPi>, name: string): any {
  for (const [, snapshot] of pi.api.events.emit.mock.calls) {
    const server = snapshot?.servers?.find((entry: any) => entry.name === name);
    if (server) return server;
  }
  return undefined;
}

async function shutdown(pi: ReturnType<typeof createPi>): Promise<void> {
  try {
    await pi.handlers.get("session_shutdown")?.({ type: "session_shutdown" });
  } catch {
    // Cleanup must not hide the assertion that caused the test to fail.
  }
}

describe("production project trust startup surfaces", () => {
  let fixture: Fixture;
  let cwdSpy: { mockRestore(): void } | undefined;

  beforeEach(() => {
    vi.resetModules();
    managerMocks.instances.length = 0;
    managerMocks.connect.mockReset().mockImplementation(async (name: string, definition: unknown) => (
      serverConnection(name, definition)
    ));
    fixture = createFixture();
    vi.stubEnv("HOME", fixture.home);
    vi.stubEnv("PI_PACKAGE_DIR", "");
    vi.stubEnv("PI_CODING_AGENT_DIR", join(fixture.home, ".pi", "agent"));
    vi.stubEnv("PI_MCP_CONFIG_MODE", "merge");
    // Positive controls must register real direct tools even when the command
    // is run under the explicit inherited __none__ validation environment.
    vi.stubEnv("MCP_DIRECT_TOOLS", undefined);
    vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
    vi.stubEnv("PI_MCP_ADAPTER_DISABLE_AUTH_CACHE", "1");
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(fixture.cwd);
  });

  afterEach(async () => {
    for (const instance of managerMocks.instances) await instance.closeAll?.();
    vi.unstubAllEnvs();
    cwdSpy?.mockRestore();
    vi.clearAllMocks();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  async function loadConfigSources(options: { expectNoFilteredServers?: boolean } = {}): Promise<void> {
    const { loadMcpConfigWithSources } = await import("../config.ts");
    const { excludeProjectServersAtLoadTime } = await import("../project-server-trust.ts");
    const loaded = loadMcpConfigWithSources(undefined, fixture.cwd);
    expect(loaded.projectServers.get("project")?.path).toBe(join(fixture.cwd, ".mcp.json"));
    expect(loaded.config.mcpServers.project).toBeDefined();
    const filtered = excludeProjectServersAtLoadTime(loaded);
    expect(filtered.mcpServers.project).toBeUndefined();
    if (options.expectNoFilteredServers) expect(Object.keys(filtered.mcpServers)).toEqual([]);
  }

  function allowProjectServers(): void {
    writeJson(join(fixture.home, ".pi", "agent", "mcp-adapter.json"), {
      settings: { projectServers: "allow" },
      mcpServers: { global: fixture.globalDefinition },
    });
  }

  function configureProjectOnlyApprovedFixture(): void {
    writeJson(join(fixture.home, ".pi", "agent", "mcp-adapter.json"), {
      settings: { projectServers: "allow" },
      mcpServers: {},
    });
    writeJson(join(fixture.home, ".pi", "agent", "mcp-cache.json"), {
      version: 1,
      servers: { project: cachedEntry("project", fixture.projectDefinition, fixture.cwd) },
    });
  }

  async function install(options?: { config?: any }) {
    const adapterModule = await import("../index.ts");
    const pi = createPi();
    if (options) adapterModule.createMcpAdapter(options)(pi.api);
    else adapterModule.default(pi.api);
    return pi;
  }

  it("keeps cached untrusted project tools and prompts invisible through session_start and settling", async () => {
    await loadConfigSources();
    const pi = await install();

    try {
      expect(process.env.MCP_DIRECT_TOOLS).toBeUndefined();
      expect(pi.tools.get("global_lookup")).toMatchObject({ name: "global_lookup", execute: expect.any(Function) });
      expect(pi.tools.has("project_lookup")).toBe(false);
      expect(pi.commands.has("mcp__project__brief")).toBe(false);
      expect(managerMocks.instances).toHaveLength(0);

      await pi.handlers.get("session_start")?.({ type: "session_start" }, context(fixture.cwd, false));
      await vi.waitFor(() => expect(managerMocks.instances, JSON.stringify({ tools: [...pi.tools.keys()], commands: [...pi.commands.keys()] })).toHaveLength(1));
      await vi.waitFor(() => expect(pi.api.events.emit).toHaveBeenCalled());
      expect(statusFor(pi, "project")).toMatchObject({
        status: "blocked",
        blockedReason: expect.stringContaining("project trust"),
      });
      await vi.waitFor(() => {
        expect(pi.tools.has("project_lookup")).toBe(false);
        expect(pi.commands.has("mcp__project__brief")).toBe(false);
      });
      expect(pi.tools.has("global_lookup")).toBe(true);
      expect(pi.commands.has("mcp__global__brief")).toBe(true);
      expect(managerMocks.connect).not.toHaveBeenCalledWith("project", expect.anything(), expect.anything());
    } finally {
      await shutdown(pi);
    }
  });

  it("keeps a trusted but headless approval-required project invisible after real trust resolution", async () => {
    await loadConfigSources();
    const pi = await install();

    try {
      expect(pi.tools.has("project_lookup")).toBe(false);
      expect(pi.commands.has("mcp__project__brief")).toBe(false);
      await pi.handlers.get("session_start")?.({ type: "session_start" }, context(fixture.cwd, true));
      await vi.waitFor(() => expect(managerMocks.instances, JSON.stringify({ tools: [...pi.tools.keys()], commands: [...pi.commands.keys()] })).toHaveLength(1));
      await vi.waitFor(() => expect(pi.api.events.emit).toHaveBeenCalled());
      expect(statusFor(pi, "project")).toMatchObject({
        status: "blocked",
        blockedReason: expect.stringContaining("approval required"),
      });
      await vi.waitFor(() => {
        expect(pi.tools.has("project_lookup")).toBe(false);
        expect(pi.commands.has("mcp__project__brief")).toBe(false);
      });
      expect(managerMocks.connect).not.toHaveBeenCalledWith("project", expect.anything(), expect.anything());
    } finally {
      await shutdown(pi);
    }
  });

  it("starts the real runtime for an approved project plus global warm cache and publishes tools/prompts without first use", async () => {
    allowProjectServers();
    await loadConfigSources();
    const pi = await install();

    try {
      expect(pi.tools.has("project_lookup")).toBe(false);
      expect(pi.commands.has("mcp__project__brief")).toBe(false);
      await pi.handlers.get("session_start")?.({ type: "session_start" }, context(fixture.cwd, true));

      await settleSurface(pi, "project_lookup", "mcp__project__brief");
      expect(pi.tools.get("project_lookup")).toMatchObject({ name: "project_lookup", execute: expect.any(Function) });
      expect(statusFor(pi, "project")).toMatchObject({ status: "cached", toolCount: 1 });
      expect(managerMocks.instances).toHaveLength(1);
      expect(managerMocks.connect).not.toHaveBeenCalledWith("project", expect.anything(), expect.anything());
      expect(pi.tools.has("global_lookup")).toBe(true);
      expect(pi.commands.has("mcp__global__brief")).toBe(true);
    } finally {
      await shutdown(pi);
    }
  });

  it("starts a genuinely project-only approved warm cache without first use", async () => {
    configureProjectOnlyApprovedFixture();
    await loadConfigSources({ expectNoFilteredServers: true });
    const pi = await install();

    try {
      expect([...pi.tools.keys()].filter(name => name.endsWith("_lookup"))).toEqual([]);
      expect(pi.commands.has("mcp__project__brief")).toBe(false);
      await pi.handlers.get("session_start")?.({ type: "session_start" }, context(fixture.cwd, true));

      await settleSurface(pi, "project_lookup", "mcp__project__brief");
      expect(statusFor(pi, "project")).toMatchObject({ status: "cached", toolCount: 1 });
      expect(managerMocks.instances).toHaveLength(1);
      expect(managerMocks.connect).toHaveBeenCalledTimes(0);
    } finally {
      await shutdown(pi);
    }
  });

  it("keeps project surfaces hidden during trusted interactive approval and publishes them after Allow", async () => {
    await loadConfigSources();
    const pi = await install();
    const sessionContext = context(fixture.cwd, true, true);
    let releaseApproval!: (answer: string | undefined) => void;
    const approval = new Promise<string | undefined>(resolve => {
      releaseApproval = resolve;
    });
    sessionContext.ui.select.mockReturnValue(approval);
    let sessionStart: Promise<unknown> | undefined;

    try {
      expect(pi.tools.get("global_lookup")).toMatchObject({ name: "global_lookup", execute: expect.any(Function) });
      expect(pi.tools.has("project_lookup")).toBe(false);
      expect(pi.commands.has("mcp__project__brief")).toBe(false);

      sessionStart = Promise.resolve(pi.handlers.get("session_start")?.({ type: "session_start" }, sessionContext));
      await vi.waitFor(() => expect(sessionContext.ui.select).toHaveBeenCalledTimes(1));
      expect(pi.tools.has("project_lookup")).toBe(false);
      expect(pi.commands.has("mcp__project__brief")).toBe(false);
      expect(pi.tools.has("global_lookup")).toBe(true);

      releaseApproval("Allow");
      await sessionStart;
      await settleSurface(pi, "project_lookup", "mcp__project__brief");
      expect(statusFor(pi, "project")).toMatchObject({ status: "cached", toolCount: 1 });
      expect(managerMocks.instances).toHaveLength(1);
      expect(managerMocks.connect).toHaveBeenCalledTimes(0);
    } finally {
      releaseApproval?.("Allow");
      if (sessionStart) void sessionStart.catch(() => undefined);
      await shutdown(pi);
    }
  });

  it("keeps ambient project servers isolated from an explicit programmatic empty config", async () => {
    await loadConfigSources();
    const pi = await install({ config: { mcpServers: {} } });

    expect(pi.tools.has("global_lookup")).toBe(false);
    expect(pi.tools.has("project_lookup")).toBe(false);
    expect(pi.commands.has("mcp__project__brief")).toBe(false);
    await pi.handlers.get("session_start")?.({ type: "session_start" }, context(fixture.cwd, true));
    await new Promise(resolve => setImmediate(resolve));
    expect(managerMocks.instances).toHaveLength(0);
    expect(pi.tools.has("project_lookup")).toBe(false);
    expect(pi.commands.has("mcp__project__brief")).toBe(false);
  });
});
