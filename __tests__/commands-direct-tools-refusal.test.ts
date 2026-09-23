import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createMcpPanel: vi.fn(),
  writeDirectToolsConfig: vi.fn(),
  onDirectToolsConfigChanged: vi.fn(),
}));

vi.mock("../mcp-panel.ts", () => ({
  createMcpPanel: mocks.createMcpPanel,
}));

vi.mock("../config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.ts")>()),
  writeDirectToolsConfig: mocks.writeDirectToolsConfig,
}));

vi.mock("../init.ts", () => ({
  clearFailure: vi.fn(),
  getFailureAgeSeconds: vi.fn(() => null),
  getFailureMessage: vi.fn(() => undefined),
  markKeepAliveAfterConnect: vi.fn(),
  notifyToolMetadataUpdated: vi.fn(),
  recordFailure: vi.fn(),
  updateMetadataCache: vi.fn(),
  updateStatusBar: vi.fn(),
}));

describe("directTools write refusal handling", () => {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalCwd = process.cwd();

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    process.chdir(originalCwd);
    vi.resetModules();
  });

  it("does not live-refresh a runtime-registered proxy-only server without persistence provenance", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-runtime-server-home-"));
    delete process.env.PI_CODING_AGENT_DIR;
    const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-runtime-server-cwd-"));
    process.chdir(cwd);
    vi.resetModules();
    const runtimeDefinition = { url: "https://runtime.example/mcp", directTools: false };
    mocks.createMcpPanel.mockReset().mockImplementation((_config, _cache, _provenance, _callbacks, _tui, done) => {
      queueMicrotask(() => done({ cancelled: false, disabledChanges: new Map(), changes: new Map([["runtime", true]]) }));
      return { dispose() {} };
    });
    mocks.writeDirectToolsConfig.mockReset().mockImplementation(() => {});
    const refresh = vi.fn((changes: Map<string, true | string[] | false>) => {
      runtimeDefinition.directTools = changes.get("runtime") as false;
    });

    const { openMcpPanel } = await import("../commands.ts");
    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      custom: vi.fn((factory: any, options: any) => {
        factory({ requestRender: vi.fn() }, undefined, undefined, vi.fn());
        options.onHandle?.({ setHidden: vi.fn(), focus: vi.fn() });
      }),
    };
    const config = { mcpServers: { runtime: runtimeDefinition } };
    const result = await openMcpPanel(
      {
        programmaticConfig: false,
        config,
        manager: { getConnection: () => null },
        toolMetadata: new Map(),
        failureTracker: new Map(),
        failureMessages: new Map(),
      } as any,
      { getFlag: () => undefined } as any,
      { hasUI: true, mode: "tui", cwd, ui } as any,
      undefined,
      refresh,
    );

    const { computeServerHash } = await import("../metadata-cache.ts");
    const { resolveDirectTools } = await import("../startup-mcp-facade.ts");
    const cache = {
      version: 1,
      servers: {
        runtime: {
          configHash: computeServerHash(runtimeDefinition, cwd),
          tools: [{ name: "search" }],
          resources: [],
          cachedAt: Date.now(),
        },
      },
    } as any;

    expect(result).toEqual({ configChanged: false });
    expect(refresh).not.toHaveBeenCalled();
    expect(config.mcpServers.runtime).toBe(runtimeDefinition);
    expect(runtimeDefinition.directTools).toBe(false);
    expect(resolveDirectTools(config as any, cache, "server", undefined, cwd)).toEqual([]);
    expect(mocks.writeDirectToolsConfig).toHaveBeenCalledOnce();
  });

  it("does not claim an update or request live refresh when persistence is refused", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-direct-tools-refusal-home-"));
    delete process.env.PI_CODING_AGENT_DIR;
    process.chdir(mkdtempSync(join(tmpdir(), "pi-mcp-direct-tools-refusal-cwd-")));
    vi.resetModules();
    mocks.createMcpPanel.mockReset().mockImplementation((_config, _cache, _provenance, _callbacks, _tui, done) => {
      queueMicrotask(() => done({ cancelled: false, disabledChanges: new Map(), changes: new Map([["server", true]]) }));
      return { dispose() {} };
    });
    mocks.writeDirectToolsConfig.mockReset().mockImplementation(() => {
      throw new Error("Refusing to write read-only imported MCP config");
    });

    const { openMcpPanel } = await import("../commands.ts");
    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      custom: vi.fn((factory: any, options: any) => {
        factory({ requestRender: vi.fn() }, undefined, undefined, vi.fn());
        options.onHandle?.({ setHidden: vi.fn(), focus: vi.fn() });
      }),
    };
    const result = await openMcpPanel(
      {
        programmaticConfig: false,
        config: { mcpServers: { server: { command: "server" } } },
        manager: { getConnection: () => null },
        toolMetadata: new Map(),
        failureTracker: new Map(),
        failureMessages: new Map(),
      } as any,
      { getFlag: () => undefined } as any,
      { hasUI: true, mode: "tui", cwd: "/tmp", ui } as any,
      undefined,
      mocks.onDirectToolsConfigChanged,
    );

    expect(result).toEqual({ configChanged: false });
    expect(mocks.writeDirectToolsConfig).toHaveBeenCalledOnce();
    expect(mocks.onDirectToolsConfigChanged).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      "Failed to update direct tools: Refusing to write read-only imported MCP config",
      "error",
    );
    expect(ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("live refresh failed"), "error");
  });
});
