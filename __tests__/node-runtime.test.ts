import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { brotliCompressSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertSupportedNodeRuntime, UnsupportedNodeRuntimeError } from "../node-runtime.ts";
import { probeMcpEndpoint } from "../mcp-probe.ts";
import { createCaFetch } from "../http-ca.ts";
import { createOAuthFetch } from "../mcp-auth-fetch.ts";
import { McpServerManager } from "../server-manager.ts";
import { getMcpOAuthTokensForUrl, updateMcpOAuthTokensForUrl } from "../oauth.ts";
import { resetTestAuthSecretStore } from "../mcp-auth.ts";
import { startAuth } from "../mcp-auth-flow.ts";
import { isCallbackServerRunning } from "../mcp-callback-server.ts";
import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";

const originalNode = Object.getOwnPropertyDescriptor(process.versions, "node")!;
function running(version: string) {
  Object.defineProperty(process.versions, "node", { ...originalNode, value: version });
}
afterEach(() => {
  Object.defineProperty(process.versions, "node", originalNode);
  vi.restoreAllMocks();
  resetTestAuthSecretStore();
});

describe("October 2026 Node runtime requirement", () => {
  it.each(["22.23.4", "22.23.5", "22.24.0", "24.22.1", "24.23.0", "26.12.1", "26.13.0"])("accepts supported %s", version => {
    expect(() => assertSupportedNodeRuntime(version)).not.toThrow();
  });
  it.each(["20.20.0", "22.23.3", "22.22.99", "23.99.0", "24.22.0", "25.12.0", "26.12.0", "27.0.0", "28.0.0", "26.12.1-rc.1", "invalid"])("rejects unsupported %s", version => {
    expect(() => assertSupportedNodeRuntime(version)).toThrow(UnsupportedNodeRuntimeError);
  });

  it("blocks probes, HTTP/SSE, custom CA, and OAuth before network or secret commands", async () => {
    running("26.12.0");
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    await expect(probeMcpEndpoint("http://127.0.0.1/mcp")).rejects.toThrow(/26.12.1/);
    const headers = vi.fn(() => new Headers());
    expect(() => createOAuthFetch("https://example.test/mcp", headers)).toThrow(UnsupportedNodeRuntimeError);
    expect(headers).not.toHaveBeenCalled();
    expect(() => createCaFetch({ url: "https://example.test", caFile: "/missing/ca.pem" })).toThrow(UnsupportedNodeRuntimeError);
    for (const transport of [undefined, "sse", "streamable-http"] as const) {
      const manager = new McpServerManager();
      try {
        await expect(manager.connect("blocked", {
          url: "http://127.0.0.1/mcp", auth: false,
          headers: { "X-Test": "!must-not-execute" },
          ...(transport ? { httpTransport: transport } : {}),
        })).rejects.toThrow(UnsupportedNodeRuntimeError);
      } finally {
        await manager.closeAll();
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects OAuth startup before reserving a callback listener", async () => {
    running("26.12.0");
    expect(isCallbackServerRunning()).toBe(false);
    await expect(startAuth("blocked-start", "https://example.test/mcp")).rejects.toThrow(UnsupportedNodeRuntimeError);
    expect(isCallbackServerRunning()).toBe(false);
  });

  it("uses fixed Node bundled trust without the affected eMudhra roots", () => {
    const subjects = rootCertificates.map(pem => new X509Certificate(pem).subject);
    expect(subjects.length).toBeGreaterThan(0);
    expect(subjects.filter(subject => /CN=(AAA Certificate Services|emSign ECC Root CA - G3)(?:\n|$)/.test(subject))).toEqual([]);
  });

  it("preserves stdio connections without the HTTP gate", async () => {
    running("26.12.0");
    const manager = new McpServerManager();
    try {
      const connection = await manager.connect("stdio", {
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/delayed-mcp-server.mjs", import.meta.url))],
      });
      expect(connection.status).toBe("connected");
    } finally {
      await manager.closeAll();
    }
  });

  it("keeps valid token reads local and surfaces a blocked public OAuth refresh", async () => {
    running("26.12.0");
    const fetch = vi.spyOn(globalThis, "fetch");
    const url = "https://runtime.example.test/mcp";
    await updateMcpOAuthTokensForUrl("runtime", url, { accessToken: "fixture", expiresAt: Date.now() / 1000 + 3600 });
    expect(await getMcpOAuthTokensForUrl("runtime", url)).toMatchObject({ accessToken: "fixture" });
    await updateMcpOAuthTokensForUrl("runtime", url, { accessToken: "fixture", refreshToken: "fixture-refresh", expiresAt: 1 });
    await expect(getMcpOAuthTokensForUrl("runtime", url)).rejects.toThrow(UnsupportedNodeRuntimeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows a harmless Brotli-compressed MCP response on a fixed runtime", async () => {
    const body = brotliCompressSync(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2026-07-28" } })));
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "br" });
      response.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      expect(await probeMcpEndpoint(`http://127.0.0.1:${address.port}/mcp`)).toMatchObject({ isMcp: true });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("ships the guard with matching manifest and lockfile requirements", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
    expect(manifest.engines.node).toBe("^22.23.4 || ^24.22.1 || ^26.12.1");
    expect(lock.packages[""].engines.node).toBe(manifest.engines.node);
    expect(manifest.files).toContain("node-runtime.ts");
  });
});
