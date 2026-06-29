import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const exampleRoot = join(__dirname, "..", "examples", "interactive-visualizer");

describe("interactive visualizer example", () => {
  it("declares a build script that generates dist assets from source", () => {
    const pkg = JSON.parse(readFileSync(join(exampleRoot, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    const buildScript = readFileSync(join(exampleRoot, "scripts", "build.mjs"), "utf-8");

    expect(pkg.scripts?.build).toBe("node ./scripts/build.mjs");
    expect(buildScript).toContain('entryPoints: [path.join(srcDir, "ui", "app.ts")]');
    expect(buildScript).toContain('entryPoints: [path.join(srcDir, "server.ts")]');
    expect(buildScript).toContain('path.join(distDir, "app.html")');
    expect(buildScript).toContain('outfile: path.join(distDir, "server.js")');
  });

  it("keeps the server and UI sources wired to the chart app", () => {
    const server = readFileSync(join(exampleRoot, "src", "server.ts"), "utf-8");
    const app = readFileSync(join(exampleRoot, "src", "ui", "app.ts"), "utf-8");
    const html = readFileSync(join(exampleRoot, "src", "ui", "index.html"), "utf-8");

    expect(server).toContain('readFileSync(join(__dirname, "..", "dist", "app.html"), "utf-8")');
    expect(server).toContain('"show_chart"');
    expect(server).toContain('"interactive-visualizer"');
    expect(app).toContain('import Chart from "chart.js/auto"');
    expect(app).toContain('const root = document.getElementById("app")!;');
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('<div id="app"></div>');
    expect(html).toContain("/*__INLINE_JS__*/");
  });
});
