import { describe, expect, it, vi } from "vitest";
import { updateStatusBar } from "../init.ts";

describe("updateStatusBar", () => {
  it("dims the MCP footer and lists only connected server names", () => {
    const setStatus = vi.fn();
    const fg = vi.fn((_tone: string, text: string) => `dim(${text})`);
    const state = {
      ui: {
        setStatus,
        theme: { fg },
      },
      config: {
        mcpServers: {
          alpha: { command: "npx", args: ["-y", "alpha-server"] },
          beta: { command: "npx", args: ["-y", "beta-server"] },
          gamma: { command: "npx", args: ["-y", "gamma-server"] },
        },
      },
      manager: {
        getAllConnections: () => new Map([
          ["alpha", { status: "connected" }],
          ["beta", { status: "needs-auth" }],
          ["gamma", { status: "disconnected" }],
        ]),
      },
    } as any;

    updateStatusBar(state);

    expect(fg).toHaveBeenCalledWith("dim", "MCP: 1/3 servers, alpha");
    expect(setStatus).toHaveBeenCalledWith("mcp", "dim(MCP: 1/3 servers, alpha)");
  });

  it("clears the MCP footer when no servers are configured", () => {
    const setStatus = vi.fn();
    const state = {
      ui: {
        setStatus,
        theme: { fg: vi.fn() },
      },
      config: { mcpServers: {} },
      manager: { getAllConnections: () => new Map() },
    } as any;

    updateStatusBar(state);

    expect(setStatus).toHaveBeenCalledWith("mcp", undefined);
  });
});
