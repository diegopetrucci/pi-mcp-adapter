import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeServerHash,
  findServerCacheEntry,
  getMissingConfiguredDirectToolServers,
  getMetadataCachePath,
  isServerCacheValid,
  loadMetadataCache,
  outputShapeKey,
  resolveServerCacheEntry,
  saveMetadataCache,
  saveObservedOutput,
  serializeTools,
  serverCacheEntries,
} from "../metadata-cache.ts";
import { resolveCachedPrompts } from "../prompts.ts";
import type { MetadataCache, McpTool, ServerCacheEntry, ServerEntry } from "../types.ts";

// Two checkouts of the same repo share one server name, but their session cwd is part of the config hash.
const CHECKOUT_A = "/Users/dev/repo-checkout-a";
const CHECKOUT_B = "/Users/dev/repo-checkout-b";

function xcodeBridge(): ServerEntry {
  return { command: "xcrun", args: ["mcpbridge"] };
}

function catalogEntry(definition: ServerEntry, cwd: string, cachedAt: number, toolName = "build"): ServerCacheEntry {
  const tools: McpTool[] = [{ name: toolName, description: `runs ${toolName}`, inputSchema: { type: "object" } }];
  return {
    configHash: computeServerHash(definition, cwd),
    tools: serializeTools(tools),
    resources: [],
    cachedAt,
  };
}

function writeCacheFile(payload: unknown): void {
  const cachePath = getMetadataCachePath();
  mkdirSync(join(cachePath, ".."), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(payload), "utf-8");
}

function readCacheFile(): any {
  return JSON.parse(readFileSync(getMetadataCachePath(), "utf-8"));
}

describe("per-config metadata cache entries", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-cache-variants-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("keeps one valid entry per checkout cwd instead of overwriting the shared server name", () => {
    const definition = xcodeBridge();
    expect(computeServerHash(definition, CHECKOUT_A)).not.toBe(computeServerHash(definition, CHECKOUT_B));

    saveMetadataCache({ version: 1, servers: { xcode: catalogEntry(definition, CHECKOUT_A, 1_000, "buildA") } });
    saveMetadataCache({ version: 1, servers: { xcode: catalogEntry(definition, CHECKOUT_B, 2_000, "buildB") } });

    const cache = loadMetadataCache();
    expect(resolveServerCacheEntry(cache, "xcode", definition, 0, CHECKOUT_A)?.tools.map(tool => tool.name)).toEqual(["buildA"]);
    expect(resolveServerCacheEntry(cache, "xcode", definition, 0, CHECKOUT_B)?.tools.map(tool => tool.name)).toEqual(["buildB"]);
    // No rediscovery for either checkout: the second write did not invalidate the first checkout's entry.
    const config = { settings: { directTools: true as const }, mcpServers: { xcode: definition } };
    expect(getMissingConfiguredDirectToolServers(config, cache, undefined, CHECKOUT_A)).toEqual([]);
    expect(getMissingConfiguredDirectToolServers(config, cache, undefined, CHECKOUT_B)).toEqual([]);
  });

  it("serves prompt commands from the entry matching the current cwd", () => {
    const definition: ServerEntry = { command: "node", args: ["server.js"] };
    const entryA = catalogEntry(definition, CHECKOUT_A, 1_000);
    const entryB = catalogEntry(definition, CHECKOUT_B, 2_000);
    saveMetadataCache({
      version: 1,
      servers: {
        docs: { ...entryA, prompts: [{ name: "briefA", description: "from checkout A" }] },
      },
    });
    saveMetadataCache({
      version: 1,
      servers: {
        docs: { ...entryB, prompts: [{ name: "briefB", description: "from checkout B" }] },
      },
    });

    const config = { mcpServers: { docs: definition } };
    expect(resolveCachedPrompts(config, CHECKOUT_A).map(prompt => prompt.originalName)).toEqual(["briefA"]);
    expect(resolveCachedPrompts(config, CHECKOUT_B).map(prompt => prompt.originalName)).toEqual(["briefB"]);
  });

  it("keeps failure markers per config hash", () => {
    const definition = xcodeBridge();
    const checkoutAEntry = catalogEntry(definition, CHECKOUT_A, 1_000);
    saveMetadataCache({ version: 1, servers: { xcode: checkoutAEntry } });
    saveMetadataCache({
      version: 1,
      servers: {
        xcode: { configHash: computeServerHash(definition, CHECKOUT_B), tools: [], resources: [], discoveryFailed: true, cachedAt: 2_000 },
      },
    });

    const cache = loadMetadataCache();
    expect(findServerCacheEntry(cache, "xcode", computeServerHash(definition, CHECKOUT_A))?.tools.map(tool => tool.name)).toEqual(["build"]);
    expect(resolveServerCacheEntry(cache, "xcode", definition, 0, CHECKOUT_A)).toBeDefined();
    // The failure marker only covers checkout B's config.
    expect(resolveServerCacheEntry(cache, "xcode", definition, 0, CHECKOUT_B)).toBeUndefined();
    expect(findServerCacheEntry(cache, "xcode", computeServerHash(definition, CHECKOUT_B))?.discoveryFailed).toBe(true);
  });

  it("keeps saved output shapes on the entry of the config that observed them", () => {
    const definition = xcodeBridge();
    const entryA = catalogEntry(definition, CHECKOUT_A, 1_000);
    const entryB = catalogEntry(definition, CHECKOUT_B, 2_000);
    saveMetadataCache({ version: 1, servers: { xcode: entryA } });
    saveMetadataCache({ version: 1, servers: { xcode: entryB } });

    const toolKey = outputShapeKey(entryA.tools[0]!);
    saveObservedOutput(
      "xcode",
      definition,
      "build",
      toolKey,
      { source: "structuredContent", shape: { type: "object" } },
      CHECKOUT_A,
    );

    const cache = loadMetadataCache();
    expect(resolveServerCacheEntry(cache, "xcode", definition, 0, CHECKOUT_A)?.outputShapes).toEqual({
      build: { source: "structuredContent", shape: { type: "object" } },
    });
    expect(resolveServerCacheEntry(cache, "xcode", definition, 0, CHECKOUT_B)?.outputShapes).toBeUndefined();
  });

  it("caps the entries per server name and evicts the oldest cached entry", () => {
    const definition = xcodeBridge();
    for (let index = 0; index < 10; index += 1) {
      const cwd = `/Users/dev/checkout-${index}`;
      saveMetadataCache({ version: 1, servers: { xcode: catalogEntry(definition, cwd, 1_000 + index) } });
    }

    const file = readCacheFile();
    const cache = loadMetadataCache()!;
    expect(serverCacheEntries(cache, "xcode")).toHaveLength(8);
    expect(Object.keys(file.variants?.xcode ?? {}).length + 1).toBe(8);
    // The two oldest configs are gone; the newest is in the legacy slot older adapters read.
    for (const [index, cwd] of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].entries()) {
      const entry = findServerCacheEntry(cache, "xcode", computeServerHash(definition, `/Users/dev/checkout-${cwd}`));
      if (index < 2) expect(entry).toBeUndefined();
      else expect(entry).toBeDefined();
    }
    expect(file.servers.xcode.configHash).toBe(computeServerHash(definition, "/Users/dev/checkout-9"));
  });

  it("loads a single-entry cache file written by an older adapter", () => {
    const definition = xcodeBridge();
    const legacyEntry = catalogEntry(definition, CHECKOUT_A, 1_000);
    writeCacheFile({ version: 1, servers: { xcode: legacyEntry } });

    const cache = loadMetadataCache();
    expect(cache?.servers.xcode).toEqual(legacyEntry);
    expect(cache?.variants).toBeUndefined();
    expect(resolveServerCacheEntry(cache, "xcode", definition, 0, CHECKOUT_A)).toEqual(legacyEntry);
  });

  it("keeps entries written by two sessions that alternate full-file writes", () => {
    const definition = xcodeBridge();
    // Each session writes its own catalog against the state it read from disk, like two Pi processes.
    const sessionA = catalogEntry(definition, CHECKOUT_A, 1_000);
    const sessionB = catalogEntry(definition, CHECKOUT_B, 2_000);
    saveMetadataCache({ version: 1, servers: { xcode: sessionA } });
    saveMetadataCache({ version: 1, servers: { xcode: sessionB } });
    // Checkout A refreshes its metadata after B's write; B's entry must survive.
    saveMetadataCache({ version: 1, servers: { xcode: { ...sessionA, cachedAt: 3_000 } } });

    const cache = loadMetadataCache();
    expect(resolveServerCacheEntry(cache, "xcode", definition, 0, CHECKOUT_A)?.cachedAt).toBe(3_000);
    expect(resolveServerCacheEntry(cache, "xcode", definition, 0, CHECKOUT_B)?.cachedAt).toBe(2_000);
  });

  it("keeps the legacy slot readable and rewritable by an older adapter", () => {
    const definition = xcodeBridge();
    saveMetadataCache({ version: 1, servers: { xcode: catalogEntry(definition, CHECKOUT_A, 1_000) } });
    saveMetadataCache({ version: 1, servers: { xcode: catalogEntry(definition, CHECKOUT_B, 2_000) } });

    const file = readCacheFile();
    // 5.0.x/5.1.x validate the version and read `servers[name]` as a single entry object.
    expect(file.version).toBe(1);
    const legacyEntry = file.servers.xcode;
    expect(Array.isArray(legacyEntry)).toBe(false);
    expect(typeof legacyEntry.configHash).toBe("string");
    expect(Array.isArray(legacyEntry.tools)).toBe(true);
    expect(Array.isArray(legacyEntry.resources)).toBe(true);
    expect(legacyEntry.cachedAt).toBe(2_000);
    expect(isServerCacheValid(legacyEntry, definition, 0, CHECKOUT_B)).toBe(true);
    expect(isServerCacheValid(legacyEntry, definition, 0, CHECKOUT_A)).toBe(false);

    // An older adapter rewrites the file with only the slot it knows; the extra variants are lost, nothing breaks.
    writeCacheFile({ version: 1, servers: { xcode: { ...legacyEntry, cachedAt: 4_000 } } });
    const cache = loadMetadataCache();
    expect(cache?.servers.xcode?.cachedAt).toBe(4_000);
    expect(serverCacheEntries(cache, "xcode")).toHaveLength(1);
    expect(resolveServerCacheEntry(cache, "xcode", definition, 0, CHECKOUT_A)).toBeUndefined();
    expect(resolveServerCacheEntry(cache, "xcode", definition, 0, CHECKOUT_B)).toBeDefined();
  });

  it("drops malformed variant data instead of returning it to readers", () => {
    const definition = xcodeBridge();
    const valid = catalogEntry(definition, CHECKOUT_A, 1_000);
    writeCacheFile({
      version: 1,
      servers: { xcode: valid },
      variants: { xcode: { notAnEntry: null, alsoBad: 42, stale: { ...catalogEntry(definition, CHECKOUT_B, 2_000) } } },
    });

    const cache: MetadataCache = loadMetadataCache()!;
    expect(serverCacheEntries(cache, "xcode")).toHaveLength(2);
    expect(resolveServerCacheEntry(cache, "xcode", definition, 0, CHECKOUT_A)).toBeDefined();
    expect(resolveServerCacheEntry(cache, "xcode", definition, 0, CHECKOUT_B)).toBeDefined();
  });
});
