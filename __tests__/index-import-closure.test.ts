import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, relative, resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entryPath = resolve(repoRoot, "index.ts");

function isRuntimeImport(statement: ts.Statement): statement is ts.ImportDeclaration | ts.ExportDeclaration {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) return !clause;
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
  const resolved = candidates.find(candidate => {
    try {
      readFileSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
  if (!resolved) throw new Error(`Could not resolve local import ${specifier} from ${importer}`);
  return resolved;
}

function runtimeImportClosure(entry: string): { files: Set<string>; edges: Map<string, string[]> } {
  const files = new Set<string>();
  const edges = new Map<string, string[]>();

  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
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
  return { files, edges };
}

describe("index startup runtime import boundary", () => {
  it("traverses the complete local static/re-export closure and excludes heavy runtime modules", () => {
    const { files, edges } = runtimeImportClosure(entryPath);
    const visited = [...files].map(file => relative(repoRoot, file));

    // These assertions make this a transitive regression rather than a check
    // of index.ts alone: config, metadata, prompts, references, and the
    // startup facade must all be visited.
    expect(visited).toEqual(expect.arrayContaining([
      "config.ts",
      "metadata-cache.ts",
      "mcp-references.ts",
      "prompts.ts",
      "namespace-tools.ts",
      "startup-mcp-facade.ts",
    ]));

    const forbiddenLocal = new Set([
      "commands.ts",
      "direct-tools.ts",
      "init.ts",
      "mcp-auth-flow.ts",
      "mcp-auth.ts",
      "mcp-code.ts",
      "mcp-panel.ts",
      "mcp-runtime.ts",
      "mcp-setup-panel.ts",
      "lifecycle.ts",
      "proxy-modes.ts",
      "sampling-handler.ts",
      "secure-keyring.ts",
      "server-manager.ts",
      "tool-registrar.ts",
      "ui-server.ts",
    ]);
    const forbiddenExternal = new Set([
      "@earendil-works/pi-ai",
      "@modelcontextprotocol/client",
      "@modelcontextprotocol/core",
      "@modelcontextprotocol/ext-apps",
      "@modelcontextprotocol/ext-tasks",
      "@napi-rs/keyring",
      "open",
      "recheck",
    ]);
    const violations: string[] = [];
    for (const [importer, imports] of edges) {
      for (const imported of imports) {
        const localName = imported.startsWith(`${repoRoot}/`) ? relative(repoRoot, imported) : undefined;
        const externalName = imported.startsWith(`${repoRoot}/`) || imported.startsWith("node:")
          ? undefined
          : imported;
        if (localName && forbiddenLocal.has(localName)) {
          violations.push(`${relative(repoRoot, importer)} -> ${localName}`);
        }
        if (externalName && [...forbiddenExternal].some(name => externalName === name || externalName.startsWith(`${name}/`))) {
          violations.push(`${relative(repoRoot, importer)} -> ${externalName}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
