import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: string[];
  publishConfig?: { access?: string };
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
  types?: string;
};

const packageLock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf-8")) as {
  name: string;
  version: string;
  packages?: {
    "": {
      name?: string;
      version?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
  };
};

const hostPeerPackages = {
  "@earendil-works/pi-ai": { peer: "^0.84.1 || ^0.85.0 || ^0.86.0", dev: "0.86.0" },
  "@earendil-works/pi-tui": { peer: "*", dev: "0.86.0" },
  "typebox": { peer: "*", dev: "1.3.3" },
};
const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");
const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf-8");
const releaseWorkflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf-8");

describe("TLH package identity and release evidence", () => {
  it("keeps the scoped package identity and exact README install pin", () => {
    const exactInstall = `pi install npm:${packageJson.name}@${packageJson.version}`;

    expect(packageJson.name).toBe("@diegopetrucci/pi-mcp-adapter");
    expect(packageJson.version).toBe("2.36.0");
    expect(packageJson.publishConfig).toMatchObject({ access: "public" });
    expect(readme).toContain(exactInstall);
    expect(readme.match(/pi install npm:@diegopetrucci\/pi-mcp-adapter@2\.36\.0/g)).toHaveLength(1);
  });

  it("keeps trusted publishing and the fork changelog evidence", () => {
    expect(releaseWorkflow).toContain("id-token: write");
    expect(releaseWorkflow).toContain("npm publish --access public --provenance");
    expect(releaseWorkflow).toContain("default: tlh-v2.36.0");
    expect(releaseWorkflow.indexOf("npm ci")).toBeLessThan(releaseWorkflow.indexOf("npm publish"));
    expect(releaseWorkflow.indexOf("npm run build:public")).toBeLessThan(releaseWorkflow.indexOf("npm publish"));
    expect(changelog).toContain("### TLH fork release - 2026-09-22 (adopted-with-exceptions)");
    expect(changelog).toContain("> **Inherited upstream history (2.12–2.35):** retained for context only; the URL installer and Jev/TypeSafe integrations are excluded from this fork.");
    expect(changelog).toContain("pi install npm:@diegopetrucci/pi-mcp-adapter@2.36.0");
    expect(changelog).toContain("docs/UPSTREAM-SYNC.md");
  });
});

describe("package.json files", () => {
  it("keeps the bundled MCP scripting skill available for manual use only", () => {
    const skill = readFileSync(join(repoRoot, "skills", "mcp-scripting", "SKILL.md"), "utf-8");
    expect(skill).toMatch(/^disable-model-invocation:\s*true\s*$/m);
  });

  it("exports source entry points and plain Node host helpers", () => {
    expect(packageJson.types).toBe("./index.ts");
    expect(packageJson.exports).toMatchObject({
      ".": {
        types: "./index.ts",
        import: "./index.ts",
        default: "./index.ts",
      },
      "./types": {
        types: "./dist/types.d.ts",
        import: "./dist/types.js",
        default: "./dist/types.js",
      },
      "./config": {
        types: "./dist/config.d.ts",
        import: "./dist/config.js",
        default: "./dist/config.js",
      },
      "./metadata-cache": {
        types: "./dist/metadata-cache.d.ts",
        import: "./dist/metadata-cache.js",
        default: "./dist/metadata-cache.js",
      },
    });
  });

  it("ships public host helpers without install-time prepare", () => {
    const publishedFiles = new Set(packageJson.files ?? []);

    expect(packageJson.scripts?.prepare).toBeUndefined();
    expect(packageJson.scripts?.prepack).toBe("npm run build:public");
    expect(publishedFiles.has("dist")).toBe(true);
    for (const entry of Object.values(packageJson.exports ?? {})) {
      if (!entry || typeof entry !== "object") continue;
      for (const target of Object.values(entry)) {
        if (typeof target === "string" && target.startsWith("./dist/")) {
          expect(readFileSync(join(repoRoot, target), "utf-8").length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("publishes every root runtime TypeScript module and required package assets", () => {
    const publishedFiles = new Set(packageJson.files ?? []);
    const runtimeModules = readdirSync(repoRoot)
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) => !entry.endsWith(".test.ts"))
      .filter((entry) => entry !== "vitest.config.ts");

    expect(runtimeModules.length).toBeGreaterThan(0);
    expect(runtimeModules.filter((entry) => !publishedFiles.has(entry))).toEqual([]);
    expect([...publishedFiles]).toEqual(expect.arrayContaining([
      "dist",
      "skills",
      "mcp-script-worker.mjs",
      "mcp-keyring-helper.cjs",
      "app-bridge.bundle.js",
      "banner.png",
    ]));
    expect([...publishedFiles].filter((entry) => /(?:jev|semantic-search|mcp-install)/i.test(entry))).toEqual([]);
  });

  it("does not import the peer-dependent MCP app bridge from runtime modules", () => {
    const runtimeModules = readdirSync(repoRoot)
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) => !entry.endsWith(".test.ts"))
      .filter((entry) => entry !== "vitest.config.ts");

    const offenders = runtimeModules.filter((entry) =>
      readFileSync(join(repoRoot, entry), "utf-8").includes("@modelcontextprotocol/ext-apps/app-bridge")
    );

    expect(offenders).toEqual([]);
  });
});

describe("scoped lockfile and package/docs exclusions", () => {
  it("matches the resolved scoped manifest and excludes retired integration artifacts", () => {
    const lockRoot = packageLock.packages?.[""];
    expect(packageLock.name).toBe(packageJson.name);
    expect(packageLock.version).toBe(packageJson.version);
    expect(lockRoot?.name).toBe(packageJson.name);
    expect(lockRoot?.version).toBe(packageJson.version);
    expect(lockRoot?.dependencies).toEqual(packageJson.dependencies);
    expect(lockRoot?.devDependencies).toEqual(packageJson.devDependencies);
    expect(lockRoot?.peerDependencies).toEqual(packageJson.peerDependencies);
    expect(lockRoot?.peerDependenciesMeta).toEqual(packageJson.peerDependenciesMeta);
    expect(packageJson.dependencies?.["@typesafe-ai/sdk"]).toBeUndefined();
    expect(readme).not.toMatch(/Jev|TypeSafe|semantic-search|action:\s*["']install|Install from one URL/i);
  });
});

describe("package.json dependency policy", () => {
  it("uses only registry semver dependency specs and no native refresh-lock addon", () => {
    const dependencyGroups = [
      packageJson.dependencies ?? {},
      packageJson.devDependencies ?? {},
      packageJson.peerDependencies ?? {},
    ];
    const registrySemver = /^(?:[~^]?\d+\.\d+\.\d+|\*)(?:\s*\|\|\s*(?:[~^]?\d+\.\d+\.\d+|\*))*$/;

    for (const dependencies of dependencyGroups) {
      for (const [name, spec] of Object.entries(dependencies)) {
        if (name === "recheck") {
          expect(spec).toBe("4.6.0-beta.3");
          continue;
        }
        expect(spec).toMatch(registrySemver);
        expect(spec).not.toMatch(/^(?:https?:|git(?:\+[^:]+)?:|file:)/);
      }
    }
    expect(packageJson.dependencies?.["fs-native-extensions"]).toBeUndefined();
  });

  it("treats Pi host packages as optional peers with exact dev pins", () => {
    const entries = Object.entries(hostPeerPackages);

    for (const [name, versions] of entries) {
      expect(packageJson.peerDependencies?.[name]).toBe(versions.peer);
      expect(packageJson.peerDependenciesMeta?.[name]?.optional).toBe(true);
      expect(packageJson.dependencies?.[name]).toBeUndefined();
      expect(packageJson.devDependencies?.[name]).toBe(versions.dev);
    }
  });

  it("uses the stable modular SDK v2 client/core packages without the legacy monolithic SDK", () => {
    expect(packageJson.dependencies?.["@modelcontextprotocol/ext-apps"]).toBeDefined();
    expect(packageJson.dependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined();
    expect(packageJson.dependencies?.["@modelcontextprotocol/client"]).toBe("2.0.0");
    expect(packageJson.dependencies?.["@modelcontextprotocol/core"]).toBe("2.0.0");
    expect(packageJson.devDependencies?.["@modelcontextprotocol/server"]).toBeUndefined();
  });
});
