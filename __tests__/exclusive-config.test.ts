import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findAvailableImportConfigs,
  getMcpDiscoverySummary,
  getPiGlobalConfigPath,
  getServerProvenance,
  loadMcpConfig,
  writeDirectToolsConfig,
  writeSharedServerEntry,
} from "../config.ts";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("exclusive MCP config", () => {
  it.each(["exclusive", "merge"])("reloads queued URL writes at the active project path in %s mode", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-config-reload-"));
    roots.push(root);
    const destination = join(root, ".mcp.json");
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    vi.stubEnv("PI_MCP_CONFIG_MODE", mode);
    const prior = { url: "https://prior.example/mcp", headers: { "X-Service": "retained" } };
    await writeConfig(destination, { custom: { retained: true }, mcpServers: { prior } });
    const installed = { first: { url: "https://first.example/mcp" }, second: { url: "https://second.example/mcp" } };
    await Promise.all(Object.entries(installed).map(([name, entry]) =>
      withFileMutationQueue(destination, async () => { writeSharedServerEntry(destination, name, entry); }),
    ));
    expect(loadMcpConfig(destination, root).mcpServers).toMatchObject({ prior, ...installed });
    expect(JSON.parse(await readFile(destination, "utf8"))).toEqual({ custom: { retained: true }, mcpServers: { prior, ...installed } });
  });

  it("keeps an explicit override read-only while persisting adapter-only changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-exclusive-read-only-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    const override = join(root, "external.json");
    const overrideConfig = {
      mcpServers: {
        chosen: {
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer secret" },
          bearerToken: "secret",
        },
      },
    };
    await Promise.all([
      writeConfig(join(agentDir, "mcp-adapter.json"), { mcpServers: {} }),
      writeConfig(override, overrideConfig),
    ]);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_MCP_CONFIG_MODE", "exclusive");

    const before = await readFile(override, "utf8");
    const config = loadMcpConfig(override, workspace);
    writeDirectToolsConfig(
      new Map([["chosen", true]]),
      getServerProvenance(override, workspace),
      config,
      undefined,
      workspace,
    );

    expect(await readFile(override, "utf8")).toBe(before);
    expect(JSON.parse(await readFile(getPiGlobalConfigPath(undefined, workspace), "utf8"))).toEqual({
      mcpServers: { chosen: { directTools: true } },
    });
    expect(loadMcpConfig(override, workspace).mcpServers.chosen).toEqual({
      ...overrideConfig.mcpServers.chosen,
      directTools: true,
    });
  });

  it("projects only canonical adapter state over an arbitrary exclusive source", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-exclusive-overlay-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    const override = join(workspace, "external.json");
    await Promise.all([
      writeConfig(override, { mcpServers: { chosen: { command: "chosen", url: "https://chosen.example/mcp" } } }),
      writeConfig(join(workspace, ".vscode", "mcp.json"), { mcpServers: { imported: { command: "imported" } } }),
      writeConfig(join(agentDir, "mcp-adapter.json"), {
        imports: ["vscode"],
        settings: { directTools: true, toolPrefix: "none" },
        mcpServers: {
          chosen: { command: "must-not-replace", url: "https://must-not-replace", env: { SECRET: "must-not-copy" }, directTools: ["chosen_tool"], disabled: true },
          unrelated: { command: "must-not-load", directTools: true },
        },
      }),
    ]);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_MCP_CONFIG_MODE", "exclusive");

    const { getMcpDiscoverySummary, loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig(override, workspace);
    expect(config.settings).toMatchObject({ directTools: true, toolPrefix: "none" });
    expect(config.mcpServers).toEqual({
      chosen: { command: "chosen", url: "https://chosen.example/mcp", directTools: ["chosen_tool"], disabled: true },
      imported: { command: "imported" },
    });
    expect(config.mcpServers).not.toHaveProperty("unrelated");
    expect(getMcpDiscoverySummary(override, workspace).sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "explicit-read-only", kind: "explicit", serverCount: 1 }),
      expect.objectContaining({ id: "pi-adapter-overlay", kind: "pi", serverCount: 0 }),
    ]));
  });

  it("loads the private agent config by default and honors an explicit override", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-exclusive-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    const override = join(root, "hostile-override.json");
    await Promise.all([
      writeConfig(join(agentDir, "mcp-adapter.json"), {
        imports: ["vscode"],
        mcpServers: { exact_root: { command: "node", args: ["exact-root"] } },
      }),
      writeConfig(join(workspace, ".mcp.json"), {
        mcpServers: { hostile_project: { command: "node", args: ["hostile-project"] } },
      }),
      writeConfig(join(workspace, ".pi", "mcp.json"), {
        mcpServers: { hostile_pi: { command: "node", args: ["hostile-pi"] } },
      }),
      writeConfig(join(workspace, ".vscode", "mcp.json"), {
        mcpServers: { explicit_vscode: { command: "node", args: ["explicit-vscode"] } },
      }),
      writeConfig(override, {
        mcpServers: { chosen: { command: "node", args: ["chosen"] } },
      }),
    ]);

    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_MCP_CONFIG_MODE", "exclusive");

    const config = loadMcpConfig(undefined, workspace);
    expect(Object.keys(config.mcpServers).sort()).toEqual(["exact_root", "explicit_vscode"]);
    expect(findAvailableImportConfigs(workspace)).toEqual([]);
    const discovery = getMcpDiscoverySummary(undefined, workspace);
    expect(discovery.sources.map(({ id }) => id)).toEqual(["pi-global"]);
    expect(discovery.imports.map(({ kind }) => kind)).toEqual(["vscode"]);
    expect(discovery.agentPlugins).toEqual([]);
    expect(discovery.hostConfigDiscovery).toBe("off");

    const overrideConfig = loadMcpConfig(override, workspace);
    expect(overrideConfig.mcpServers).toEqual({
      chosen: { command: "node", args: ["chosen"] },
      explicit_vscode: { command: "node", args: ["explicit-vscode"] },
    });
    const overrideDiscovery = getMcpDiscoverySummary(override, workspace);
    expect(overrideDiscovery.sources).toEqual([
      expect.objectContaining({ id: "explicit-read-only", kind: "explicit", path: override, exists: true, serverCount: 1 }),
      expect.objectContaining({ id: "pi-adapter-overlay", kind: "pi", exists: true, serverCount: 0 }),
    ]);
    expect(overrideDiscovery.imports).toEqual([
      expect.objectContaining({ kind: "vscode", serverCount: 1 }),
    ]);
  });
});

async function writeConfig(filePath: string, config: unknown): Promise<void> {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`);
}
