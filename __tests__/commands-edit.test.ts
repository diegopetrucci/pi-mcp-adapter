import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function edit(ui: { editor: () => Promise<string>; notify: () => void }, cwd: string) {
  const { editSharedConfig } = await import("../commands.ts");
  return editSharedConfig({ cwd, hasUI: true, ui } as any, "project");
}

describe("/mcp edit", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    vi.resetModules();
  });

  it.each([
    ['{"mcpServers":{', "not saved"],
    ["null", "top-level value must be an object"],
  ])("does not save %j", async (text, message) => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-edit-"));
    const path = join(cwd, ".mcp.json");
    writeFileSync(path, '{"mcpServers":{}}\n');
    const ui = { editor: vi.fn(async () => text), notify: vi.fn() };

    expect(await edit(ui, cwd)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe('{"mcpServers":{}}\n');
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(message), "error");
  });

  it("saves JSONC with comments and trailing commas as typed, creating parent directories", async () => {
    const cwd = join(mkdtempSync(join(tmpdir(), "mcp-edit-")), "nested", "dir");
    const text = '{\n  // comment\n  "mcpServers": {},\n}\n';
    const ui = { editor: vi.fn(async () => text), notify: vi.fn() };

    expect(await edit(ui, cwd)).toBe(true);
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toBe(text);
  });

  it("opens and saves the explicit global shared config with its full current content", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-edit-global-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "mcp-edit-global-project-"));
    vi.stubEnv("HOME", home);
    const path = join(home, ".config", "mcp", "mcp.json");
    const before = '{\n  // shared\n  "mcpServers": {},\n}\n';
    const after = '{\n  "mcpServers": {\"global\": {\"command\": \"demo\"}},\n}\n';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, before);
    const ui = { editor: vi.fn(async () => after), notify: vi.fn() };
    const { editSharedConfig } = await import("../commands.ts");

    expect(await editSharedConfig({ cwd, hasUI: true, ui } as any, "global")).toBe(true);
    expect(ui.editor).toHaveBeenCalledWith(`Edit ${path} (Ctrl+G opens $EDITOR)`, before);
    expect(readFileSync(path, "utf8")).toBe(after);
  });

  it("preserves an existing relative config symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-edit-symlink-"));
    const cwd = join(root, "project");
    const path = join(cwd, ".mcp.json");
    const target = join(root, "configs", "mcp.json");
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '{"mcpServers":{}}\n');
    symlinkSync(relative(dirname(path), target), path);
    const text = '{\n  // edited through link\n  "mcpServers": {},\n}\n';
    const ui = { editor: vi.fn(async () => text), notify: vi.fn() };

    expect(await edit(ui, cwd)).toBe(true);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(text);
  });
});
