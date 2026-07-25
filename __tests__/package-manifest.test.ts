import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJsonPath = join(repoRoot, "package.json");
const readmePath = join(repoRoot, "README.md");
const changelogPath = join(repoRoot, "CHANGELOG.md");
const releaseWorkflowPath = join(repoRoot, ".github/workflows/release.yml");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
  name: string;
  version: string;
  files?: string[];
  publishConfig?: { access?: string };
};
const readme = readFileSync(readmePath, "utf-8");
const changelog = readFileSync(changelogPath, "utf-8");
const releaseWorkflow = readFileSync(releaseWorkflowPath, "utf-8");

describe("package manifest and release evidence", () => {
  it("publishes every root runtime TypeScript module plus release docs", () => {
    const publishedFiles = new Set(packageJson.files ?? []);
    const runtimeModules = readdirSync(repoRoot)
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) => !entry.endsWith(".test.ts"))
      .filter((entry) => entry !== "vitest.config.ts");

    expect(runtimeModules.length).toBeGreaterThan(0);
    expect(runtimeModules.filter((entry) => !publishedFiles.has(entry))).toEqual([]);
    expect([...publishedFiles]).toEqual(expect.arrayContaining(["README.md", "CHANGELOG.md", "LICENSE", "cli.js"]));
  });

  it("keeps the tlh package identity and exact README install pin at 2.10.2", () => {
    const exactInstall = `pi install npm:${packageJson.name}@${packageJson.version}`;

    expect(packageJson.name).toBe("@diegopetrucci/pi-mcp-adapter");
    expect(packageJson.version).toBe("2.10.2");
    expect(packageJson.publishConfig).toMatchObject({ access: "public" });
    expect(readme).toContain(exactInstall);
    expect(readme.match(/pi install npm:@diegopetrucci\/pi-mcp-adapter@2\.10\.2/g)).toHaveLength(1);
  });

  it("keeps trusted publishing and changelog evidence aligned with the fork intake docs", () => {
    expect(releaseWorkflow).toContain("id-token: write");
    expect(releaseWorkflow).toContain("npm publish --access public --provenance");
    expect(releaseWorkflow).toContain("default: tlh-v2.10.2");
    expect(changelog).toContain("## [2.11.0] - 2026-07-03");
    expect(changelog).toContain("## [2.10.2] - 2026-07-08");
    expect(changelog).toContain("pi install npm:@diegopetrucci/pi-mcp-adapter@2.10.2");
  });
});
