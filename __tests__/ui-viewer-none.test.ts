import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { ConsentManager } from "../consent-manager.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";
import { maybeStartUiSession } from "../ui-session.ts";
import { isMcpUiEnabled, resolveMcpUiViewerPreference } from "../ui-viewer-preference.ts";

const glimpseMocks = vi.hoisted(() => ({
  isGlimpseAvailable: vi.fn(() => true),
  openGlimpseWindow: vi.fn(),
}));

vi.mock("../glimpse-ui.ts", () => glimpseMocks);
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_command, _options, callback) => callback(null, "")),
}));

function textOf(result: any): string {
  return result.content.map((entry: any) => entry.text ?? "").join("\n");
}

function makeState() {
  const callTool = vi.fn(async () => ({
    isError: false,
    content: [{ type: "text" as const, text: "tool output" }],
  }));
  const connection = {
    status: "connected" as const,
    client: { callTool },
    tools: [{ name: "app", description: "App", inputSchema: { type: "object" } }],
    resources: [],
  };
  const metadata = [
    { name: "demo_app", originalName: "app", description: "App", uiResourceUri: "ui://app" },
    { name: "demo_plain", originalName: "plain", description: "Plain" },
  ];
  const state = {
    config: { settings: { toolPrefix: "server" }, mcpServers: { demo: { command: "demo" } } },
    manager: {
      getConnection: vi.fn(() => connection),
      getAllConnections: vi.fn(() => new Map([["demo", connection]])),
      getRequestOptions: vi.fn(() => undefined),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      registerUiStreamListener: vi.fn(),
      removeUiStreamListener: vi.fn(),
    },
    lifecycle: {},
    toolMetadata: new Map([["demo", metadata]]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    uiResourceHandler: {
      readUiResource: vi.fn(async () => ({
        uri: "ui://app",
        html: "<main>App</main>",
        mimeType: "text/html",
        meta: {},
      })),
    },
    consentManager: new ConsentManager("never"),
    uiServer: null,
    completedUiSessions: [],
    openBrowser: vi.fn(async () => undefined),
    sendMessage: vi.fn(),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: (_name: string, value: string) => value },
    },
  } as any;

  return { state, callTool };
}

afterEach(() => {
  delete process.env.MCP_UI_VIEWER;
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_TTY;
  vi.mocked(execFile).mockImplementation((_command: any, _options: any, callback: any) => callback(null, "") as any);
  glimpseMocks.isGlimpseAvailable.mockClear();
  glimpseMocks.openGlimpseWindow.mockClear();
});

describe("MCP_UI_VIEWER preference", () => {
  it("is disabled unless an opt-in viewer is named", () => {
    delete process.env.MCP_UI_VIEWER;
    expect(resolveMcpUiViewerPreference()).toBeNull();
    expect(isMcpUiEnabled()).toBe(false);

    for (const value of ["", "none", "off", "disabled", "0", "true", "yes"]) {
      process.env.MCP_UI_VIEWER = value;
      expect(resolveMcpUiViewerPreference()).toBeNull();
      expect(isMcpUiEnabled()).toBe(false);
    }
  });

  it.each([
    ["AUTO", "auto"],
    ["browser", "browser"],
    ["Glimpse", "glimpse"],
    ["orca", "orca"],
  ])("accepts %s as an opt-in viewer", (value, expected) => {
    process.env.MCP_UI_VIEWER = value;
    expect(resolveMcpUiViewerPreference()).toBe(expected);
    expect(isMcpUiEnabled()).toBe(true);
  });
});

describe("MCP Apps UI off by default", () => {
  it("does not start a UI session or open a window for ui:// tools", async () => {
    const { state } = makeState();

    const result = await executeCall(state, "demo_app", {}, "demo");

    expect(textOf(result)).toBe("tool output");
    expect(state.uiResourceHandler.readUiResource).not.toHaveBeenCalled();
    expect(state.openBrowser).not.toHaveBeenCalled();
    expect(glimpseMocks.openGlimpseWindow).not.toHaveBeenCalled();
    expect(state.ui.notify).not.toHaveBeenCalled();
    expect(state.uiServer).toBeNull();
  });

  it("returns the same result shape as an ordinary tool on the proxy path", async () => {
    const { state } = makeState();

    const uiResult = await executeCall(state, "demo_app", {}, "demo");
    const plainResult = await executeCall(state, "demo_plain", {}, "demo");

    expect(uiResult.details).not.toHaveProperty("uiOpen");
    expect(uiResult.details).not.toHaveProperty("uiViewer");
    expect(uiResult.details).not.toHaveProperty("uiUrl");
    expect(Object.keys(uiResult.details).sort()).toEqual(Object.keys(plainResult.details).sort());
    expect(textOf(uiResult)).toBe(textOf(plainResult));
  });

  it("returns the same result shape as an ordinary tool on the direct path", async () => {
    const { state } = makeState();
    const executeUi = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "app", prefixedName: "demo_app", description: "App", uiResourceUri: "ui://app" },
    );
    const executePlain = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "plain", prefixedName: "demo_plain", description: "Plain" },
    );

    const uiResult = await executeUi("call-ui", {}, undefined as any, () => {}, undefined as any);
    const plainResult = await executePlain("call-plain", {}, undefined as any, () => {}, undefined as any);

    expect(uiResult.details).not.toHaveProperty("uiOpen");
    expect(uiResult.details).not.toHaveProperty("uiViewer");
    expect(uiResult.details).not.toHaveProperty("uiUrl");
    expect(Object.keys(uiResult.details).sort()).toEqual(Object.keys(plainResult.details).sort());
    expect(textOf(uiResult)).toBe(textOf(plainResult));
    expect(state.uiResourceHandler.readUiResource).not.toHaveBeenCalled();
    expect(state.openBrowser).not.toHaveBeenCalled();
    expect(state.ui.notify).not.toHaveBeenCalled();
    expect(state.uiServer).toBeNull();
  });

  it.each(["none", "off", "disabled"])("treats %s as disabled rather than a suppressed viewer", async (value) => {
    process.env.MCP_UI_VIEWER = value;
    const { state } = makeState();

    const runtime = await maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    });

    expect(runtime).toBeNull();
    expect(state.uiResourceHandler.readUiResource).not.toHaveBeenCalled();
    expect(state.openBrowser).not.toHaveBeenCalled();
    expect(state.ui.notify).not.toHaveBeenCalled();
    expect(state.uiServer).toBeNull();
  });
});

describe("MCP Apps UI opt-in", () => {
  it("starts a UI session for ui:// tools on the proxy path with MCP_UI_VIEWER=browser", async () => {
    process.env.MCP_UI_VIEWER = "browser";
    const { state } = makeState();

    const result = await executeCall(state, "demo_app", {}, "demo");

    expect(state.uiResourceHandler.readUiResource).toHaveBeenCalledWith("demo", "ui://app", expect.any(Object));
    expect(state.openBrowser).toHaveBeenCalledWith(expect.stringContaining("http://localhost:"));
    expect(textOf(result)).toContain("tool output");
    expect(result.details).toMatchObject({ uiOpen: true, uiViewer: "browser" });
    expect(result.details.uiUrl).toContain("http://localhost:");

    state.uiServer?.close("test-cleanup");
  });

  it("starts a UI session for ui:// tools on the direct path with MCP_UI_VIEWER=browser", async () => {
    process.env.MCP_UI_VIEWER = "browser";
    const { state } = makeState();
    const execute = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "app", prefixedName: "demo_app", description: "App", uiResourceUri: "ui://app" },
    );

    const result = await execute("call-1", {}, undefined as any, () => {}, undefined as any);

    expect(state.uiResourceHandler.readUiResource).toHaveBeenCalledWith("demo", "ui://app", expect.any(Object));
    expect(state.openBrowser).toHaveBeenCalledWith(expect.stringContaining("http://localhost:"));
    expect(textOf(result)).toContain("tool output");
    expect(result.details).toMatchObject({ uiOpen: true, uiViewer: "browser" });
    expect(result.details.uiUrl).toContain("http://localhost:");

    state.uiServer?.close("test-cleanup");
  });
});

describe("remote MCP UI viewers", () => {
  it("skips Glimpse and prints a remote access hint for SSH sessions", async () => {
    process.env.MCP_UI_VIEWER = "auto";
    process.env.SSH_CONNECTION = "192.0.2.10 55555 127.0.0.1 22";
    const { state } = makeState();

    const runtime = await maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    });

    expect(runtime).toMatchObject({ viewer: "browser", windowOpen: true });
    expect(state.openBrowser).toHaveBeenCalledWith(expect.stringContaining("http://localhost:"));
    expect(glimpseMocks.isGlimpseAvailable).not.toHaveBeenCalled();
    expect(glimpseMocks.openGlimpseWindow).not.toHaveBeenCalled();
    expect(state.ui.notify).toHaveBeenCalledWith(expect.stringContaining("This looks like a remote session"), "info");
    expect(state.ui.notify).toHaveBeenCalledWith(expect.stringContaining("SSH: run `ssh -L"), "info");
    const handle = state.uiServer;
    expect(state.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(`-L ${handle.proxyPort}:127.0.0.1:${handle.proxyPort}`),
      "info",
    );

    runtime?.close("test-cleanup");
  });

  it("uses local-window wording when a remote login is active but Glimpse opened", async () => {
    process.env.MCP_UI_VIEWER = "auto";
    vi.mocked(execFile).mockImplementation((_command: any, _options: any, callback: any) => callback(null, "nico ttys001 2026-08-02 08:00 (192.0.2.10)\n") as any);
    const { state } = makeState();
    glimpseMocks.openGlimpseWindow.mockResolvedValueOnce({ close: vi.fn() });

    const runtime = await maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    });

    expect(runtime).toMatchObject({ viewer: "glimpse", windowOpen: true });
    expect(state.ui.notify).toHaveBeenCalledWith(expect.stringContaining("MCP UI opened on this host"), "info");
    expect(state.ui.notify).toHaveBeenCalledWith(expect.stringContaining("If you're controlling this session remotely"), "info");

    runtime?.close("test-cleanup");
  });
});

describe("MCP UI context submissions", () => {
  it("triggers an agent turn when the UI updates model context", async () => {
    process.env.MCP_UI_VIEWER = "browser";
    const { state } = makeState();

    const runtime = await maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    });
    if (!runtime) throw new Error("expected UI runtime");

    await fetch(`${runtime.url.replace(/\/?\?.*$/, "")}/proxy/ui/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: state.uiServer.sessionToken, params: { content: [{ type: "text", text: "Use this selection" }] } }),
    });

    expect(state.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "mcp-ui-context",
        content: [{ type: "text", text: expect.stringContaining("Use this selection") }],
        display: "UI Context submitted",
      }),
      { triggerTurn: true },
    );

    runtime.close("test-cleanup");
  });
});
