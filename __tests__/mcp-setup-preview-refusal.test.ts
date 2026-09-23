import { lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function discovery(imports: Array<{ kind: "cursor"; path: string; serverCount: number }> = []): any {
  return {
    sources: [],
    imports,
    hostConfigs: [],
    hostConfigDiscovery: "off",
    agentPlugins: [],
    conflicts: [],
    hasAnyConfig: false,
    hasAnyDetectedPaths: false,
    hasSharedServers: false,
    hasPiOwnedServers: false,
    totalServerCount: 0,
    fingerprint: "test",
    repoPrompt: { configured: false },
  };
}

function previewCallbacks(overrides: Record<string, unknown> = {}): any {
  const preview = {
    path: "/tmp/mcp.json",
    existed: false,
    changed: true,
    beforeText: "",
    afterText: "{}\n",
    diffText: "--- before\n+++ after\n",
  };
  return {
    previewImports: () => preview,
    previewStarterConfig: () => preview,
    previewRepoPrompt: () => null,
    previewKnownServer: () => preview,
    adoptImports: async () => ({ added: [], path: preview.path }),
    scaffoldConfig: async () => ({ path: preview.path }),
    addRepoPrompt: async () => ({ path: preview.path, serverName: "repoprompt" }),
    addKnownServer: async (preset: { name: string }) => ({ path: preview.path, serverName: preset.name }),
    openPath: async () => {},
    markSetupCompleted: () => {},
    ...overrides,
  };
}

describe("MCP setup write-preview refusals", () => {
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

  it("renders a refusal instead of throwing when the Pi global path aliases Cursor", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-setup-pi-alias-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-setup-pi-alias-cwd-"));
    process.env.HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;
    process.chdir(cwd);

    const cursorPath = join(home, ".cursor", "mcp.json");
    const piPath = join(home, ".pi", "agent", "mcp.json");
    writeJson(cursorPath, { mcpServers: { cursor: { command: "cursor" } } });
    mkdirSync(dirname(piPath), { recursive: true });
    symlinkSync(cursorPath, piPath);

    const config = await import("../config.ts");
    const { createMcpSetupPanel } = await import("../mcp-setup-panel.ts");
    const adoptImports = vi.fn(async () => ({ added: ["cursor" as const], path: piPath }));
    const callbacks = previewCallbacks({
      previewImports: (imports: string[]) => config.previewCompatibilityImports(imports as ["cursor"], undefined, cwd),
      adoptImports,
    });
    const panel = createMcpSetupPanel(
      discovery([{ kind: "cursor", path: cursorPath, serverCount: 1 }]),
      callbacks,
      { mode: "setup", onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false } },
      { requestRender: () => {} },
      () => {},
    );

    const output = panel.render(120).join("\n");
    expect(output).toContain("Write refused:");
    expect(output).toContain("No changes will be made.");
    panel.handleInput("\r");
    expect(adoptImports).not.toHaveBeenCalled();
    expect(lstatSync(piPath).isSymbolicLink()).toBe(true);
    panel.dispose();
  });

  it("renders a refusal when the global shared path aliases Cursor", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-setup-shared-alias-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-setup-shared-alias-cwd-"));
    process.env.HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;
    process.chdir(cwd);

    const cursorPath = join(home, ".cursor", "mcp.json");
    const sharedPath = join(home, ".config", "mcp", "mcp.json");
    writeJson(cursorPath, { mcpServers: { cursor: { command: "cursor" } } });
    mkdirSync(dirname(sharedPath), { recursive: true });
    symlinkSync(cursorPath, sharedPath);

    const config = await import("../config.ts");
    const { createMcpSetupPanel } = await import("../mcp-setup-panel.ts");
    const scaffoldConfig = vi.fn(async () => ({ path: sharedPath }));
    const panel = createMcpSetupPanel(
      discovery(),
      previewCallbacks({
        previewStarterConfig: (target: "project" | "global") => config.previewStarterSharedConfig(target, cwd),
        scaffoldConfig,
      }),
      { mode: "setup", onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false } },
      { requestRender: () => {} },
      () => {},
    );

    // Select the global target and then its starter action before the first
    // render that evaluates the write preview.
    panel.handleInput("\x1b[B");
    panel.handleInput("\r");
    panel.handleInput("\x1b[B");
    panel.handleInput("\x1b[B");
    const output = panel.render(120).join("\n");
    expect(output).toContain("Write refused:");
    expect(output).toContain("No changes will be made.");
    panel.handleInput("\r");
    expect(scaffoldConfig).not.toHaveBeenCalled();
    expect(lstatSync(sharedPath).isSymbolicLink()).toBe(true);
    panel.dispose();
  });
});
