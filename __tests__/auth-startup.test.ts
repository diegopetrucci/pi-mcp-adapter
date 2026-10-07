import { computeServerHash } from "../metadata-cache.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const managerMocks = vi.hoisted(() => ({
  instances: [] as any[],
  connect: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  factoryCalls: [] as Array<{ args: any[]; runtime: any }>,
  handleStarts: [] as Array<{ runtime: any; args: any[] }>,
  factoryWaiters: [] as Array<() => void>,
}));

vi.mock("../mcp-runtime.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp-runtime.ts")>();
  return {
    ...actual,
    createMcpRuntime: vi.fn((...args: any[]) => {
      const runtime = actual.createMcpRuntime(...args);
      const originalHandleSessionStart = runtime.handleSessionStart;
      runtime.handleSessionStart = vi.fn(function (this: any, ...startArgs: any[]) {
        runtimeMocks.handleStarts.push({ runtime: this, args: startArgs });
        return Reflect.apply(originalHandleSessionStart, this, startArgs);
      });
      runtimeMocks.factoryCalls.push({ args, runtime });
      for (const resolve of runtimeMocks.factoryWaiters.splice(0)) resolve();
      return runtime;
    }),
  };
});

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
      this.setProviderToken = vi.fn();
      this.setMetadataListChangedListener = vi.fn();
      this.setListenStateChangedListener = vi.fn();
      this.getConnection = vi.fn((name: string) => connections.get(name));
      this.getAllConnections = vi.fn(() => new Map(connections));
      this.getRequestOptions = vi.fn((_name: string, signal?: AbortSignal) => signal ? { signal } : undefined);
      this.touch = vi.fn((name: string) => {
        const connection = connections.get(name);
        if (connection) connection.lastUsedAt = Date.now();
      });
      this.incrementInFlight = vi.fn((name: string) => {
        const connection = connections.get(name);
        if (connection) connection.inFlight = (connection.inFlight ?? 0) + 1;
      });
      this.decrementInFlight = vi.fn((name: string) => {
        const connection = connections.get(name);
        if (connection?.inFlight) connection.inFlight--;
      });
      this.isConnecting = vi.fn(() => false);
      this.isIdle = vi.fn(() => false);
      this.ensureListen = vi.fn(async () => {});
      this.refreshTools = vi.fn(async () => "unchanged");
      this.close = vi.fn(async (name: string) => {
        const connection = connections.get(name);
        await connection?.client.close?.();
        connections.delete(name);
      });
      this.closeAll = vi.fn(async () => {
        for (const connection of connections.values()) await connection.client.close?.();
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
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function createPi() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const tools = new Map<string, any>();
  let activeTools: string[] = [];
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
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler)),
    getAllTools: vi.fn(() => [...tools.values()]),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((next: string[]) => { activeTools = [...next]; }),
    registerMcpServer: vi.fn(),
    getMcpServers: vi.fn(() => []),
    events: { on: vi.fn(), emit: vi.fn() },
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
  return { api, handlers, tools };
}

function piAuthEntry(serverUrl: string) {
  return {
    serverUrl,
    tokens: {
      access_token: "pi-access",
      token_type: "Bearer",
      refresh_token: "pi-refresh",
      scope: "mcp:read",
    },
    tokensExpireAt: Date.now() + 3_600_000,
    clientInformation: { client_id: "pi-client", redirect_uris: ["http://127.0.0.1/callback"] },
    codeVerifier: "must-not-copy",
    oauthState: "must-not-copy",
  };
}

type Fixture = {
  root: string;
  agentDir: string;
  cwd: string;
  authPath: string;
  onboardingPath: string;
  configPath: string;
  nativeConfigPath: string;
  settingsPath: string;
  config: any;
  piAuth: Record<string, unknown>;
};

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mcp-auth-startup-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const definition = {
    url: "http://127.0.0.1:43210/mcp",
    auth: "oauth",
    directTools: true,
    lifecycle: "lazy",
  };
  const config = { settings: { scriptMode: true }, mcpServers: { docs: definition } };
  const cache = {
    version: 1,
    servers: {
      docs: {
        configHash: computeServerHash(definition, cwd),
        cacheScope: "shared",
        cachedAt: Date.now(),
        tools: [{ name: "lookup", description: "Look up a document", inputSchema: { type: "object", properties: {} } }],
        resources: [],
        prompts: [],
      },
    },
  };
  const configPath = join(agentDir, "mcp-adapter.json");
  const nativeConfigPath = join(agentDir, "mcp.json");
  const settingsPath = join(agentDir, "settings.json");
  const authPath = join(agentDir, "mcp-auth.json");
  const onboardingPath = join(agentDir, "mcp-onboarding.json");
  writeJson(configPath, config);
  writeJson(join(agentDir, "mcp-cache.json"), cache);
  const url = String(new URL(definition.url));
  const piAuth = { [url]: piAuthEntry(definition.url) };
  writeJson(authPath, piAuth);
  return { root, agentDir, cwd, authPath, onboardingPath, configPath, nativeConfigPath, settingsPath, config, piAuth };
}

function snapshotNativeFiles(fixture: Fixture): Array<string | undefined> {
  return [fixture.authPath, fixture.nativeConfigPath, fixture.settingsPath].map(path =>
    existsSync(path) ? readFileSync(path, "utf8") : undefined,
  );
}

function expectNativeFilesUnchanged(fixture: Fixture, before: Array<string | undefined>): void {
  expect(snapshotNativeFiles(fixture)).toEqual(before);
}

async function expectNoAdapterCredential(fixture: Fixture): Promise<void> {
  const { getAuthForUrl } = await import("../mcp-auth.ts");
  expect(getAuthForUrl("docs", fixture.config.mcpServers.docs.url)).toBeUndefined();
}

type SelectOptions = { signal?: AbortSignal };

type Select = (prompt: string, choices: string[], options?: SelectOptions) => Promise<string | undefined>;

function context(fixture: Fixture, select: Select, hasUI = true): any {
  return {
    cwd: fixture.cwd,
    hasUI,
    mode: hasUI ? "tui" : "rpc",
    signal: undefined,
    isProjectTrusted: () => true,
    ui: {
      select: vi.fn(select),
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: (_color: string, value: string) => value },
    },
    modelRegistry: {},
  };
}

async function loadFixture(fixture: Fixture, select: Select, hasUI = true) {
  const auth = await import("../mcp-auth.ts");
  auth.resetTestAuthSecretStore();
  const { createMcpAdapter } = await import("../index.ts");
  const pi = createPi();
  createMcpAdapter({ configPath: fixture.configPath })(pi.api);
  const sessionContext = context(fixture, select, hasUI);
  return { ...pi, sessionContext };
}

function connectionFor(name: string, callTool = vi.fn(async () => ({ content: [{ type: "text", text: "lookup result" }] }))) {
  return {
    status: "connected",
    definition: { url: "http://127.0.0.1:43210/mcp", auth: "oauth" },
    client: { callTool, readResource: vi.fn(), close: vi.fn(async () => {}) },
    tools: [{ name: "lookup", description: `${name} lookup`, inputSchema: { type: "object", properties: {} } }],
    resources: [],
    prompts: [],
    instructions: undefined,
    lastUsedAt: Date.now(),
    inFlight: 0,
    statusMessage: undefined,
    listenState: "ready",
  };
}

const realSetTimeout = globalThis.setTimeout.bind(globalThis);

function waitForFactoryCall(): Promise<void> {
  if (runtimeMocks.factoryCalls.length > 0) return Promise.resolve();
  return new Promise(resolve => runtimeMocks.factoryWaiters.push(resolve));
}

async function observeHeldGate(calls: Array<unknown>): Promise<void> {
  await waitForFactoryCall();
  await new Promise<void>(resolve => realSetTimeout(resolve, 0));
  expect(runtimeMocks.handleStarts).toHaveLength(0);
  expect(managerMocks.instances).toHaveLength(0);
  expect(calls).toHaveLength(0);
}

describe("production native sign-in startup ownership", () => {
  let fixture: Fixture;
  let cwdSpy: { mockRestore(): void } | undefined;
  let calls: { name: string; signal?: AbortSignal; connection: any }[];

  beforeEach(() => {
    vi.resetModules();
    managerMocks.instances.length = 0;
    runtimeMocks.factoryCalls.length = 0;
    runtimeMocks.handleStarts.length = 0;
    runtimeMocks.factoryWaiters.length = 0;
    calls = [];
    managerMocks.connect.mockReset().mockImplementation(async (name: string, _definition: unknown, signal?: AbortSignal) => {
      const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "lookup result" }] }));
      const connection = connectionFor(name, callTool);
      calls.push({ name, signal, connection });
      return connection;
    });
    fixture = createFixture();
    vi.stubEnv("HOME", fixture.root);
    vi.stubEnv("PI_PACKAGE_DIR", "");
    vi.stubEnv("PI_CODING_AGENT_DIR", fixture.agentDir);
    vi.stubEnv("PI_MCP_CONFIG_MODE", "merge");
    vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
    vi.stubEnv("PI_MCP_ADAPTER_DISABLE_AUTH_CACHE", "1");
    vi.stubEnv("MCP_DIRECT_TOOLS", undefined);
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(fixture.cwd);
  });

  afterEach(async () => {
    for (const instance of managerMocks.instances) await instance.closeAll?.();
    vi.unstubAllEnvs();
    cwdSpy?.mockRestore();
    vi.clearAllMocks();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("holds proxy, direct, and script cold starts until the live import choice", async () => {
    const choice = deferred<string | undefined>();
    const beforeNative = snapshotNativeFiles(fixture);
    const beforeConfig = readFileSync(fixture.configPath, "utf8");
    const { api, handlers, tools, sessionContext } = await loadFixture(
      fixture,
      async () => choice.promise,
    );
    const start = Promise.resolve(handlers.get("session_start")?.({ type: "session_start" }, sessionContext));
    await vi.waitFor(() => expect(sessionContext.ui.select).toHaveBeenCalledTimes(1));

    const proxy = tools.get("mcp");
    const direct = tools.get("docs_lookup");
    const script = tools.get("mcpScript");
    expect(proxy).toBeDefined();
    expect(direct).toBeDefined();
    expect(script).toBeDefined();
    expect(calls).toHaveLength(0);

    const proxyCall = proxy.execute("proxy-1", { connect: "docs" }, undefined, undefined, sessionContext);
    const directCall = direct.execute("direct-1", {}, undefined, undefined, sessionContext);
    const scriptCall = script.execute("script-1", { code: 'return await tools.call("docs_lookup", {});' }, undefined, undefined, sessionContext);
    await observeHeldGate(calls);

    choice.resolve("Import sign-in");
    await start;
    const [proxyResult, directResult, scriptResult] = await Promise.all([proxyCall, directCall, scriptCall]);
    expect(proxyResult).toMatchObject({ details: { mode: "list", server: "docs" } });
    expect(proxyResult.details?.error).toBeUndefined();
    expect(directResult).toMatchObject({ content: expect.arrayContaining([{ type: "text", text: "lookup result" }]) });
    expect(directResult.details?.error).toBeUndefined();
    expect(scriptResult.details.calls).toHaveLength(1);
    expect(scriptResult.details.calls[0]).toMatchObject({ operation: "call", path: "docs_lookup", ok: true });
    expect(scriptResult.content.some((block: any) => String(block.text ?? "").includes("lookup result"))).toBe(true);
    const rpcCalls = calls.flatMap(call => call.connection.client.callTool.mock.calls);
    expect(rpcCalls).toHaveLength(2);
    for (const [params, options] of rpcCalls) {
      expect(params).toMatchObject({ name: "lookup", arguments: {} });
      expect(options).toMatchObject({
        signal: expect.any(AbortSignal),
        onprogress: expect.any(Function),
        resetTimeoutOnProgress: true,
      });
    }
    const { getAuthForUrl } = await import("../mcp-auth.ts");
    expect(getAuthForUrl("docs", fixture.config.mcpServers.docs.url)).toMatchObject({
      tokens: { accessToken: "pi-access" },
    });
    expectNativeFilesUnchanged(fixture, beforeNative);
    expect(readFileSync(fixture.configPath, "utf8")).toBe(beforeConfig);
    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
    expect(api.registerMcpServer).toHaveBeenCalledTimes(0);
  }, 20_000);

  it("cancels a held prompt on shutdown without late auth or runtime startup", async () => {
    const choice = deferred<string | undefined>();
    let selectSignal: AbortSignal | undefined;
    const { handlers, tools, sessionContext } = await loadFixture(
      fixture,
      async (_prompt, _choices, options) => {
        selectSignal = options?.signal;
        return choice.promise;
      },
    );
    await handlers.get("session_start")?.({ type: "session_start" }, sessionContext);
    await vi.waitFor(() => expect(sessionContext.ui.select).toHaveBeenCalledTimes(1));
    const beforeNative = snapshotNativeFiles(fixture);
    const beforeOnboarding = existsSync(fixture.onboardingPath)
      ? readFileSync(fixture.onboardingPath, "utf8")
      : undefined;
    const pending = tools.get("mcp").execute("proxy-1", { connect: "docs" }, undefined, undefined, sessionContext);
    const pendingRejection = expect(pending).rejects.toThrow("MCP extension session restarted (stale session)");
    await observeHeldGate(calls);

    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
    expect(selectSignal?.aborted).toBe(true);
    await pendingRejection;
    choice.resolve("Import sign-in");
    await Promise.resolve();
    expect(calls).toHaveLength(0);
    expectNativeFilesUnchanged(fixture, beforeNative);
    expect(existsSync(fixture.onboardingPath)
      ? readFileSync(fixture.onboardingPath, "utf8")
      : undefined).toBe(beforeOnboarding);
    const { getAuthForUrl } = await import("../mcp-auth.ts");
    expect(getAuthForUrl("docs", fixture.config.mcpServers.docs.url)).toBeUndefined();
  }, 20_000);

  it("uses the current trust-filtered config and excludes an untrusted project candidate", async () => {
    const project = {
      url: "http://127.0.0.1:43211/mcp",
      auth: "oauth",
      directTools: true,
      lifecycle: "lazy",
    };
    writeJson(join(fixture.cwd, ".mcp.json"), { mcpServers: { project } });
    const nativeAuth = JSON.parse(readFileSync(fixture.authPath, "utf8"));
    nativeAuth[String(new URL(project.url))] = piAuthEntry(project.url);
    writeJson(fixture.authPath, nativeAuth);
    const select = vi.fn(async () => "Sign in again");
    const beforeNative = snapshotNativeFiles(fixture);
    const { handlers, sessionContext } = await loadFixture(fixture, select);
    sessionContext.isProjectTrusted = () => false;
    await handlers.get("session_start")?.({ type: "session_start" }, sessionContext);
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    expect(select.mock.calls[0]?.[0]).toContain("docs");
    expect(select.mock.calls[0]?.[0]).not.toContain("project");
    expectNativeFilesUnchanged(fixture, beforeNative);
  }, 20_000);

  it("skips the offer without a UI on a cold proxy first use", async () => {
    const select = vi.fn(async () => "Import sign-in");
    const { handlers, tools, sessionContext } = await loadFixture(fixture, select, false);
    const beforeNative = snapshotNativeFiles(fixture);
    const beforeOnboarding = existsSync(fixture.onboardingPath)
      ? readFileSync(fixture.onboardingPath, "utf8")
      : undefined;
    const start = Promise.resolve(handlers.get("session_start")?.({ type: "session_start" }, sessionContext));
    const cold = tools.get("mcp").execute("no-ui", { connect: "docs" }, undefined, undefined, sessionContext);
    const [, result] = await Promise.all([start, cold]);
    expect(result).toBeDefined();
    expect(select).not.toHaveBeenCalled();
    expectNativeFilesUnchanged(fixture, beforeNative);
    expect(existsSync(fixture.onboardingPath) ? readFileSync(fixture.onboardingPath, "utf8") : undefined)
      .toBe(beforeOnboarding);
    await expectNoAdapterCredential(fixture);
  }, 20_000);

  it("skips the offer on an unsupported host on a cold proxy first use", async () => {
    const select = vi.fn(async () => "Import sign-in");
    const unsupported = createPi();
    delete unsupported.api.registerMcpServer;
    const { createMcpAdapter } = await import("../index.ts");
    createMcpAdapter({ configPath: fixture.configPath })(unsupported.api);
    const unsupportedContext = context(fixture, select);
    const beforeNative = snapshotNativeFiles(fixture);
    const beforeOnboarding = existsSync(fixture.onboardingPath)
      ? readFileSync(fixture.onboardingPath, "utf8")
      : undefined;
    const start = Promise.resolve(unsupported.handlers.get("session_start")?.({ type: "session_start" }, unsupportedContext));
    const cold = unsupported.tools.get("mcp").execute("unsupported", { connect: "docs" }, undefined, undefined, unsupportedContext);
    const [, result] = await Promise.all([start, cold]);
    expect(result).toBeDefined();
    expect(select).not.toHaveBeenCalled();
    expectNativeFilesUnchanged(fixture, beforeNative);
    expect(existsSync(fixture.onboardingPath) ? readFileSync(fixture.onboardingPath, "utf8") : undefined)
      .toBe(beforeOnboarding);
    await expectNoAdapterCredential(fixture);
  }, 20_000);

  it("skips the offer for programmatic configuration on a cold proxy first use", async () => {
    const select = vi.fn(async () => "Import sign-in");
    const { createMcpAdapter } = await import("../index.ts");
    const programmatic = createPi();
    createMcpAdapter({ config: fixture.config })(programmatic.api);
    const programmaticContext = context(fixture, select);
    const beforeNative = snapshotNativeFiles(fixture);
    const beforeOnboarding = existsSync(fixture.onboardingPath)
      ? readFileSync(fixture.onboardingPath, "utf8")
      : undefined;
    const start = Promise.resolve(programmatic.handlers.get("session_start")?.({ type: "session_start" }, programmaticContext));
    const cold = programmatic.tools.get("mcp").execute("programmatic", { connect: "docs" }, undefined, undefined, programmaticContext);
    const [, result] = await Promise.all([start, cold]);
    expect(result).toBeDefined();
    expect(select).not.toHaveBeenCalled();
    expectNativeFilesUnchanged(fixture, beforeNative);
    expect(existsSync(fixture.onboardingPath) ? readFileSync(fixture.onboardingPath, "utf8") : undefined)
      .toBe(beforeOnboarding);
    await expectNoAdapterCredential(fixture);
  }, 20_000);

  it("skips the offer when the native auth file is absent on a cold proxy first use", async () => {
    rmSync(fixture.authPath);
    const select = vi.fn(async () => "Import sign-in");
    const { handlers, tools, sessionContext } = await loadFixture(fixture, select);
    const beforeNative = snapshotNativeFiles(fixture);
    const beforeOnboarding = existsSync(fixture.onboardingPath)
      ? readFileSync(fixture.onboardingPath, "utf8")
      : undefined;
    const start = Promise.resolve(handlers.get("session_start")?.({ type: "session_start" }, sessionContext));
    const cold = tools.get("mcp").execute("missing-auth", { connect: "docs" }, undefined, undefined, sessionContext);
    const [, result] = await Promise.all([start, cold]);
    expect(result).toBeDefined();
    expect(select).not.toHaveBeenCalled();
    expectNativeFilesUnchanged(fixture, beforeNative);
    expect(existsSync(fixture.onboardingPath) ? readFileSync(fixture.onboardingPath, "utf8") : undefined)
      .toBe(beforeOnboarding);
    await expectNoAdapterCredential(fixture);
  }, 20_000);

  it.each(["Import sign-in", "Sign in again"] as const)("cancels a predecessor prompt on successor takeover with late %s", async (lateChoice) => {
    const firstChoice = deferred<string | undefined>();
    let promptCount = 0;
    const selectSignals: Array<AbortSignal | undefined> = [];
    const select = vi.fn(async (_prompt: string, _choices: string[], options?: SelectOptions) => {
      promptCount++;
      selectSignals.push(options?.signal);
      return promptCount === 1 ? firstChoice.promise : "Sign in again";
    });
    const { handlers, tools, sessionContext } = await loadFixture(fixture, select);
    const firstStart = Promise.resolve(handlers.get("session_start")?.({ type: "session_start" }, sessionContext));
    const firstStartResult = expect(firstStart).resolves.toBeUndefined();
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    const beforeNative = snapshotNativeFiles(fixture);
    const pending = tools.get("mcp").execute("old", { connect: "docs" }, undefined, undefined, sessionContext);
    const pendingRejection = expect(pending).rejects.toThrow("MCP extension session restarted (stale session)");
    await observeHeldGate(calls);

    const successorStart = Promise.resolve(handlers.get("session_start")?.({ type: "session_start" }, sessionContext));
    const successorStartResult = expect(successorStart).resolves.toBeUndefined();
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      const onboarding = JSON.parse(readFileSync(fixture.onboardingPath, "utf8"));
      expect(onboarding.piSignInImportsAsked).toEqual([{
        server: "docs",
        url: String(new URL(fixture.config.mcpServers.docs.url)),
      }]);
    });
    const currentOnboarding = readFileSync(fixture.onboardingPath, "utf8");
    await pendingRejection;
    expect(selectSignals[0]?.aborted).toBe(true);
    firstChoice.resolve(lateChoice);
    await firstStartResult;
    await successorStartResult;
    await Promise.resolve();
    expectNativeFilesUnchanged(fixture, beforeNative);
    expect(readFileSync(fixture.onboardingPath, "utf8")).toBe(currentOnboarding);
    const { getAuthForUrl } = await import("../mcp-auth.ts");
    expect(getAuthForUrl("docs", fixture.config.mcpServers.docs.url)).toBeUndefined();
  }, 20_000);

  it("holds session_start initialization behind the live offer when metadata bootstrap is cold", async () => {
    rmSync(join(fixture.agentDir, "mcp-cache.json"));
    const choice = deferred<string | undefined>();
    const { handlers, tools, sessionContext } = await loadFixture(fixture, async () => choice.promise);
    const start = Promise.resolve(handlers.get("session_start")?.({ type: "session_start" }, sessionContext));
    const startResult = expect(start).resolves.toBeUndefined();
    await vi.waitFor(() => expect(sessionContext.ui.select).toHaveBeenCalledTimes(1));
    const beforeNative = snapshotNativeFiles(fixture);
    await observeHeldGate(calls);

    choice.resolve("Import sign-in");
    await startResult;
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const direct = tools.get("docs_lookup");
    const result = await direct.execute("uncached", {}, undefined, undefined, sessionContext);
    expect(result).toMatchObject({ content: expect.arrayContaining([{ type: "text", text: "lookup result" }]) });
    expect(result.details?.error).toBeUndefined();
    const { getAuthForUrl } = await import("../mcp-auth.ts");
    expect(getAuthForUrl("docs", fixture.config.mcpServers.docs.url)).toMatchObject({
      tokens: { accessToken: "pi-access" },
    });
    expectNativeFilesUnchanged(fixture, beforeNative);
    expect(calls.flatMap(call => call.connection.client.callTool.mock.calls)).not.toHaveLength(0);
  }, 20_000);

  it("keeps the single 30-second first-use deadline while the prompt is pending", async () => {
    // Warm only the real module under the same reset module registry. The
    // factory itself remains observable and is invoked by the production path.
    await import("../mcp-runtime.ts");
    fixture.config = {
      ...fixture.config,
      settings: { ...fixture.config.settings, deferWithMissingMetadata: true },
    };
    writeJson(fixture.configPath, fixture.config);
    const choice = deferred<string | undefined>();
    const { handlers, tools, sessionContext } = await loadFixture(fixture, async () => choice.promise);
    const start = Promise.resolve(handlers.get("session_start")?.({ type: "session_start" }, sessionContext));
    const startResult = expect(start).resolves.toBeUndefined();
    await vi.waitFor(() => expect(sessionContext.ui.select).toHaveBeenCalledTimes(1));
    const beforeNative = snapshotNativeFiles(fixture);
    const beforeOnboarding = existsSync(fixture.onboardingPath)
      ? readFileSync(fixture.onboardingPath, "utf8")
      : undefined;

    vi.useFakeTimers();
    try {
      const factoryReady = waitForFactoryCall();
      const pending = tools.get("mcp").execute("deadline", { connect: "docs" }, undefined, undefined, sessionContext);
      const pendingState = pending.then(
        value => ({ status: "fulfilled" as const, value }),
        error => ({ status: "rejected" as const, error }),
      );
      let pendingSettled = false;
      void pendingState.then(() => { pendingSettled = true; });
      await factoryReady;
      await new Promise<void>(resolve => realSetTimeout(resolve, 0));
      expect(runtimeMocks.handleStarts).toHaveLength(0);
      expect(managerMocks.instances).toHaveLength(0);
      expect(calls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(29_999);
      await Promise.resolve();
      expect(pendingSettled).toBe(false);
      expect(calls).toHaveLength(0);
      expectNativeFilesUnchanged(fixture, beforeNative);

      await vi.advanceTimersByTimeAsync(1);
      const outcome = await pendingState;
      expect(outcome.status).toBe("fulfilled");
      if (outcome.status === "fulfilled") {
        expect(outcome.value).toMatchObject({ details: { error: "init_timeout", timeoutMs: 30_000 } });
      }
      expect(calls).toHaveLength(0);

      choice.resolve("Sign in again");
      await startResult;
      await new Promise<void>(resolve => realSetTimeout(resolve, 0));
      const onboarding = JSON.parse(readFileSync(fixture.onboardingPath, "utf8"));
      expect(onboarding.piSignInImportsAsked).toEqual([{
        server: "docs",
        url: String(new URL(fixture.config.mcpServers.docs.url)),
      }]);
      expectNativeFilesUnchanged(fixture, beforeNative);
      expect(runtimeMocks.handleStarts).toHaveLength(0);
      expect(managerMocks.instances).toHaveLength(0);
      expect(calls).toHaveLength(0);
      expect(existsSync(fixture.onboardingPath) ? readFileSync(fixture.onboardingPath, "utf8") : undefined)
        .not.toBe(beforeOnboarding);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("fences owner cancellation while the real sign-in module is still loading", async () => {
    const moduleEntered = deferred<void>();
    const releaseModule = deferred<void>();
    const moduleLoaded = deferred<void>();
    vi.doMock("../pi-signin-import.ts", async (importOriginal) => {
      moduleEntered.resolve(undefined);
      await releaseModule.promise;
      const realModule = await importOriginal();
      moduleLoaded.resolve(undefined);
      return realModule;
    });
    const select = vi.fn(async () => "Import sign-in");
    const { handlers, tools, sessionContext } = await loadFixture(fixture, select);
    const start = Promise.resolve(handlers.get("session_start")?.({ type: "session_start" }, sessionContext));
    const startResult = expect(start).resolves.toBeUndefined();
    await moduleEntered.promise;
    const beforeNative = snapshotNativeFiles(fixture);
    const beforeOnboarding = existsSync(fixture.onboardingPath)
      ? readFileSync(fixture.onboardingPath, "utf8")
      : undefined;
    const pending = tools.get("mcp").execute("loading", { connect: "docs" }, undefined, undefined, sessionContext);
    const pendingRejection = expect(pending).rejects.toThrow("MCP extension session restarted (stale session)");
    await observeHeldGate(calls);

    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, sessionContext);
    await pendingRejection;
    releaseModule.resolve(undefined);
    await moduleLoaded.promise;
    await startResult;
    await new Promise<void>(resolve => realSetTimeout(resolve, 0));
    expect(select).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(select.mock.calls).toHaveLength(0);
    expectNativeFilesUnchanged(fixture, beforeNative);
    expect(existsSync(fixture.onboardingPath) ? readFileSync(fixture.onboardingPath, "utf8") : undefined)
      .toBe(beforeOnboarding);
    await expectNoAdapterCredential(fixture);
    vi.doUnmock("../pi-signin-import.ts");
  }, 20_000);
});
