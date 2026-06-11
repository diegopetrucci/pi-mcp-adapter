import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadMcpConfig: vi.fn(),
  managers: [] as any[],
}));

vi.mock("../config.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../config.ts")>()),
  loadMcpConfig: mocks.loadMcpConfig,
}));

vi.mock("../server-manager.ts", () => ({
  McpServerManager: vi.fn().mockImplementation(function (this: any) {
    this.setSamplingConfig = vi.fn();
    this.setElicitationConfig = vi.fn();
    this.getConnection = vi.fn();
    this.connect = vi.fn();
    mocks.managers.push(this);
  }),
}));

function context(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp/project",
    hasUI: true,
    mode: "tui",
    ui: { select: vi.fn(), input: vi.fn(), notify: vi.fn() },
    modelRegistry: {},
    ...overrides,
  } as any;
}

describe("initializeMcp elicitation config", () => {
  beforeEach(() => {
    mocks.managers.length = 0;
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {}, settings: {} });
  });

  it("enables form and URL elicitation in the local TUI", async () => {
    const { initializeMcp } = await import("../init.ts");
    const ctx = context();

    await initializeMcp({ getFlag: vi.fn() } as any, ctx);

    expect(mocks.managers[0].setElicitationConfig).toHaveBeenCalledWith({
      ui: ctx.ui,
      allowUrl: true,
    });
  });

  it("keeps RPC elicitation form-only so the backend never opens a browser", async () => {
    const { initializeMcp } = await import("../init.ts");
    const ctx = context({ mode: "rpc" });

    await initializeMcp({ getFlag: vi.fn() } as any, ctx);

    expect(mocks.managers[0].setElicitationConfig).toHaveBeenCalledWith({
      ui: ctx.ui,
      allowUrl: false,
    });
  });

  it("does not enable elicitation without UI or when disabled", async () => {
    const { initializeMcp } = await import("../init.ts");

    await initializeMcp({ getFlag: vi.fn() } as any, context({ hasUI: false }));
    expect(mocks.managers[0].setElicitationConfig).not.toHaveBeenCalled();

    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {}, settings: { elicitation: false } });
    await initializeMcp({ getFlag: vi.fn() } as any, context());
    expect(mocks.managers[1].setElicitationConfig).not.toHaveBeenCalled();
  });
});
