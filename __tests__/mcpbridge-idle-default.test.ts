import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeMcp } from "../init.ts";
import { computeServerHash } from "../metadata-cache.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import type { ServerEntry } from "../types.ts";
import { defaultIdleTimeoutFor } from "../idle-defaults.ts";

describe("defaultIdleTimeoutFor", () => {
  it.each([
    [{ command: "xcrun", args: ["mcpbridge"] }, 0],
    [{ command: "/usr/bin/xcrun", args: ["mcpbridge"] }, 0],
    [{ command: "mcpbridge" }, 0],
    [{ command: "/Applications/Xcode.app/Contents/Developer/usr/bin/mcpbridge", args: ["--x"] }, 0],
    [{ command: "xcrun", args: ["--sdk", "macosx", "mcpbridge"] }, 0],
    [{ command: "xcrun", args: ["--toolchain", "X", "mcpbridge"] }, 0],
    [{ command: "xcrun", args: ["simctl"] }, undefined],
    [{ command: "xcrun" }, undefined],
    [{ command: "node", args: ["mcpbridge"] }, undefined],
    [{ url: "https://example.com/mcpbridge" }, undefined],
  ] as [ServerEntry, number | undefined][])("%j -> %s", (definition, expected) => {
    expect(defaultIdleTimeoutFor(definition)).toBe(expected);
  });
});

describe("mcpbridge idle default in initializeMcp", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-mcp-mcpbridge-idle-"));
    process.env.PI_CODING_AGENT_DIR = dir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(dir, { recursive: true, force: true });
  });

  const fixture = fileURLToPath(new URL("./fixtures/prompts-server.mjs", import.meta.url));
  // Stand-ins named like Xcode's bridge that forward to a real fixture server.
  const script = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  const start = (mcpServers: Record<string, ServerEntry>, settings: Record<string, unknown> = {}) => initializeMcp(
    { getFlag: vi.fn() } as any,
    { cwd: dir, hasUI: false, mode: "print", signal: new AbortController().signal } as any,
    createMcpRuntimeOwner(),
    { config: { mcpServers, settings } },
  );

  const idleMs = (state: Awaited<ReturnType<typeof start>>, name: string) =>
    (state.lifecycle as any).getIdleTimeout(name);

  it.skipIf(process.platform === "win32")("keeps lazy mcpbridge servers resident through discovery and exempt from idle shutdown", async () => {
    const xcrun = script("xcrun", `shift\nexec "${process.execPath}" "${fixture}" xcrun`);
    const bare = script("mcpbridge", `exec "${process.execPath}" "${fixture}" bare`);
    const definitions: Record<string, ServerEntry> = {
      viaxcrun: { command: xcrun, args: ["mcpbridge"] },
      bare: { command: bare },
      explicit: { command: bare, idleTimeout: 3 },
      plain: { command: process.execPath, args: [fixture, "plain"] },
    };
    // The default must not leak into definitions, which would change approval/cache hashes.
    const before = Object.fromEntries(Object.entries(definitions).map(([n, d]) => [n, computeServerHash(d, dir)]));

    const state = await start(definitions, { idleTimeout: 7 });
    try {
      const connected = [...state.manager.getAllConnections()].map(([name]) => name).sort();
      expect(connected).toContain("viaxcrun");
      expect(connected).toContain("bare");
      expect(connected).not.toContain("plain");
      expect(idleMs(state, "viaxcrun")).toBe(0);
      expect(idleMs(state, "bare")).toBe(0);
      expect(idleMs(state, "explicit")).toBe(3 * 60_000);
      expect(idleMs(state, "plain")).toBe(7 * 60_000);
      for (const [n, d] of Object.entries(definitions)) {
        expect(computeServerHash(d, dir)).toBe(before[n]);
        expect(d.idleTimeout).toBe(n === "explicit" ? 3 : undefined);
      }
    } finally {
      await state.owner.stop("test cleanup");
    }
  });

  it("plain lazy servers keep the default 10 minute idle timeout", async () => {
    const state = await start({ plain: { command: process.execPath, args: [fixture, "plain"] } });
    try {
      expect(idleMs(state, "plain")).toBe(10 * 60_000);
    } finally {
      await state.owner.stop("test cleanup");
    }
  });
});
