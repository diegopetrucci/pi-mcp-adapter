import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getDirectToolParametersSchema,
  getMissingConfiguredDirectToolServers,
  MCP_PROXY_TOOL_PARAMETERS_SCHEMA,
} from "../startup-mcp-facade.ts";
import { computeServerHash, type MetadataCache } from "../metadata-cache.ts";
import type { McpConfig } from "../types.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("startup MCP facade support", () => {
  it("reports direct-tool servers whose cache is missing or stale", () => {
    const config: McpConfig = {
      settings: { directTools: true },
      mcpServers: {
        fresh: { command: "npx", args: ["-y", "fresh-server"] },
        stale: { command: "npx", args: ["-y", "stale-server"] },
        missing: { command: "npx", args: ["-y", "missing-server"] },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        fresh: {
          configHash: computeServerHash(config.mcpServers.fresh),
          cachedAt: Date.now(),
          tools: [],
          resources: [],
        },
        stale: {
          configHash: "stale-hash",
          cachedAt: Date.now(),
          tools: [],
          resources: [],
        },
      },
    };

    expect(getMissingConfiguredDirectToolServers(config, cache)).toEqual(["stale", "missing"]);
  });

  it("provides the same startup-time schemas used by index registration", () => {
    expect(getDirectToolParametersSchema({ inputSchema: undefined })).toMatchObject({
      type: "object",
      properties: {},
    });
    expect(MCP_PROXY_TOOL_PARAMETERS_SCHEMA).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        tool: expect.any(Object),
        args: expect.any(Object),
        connect: expect.any(Object),
        describe: expect.any(Object),
        search: expect.any(Object),
        regex: expect.any(Object),
        includeSchemas: expect.any(Object),
        server: expect.any(Object),
        action: expect.any(Object),
      }),
    });
  });

  it("avoids heavy runtime imports on the startup helper path", () => {
    const source = readFileSync(join(repoRoot, "startup-mcp-facade.ts"), "utf-8");

    for (const forbidden of [
      "./commands.ts",
      "./init.ts",
      "./proxy-modes.ts",
      "./direct-tools.ts",
      "./mcp-auth-flow.ts",
      "./server-manager.ts",
      "./mcp-panel.ts",
      "./mcp-setup-panel.ts",
      "open",
      "recheck",
      "@earendil-works/pi-ai",
      "@modelcontextprotocol/sdk",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
