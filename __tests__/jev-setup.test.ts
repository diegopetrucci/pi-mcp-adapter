import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupJevSemanticSearch } from "../commands.ts";
import {
  getPiGlobalConfigPath,
  getPiMcpGlobalConfigPath,
  getProjectPiConfigPath,
  loadMcpConfig,
  writeJevSemanticSearchConfig,
} from "../config.ts";
import type { McpExtensionState } from "../state.ts";

const mocks = vi.hoisted(() => ({
  resolveJevCredential: vi.fn(() => ({ status: "present", source: "keyring", apiKey: "test-key" })),
}));

vi.mock("../jev-key-store.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jev-key-store.ts")>()),
  resolveJevCredential: mocks.resolveJevCredential,
}));

function state(): McpExtensionState {
  return {
    config: {
      mcpServers: {
        zeta: { command: "zeta" },
        disabled: { command: "disabled", disabled: true },
        alpha: { command: "alpha" },
      },
    },
  } as McpExtensionState;
}

afterEach(() => vi.unstubAllEnvs());

describe("Jev setup", () => {
  it("enables semantic search for confirmed servers and preserves other settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-jev-setup-"));
    const path = join(root, ".pi", "mcp-adapter.json");
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(path, '{"settings":{"scriptMode":true},"custom":"kept"}\n');
    const ui = {
      select: vi.fn(async () => "Use all 2 enabled servers (default)"),
      confirm: vi.fn(async () => true),
      notify: vi.fn(),
    };
    const currentState = state();
    currentState.config.settings = { jev: { scriptEvaluation: true, allowedServers: ["prior"] } };

    expect(await setupJevSemanticSearch(currentState, { hasUI: true, cwd: root, ui } as any, path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      settings: {
        scriptMode: true,
        jev: { scriptEvaluation: true, semanticSearch: true, allowedServers: ["alpha", "zeta"] },
      },
      custom: "kept",
    });
    expect(ui.confirm.mock.calls[0]?.[1]).toContain("script evaluations");
    expect(ui.notify).toHaveBeenCalledWith("Jev semantic search configured for 2 servers. Reloading Pi…", "info");
  });

  it("explains how to store a missing credential without changing config", async () => {
    mocks.resolveJevCredential.mockReturnValueOnce({ status: "missing" });
    const ui = { select: vi.fn(), confirm: vi.fn(), notify: vi.fn() };

    expect(await setupJevSemanticSearch(state(), { hasUI: true, ui } as any)).toBe(false);
    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("pi-mcp-adapter key set systemone"), "error");
  });

  it("does not overwrite malformed configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-jev-setup-invalid-"));
    const path = join(root, ".pi", "mcp-adapter.json");
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(path, "{invalid\n");

    expect(() => writeJevSemanticSearchConfig(undefined, root, ["demo"])).toThrow(`Failed to read MCP config at ${realpathSync(path)}`);
    expect(readFileSync(path, "utf8")).toBe("{invalid\n");
  });

  it("writes project-scoped policy by default and validates server names", () => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-jev-setup-project-"));
    const result = writeJevSemanticSearchConfig(undefined, cwd, ["demo"]);
    expect(result.path).toBe(join(cwd, ".pi", "mcp-adapter.json"));
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toMatchObject({
      settings: { jev: { semanticSearch: true, allowedServers: ["demo"] } },
    });

    expect(writeJevSemanticSearchConfig(undefined, cwd, ["x".repeat(129)]).changed).toBe(true);

    const beforeInvalid = readFileSync(result.path, "utf8");
    expect(() => writeJevSemanticSearchConfig(undefined, cwd, ["__proto__"])).toThrow("allowedServers");
    expect(readFileSync(result.path, "utf8")).toBe(beforeInvalid);
  });

  it("overrides a lower-precedence project policy", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-jev-setup-precedence-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { demo: { command: "demo" } },
      settings: { jev: { semanticSearch: true, allowedServers: ["demo"] } },
    }));

    expect(writeJevSemanticSearchConfig(undefined, root, ["demo"], { semanticSearch: true, allowedServers: ["demo"] }).changed).toBe(true);
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { demo: { command: "demo" }, other: { command: "other" } },
      settings: { jev: { semanticSearch: true, allowedServers: ["demo", "other"] } },
    }));
    expect(loadMcpConfig(undefined, root).settings?.jev).toMatchObject({
      semanticSearch: true,
      allowedServers: ["demo"],
    });
  });

  it("overlays read-only sources without copying them and refuses owned aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-jev-setup-guards-"));
    const cwd = join(root, "project");
    const agent = join(root, "agent");
    const fixtureHome = join(root, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(fixtureHome, { recursive: true });
    vi.stubEnv("HOME", fixtureHome);
    vi.stubEnv("USERPROFILE", fixtureHome);
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    const globalPath = getPiGlobalConfigPath(undefined, cwd);
    const projectPath = getProjectPiConfigPath(cwd);
    const sources = [
      join(homedir(), ".config", "mcp", "mcp.json"),
      join(cwd, ".mcp.json"),
      join(homedir(), ".agents", "mcp.json"),
      join(homedir(), ".cursor", "mcp.json"),
      getPiMcpGlobalConfigPath(),
    ];
    const isFixturePath = (path: string): boolean => {
      const resolved = resolve(path);
      const relativePath = relative(root, resolved);
      return relativePath !== "" && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
    };
    for (const path of [...sources, globalPath, projectPath]) expect(isFixturePath(path), path).toBe(true);
    for (const source of sources) {
      const original = JSON.stringify({ settings: { unrelated: true }, custom: source });
      mkdirSync(join(source, ".."), { recursive: true });
      writeFileSync(source, original);
      rmSync(globalPath, { force: true });
      const result = writeJevSemanticSearchConfig(source, cwd, ["demo"]);
      expect(result.path).toBe(globalPath);
      expect(readFileSync(source, "utf8")).toBe(original);
      expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({
        settings: { jev: { semanticSearch: true, allowedServers: ["demo"] } },
      });
    }

    const sharedSource = join(root, "shared.json");
    const sharedBytes = '{"settings":{"shared":true},"unrelated":"keep"}\n';
    writeFileSync(sharedSource, sharedBytes);
    mkdirSync(join(projectPath, ".."), { recursive: true });
    rmSync(projectPath, { force: true });
    symlinkSync(sharedSource, projectPath);
    rmSync(globalPath, { force: true });
    expect(() => writeJevSemanticSearchConfig(undefined, cwd, ["demo"])).toThrow(/Refusing to write Jev settings/);
    expect(readFileSync(sharedSource, "utf8")).toBe(sharedBytes);
    expect(readFileSync(projectPath, "utf8")).toBe(sharedBytes);
    expect(() => readFileSync(globalPath, "utf8")).toThrow();

    rmSync(projectPath, { force: true });
    writeFileSync(projectPath, '{"settings":{"owned":true}}\n');
    const projectAlias = join(root, "project-alias.json");
    symlinkSync(projectPath, projectAlias);
    expect(() => writeJevSemanticSearchConfig(projectAlias, cwd, ["demo"])).toThrow(/Refusing to write Jev settings/);
    rmSync(projectAlias, { force: true });

    mkdirSync(join(globalPath, ".."), { recursive: true });
    rmSync(globalPath, { force: true });
    symlinkSync(sharedSource, globalPath);
    expect(() => writeJevSemanticSearchConfig(globalPath, cwd, ["demo"])).toThrow(/Refusing to write Jev settings/);
    expect(readFileSync(sharedSource, "utf8")).toBe(sharedBytes);
    expect(readFileSync(globalPath, "utf8")).toBe(sharedBytes);
  });
});
