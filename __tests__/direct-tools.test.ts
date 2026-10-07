import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { DIRECT_TOOLS_ADVISORY_THRESHOLD, buildProxyDescription, getLargeDirectToolsAdvisory, resolveDirectTools } from "../direct-tools.ts";
import {
  computeServerHash,
  getMissingConfiguredDirectToolServers,
  isServerCacheValid,
  type MetadataCache,
} from "../metadata-cache.ts";
import { buildToolMetadata } from "../tool-metadata.ts";
import { formatToolName } from "../types.ts";
import type { McpConfig } from "../types.ts";
import { reconstructToolMetadata } from "../metadata-cache.ts";
import { updateServerMetadata } from "../init.ts";
import { markBuiltInAgentPlugin } from "../agent-plugin-provenance.ts";

const originalHashEnv = {
  MCP_HASH_CWD: process.env.MCP_HASH_CWD,
  MCP_HASH_ENV: process.env.MCP_HASH_ENV,
  MCP_HASH_HEADER: process.env.MCP_HASH_HEADER,
  MCP_HASH_TOKEN: process.env.MCP_HASH_TOKEN,
  MCP_HASH_URL: process.env.MCP_HASH_URL,
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalHashEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("formatToolName", () => {
  it("sanitizes dotted MCP tool names for every prefix mode", () => {
    expect(formatToolName("namespace.tool", "demo", "server")).toBe("demo_namespace_tool");
    expect(formatToolName("namespace.tool", "demo-mcp", "short")).toBe("demo_namespace_tool");
    expect(formatToolName("namespace.tool", "demo", "none")).toBe("namespace_tool");
    expect(formatToolName("namespace.tool", "demo-mcp", "mcp")).toBe("mcp__demo-mcp_namespace_tool");
  });

  it("sanitizes server names in live tool and resource metadata", () => {
    const { metadata } = buildToolMetadata(
      [{ name: "find", description: "Find" }] as any,
      [{ name: "guide", uri: "file://guide" }] as any,
      { command: "demo" },
      "my server",
      "server",
    );

    expect(metadata.map((tool) => tool.name)).toEqual([
      "my_20_server_find",
      "my_20_server_read_guide",
    ]);
  });
});

describe("buildProxyDescription", () => {
  it("keeps the gateway description fixed and bounded", () => {
    const description = buildProxyDescription({ mcpServers: {} });

    expect(description).toContain("MCP gateway for server status");
    expect(description).toContain("tool search");
    expect(description).toContain("Non-MCP tools should be called directly");
    expect(description).not.toMatch(/URL|install|Jev|TypeSafe|Servers:|Disabled/);
  });

  it("keeps bounded descriptions byte-stable across mixed server configurations", () => {
    const emptyConfig: McpConfig = { mcpServers: {} };
    const mixedConfig: McpConfig = {
      settings: { directTools: true, scriptMode: true, toolPrefix: "server" },
      mcpServers: {
        "enabled-server": {
          command: "enabled",
          description: "enabled instructions and enabled-only context",
          directTools: true,
          searchKeywords: { "*": ["enabled instructions"] },
          excludeTools: ["excluded_enabled_tool"],
        },
        "disabled-server": {
          command: "disabled",
          description: "Disabled servers should never be listed",
          disabled: true,
          directTools: "search",
          includeTools: ["included_disabled_tool"],
        },
        "search-mode-server": {
          command: "search",
          description: "search-mode instructions and exclusion markers",
          directTools: "search",
          includeTools: ["included_search_tool"],
          excludeTools: ["excluded_search_tool"],
          searchKeywords: { lookup: ["search-mode instructions"] },
        },
      },
    };
    const expectedWithoutScript = 'MCP gateway for server status, tool search, tool description, connection, authentication, and single MCP tool calls. Use mcp({}) for status, mcp({search: "query"}) to find tools, mcp({describe: "tool"}) for parameters, and mcp({tool: "tool", args: "{\\"key\\":\\"value\\"}"}) for one call. Non-MCP tools should be called directly.';
    const expectedWithScript = 'MCP gateway for server status, tool search, tool description, connection, authentication, and single MCP tool calls. Use mcpScript for several MCP calls with logic between them. Use mcp({}) for status, mcp({search: "query"}) to find tools, mcp({describe: "tool"}) for parameters, and mcp({tool: "tool", args: "{\\"key\\":\\"value\\"}"}) for one call. Non-MCP tools should be called directly.';

    for (const [scriptTool, expected] of [[false, expectedWithoutScript], [true, expectedWithScript]] as const) {
      const empty = buildProxyDescription(emptyConfig, scriptTool);
      const mixed = buildProxyDescription(mixedConfig, scriptTool);

      expect(empty).toBe(expected);
      expect(mixed).toBe(expected);
      expect(mixed).toBe(empty);
      expect(mixed.length).toBe(expected.length);
      expect(mixed).not.toContain("enabled-server");
      expect(mixed).not.toContain("disabled-server");
      expect(mixed).not.toContain("search-mode-server");
      expect(mixed).not.toContain("Disabled servers");
      expect(mixed).not.toContain("enabled instructions");
      expect(mixed).not.toContain("excluded_search_tool");
    }

    expect(expectedWithoutScript).not.toContain("mcpScript");
    expect(expectedWithScript).toContain("Use mcpScript");
  });

  it("does not include configured server or tool lists in the gateway description", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        figma: {
          command: "npx",
          args: ["-y", "figma"],
          excludeTools: ["get_figjam", "figma_get_screenshot"],
        },
      },
    };

    const description = buildProxyDescription(config);

    expect(description).not.toContain("figma");
    expect(description).not.toContain("get_screenshot");
  });

  it("only adds scripting guidance when the scripting tool is actually enabled", () => {
    const config: McpConfig = { settings: { scriptMode: true }, mcpServers: { demo: { command: "demo" } } };
    const withoutScript = buildProxyDescription(config, false);
    const withScript = buildProxyDescription(config, true);

    expect(withoutScript).not.toContain("mcpScript");
    expect(withScript).toContain("Use mcpScript");
    expect(withScript).not.toContain("demo");
    expect(buildProxyDescription({ mcpServers: { other: { command: "other" } } }, false)).toBe(withoutScript);
  });
});

describe("metadata cache hashing", () => {
  it("invalidates metadata when the protocol era changes", () => {
    const legacy = computeServerHash({ command: "node" });
    const automatic = computeServerHash({ command: "node", protocolVersion: "auto" });
    const modern = computeServerHash({ command: "node", protocolVersion: "2026-07-28" });

    expect(new Set([legacy, automatic, modern]).size).toBe(3);
  });

  it("invalidates cached stdio tools when inheritEnv or literalEnv changes", () => {
    const definition = { command: "node", env: { MODE: "${MODE}" } };
    const environment = { MODE: "expanded" };
    const entry = { configHash: computeServerHash(definition, environment), cachedAt: Date.now(), tools: [], resources: [] };
    const literal = { ...definition, literalEnv: true };
    const plugin = markBuiltInAgentPlugin({ ...definition }, ["env"]);

    expect(isServerCacheValid(entry, { ...definition, inheritEnv: true, literalEnv: false }, undefined, environment)).toBe(true);
    expect(isServerCacheValid(entry, { ...definition, inheritEnv: false }, undefined, environment)).toBe(false);
    expect(isServerCacheValid(entry, literal, undefined, environment)).toBe(false);
    expect(computeServerHash(literal, { MODE: "first" })).toBe(computeServerHash(literal, { MODE: "second" }));
    expect(computeServerHash(plugin, { MODE: "first" })).toBe(computeServerHash(plugin, { MODE: "second" }));
  });

  it("keeps caches from before stdio env flags were hashed valid for remote servers only", () => {
    const cached = (configHash: string) => ({ configHash, cachedAt: Date.now(), tools: [], resources: [] });

    expect(isServerCacheValid(cached("211503c5c035663196f90839c226a3f67c2e01ff7719c2ed818860072c96d8ec"), { url: "https://example.test/mcp" })).toBe(true);
    expect(isServerCacheValid(cached("c5e102840a79aec3fd3d129037f379198fb13cdcfa5ffbc96a5f314002e7d188"), { socket: "/tmp/mcp.sock" })).toBe(true);
    expect(isServerCacheValid(cached("c7cd5329512fb9b1605e786af247579d1ff2e23f694488e403295ea142b4e9ce"), { command: "node" })).toBe(false);
  });

  it("hashes interpolated URLs", () => {
    process.env.MCP_HASH_URL = "https://one.example.test/mcp";
    const first = computeServerHash({ url: "${MCP_HASH_URL}" });

    process.env.MCP_HASH_URL = "https://two.example.test/mcp";
    const second = computeServerHash({ url: "${MCP_HASH_URL}" });

    expect(first).not.toBe(second);
    expect(computeServerHash({ url: "${MCP_HASH_URL}" })).toBe(
      computeServerHash({ url: "https://two.example.test/mcp" }),
    );
  });

  it("hashes an embedding host's explicit environment", () => {
    const definition = {
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer ${PRIVATE_TOKEN}" },
    };
    const first = computeServerHash(definition, { PRIVATE_TOKEN: "first" });
    const second = computeServerHash(definition, { PRIVATE_TOKEN: "second" });

    expect(first).not.toBe(second);
    expect(computeServerHash(definition, { PRIVATE_TOKEN: "first" })).toBe(first);
    expect(isServerCacheValid({
      configHash: first,
      cachedAt: Date.now(),
      tools: [],
      resources: [],
    }, definition, undefined, { PRIVATE_TOKEN: "first" })).toBe(true);
  });

  it("does not hash URL placeholders with missing environment variables", () => {
    delete process.env.MCP_HASH_URL;

    expect(() => computeServerHash({ url: "https://${MCP_HASH_URL}/mcp" })).toThrow(
      "Missing environment variable in MCP server URL: MCP_HASH_URL",
    );
  });

  it("treats cached URL placeholders with missing environment variables as cache misses", () => {
    delete process.env.MCP_HASH_URL;

    expect(isServerCacheValid({
      configHash: "cached",
      cachedAt: Date.now(),
      tools: [],
      resources: [],
    }, { url: "https://${MCP_HASH_URL}/mcp" })).toBe(false);
  });

  it("skips cached direct tools when URL placeholders are missing", () => {
    delete process.env.MCP_HASH_URL;

    const config: McpConfig = {
      settings: { directTools: true },
      mcpServers: {
        remote: { url: "https://${MCP_HASH_URL}/mcp" },
      },
    };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        remote: {
          configHash: "cached",
          cachedAt: Date.now(),
          tools: [{ name: "search", inputSchema: { type: "object" } }],
          resources: [],
        },
      },
    };

    expect(resolveDirectTools(config, cache, "server")).toEqual([]);
  });

  it("hashes interpolated cwd", () => {
    process.env.MCP_HASH_CWD = "/tmp/mcp-one";
    const first = computeServerHash({ command: "node", cwd: "${MCP_HASH_CWD}/server" });

    process.env.MCP_HASH_CWD = "/tmp/mcp-two";
    const second = computeServerHash({ command: "node", cwd: "${MCP_HASH_CWD}/server" });

    expect(first).not.toBe(second);
    expect(computeServerHash({ command: "node", cwd: "${MCP_HASH_CWD}/server" })).toBe(
      computeServerHash({ command: "node", cwd: "/tmp/mcp-two/server" }),
    );
  });

  it("hashes the effective default cwd only for stdio servers without an explicit cwd", () => {
    const definition = { command: "node", args: ["server.js"] };

    expect(computeServerHash(definition, "/repo/a")).not.toBe(computeServerHash(definition, "/repo/b"));
    expect(computeServerHash({ ...definition, cwd: "/fixed" }, "/repo/a")).toBe(
      computeServerHash({ ...definition, cwd: "/fixed" }, "/repo/b"),
    );
    expect(computeServerHash({ url: "https://example.test/mcp" }, "/repo/a")).toBe(
      computeServerHash({ url: "https://example.test/mcp" }, "/repo/b"),
    );
  });

  it("hashes interpolated env values", () => {
    process.env.MCP_HASH_ENV = "/tmp/data-one";
    const first = computeServerHash({ command: "node", env: { DATA_DIR: "${MCP_HASH_ENV}" } });

    process.env.MCP_HASH_ENV = "/tmp/data-two";
    const second = computeServerHash({ command: "node", env: { DATA_DIR: "${MCP_HASH_ENV}" } });

    expect(first).not.toBe(second);
    expect(computeServerHash({ command: "node", env: { DATA_DIR: "${MCP_HASH_ENV}" } })).toBe(
      computeServerHash({ command: "node", env: { DATA_DIR: "/tmp/data-two" } }),
    );
  });

  it("hashes interpolated header values", () => {
    process.env.MCP_HASH_HEADER = "header-one";
    const first = computeServerHash({ url: "https://example.test/mcp", headers: { "x-root": "$env:MCP_HASH_HEADER" } });

    process.env.MCP_HASH_HEADER = "header-two";
    const second = computeServerHash({ url: "https://example.test/mcp", headers: { "x-root": "$env:MCP_HASH_HEADER" } });

    expect(first).not.toBe(second);
    expect(computeServerHash({ url: "https://example.test/mcp", headers: { "x-root": "$env:MCP_HASH_HEADER" } })).toBe(
      computeServerHash({ url: "https://example.test/mcp", headers: { "x-root": "header-two" } }),
    );
  });

  it("hashes the effective per-request header command", () => {
    process.env.MCP_SIGNER_ACTOR = "actor-one";
    const first = computeServerHash({
      url: "https://example.test/mcp",
      requestHeadersCommand: {
        command: "node",
        args: ["sign.mjs", "${MCP_SIGNER_ACTOR}"],
        env: { ACTOR: "$env:MCP_SIGNER_ACTOR" },
      },
    });

    process.env.MCP_SIGNER_ACTOR = "actor-two";
    const second = computeServerHash({
      url: "https://example.test/mcp",
      requestHeadersCommand: {
        command: "node",
        args: ["sign.mjs", "${MCP_SIGNER_ACTOR}"],
        env: { ACTOR: "$env:MCP_SIGNER_ACTOR" },
      },
    });

    expect(first).not.toBe(second);
  });

  it("hashes tilde cwd as the home directory", () => {
    expect(computeServerHash({ command: "node", cwd: "~/server" })).toBe(
      computeServerHash({ command: "node", cwd: join(homedir(), "server") }),
    );
  });

  it("hashes the effective bearerTokenEnv value", () => {
    process.env.MCP_HASH_TOKEN = "token-one";
    const first = computeServerHash({ url: "https://example.test/mcp", auth: "bearer", bearerTokenEnv: "MCP_HASH_TOKEN" });

    process.env.MCP_HASH_TOKEN = "token-two";
    const second = computeServerHash({ url: "https://example.test/mcp", auth: "bearer", bearerTokenEnv: "MCP_HASH_TOKEN" });

    expect(first).not.toBe(second);
    expect(computeServerHash({ url: "https://example.test/mcp", auth: "bearer", bearerTokenEnv: "MCP_HASH_TOKEN" })).toBe(
      computeServerHash({ url: "https://example.test/mcp", auth: "bearer", bearerToken: "token-two", bearerTokenEnv: "MCP_HASH_TOKEN" }),
    );
  });

  it("hashes interpolated bearerToken values", () => {
    process.env.MCP_HASH_TOKEN = "token-one";
    const first = computeServerHash({ url: "https://example.test/mcp", auth: "bearer", bearerToken: "${MCP_HASH_TOKEN}" });

    process.env.MCP_HASH_TOKEN = "token-two";
    const second = computeServerHash({ url: "https://example.test/mcp", auth: "bearer", bearerToken: "${MCP_HASH_TOKEN}" });

    expect(first).not.toBe(second);
    expect(computeServerHash({ url: "https://example.test/mcp", auth: "bearer", bearerToken: "$env:MCP_HASH_TOKEN" })).toBe(
      computeServerHash({ url: "https://example.test/mcp", auth: "bearer", bearerToken: "token-two" }),
    );
  });

  it("invalidates cached metadata when an interpolated bearerToken env value changes", () => {
    const definition = { url: "https://example.test/mcp", auth: "bearer" as const, bearerToken: "${MCP_HASH_TOKEN}" };
    process.env.MCP_HASH_TOKEN = "token-one";
    const entry = {
      configHash: computeServerHash(definition),
      cachedAt: Date.now(),
      tools: [],
      resources: [],
    };

    expect(isServerCacheValid(entry, definition)).toBe(true);

    process.env.MCP_HASH_TOKEN = "token-two";

    expect(isServerCacheValid(entry, definition)).toBe(false);
  });

  it("invalidates stdio cache entries across session cwd changes when cwd is implicit", () => {
    const definition = { command: "node", args: ["server.js"] };
    const entry = {
      configHash: computeServerHash(definition, "/repo/a"),
      cachedAt: Date.now(),
      tools: [],
      resources: [],
    };

    expect(isServerCacheValid(entry, definition, undefined, "/repo/a")).toBe(true);
    expect(isServerCacheValid(entry, definition, undefined, "/repo/b")).toBe(false);
  });

  it("keeps numeric maxAgeMs positional semantics alongside implicit cwd hashing", () => {
    const definition = { command: "node", args: ["server.js"] };
    const entry = {
      configHash: computeServerHash(definition, "/repo/a"),
      cachedAt: Date.now() - 2_000,
      tools: [],
      resources: [],
    };

    expect(isServerCacheValid(entry, definition, 5_000, "/repo/a")).toBe(true);
    expect(isServerCacheValid(entry, definition, 1_000, "/repo/a")).toBe(false);
    expect(isServerCacheValid(entry, definition, 5_000, "/repo/b")).toBe(false);
  });
});

describe("direct tool metadata bootstrap", () => {
  it("omits cached direct tools from servers in active failure backoff", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server", directTools: true },
      mcpServers: {
        demo: { command: "demo", directTools: true },
        failed: { command: "failed", directTools: true },
      },
    };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        demo: {
          configHash: computeServerHash(config.mcpServers.demo),
          cachedAt: Date.now(),
          tools: [{ name: "search", description: "Search" }],
          resources: [],
        },
        failed: {
          configHash: computeServerHash(config.mcpServers.failed),
          cachedAt: Date.now(),
          tools: [{ name: "stale", description: "Stale" }],
          resources: [],
        },
      },
    };

    expect(resolveDirectTools(config, cache, "server", undefined, undefined, new Set(["failed"])).map(tool => tool.prefixedName)).toEqual([
      "demo_search",
    ]);
  });

  it("keeps duplicate direct names fail-closed when one server is in backoff", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const config: McpConfig = {
      settings: { toolPrefix: "none", directTools: true, warnOnLargeDirectTools: false },
      mcpServers: {
        failed: { command: "failed" },
        healthy: { command: "healthy" },
      },
    };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        failed: {
          configHash: computeServerHash(config.mcpServers.failed),
          cachedAt: Date.now(),
          tools: [{ name: "search", description: "Failed" }],
          resources: [],
        },
        healthy: {
          configHash: computeServerHash(config.mcpServers.healthy),
          cachedAt: Date.now(),
          tools: [{ name: "search", description: "Healthy" }],
          resources: [],
        },
      },
    };

    expect(resolveDirectTools(config, cache, "none")).toEqual([]);
    expect(resolveDirectTools(config, cache, "none", undefined, undefined, new Set(["failed"]))).toEqual([]);
  });

  it("keeps healthy selector results stable when another server is in backoff", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server", directTools: true, warnOnLargeDirectTools: false },
      mcpServers: {
        "my-server": { command: "healthy", excludeTools: ["my_2d_server_search_records"] },
        my_2d_server: { command: "failed" },
      },
    };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        "my-server": {
          configHash: computeServerHash(config.mcpServers["my-server"]),
          cachedAt: Date.now(),
          tools: [{ name: "search-records", description: "Healthy" }],
          resources: [],
        },
        my_2d_server: {
          configHash: computeServerHash(config.mcpServers.my_2d_server),
          cachedAt: Date.now(),
          tools: [{ name: "search_records", description: "Failed" }],
          resources: [],
        },
      },
    };

    const withoutBackoff = resolveDirectTools(config, cache, "server").map(tool => [tool.serverName, tool.prefixedName]);
    const withBackoff = resolveDirectTools(config, cache, "server", undefined, undefined, new Set(["my_2d_server"])).map(tool => [tool.serverName, tool.prefixedName]);

    expect(withoutBackoff).toEqual([
      ["my-server", "my-server_search-records"],
      ["my_2d_server", "my_2d_server_search_records"],
    ]);
    expect(withBackoff).toEqual([
      ["my-server", "my-server_search-records"],
    ]);
  });

  it("includes env-selected servers without config-level direct tool settings", () => {
    const config: McpConfig = {
      mcpServers: {
        selected: { command: "selected-server" },
        cached: { command: "cached-server" },
        other: { command: "other-server" },
        disabled: { command: "disabled-server", disabled: true },
      },
    };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        cached: {
          configHash: computeServerHash(config.mcpServers.cached),
          cachedAt: Date.now(),
          tools: [],
          resources: [],
        },
      },
    };

    expect(getMissingConfiguredDirectToolServers(
      config,
      cache,
      ["selected/search", "cached", "disabled"],
    )).toEqual(["selected"]);
  });
});

describe("excludeTools filtering", () => {
  it("filters excluded tools from live and cached metadata", () => {
    const definition = {
      command: "npx",
      args: ["-y", "figma"],
      excludeTools: ["figma_get_screenshot", "read_figjam"],
    };

    const { metadata } = buildToolMetadata(
      [
        { name: "get_screenshot", description: "Screenshot" },
        { name: "get_nodes", description: "Nodes" },
      ] as any,
      [
        { name: "figjam", uri: "ui://figjam", description: "FigJam" },
      ] as any,
      definition,
      "figma",
      "server",
    );

    expect(metadata.map((tool) => tool.name)).toEqual(["figma_get_nodes"]);

    const reconstructed = reconstructToolMetadata(
      "figma",
      {
        configHash: computeServerHash(definition),
        cachedAt: Date.now(),
        tools: [
          { name: "get_screenshot", description: "Screenshot" },
          { name: "get_nodes", description: "Nodes" },
        ],
        resources: [{ name: "figjam", uri: "ui://figjam", description: "FigJam" }],
      },
      "server",
      definition,
    );

    expect(reconstructed.map((tool) => tool.name)).toEqual(["figma_get_nodes"]);
  });

  it("matches normalized legacy server-prefix exclusions across metadata paths", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server", directTools: true },
      mcpServers: {
        "my-server": { command: "demo", directTools: true, excludeTools: ["my_server_do_thing"] },
      },
    };
    const entry = {
      configHash: computeServerHash(config.mcpServers["my-server"]),
      cachedAt: Date.now(),
      tools: [{ name: "do_thing", description: "Do thing" }],
      resources: [],
    };
    const cache: MetadataCache = { version: 1, servers: { "my-server": entry } };

    expect(buildToolMetadata(entry.tools as any, [], config.mcpServers["my-server"], "my-server", "server", config.mcpServers).metadata).toEqual([]);
    expect(reconstructToolMetadata("my-server", entry, "server", config.mcpServers["my-server"], config.mcpServers, cache)).toEqual([]);
    expect(resolveDirectTools(config, cache, "server")).toEqual([]);
  });

  it("ignores invalid cache entries for collision candidates", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server", directTools: true },
      mcpServers: {
        "my-server": { command: "hyphen", directTools: true, excludeTools: ["my_2d_server_search_records"] },
        my_2d_server: { command: "escaped", args: ["changed"] },
      },
    };
    const currentEntry = {
      configHash: computeServerHash(config.mcpServers["my-server"]),
      cachedAt: Date.now(),
      tools: [{ name: "search-records", description: "Current" }],
      resources: [],
    };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        "my-server": currentEntry,
        my_2d_server: {
          configHash: "stale",
          cachedAt: Date.now(),
          tools: [{ name: "search_records", description: "Stale" }],
          resources: [],
        },
      },
    };

    expect(reconstructToolMetadata("my-server", currentEntry, "server", config.mcpServers["my-server"], config.mcpServers, cache)).toEqual([]);
    expect(resolveDirectTools(config, cache, "server")).toEqual([]);
  });

  it("ignores cached app-only tools for reconstructed metadata collision candidates", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        "my-server": { command: "current", excludeTools: ["my_server_do_thing"] },
        my_server: { command: "app" },
      },
    };
    const currentEntry = {
      configHash: computeServerHash(config.mcpServers["my-server"]),
      cachedAt: Date.now(),
      tools: [{ name: "do_thing", description: "Current" }],
      resources: [],
    };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        "my-server": currentEntry,
        my_server: {
          configHash: computeServerHash(config.mcpServers.my_server),
          cachedAt: Date.now(),
          tools: [{ name: "do_thing", description: "App only", uiVisibility: ["app"] }],
          resources: [],
        },
      },
    };

    expect(reconstructToolMetadata("my-server", currentEntry, "server", config.mcpServers["my-server"], config.mcpServers, cache)).toEqual([]);
  });

  it("keeps cached metadata filtering scoped to current server identities", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server", directTools: true },
      mcpServers: {
        my_2d_server: { command: "escaped", excludeTools: ["my_2d_server_do_thing"] },
        "my-server": { command: "hyphen", excludeTools: ["my_2d_server_do_thing"] },
      },
    };
    const cache: MetadataCache = {
      version: 1,
      servers: Object.fromEntries(Object.entries(config.mcpServers).map(([serverName, definition]) => [serverName, {
        configHash: computeServerHash(definition),
        cachedAt: Date.now(),
        tools: [{ name: "do_thing", description: serverName }],
        resources: [],
      }])),
    };

    expect(reconstructToolMetadata("my-server", cache.servers["my-server"]!, "server", config.mcpServers["my-server"], config.mcpServers, cache).map(tool => tool.name)).toEqual(["my-server_do_thing"]);
    expect(reconstructToolMetadata("my_2d_server", cache.servers.my_2d_server!, "server", config.mcpServers.my_2d_server, config.mcpServers, cache)).toEqual([]);
    expect(resolveDirectTools(config, cache, "server").map(tool => tool.prefixedName)).toEqual(["my-server_do_thing"]);
  });

  it("filters included tools from live and cached metadata before applying exclusions", () => {
    const definition = {
      command: "npx",
      args: ["-y", "figma"],
      includeTools: ["get_node*", "figma_read_figjam"],
      excludeTools: ["get_nodes_secret"],
    };

    const tools = [
      { name: "get_screenshot", description: "Screenshot" },
      { name: "get_nodes", description: "Nodes" },
      { name: "get_nodes_secret", description: "Secret nodes" },
    ];
    const resources = [{ name: "figjam", uri: "ui://figjam", description: "FigJam" }];

    const { metadata } = buildToolMetadata(tools as any, resources as any, definition, "figma", "server");

    expect(metadata.map((tool) => tool.name)).toEqual(["figma_get_nodes", "figma_read_figjam"]);

    const reconstructed = reconstructToolMetadata(
      "figma",
      {
        configHash: computeServerHash(definition),
        cachedAt: Date.now(),
        tools,
        resources,
      },
      "server",
      definition,
    );

    expect(reconstructed.map((tool) => tool.name)).toEqual(["figma_get_nodes", "figma_read_figjam"]);
  });

  it("honors per-server toolPrefix while building live metadata", () => {
    const { metadata } = buildToolMetadata(
      [{ name: "search", description: "Search" }] as any,
      [],
      { command: "npx", args: ["-y", "github"], toolPrefix: "none" },
      "github",
      "server",
    );

    expect(metadata.map((tool) => tool.name)).toEqual(["search"]);
  });

  it("sanitizes registered names while preserving raw MCP names", () => {
    const { metadata } = buildToolMetadata(
      [{ name: "namespace.tool", description: "Namespaced tool" }] as any,
      [],
      { command: "npx", args: ["-y", "demo"] },
      "demo",
      "server",
    );

    expect(metadata).toEqual([
      expect.objectContaining({
        name: "demo_namespace_tool",
        originalName: "namespace.tool",
      }),
    ]);
  });

  it("omits all raw tools when sanitized live metadata names collide", () => {
    const { metadata } = buildToolMetadata(
      [
        { name: "namespace.tool", description: "Dotted" },
        { name: "namespace_tool", description: "Underscored" },
        { name: "read_namespace.tool", description: "Tool before colliding resource" },
      ] as any,
      [{ name: "namespace.tool", uri: "ui://namespace.tool", description: "Resource" }] as any,
      { command: "npx", args: ["-y", "demo"] },
      "demo",
      "server",
    );

    expect(metadata).toEqual([]);
  });

  it("omits all raw tools when sanitized cached metadata names collide", () => {
    const reconstructed = reconstructToolMetadata(
      "demo",
      {
        configHash: "hash",
        cachedAt: Date.now(),
        tools: [
          { name: "namespace.tool", description: "Dotted" },
          { name: "namespace_tool", description: "Underscored" },
          { name: "read_namespace.tool", description: "Tool before colliding resource" },
        ],
        resources: [{ name: "namespace.tool", uri: "ui://namespace.tool", description: "Resource" }],
      },
      "server",
      { command: "npx", args: ["-y", "demo"] },
    );

    expect(reconstructed).toEqual([]);
  });

  it("does not register either owner of a self-prefix collision", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const definition = { command: "demo", directTools: true };
    const config = { mcpServers: { demo: definition } };
    const cache: MetadataCache = { version: 1, servers: { demo: {
      configHash: computeServerHash(definition),
      cachedAt: Date.now(),
      tools: [{ name: "search" }, { name: "demo_search" }],
      resources: [],
    } } };

    expect(resolveDirectTools(config, cache, "server")).toEqual([]);
  });

  it("filters excluded tools during direct tool registration from cache", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        figma: {
          command: "npx",
          args: ["-y", "figma"],
          directTools: true,
          excludeTools: ["figma_get_screenshot", "read_figjam"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        figma: {
          configHash: computeServerHash(config.mcpServers.figma),
          cachedAt: Date.now(),
          tools: [
            { name: "get_screenshot", description: "Screenshot" },
            { name: "get_nodes", description: "Nodes" },
          ],
          resources: [
            { name: "figjam", uri: "ui://figjam", description: "FigJam" },
          ],
        },
      },
    };

    const specs = resolveDirectTools(config, cache, "server");

    expect(specs.map((spec) => spec.prefixedName)).toEqual(["figma_get_nodes"]);
  });

  it("registers servers that previously collided after prefix escaping", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server", directTools: true },
      mcpServers: {
        "a b": { command: "first" },
        "a-20-b": { command: "second" },
      },
    };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        "a b": {
          configHash: computeServerHash(config.mcpServers["a b"]),
          cachedAt: Date.now(),
          tools: [{ name: "search", description: "First" }],
          resources: [],
        },
        "a-20-b": {
          configHash: computeServerHash(config.mcpServers["a-20-b"]),
          cachedAt: Date.now(),
          tools: [{ name: "search", description: "Second" }],
          resources: [],
        },
      },
    };

    expect(resolveDirectTools(config, cache, "server").map((spec) => [spec.serverName, spec.prefixedName])).toEqual([
      ["a b", "a_20_b_search"],
      ["a-20-b", "a-20-b_search"],
    ]);
  });

  it("keeps provider-valid server prefix characters and skips escaped-name collisions", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config: McpConfig = {
      settings: { toolPrefix: "server", directTools: true, warnOnLargeDirectTools: false },
      mcpServers: {
        "my_server": { command: "underscore" },
        "my-server": { command: "hyphen" },
        "my server": { command: "space" },
        "my_20_server": { command: "escaped" },
      },
    };
    const cache: MetadataCache = {
      version: 1,
      servers: Object.fromEntries(Object.entries(config.mcpServers).map(([serverName, definition]) => [serverName, {
        configHash: computeServerHash(definition),
        cachedAt: Date.now(),
        tools: [{ name: "get", description: serverName }],
        resources: [],
      }])),
    };

    expect(resolveDirectTools(config, cache, "server").map((spec) => [spec.serverName, spec.prefixedName])).toEqual([
      ["my_server", "my_server_get"],
      ["my-server", "my-server_get"],
    ]);
    expect(warn).toHaveBeenCalledWith('MCP: skipping colliding direct name "my_20_server_get" from "my server", "my_20_server"');
  });

  it("honors per-server toolPrefix during direct tool registration from cache", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "none" },
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "github"],
          directTools: true,
          toolPrefix: "server",
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        github: {
          configHash: computeServerHash(config.mcpServers.github),
          cachedAt: Date.now(),
          tools: [{ name: "search", description: "Search" }],
          resources: [],
        },
      },
    };

    const specs = resolveDirectTools(config, cache, "none");

    expect(specs.map((spec) => spec.prefixedName)).toEqual(["github_search"]);
  });

  it("resolves tools deterministically and reports the advisory at the eager-tool threshold", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tools = Array.from({ length: DIRECT_TOOLS_ADVISORY_THRESHOLD }, (_, index) => ({
      name: `tool_${index}`,
      description: `Tool ${index}`,
    }));
    const config: McpConfig = {
      mcpServers: {
        huge: {
          command: "npx",
          args: ["-y", "huge"],
          directTools: true,
        },
      },
    };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        huge: {
          configHash: computeServerHash(config.mcpServers.huge),
          cachedAt: Date.now(),
          tools,
          resources: [],
        },
      },
    };

    const specs = resolveDirectTools(config, cache, "server");

    expect(specs).toHaveLength(DIRECT_TOOLS_ADVISORY_THRESHOLD);
    expect(warn).not.toHaveBeenCalled();
    expect(getLargeDirectToolsAdvisory(config, specs)).toEqual(expect.stringContaining("75+ direct tools"));
    expect(getLargeDirectToolsAdvisory(config, specs)).toEqual(expect.stringContaining("settings.warnOnLargeDirectTools to false"));
    expect(getLargeDirectToolsAdvisory(config, specs.slice(0, -1))).toBeUndefined();
    expect(getLargeDirectToolsAdvisory(config, specs.map((spec) => ({ ...spec, lazy: true })))).toBeUndefined();
  });

  it("suppresses the large direct-tools advisory when configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tools = Array.from({ length: DIRECT_TOOLS_ADVISORY_THRESHOLD }, (_, index) => ({
      name: `tool_${index}`,
      description: `Tool ${index}`,
    }));
    const config: McpConfig = {
      settings: { warnOnLargeDirectTools: false },
      mcpServers: {
        huge: {
          command: "npx",
          args: ["-y", "huge"],
          directTools: true,
        },
      },
    };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        huge: {
          configHash: computeServerHash(config.mcpServers.huge),
          cachedAt: Date.now(),
          tools,
          resources: [],
        },
      },
    };

    const specs = resolveDirectTools(config, cache, "server");

    expect(specs).toHaveLength(DIRECT_TOOLS_ADVISORY_THRESHOLD);
    expect(warn).not.toHaveBeenCalled();
    expect(getLargeDirectToolsAdvisory(config, specs)).toBeUndefined();
  });

  it("filters included tools during direct tool registration from cache", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        figma: {
          command: "npx",
          args: ["-y", "figma"],
          directTools: true,
          includeTools: ["get_node*", "figma_read_figjam"],
          excludeTools: ["get_nodes_secret"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        figma: {
          configHash: computeServerHash(config.mcpServers.figma),
          cachedAt: Date.now(),
          tools: [
            { name: "get_screenshot", description: "Screenshot" },
            { name: "get_nodes", description: "Nodes" },
            { name: "get_nodes_secret", description: "Secret nodes" },
          ],
          resources: [{ name: "figjam", uri: "ui://figjam", description: "FigJam" }],
        },
      },
    };

    const specs = resolveDirectTools(config, cache, "server");

    expect(specs.map((spec) => spec.prefixedName)).toEqual(["figma_get_nodes", "figma_read_figjam"]);
  });

  it("applies safe legacy exclusions alongside unrelated current selectors", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server", directTools: true },
      mcpServers: {
        "my-server": { command: "demo", excludeTools: ["my-server_other", "my_2d_server_search_records"] },
      },
    };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        "my-server": {
          configHash: computeServerHash(config.mcpServers["my-server"]),
          cachedAt: Date.now(),
          tools: [
            { name: "search-records", description: "Search" },
            { name: "other", description: "Other" },
          ],
          resources: [],
        },
      },
    };

    expect(resolveDirectTools(config, cache, "server")).toEqual([]);
    expect(buildToolMetadata(cache.servers["my-server"]!.tools as any, [], config.mcpServers["my-server"], "my-server", "server", config.mcpServers).metadata).toEqual([]);
  });

  it("keeps a same-server tool when another current sibling matches the selector", () => {
    const definition = { command: "demo", excludeTools: ["search_records"] };
    const tools = [
      { name: "search-records", description: "Hyphen" },
      { name: "search_records", description: "Underscore" },
    ] as any;

    expect(buildToolMetadata(tools, [], definition, "demo", "server", { demo: definition }).metadata.map(tool => tool.name)).toEqual(["demo_search-records"]);
    const state = {
      config: { settings: { toolPrefix: "server" }, mcpServers: { demo: definition } },
      toolMetadata: new Map(),
      resourceCounts: new Map(),
      promptMetadata: new Map(),
      promptMetadataLive: new Set(),
      serverInstructions: new Map(),
      manager: { getConnection: () => ({ status: "connected", tools, resources: [], prompts: [] }) },
    } as any;
    updateServerMetadata(state, "demo");
    expect(state.toolMetadata.get("demo")?.map((tool: any) => tool.name)).toEqual(["demo_search-records"]);
  });

  it("ignores stale same-server metadata during live updates", () => {
    const definition = { command: "demo", excludeTools: ["demo_search_records"] };
    const staleMetadata = [{ name: "demo_search_records", originalName: "search_records", description: "Old" }];
    const tools = [{ name: "search-records", description: "New" }] as any;

    expect(buildToolMetadata(tools, [], definition, "demo", "server", { demo: definition }, new Map([["demo", staleMetadata]])).metadata).toEqual([]);
    const state = {
      config: { settings: { toolPrefix: "server" }, mcpServers: { demo: definition } },
      toolMetadata: new Map([["demo", staleMetadata]]),
      resourceCounts: new Map(),
      promptMetadata: new Map(),
      promptMetadataLive: new Set(),
      serverInstructions: new Map(),
      manager: { getConnection: () => ({ status: "connected", tools, resources: [], prompts: [] }) },
    } as any;
    updateServerMetadata(state, "demo");
    expect(state.toolMetadata.get("demo")).toEqual([]);
  });

  it("does not synthesize unavailable servers when live metadata is known", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        "my-server": { command: "demo", excludeTools: ["my_2d_server_search_records"] },
        my_2d_server: { command: "unknown" },
      },
    };

    expect(buildToolMetadata(
      [{ name: "search-records", description: "Search" }] as any,
      [],
      config.mcpServers["my-server"],
      "my-server",
      "server",
      config.mcpServers,
      new Map(),
    ).metadata).toEqual([]);
  });

  it("uses missing configured candidates only for startup metadata", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        "my-server": { command: "demo", excludeTools: ["my_server_do_thing"] },
        my_server: { command: "other" },
      },
    };

    expect(buildToolMetadata(
      [{ name: "do_thing", description: "Current" }] as any,
      [],
      config.mcpServers["my-server"],
      "my-server",
      "server",
      config.mcpServers,
      new Map(),
      true,
    ).metadata.map(tool => tool.name)).toEqual(["my-server_do_thing"]);
  });

  it("normalizes missing startup candidates for hyphenated tool names", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        "my-server": { command: "demo", excludeTools: ["my_server_do_thing"] },
        my_server: { command: "other" },
      },
    };

    expect(buildToolMetadata(
      [{ name: "do-thing", description: "Current" }] as any,
      [],
      config.mcpServers["my-server"],
      "my-server",
      "server",
      config.mcpServers,
      new Map(),
      true,
    ).metadata.map(tool => tool.name)).toEqual(["my-server_do-thing"]);
  });

  it("uses known live metadata to keep a safe legacy selector scoped", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        "my-server": { command: "hyphen", excludeTools: ["my_2d_server_search_records"] },
        my_2d_server: { command: "escaped" },
      },
    };
    const knownMetadata = new Map([["my_2d_server", [{ name: "my_2d_server_search_records", originalName: "search_records", description: "Other" }]]]);

    expect(buildToolMetadata(
      [{ name: "search-records", description: "Search" }] as any,
      [],
      config.mcpServers["my-server"],
      "my-server",
      "server",
      config.mcpServers,
      knownMetadata,
    ).metadata.map(tool => tool.name)).toEqual(["my-server_search-records"]);
  });

  it("uses known state metadata during live updates", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const state = {
      config: {
        settings: { toolPrefix: "server" },
        mcpServers: {
          "my-server": { command: "hyphen", excludeTools: ["search_records"] },
          my_2d_server: { command: "escaped" },
        },
      },
      toolMetadata: new Map([["my_2d_server", [{ name: "my_2d_server_search_records", originalName: "search_records", description: "Other" }]]]),
      resourceCounts: new Map(),
      promptMetadata: new Map(),
      promptMetadataLive: new Set(),
      serverInstructions: new Map(),
      manager: {
        getConnection: (name: string) => name === "my-server" ? {
          status: "connected",
          tools: [{ name: "search-records", description: "Search" }],
          resources: [],
          prompts: [],
          client: { callTool },
        } : undefined,
        getRequestOptions: () => undefined,
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    updateServerMetadata(state, "my-server");
    expect(state.toolMetadata.get("my-server").map((tool: any) => tool.name)).toEqual(["my-server_search-records"]);
    const { executeCall } = await import("../proxy-modes.ts");
    await expect(executeCall(state, "my-server_search-records", {})).resolves.toMatchObject({ details: { server: "my-server", tool: "search-records" } });
    expect(callTool).toHaveBeenCalledOnce();
    await expect(executeCall(state, "my-server_search-records", { token: undefined })).rejects.toThrow(
      "tool arguments: value at token is not JSON-serializable",
    );
    expect(callTool).toHaveBeenCalledOnce();
  });

  it("does not apply live legacy exclusions to another server's current tool name", () => {
    const configuredServers = {
      "my-server": { command: "hyphen", excludeTools: ["my_2d_server_do_thing"] },
      my_2d_server: { command: "escaped", excludeTools: ["my_2d_server_do_thing"] },
    };
    const tools = [{ name: "do_thing", description: "Do thing" }] as any;

    expect(buildToolMetadata(tools, [], configuredServers["my-server"], "my-server", "server", configuredServers).metadata.map(tool => tool.name)).toEqual([
      "my-server_do_thing",
    ]);
    expect(buildToolMetadata(tools, [], configuredServers.my_2d_server, "my_2d_server", "server", configuredServers).metadata).toEqual([]);
  });

  it("does not apply legacy exclusions to another server's current tool name", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server", directTools: true },
      mcpServers: {
        "my-server": { command: "hyphen", excludeTools: ["my_2d_server_do_thing"] },
        my_2d_server: { command: "escaped", excludeTools: ["my_2d_server_do_thing"] },
      },
    };
    const cache: MetadataCache = {
      version: 1,
      servers: Object.fromEntries(Object.entries(config.mcpServers).map(([serverName, definition]) => [serverName, {
        configHash: computeServerHash(definition),
        cachedAt: Date.now(),
        tools: [{ name: "do_thing", description: serverName }],
        resources: [],
      }])),
    };

    expect(resolveDirectTools(config, cache, "server").map(spec => [spec.serverName, spec.prefixedName])).toEqual([
      ["my-server", "my-server_do_thing"],
    ]);
  });

  it("matches mcp-prefixed exclusions when toolPrefix is mcp", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "mcp" },
      mcpServers: {
        "my-server": {
          command: "npx",
          args: ["-y", "my-server"],
          directTools: true,
          excludeTools: ["mcp__my_2d_server_do_thing"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        "my-server": {
          configHash: computeServerHash(config.mcpServers["my-server"]),
          cachedAt: Date.now(),
          tools: [
            { name: "do_thing", description: "Does a thing" },
            { name: "other_tool", description: "Another tool" },
          ],
          resources: [],
        },
      },
    };

    const specs = resolveDirectTools(config, cache, "mcp");

    expect(specs.map((spec) => spec.prefixedName)).toEqual(["mcp__my-server_other_tool"]);
  });

  it("matches prefixed exclusions even when toolPrefix is none", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "none" },
      mcpServers: {
        figma: {
          command: "npx",
          args: ["-y", "figma"],
          directTools: true,
          excludeTools: ["figma_get_screenshot"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        figma: {
          configHash: computeServerHash(config.mcpServers.figma),
          cachedAt: Date.now(),
          tools: [
            { name: "get_screenshot", description: "Screenshot" },
            { name: "get_nodes", description: "Nodes" },
          ],
          resources: [],
        },
      },
    };

    const specs = resolveDirectTools(config, cache, "none");

    expect(specs.map((spec) => spec.prefixedName)).toEqual(["get_nodes"]);
  });
});
