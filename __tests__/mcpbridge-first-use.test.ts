import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeMcp } from "../init.ts";
import { computeServerHash, loadMetadataCache, saveMetadataCache } from "../metadata-cache.ts";
import { createMcpStatusSnapshot } from "../mcp-status.ts";
import { executeCall } from "../proxy-modes.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import { connectsOnFirstUseOnly, defaultIdleTimeoutFor } from "../idle-defaults.ts";
import type { ServerEntry } from "../types.ts";

describe("connectsOnFirstUseOnly", () => {
  it.each([
    [{ command: "xcrun", args: ["mcpbridge"] }, true],
    [{ command: "/usr/bin/xcrun", args: ["mcpbridge"] }, true],
    [{ command: "xcrun", args: ["--sdk", "macosx", "mcpbridge"] }, true],
    [{ command: "mcpbridge" }, true],
    [{ command: "/Applications/Xcode.app/Contents/Developer/usr/bin/mcpbridge", args: ["--x"] }, true],
    [{ command: "xcrun", args: ["simctl"] }, false],
    [{ command: "xcrun" }, false],
    [{ command: "node", args: ["mcpbridge"] }, false],
    [{ url: "https://example.com/mcpbridge" }, false],
    // Explicit startup lifecycles win over the first-use default.
    [{ command: "xcrun", args: ["mcpbridge"], lifecycle: "eager" }, false],
    [{ command: "xcrun", args: ["mcpbridge"], lifecycle: "keep-alive" }, false],
    [{ command: "xcrun", args: ["mcpbridge"], lifecycle: "lazy" }, true],
    // lazy-keep-alive connects on first use and only becomes resident afterwards.
    [{ command: "xcrun", args: ["mcpbridge"], lifecycle: "lazy-keep-alive" }, true],
  ] as [ServerEntry, boolean][])("%j -> %s", (definition, expected) => {
    expect(connectsOnFirstUseOnly(definition)).toBe(expected);
  });

  it("shares the Xcode bridge matcher with the idle-timeout default", () => {
    const definitions: ServerEntry[] = [
      { command: "xcrun", args: ["mcpbridge"] },
      { command: "mcpbridge" },
      { command: "xcrun", args: ["simctl"] },
      { command: "node", args: ["mcpbridge"] },
      { url: "https://example.com/mcpbridge" },
    ];
    for (const definition of definitions) {
      const bridge = defaultIdleTimeoutFor(definition) === 0;
      expect(connectsOnFirstUseOnly(definition)).toBe(bridge);
    }
  });
});

describe.skipIf(process.platform === "win32")("Xcode mcpbridge servers connect only on first use", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-mcp-mcpbridge-first-use-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    delete process.env.MCP_DIRECT_TOOLS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalDirectTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
    else process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    rmSync(dir, { recursive: true, force: true });
  });

  const fixture = fileURLToPath(new URL("./fixtures/prompts-server.mjs", import.meta.url));
  const spawnLogPath = () => join(dir, "spawns.log");
  /** Spawn log lines, one per launched server process, in launch order. */
  const spawned = (): string[] => {
    const path = spawnLogPath();
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8").split("\n").map(line => line.trim()).filter(Boolean);
  };
  /** Stand-in process named like the bridge launcher that logs its spawn and forwards to a real fixture server. */
  const shim = (name: string, dropArgs = 0) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\necho "${name}" >> "${spawnLogPath()}"\n${"shift\n".repeat(dropArgs)}exec "${process.execPath}" "${fixture}"\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const xcrun = () => shim("xcrun", 1);
  const bridge = () => shim("mcpbridge");

  const start = (mcpServers: Record<string, ServerEntry>, settings: Record<string, unknown> = {}) => initializeMcp(
    { getFlag: vi.fn() } as any,
    { cwd: dir, hasUI: false, mode: "print", signal: new AbortController().signal } as any,
    createMcpRuntimeOwner(),
    { config: { mcpServers, settings } },
  );

  it("spawns no bridge process at startup and records no discovery failure", async () => {
    const definitions: Record<string, ServerEntry> = {
      viaxcrun: { command: xcrun(), args: ["mcpbridge"], directTools: true },
      bare: { command: bridge(), directTools: true },
    };
    const state = await start(definitions);
    try {
      // Startup discovery and the direct-tool cache bootstrap both leave the bridge alone.
      expect(spawned()).toEqual([]);
      expect(state.manager.getConnection("viaxcrun")).toBeUndefined();
      expect(state.manager.getConnection("bare")).toBeUndefined();
      expect(loadMetadataCache()?.servers?.viaxcrun).toBeUndefined();
      expect(loadMetadataCache()?.servers?.bare).toBeUndefined();

      // Status reports a server that has not been used yet, never a failure.
      const snapshot = createMcpStatusSnapshot(state);
      for (const name of ["viaxcrun", "bare"]) {
        expect(snapshot.servers).toContainEqual(expect.objectContaining({ name, status: "not-connected" }));
      }
      expect(state.failureTracker.size).toBe(0);
    } finally {
      await state.owner.stop("test cleanup");
    }
  });

  it("leaves a stale cache entry untouched instead of marking discovery as failed", async () => {
    const definition: ServerEntry = { command: xcrun(), args: ["mcpbridge"] };
    // A cache entry for a different configuration is stale, so the server would normally be re-discovered.
    saveMetadataCache({
      version: 1,
      servers: { xcode: { configHash: "stale-hash", tools: [], resources: [], cachedAt: 1 } },
    });

    const state = await start({ xcode: definition });
    try {
      expect(spawned()).toEqual([]);
      const cached = loadMetadataCache()?.servers?.xcode;
      expect(cached?.configHash).toBe("stale-hash");
      expect(cached?.discoveryFailed).toBeUndefined();
      expect(state.failureTracker.size).toBe(0);
    } finally {
      await state.owner.stop("test cleanup");
    }
  });

  it("connects on first use and writes metadata to the cache", async () => {
    const definition: ServerEntry = { command: xcrun(), args: ["mcpbridge"] };
    const state = await start({ xcode: definition });
    try {
      expect(spawned()).toEqual([]);

      const result = await executeCall(state, "xcode_noop", {}, "xcode");
      expect(result).toMatchObject({ content: [{ type: "text", text: "ok" }] });

      expect(spawned()).toEqual(["xcrun"]);
      expect(state.manager.getConnection("xcode")?.status).toBe("connected");
      const cached = loadMetadataCache()?.servers?.xcode;
      expect(cached?.configHash).toBe(computeServerHash(definition, dir));
      expect(cached?.tools.map(tool => tool.name)).toContain("noop");
      expect(cached?.discoveryFailed).toBeUndefined();
      expect(createMcpStatusSnapshot(state).servers).toContainEqual(expect.objectContaining({ name: "xcode", status: "connected" }));
    } finally {
      await state.owner.stop("test cleanup");
    }
  });

  it.each(["eager", "keep-alive"])(
    "still connects at startup when the user sets lifecycle %s",
    async (lifecycle) => {
      const state = await start({ xcode: { command: xcrun(), args: ["mcpbridge"], lifecycle } as ServerEntry });
      try {
        expect(spawned()).toEqual(["xcrun"]);
        expect(state.manager.getConnection("xcode")?.status).toBe("connected");
        expect(loadMetadataCache()?.servers?.xcode?.tools.map(tool => tool.name)).toContain("noop");
      } finally {
        await state.owner.stop("test cleanup");
      }
    },
  );

  it("leaves non-Xcode servers on the existing startup-discovery path", async () => {
    const state = await start({
      xcode: { command: xcrun(), args: ["mcpbridge"] },
      plain: { command: shim("plain") },
    });
    try {
      // Only the ordinary server is discovered at startup; it keeps the default lazy lifecycle.
      expect(spawned()).toEqual(["plain"]);
      expect(state.manager.getConnection("xcode")).toBeUndefined();
      expect(state.toolMetadata.get("plain")?.map(tool => tool.name)).toContain("plain_noop");
      expect(loadMetadataCache()?.servers?.plain?.tools.map(tool => tool.name)).toContain("noop");
      expect(loadMetadataCache()?.servers?.xcode).toBeUndefined();
    } finally {
      await state.owner.stop("test cleanup");
    }
  });
});
