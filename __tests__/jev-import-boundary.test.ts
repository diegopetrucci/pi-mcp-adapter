import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import * as ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findTools } from "../proxy-modes.ts";
import { loadMcpConfig } from "../config.ts";
import { semanticSearch } from "../semantic-search.ts";
import { validateJevSettings } from "../jev-settings.ts";
import { getTestSecureKeyringReadCount, resetTestSecureKeyring } from "../secure-keyring.ts";
import type { McpExtensionState } from "../state.ts";

const mockedJevClient = vi.hoisted(() => ({
  factoryLoads: 0,
  resolveSemanticJevSettings: vi.fn(),
  evaluateJev: vi.fn(),
}));

vi.mock("../jev-client.ts", () => {
  mockedJevClient.factoryLoads += 1;
  return mockedJevClient;
});

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isRuntimeImport(statement: ts.Statement): statement is ts.ImportDeclaration | ts.ExportDeclaration {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return true;
    return !clause.namedBindings.elements.every(element => element.isTypeOnly);
  }
  if (ts.isExportDeclaration(statement)) {
    if (!statement.moduleSpecifier || statement.isTypeOnly) return false;
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) return true;
    return !statement.exportClause.elements.every(element => element.isTypeOnly);
  }
  return false;
}

function resolveLocalImport(specifier: string, importer: string): string {
  const base = resolve(dirname(importer), specifier);
  const candidates = extname(base)
    ? [base]
    : [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, resolve(base, "index.ts")];
  const resolved = candidates.find(candidate => existsSync(candidate));
  if (!resolved) throw new Error(`Could not resolve local import ${specifier} from ${importer}`);
  return resolved;
}

function runtimeImportClosure(entry: string): Map<string, string[]> {
  const files = new Set<string>();
  const edges = new Map<string, string[]>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports: string[] = [];
    for (const statement of source.statements) {
      if (!isRuntimeImport(statement)) continue;
      const specifier = statement.moduleSpecifier.text;
      const target = specifier.startsWith(".") ? resolveLocalImport(specifier, file) : specifier;
      imports.push(target);
      if (target.startsWith(`${repoRoot}/`)) visit(target);
    }
    edges.set(file, imports);
  };
  visit(entry);
  return edges;
}

function assertNoJevHeavyImports(entry: string): void {
  const forbiddenLocal = new Set(["jev-client.ts", "jev-key-store.ts", "secure-keyring.ts"]);
  const forbiddenExternal = new Set(["@typesafe-ai/sdk", "@napi-rs/keyring"]);
  const violations: string[] = [];
  for (const [importer, imports] of runtimeImportClosure(entry)) {
    for (const imported of imports) {
      const local = imported.startsWith(`${repoRoot}/`) ? relative(repoRoot, imported) : undefined;
      const external = imported.startsWith(`${repoRoot}/`) || imported.startsWith("node:") ? undefined : imported;
      if (local && forbiddenLocal.has(local)) violations.push(`${relative(repoRoot, importer)} -> ${local}`);
      if (external && [...forbiddenExternal].some(name => external === name || external.startsWith(`${name}/`))) {
        violations.push(`${relative(repoRoot, importer)} -> ${external}`);
      }
    }
  }
  expect(violations).toEqual([]);
}

function state(settings?: Record<string, unknown>): McpExtensionState {
  return {
    config: {
      settings,
      mcpServers: { demo: { command: "demo" } },
    },
    toolMetadata: new Map([[
      "demo",
      [{ name: "demo_weather", originalName: "weather", description: "Get the weather" }],
    ]]),
    failureTracker: new Map(),
    manager: { getConnection: vi.fn(() => ({ status: "connected" })) },
  } as unknown as McpExtensionState;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetTestSecureKeyring();
});

describe("Jev lazy import boundary", () => {
  it("keeps config validation and default lexical discovery outside the heavy Jev closure", async () => {
    assertNoJevHeavyImports(resolve(repoRoot, "config.ts"));
    assertNoJevHeavyImports(resolve(repoRoot, "semantic-search.ts"));

    const root = mkdtempSync(join(tmpdir(), "mcp-jev-import-boundary-"));
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "demo" } } }));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
    resetTestSecureKeyring();

    mockedJevClient.resolveSemanticJevSettings.mockImplementation((runtimeState: McpExtensionState) => (
      validateJevSettings(runtimeState.config.settings?.jev)
    ));
    const loaded = loadMcpConfig(undefined, root);
    expect(validateJevSettings(loaded.settings?.jev)).toMatchObject({ semanticSearch: false, scriptEvaluation: false });
    const lexical = findTools(state(), { query: "weather" });
    expect(lexical).not.toBeInstanceOf(Promise);
    expect(lexical).toMatchObject({ matches: [{ server: "demo", tool: { name: "demo_weather" } }] });
    const disabled = await semanticSearch(state({ jev: false }), "weather");
    expect(disabled).toMatchObject({ ok: false, error: { code: "disabled" } });
    expect(getTestSecureKeyringReadCount()).toBe(0);
    expect(mockedJevClient.factoryLoads).toBe(0);
  });

  it("loads the Jev producer only for an actual semantic request", async () => {
    mockedJevClient.resolveSemanticJevSettings.mockReturnValue({
      semanticSearch: true,
      scriptEvaluation: false,
      allowedServers: ["demo"],
      model: "jev-1.13.0",
      requestTimeoutMs: 5_000,
      maxRetries: 0,
      maxStateBytes: 262_144,
      maxQuestionsPerRequest: 64,
      maxEvaluationsPerScript: 8,
      maxEvaluationBytesPerScript: 524_288,
      maxEvaluationTokensPerScript: 32_768,
      semanticCandidateLimit: 127,
      semanticMinProbability: 0.2,
    });
    mockedJevClient.evaluateJev.mockResolvedValue({
      ok: true,
      data: {
        model: "jev-1.13.0",
        usage: { inputTokens: 1, outputTokens: 1 },
        answers: { match: { type: "choice", choice: "c0", confidence: 1, probabilities: { c0: 1, none: 0 } } },
      },
    });

    const result = await semanticSearch(state({ jev: { semanticSearch: true, allowedServers: ["demo"] } }), "weather");
    expect(result).toMatchObject({ ok: true, matches: [{ tool: { name: "demo_weather" } }] });
    expect(mockedJevClient.factoryLoads).toBe(1);
    expect(mockedJevClient.resolveSemanticJevSettings).toHaveBeenCalledTimes(1);
    expect(mockedJevClient.evaluateJev).toHaveBeenCalledTimes(1);
  });
});
