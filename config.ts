// config.ts - Config loading with import support
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, readlinkSync, rmSync, statSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import stripJsonComments from "strip-json-comments";
import { getAgentPath, getConfigDirName } from "./agent-dir.ts";
import { getAgentPluginSummaries, loadAgentPluginConfigs, type AgentPluginSummary } from "./agent-plugin-loader.ts";
import { cloneBuiltInAgentPluginEntry, isBuiltInAgentPlugin, mergeBuiltInAgentPluginEntries } from "./agent-plugin-provenance.ts";
import { loadClaudePluginBundles } from "./claude-plugin-loader.ts";
import { loadPackageMcpConfigs } from "./package-mcp-loader.ts";
import { validateJevSettings } from "./jev-settings.ts";
import { formatServerNamespace, isServerDisabled, type ClaudePluginConfig, type HostConfigDiscovery, type McpConfig, type OAuthConfig, type ServerEntry, type McpSettings, type ImportKind, type ServerProvenance } from "./types.ts";
import { getMissingEnvVars, parseJsonWithComments, providerAuthUrlError, stripUtf8Bom, toStringRecord } from "./utils.ts";

const GENERIC_GLOBAL_CONFIG_PATH = join(homedir(), ".config", "mcp", "mcp.json");
const AGENTS_GLOBAL_CONFIG_PATHS = [
  join(homedir(), ".agents", "mcp.json"),
  join(homedir(), ".agents", "mcp", "mcp.json"),
] as const;
const PROJECT_CONFIG_NAME = ".mcp.json";
const PI_MCP_CONFIG_NAME = "mcp.json";
const ADAPTER_CONFIG_NAME = "mcp-adapter.json";
const REPOPROMPT_BINARY_CANDIDATES = [
  join(homedir(), "RepoPrompt", "repoprompt_cli"),
  "/Applications/Repo Prompt.app/Contents/MacOS/repoprompt-mcp",
];

export interface KnownServerPreset {
  id: string;
  name: string;
  summary: string;
  entry: ServerEntry;
  /** Offered only when one of these app paths exists; the local server is probed after adding. */
  desktopApp?: { paths: readonly string[]; enableSteps: string };
}

export const KNOWN_SERVER_PRESETS: readonly KnownServerPreset[] = [
  {
    id: "deepwiki",
    name: "DeepWiki",
    summary: "Ask questions about public GitHub repositories.",
    entry: { url: "https://mcp.deepwiki.com/mcp", protocolVersion: "auto" },
  },
  {
    id: "context7",
    name: "Context7",
    summary: "Look up current library documentation and examples.",
    entry: { url: "https://mcp.context7.com/mcp", protocolVersion: "auto" },
  },
  {
    id: "parallel-search",
    name: "Parallel Search",
    summary: "Search the web and fetch pages without an API key.",
    entry: {
      url: "https://search.parallel.ai/mcp",
      protocolVersion: "auto",
      directTools: true,
    },
  },
  {
    id: "notion",
    name: "Notion",
    summary: "Search and work with your Notion workspace.",
    entry: { url: "https://mcp.notion.com/mcp", auth: "oauth", protocolVersion: "auto" },
  },
  {
    id: "github",
    name: "GitHub",
    summary: "Work with GitHub through your Copilot account.",
    entry: { url: "https://api.githubcopilot.com/mcp", auth: "oauth", protocolVersion: "auto" },
  },
  {
    id: "chrome-devtools",
    name: "Chrome DevTools",
    summary: "Inspect and automate a local Chrome browser.",
    entry: { command: "npx", args: ["-y", "chrome-devtools-mcp@1.6.0"] },
  },
  {
    id: "figma",
    name: "Figma (desktop)",
    summary: "Read designs through the Figma desktop app. Needs a Dev or Full seat on a paid Figma plan.",
    entry: { url: "http://127.0.0.1:3845/mcp", protocolVersion: "auto" },
    desktopApp: {
      paths: [
        "/Applications/Figma.app",
        join(homedir(), "Applications", "Figma.app"),
        join(homedir(), "AppData", "Local", "Figma", "Figma.exe"),
      ],
      enableSteps: "To enable it, open a Design file in Figma, switch to Dev Mode (Shift+D), and click 'Enable desktop MCP server' in the inspect panel.",
    },
  },
];

const HOST_IMPORT_KINDS: Exclude<ImportKind, "agents">[] = [
  "cursor",
  "claude-code",
  "claude-desktop",
  "codex",
  "opencode",
  "windsurf",
  "vscode",
];

const IMPORT_PATHS: Record<ImportKind, string[]> = {
  agents: [...AGENTS_GLOBAL_CONFIG_PATHS],
  cursor: [join(homedir(), ".cursor", "mcp.json")],
  "claude-code": [
    join(homedir(), ".claude", "mcp.json"),
    join(homedir(), ".claude.json"),
    join(homedir(), ".claude", "claude_desktop_config.json"),
  ],
  "claude-desktop": [join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")],
  codex: [
    join(homedir(), ".codex", "config.toml"),
    join(homedir(), ".codex", "config.json"),
  ],
  opencode: [
    join(homedir(), ".config", "opencode", "opencode.json"),
    "./opencode.json",
  ],
  windsurf: [join(homedir(), ".windsurf", "mcp.json")],
  vscode: [".vscode/mcp.json"],
};

interface ConfigSourceSpec {
  id: "shared-global" | "agents-global" | "agents-nested-global" | "pi-mcp-global" | "pi-global" | "shared-project-ancestor" | "pi-project-ancestor" | "shared-project" | "pi-mcp-project" | "pi-project" | "explicit-read-only" | "pi-adapter-overlay";
  label: string;
  readPath: string;
  writePath: string;
  kind: "user" | "project" | "import";
  importKind?: string;
  shared: boolean;
  scope: "global" | "project";
  /** Detection-only sources are visible to setup but never merged into the active config. */
  active?: false;
  /** An explicit path may select a native Pi mcp.json while remaining read-only. */
  nativePi?: boolean;
  /** The canonical adapter layer is projected over an explicit config. */
  projection?: "adapter";
}

export interface ConfigDiscoveryPath {
  label: string;
  path: string;
  exists: boolean;
}

export interface DiscoveredImportConfig {
  kind: ImportKind;
  path: string;
}

export interface ConfigDiscoverySource extends ConfigDiscoveryPath {
  id: ConfigSourceSpec["id"];
  scope: ConfigSourceSpec["scope"];
  kind: "shared" | "pi" | "explicit";
  serverCount: number;
  active: boolean;
}

export interface ImportConfigSummary extends DiscoveredImportConfig {
  serverCount: number;
}

export interface HostConfigSummary extends ImportConfigSummary {
  active: boolean;
}

export interface McpConfigConflict {
  serverName: string;
  sources: Array<{ kind: "shared" | "pi" | "explicit" | "host"; path: string }>;
  winner: { kind: "shared" | "pi" | "explicit" | "host"; path: string };
}

export interface RepoPromptDiscovery {
  configured: boolean;
  configuredPath?: string;
  executablePath?: string;
  targetPath?: string;
  serverName?: string;
  entry?: ServerEntry;
}

export interface McpDiscoverySummary {
  sources: ConfigDiscoverySource[];
  imports: ImportConfigSummary[];
  hostConfigs: HostConfigSummary[];
  hostConfigDiscovery: HostConfigDiscovery;
  agentPlugins: AgentPluginSummary[];
  conflicts: McpConfigConflict[];
  hasAnyConfig: boolean;
  hasAnyDetectedPaths: boolean;
  hasSharedServers: boolean;
  hasPiOwnedServers: boolean;
  totalServerCount: number;
  fingerprint: string;
  repoPrompt: RepoPromptDiscovery;
  knownServerPresets: readonly KnownServerPreset[];
}

export interface McpStandardConfigSummary {
  sources: ConfigDiscoverySource[];
  hasSharedServers: boolean;
  fingerprint: string;
}

export interface ConfigWritePreview {
  path: string;
  existed: boolean;
  changed: boolean;
  beforeText: string;
  afterText: string;
  diffText: string;
}

export type SharedConfigTarget = "project" | "global";

export function getPiGlobalConfigPath(overridePath?: string, cwd = process.cwd()): string {
  return overridePath ? resolve(cwd, overridePath) : getAgentPath(ADAPTER_CONFIG_NAME);
}

export function getPiMcpGlobalConfigPath(): string {
  return getAgentPath(PI_MCP_CONFIG_NAME);
}

/** @internal Pi's built-in MCP stores OAuth sign-ins here, keyed by `String(new URL(serverUrl))`. */
export function getPiMcpAuthPath(): string {
  return getAgentPath("mcp-auth.json");
}

export function getGenericGlobalConfigPath(): string {
  return GENERIC_GLOBAL_CONFIG_PATH;
}

export function getProjectConfigPath(cwd = process.cwd()): string {
  return resolve(cwd, PROJECT_CONFIG_NAME);
}

export function getProjectPiConfigPath(cwd = process.cwd()): string {
  return resolve(cwd, getConfigDirName(), ADAPTER_CONFIG_NAME);
}

export function getProjectPiMcpConfigPath(cwd = process.cwd()): string {
  return resolve(cwd, getConfigDirName(), PI_MCP_CONFIG_NAME);
}

let piMcpConfigEnabled = false;

/** @internal Set once by the extension on Pi 0.99+, so every loader in the process agrees. */
export function setPiMcpConfigEnabled(enabled: boolean): void {
  piMcpConfigEnabled = enabled;
}

/** @internal */
export function isPiMcpConfigEnabled(): boolean {
  return piMcpConfigEnabled;
}

/** Adapter content in an old adapter `mcp.json` on Pi versions without their own MCP config. */
function legacyMcpConfigHasContent(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const raw = parseJsonWithComments(readFileSync(filePath, "utf-8"));
    if (!isRecord(raw)) return false;
    const hasServers = (value: unknown) => isRecord(value) && Object.keys(value).length > 0;
    return hasServers(raw.mcpServers)
      || hasServers(raw["mcp-servers"])
      || raw.settings !== undefined
      || raw.imports !== undefined
      || raw.claudePlugins !== undefined;
  } catch {
    return false;
  }
}

export function getLegacyMcpMigrationNotices(cwd = process.cwd(), overridePath?: string): string[] {
  if (piMcpConfigEnabled) {
    return getConfigSources(overridePath, cwd).flatMap((source) => {
      const file = isPiMcpSource(source.id) || source.nativePi ? readPiMcpConfig(source.readPath) : null;
      if (!file) return [];
      const parts: string[] = [];
      if (file.adapterKeys.length > 0) {
        const serversHint = file.adapterKeys.includes("mcp-servers") ? `, with "mcp-servers" entries under its "mcpServers" key` : "";
        parts.push(`pi-mcp-adapter does not read ${file.adapterKeys.join(", ")} in this file; move them into ${source.writePath}${serversHint}.`);
      }
      if (file.skipped.length > 0) parts.push(`Skipped ${file.skipped.join("; ")}.`);
      if (file.ignoredSettings.size > 0) {
        const ignored = [...file.ignoredSettings].map(([name, settings]) => `"${name}": ${settings.join(", ")}`);
        parts.push(`Ignored settings (details in /mcp-adapter): ${ignored.join("; ")}.`);
      }
      return parts.length > 0 ? [`${source.readPath}: ${parts.join(" ")}`] : [];
    });
  }
  const explicitPath = overridePath ? resolve(cwd, overridePath) : undefined;
  const candidates = [
    [getPiMcpGlobalConfigPath(), getPiGlobalConfigPath()],
    [getProjectPiMcpConfigPath(cwd), getProjectPiConfigPath(cwd)],
  ] as const;
  return candidates.flatMap(([source, target]) => {
    // An explicitly selected config is loaded verbatim, whatever its name.
    if (resolve(source) === explicitPath || !legacyMcpConfigHasContent(source)) return [];
    const fix = existsSync(target)
      ? `Merge ${source} into ${target}, then remove ${source}.`
      : `Move it with: mv ${JSON.stringify(source)} ${JSON.stringify(target)}`;
    return [`pi-mcp-adapter no longer reads ${source}. ${fix}`];
  });
}

export function getSharedConfigPath(target: SharedConfigTarget, cwd = process.cwd()): string {
  return target === "project" ? getProjectConfigPath(cwd) : getGenericGlobalConfigPath();
}

export function getConfigDiscoveryPaths(overridePath?: string, cwd = process.cwd()): ConfigDiscoveryPath[] {
  return getConfigSources(overridePath, cwd).map((source) => ({
    label: source.label,
    path: source.readPath,
    exists: existsSync(source.readPath),
  }));
}

export function findAvailableImportConfigs(cwd = process.cwd()): DiscoveredImportConfig[] {
  if (isExclusiveConfigMode()) return [];
  const discovered: DiscoveredImportConfig[] = [];

  for (const importKind of Object.keys(IMPORT_PATHS) as ImportKind[]) {
    const importPath = resolveImportPath(importKind, cwd);
    if (importPath) {
      discovered.push({ kind: importKind, path: importPath });
    }
  }

  return discovered;
}

function readSourceForUse(source: ConfigSourceSpec, cwd: string, base: McpConfig): (McpConfig & { ignoredSettings?: Map<string, string[]> }) | null {
  const raw = readSourceConfig(source.id, source.readPath, cwd, source.nativePi);
  if (!raw) return null;
  if (source.projection === "adapter") return projectAdapterOverlay(raw, base, cwd);
  if (!isReadOnlyImportedPath(source.readPath, cwd)) return raw;
  const stripped: McpConfig & { ignoredSettings?: Map<string, string[]> } = { mcpServers: raw.mcpServers };
  if (raw.ignoredSettings) stripped.ignoredSettings = raw.ignoredSettings;
  return stripped;
}

function getConfigSourceSummaries(sourceSpecs: ConfigSourceSpec[], cwd = process.cwd()): ConfigDiscoverySource[] {
  let effectiveConfig: McpConfig = { mcpServers: {} };
  return sourceSpecs.map((source) => {
    const loaded = readSourceForUse(source, cwd, effectiveConfig);
    if (loaded && source.active !== false) effectiveConfig = mergeConfigs(effectiveConfig, expandImports(loaded, cwd).config);
    return {
      id: source.id,
      label: source.label,
      path: source.readPath,
      exists: existsSync(source.readPath),
      scope: source.scope,
      kind: source.id === "explicit-read-only" ? "explicit" : source.shared ? "shared" : "pi",
      // The adapter overlay modifies already-counted explicit entries; it is
      // not an additional transport source for discovery totals.
      serverCount: source.projection === "adapter" ? 0 : loaded ? Object.keys(loaded.mcpServers).length : 0,
      active: source.active !== false,
    } satisfies ConfigDiscoverySource;
  });
}

export function getMcpStandardConfigSummary(overridePath?: string, cwd = process.cwd()): McpStandardConfigSummary {
  const sourceSpecs = getConfigSources(overridePath, cwd);
  const sources = getConfigSourceSummaries(sourceSpecs, cwd);
  return {
    sources,
    hasSharedServers: sources.some((source, index) => sourceSpecs[index]?.active !== false && source.kind === "shared" && source.serverCount > 0),
    fingerprint: JSON.stringify({ sources: sources.map((source, index) => [source.id, source.exists, source.serverCount, sourceSpecs[index]?.active !== false]) }),
  };
}

export function getMcpDiscoverySummary(
  overridePath?: string,
  cwd = process.cwd(),
  options: { includeHostConfigs?: boolean } = {},
): McpDiscoverySummary {
  const sourceSpecs = getConfigSources(overridePath, cwd);
  const sources = getConfigSourceSummaries(sourceSpecs, cwd);
  const includeHostConfigs = options.includeHostConfigs !== false;

  const importKinds = isExclusiveConfigMode()
    // TLH fork: in exclusive mode, always read imports from the Pi global adapter
    // config, not from an explicit override path (which is user/tool content).
    ? (readValidatedConfig(getPiGlobalConfigPath(), "MCP exclusive config")?.imports ?? [])
    : (Object.keys(IMPORT_PATHS) as ImportKind[]);
  const imports = includeHostConfigs
    ? importKinds
      .map((kind) => {
        const imported = loadImportedConfig(kind, cwd, `Failed to inspect imported MCP config from ${kind}:`);
        if (!imported) return null;
        return {
          kind,
          path: imported.path,
          serverCount: Object.keys(extractServers(imported.value, kind)).length,
        } satisfies ImportConfigSummary;
      })
      .filter((value): value is ImportConfigSummary => value !== null)
    : [];
  const hostConfigDiscovery = isExclusiveConfigMode()
    ? "off"
    : getConfiguredHostConfigDiscovery(overridePath, cwd);
  const hostConfigs = imports
    .filter((entry) => entry.kind !== "agents")
    .map((entry) => ({ ...entry, active: hostConfigDiscovery === "on" }));
  const settings = getMergedSettings(overridePath, cwd);
  const agentPlugins = isExclusiveConfigMode()
    ? []
    : getAgentPluginSummaries(settings?.agentPluginPaths, cwd);
  const activeSources = sources.filter((_source, index) => sourceSpecs[index]?.active !== false);
  const activeAgentsImport = isAgentsImportActive(sourceSpecs, cwd);
  const activeAgentsServerCount = activeAgentsImport
    ? imports.find((entry) => entry.kind === "agents")?.serverCount ?? 0
    : 0;
  const totalServerCount = activeSources.reduce((sum, source) => sum + source.serverCount, 0)
    + activeAgentsServerCount
    + agentPlugins.reduce((sum, plugin) => sum + plugin.serverCount, 0);
  const hasSharedServers = activeSources.some((source) => source.kind === "shared" && source.serverCount > 0) || agentPlugins.some(plugin => plugin.serverCount > 0);
  const hasPiOwnedServers = activeSources.some((source) => source.kind === "pi" && source.serverCount > 0);
  const hasAnyDetectedPaths = sources.some((source) => source.exists) || imports.length > 0 || agentPlugins.length > 0;
  const hasAnyConfig = totalServerCount > 0 || imports.some((entry) => entry.serverCount > 0) || hasAnyDetectedPaths;

  const summaryWithoutRepoPrompt = {
    sources,
    imports,
    hostConfigs,
    hostConfigDiscovery,
    agentPlugins,
    conflicts: getConfigConflicts(sourceSpecs, imports, cwd, overridePath),
    hasAnyConfig,
    hasAnyDetectedPaths,
    hasSharedServers,
    hasPiOwnedServers,
    totalServerCount,
  };

  const fingerprint = JSON.stringify({
    sources: sources.map((source, index) => [source.id, source.exists, source.serverCount, sourceSpecs[index]?.active !== false]),
    imports: imports.map((entry) => [entry.kind, entry.path, entry.serverCount]),
    agentPlugins: agentPlugins.map((entry) => [entry.path, entry.name, entry.serverCount]),
    hostConfigDiscovery,
    conflicts: summaryWithoutRepoPrompt.conflicts,
  });

  return {
    ...summaryWithoutRepoPrompt,
    fingerprint,
    repoPrompt: detectRepoPrompt(summaryWithoutRepoPrompt, cwd),
    knownServerPresets: KNOWN_SERVER_PRESETS.filter(({ desktopApp }) => !desktopApp || desktopApp.paths.some((path) => existsSync(path))),
  };
}

export function cloneMcpConfig(config: McpConfig): McpConfig {
  const cloned = structuredClone(config);
  for (const [name, source] of Object.entries(config.mcpServers)) {
    const builtInClone = cloneBuiltInAgentPluginEntry(source);
    if (builtInClone) cloned.mcpServers[name] = builtInClone;
  }
  return cloned;
}

export interface ProjectServerSource {
  path: string;
}

export interface LoadedMcpConfig {
  config: McpConfig;
  projectServers: Map<string, ProjectServerSource>;
  projectServerPolicy: "ask" | "allow";
}

interface ImportedServerSource {
  path: string;
  scope: "user" | "project";
}

interface LoadedHostConfig {
  config: McpConfig;
  serverSources: Map<string, ImportedServerSource>;
}

export const MCP_CONFIG_SOURCE_METADATA = Symbol.for("pi-mcp-adapter/config-source-metadata");

export function loadMcpConfig(overridePath?: string, cwd = process.cwd()): McpConfig {
  const loaded = loadMcpConfigWithSources(overridePath, cwd);
  Object.defineProperty(loaded.config, MCP_CONFIG_SOURCE_METADATA, {
    value: { projectServers: loaded.projectServers, projectServerPolicy: loaded.projectServerPolicy },
    enumerable: false,
  });
  return loaded.config;
}

export function loadMcpConfigWithSources(overridePath?: string, cwd = process.cwd()): LoadedMcpConfig {
  const sourceSpecs = getConfigSources(overridePath, cwd);
  const hostConfigDiscovery = getConfiguredHostConfigDiscovery(overridePath, cwd);
  const projectServers = new Map<string, ProjectServerSource>();
  let projectServerPolicy: "ask" | "allow" = "ask";
  let projectAgentPluginSource: ProjectServerSource | undefined;
  let projectClaudePluginSource: ProjectServerSource | undefined;
  // Host files are a lower-precedence fallback. This ordering means an opt-in
  // discovery cannot override a shared or adapter-owned definition, and all normal
  // URL-bound credential stripping remains in mergeServerMaps.
  const discoveredHost = !isExclusiveConfigMode() && hostConfigDiscovery === "on"
    ? loadDiscoveredHostConfigs(cwd)
    : { config: { mcpServers: {} }, serverSources: new Map<string, ImportedServerSource>() };
  let config: McpConfig = discoveredHost.config;

  for (const [name, source] of discoveredHost.serverSources) {
    if (source.scope === "project") projectServers.set(name, { path: source.path });
  }

  const piProjectSource = sourceSpecs.find((source) => source.id === "pi-mcp-project");
  const piProjectNames = Object.keys((piProjectSource && readPiMcpConfig(piProjectSource.readPath))?.mcpServers ?? {});
  for (const source of sourceSpecs) {
    if (source.active === false) continue;
    const loaded = readSourceForUse(source, cwd, config);
    if (!loaded) continue;
    // Pi replaces a global entry that the project file redefines; mergeServerMaps would merge fields.
    if (source.id === "pi-mcp-global") {
      for (const name of piProjectNames) delete loaded.mcpServers[name];
    }
    const expandedImport = expandImports(loaded, cwd);
    const expanded = expandedImport.config;
    const sourceRef = { path: source.readPath };
    if (Object.hasOwn(expanded.settings ?? {}, "agentPluginPaths")) {
      projectAgentPluginSource = source.scope === "project" ? sourceRef : undefined;
    }
    if (expanded.claudePlugins !== undefined) {
      projectClaudePluginSource = source.scope === "project" ? sourceRef : undefined;
    }
    if (source.scope === "project") {
      // Imports expanded by a project file are project-scoped even when they read home-level files.
      for (const name of Object.keys(expanded.mcpServers)) projectServers.set(name, sourceRef);
      if (expanded.settings?.projectServers !== undefined) {
        console.warn(`Ignoring settings.projectServers in project config ${source.readPath}; set it in the user-global MCP config instead`);
        const { projectServers: _ignored, ...settings } = expanded.settings;
        expanded.settings = settings;
      }
    } else if (expanded.settings?.projectServers === "allow" || expanded.settings?.projectServers === "ask") {
      projectServerPolicy = expanded.settings.projectServers;
    }
    for (const [name, importedSource] of expandedImport.serverSources) {
      if (importedSource.scope === "project") projectServers.set(name, { path: importedSource.path });
    }
    config = mergeConfigs(config, expanded);
  }

  if (isExclusiveConfigMode()) {
    return { config: stripProjectProviderAuth(resolveConfiguredClaudePluginMcp(config, cwd), projectServers), projectServers, projectServerPolicy };
  }

  const packageConfig = loadPackageMcpConfigs(cwd);
  const pluginConfig = loadAgentPluginConfigs(config.settings?.agentPluginPaths, cwd);
  if (projectAgentPluginSource) {
    for (const name of Object.keys(pluginConfig.mcpServers)) projectServers.set(name, projectAgentPluginSource);
  }
  const packageServers = Object.fromEntries(
    Object.entries(packageConfig.mcpServers).filter(([name]) => !Object.hasOwn(pluginConfig.mcpServers, name)),
  );
  for (const name of Object.keys(packageServers)) {
    const source = packageConfig.serverSources.get(name);
    if (source?.scope === "project") projectServers.set(name, { path: source.settingsPath });
  }
  const higherPrecedenceConfig = mergeConfigs(
    { mcpServers: packageServers },
    mergeConfigs(pluginConfig, config),
  );
  const claudePluginServers = new Set<string>();
  const mergedConfig = mergeClaudePluginMcpDefaults(config.claudePlugins, higherPrecedenceConfig, cwd, claudePluginServers);
  if (projectClaudePluginSource) {
    for (const name of claudePluginServers) projectServers.set(name, projectClaudePluginSource);
  }
  return {
    config: stripProjectProviderAuth(mergedConfig, projectServers),
    projectServers,
    projectServerPolicy,
  };
}

/** Pi provider tokens go only to servers from user-global config; Pi forbids `auth` in project files too. */
function stripProjectProviderAuth(config: McpConfig, projectServers: Map<string, ProjectServerSource>): McpConfig {
  const stripped = [...projectServers.keys()].filter((name) => typeof config.mcpServers[name]?.auth === "object");
  if (stripped.length === 0) return config;
  const mcpServers = { ...config.mcpServers };
  for (const name of stripped) {
    delete mcpServers[name];
    projectServers.delete(name);
  }
  console.warn(`Ignoring MCP servers ${stripped.map((name) => `"${name}"`).join(", ")}: auth.provider is only allowed in user-global config, and project config defines or overrides them`);
  return { ...config, mcpServers };
}

export function resolveConfiguredClaudePluginMcp(config: McpConfig, cwd = process.cwd()): McpConfig {
  return mergeClaudePluginMcpDefaults(config.claudePlugins, config, cwd);
}

export function discoverConfiguredClaudePluginSkills(config: McpConfig, cwd = process.cwd()): string[] {
  return loadClaudePluginBundles(config.claudePlugins, cwd, validateConfig, { mcp: false, skills: true }).skillPaths;
}

function mergeClaudePluginMcpDefaults(
  plugins: ClaudePluginConfig[] | undefined,
  higherPrecedenceConfig: McpConfig,
  cwd: string,
  loadedServerNames?: Set<string>,
): McpConfig {
  const pluginServers = loadClaudePluginBundles(plugins, cwd, validateConfig, { mcp: true, skills: false }).mcpServers;
  const higherNamesByNamespace = new Map(
    Object.keys(higherPrecedenceConfig.mcpServers).map(name => [formatServerNamespace(name), name]),
  );
  const defaults = Object.fromEntries(Object.entries(pluginServers).filter(([name]) => {
    const higherName = higherNamesByNamespace.get(formatServerNamespace(name));
    if (!higherName || higherName === name) return true;
    console.warn(`Claude plugin MCP server "${name}" is shadowed by higher-precedence server "${higherName}" because both normalize to the same namespace`);
    return false;
  }));
  for (const name of Object.keys(defaults)) loadedServerNames?.add(name);
  return applySettingDefaults(mergeConfigs({ mcpServers: defaults }, higherPrecedenceConfig));
}

function applySettingDefaults(config: McpConfig): McpConfig {
  const exposeResources = config.settings?.exposeResources;
  if (exposeResources === undefined) return config;
  const mcpServers = Object.fromEntries(Object.entries(config.mcpServers)
    .map(([name, entry]) => [name, entry.exposeResources === undefined ? { ...entry, exposeResources } : entry]));
  return { ...config, mcpServers };
}

function getMergedSettings(overridePath?: string, cwd = process.cwd()): McpSettings | undefined {
  let settings: McpSettings | undefined;
  for (const source of getConfigSources(overridePath, cwd)) {
    if (source.active === false || isReadOnlyImportedPath(source.readPath, cwd)) continue;
    const loaded = readSourceConfig(source.id, source.readPath, cwd, source.nativePi);
    if (loaded?.settings) settings = { ...settings, ...loaded.settings };
  }
  return settings;
}

function getConfiguredHostConfigDiscovery(overridePath?: string, cwd = process.cwd()): HostConfigDiscovery {
  let configured: HostConfigDiscovery = "off";
  const settings = getMergedSettings(overridePath, cwd);
  const value = settings?.hostConfigDiscovery;
  if (value === "off" || value === "prompt" || value === "on") configured = value;
  return configured;
}

function getConfiguredImportKinds(sourceSpecs: ConfigSourceSpec[], cwd: string): ImportKind[] {
  const importKinds: ImportKind[] = [];
  let effectiveConfig: McpConfig = { mcpServers: {} };
  for (const source of sourceSpecs) {
    if (source.active === false || isReadOnlyImportedPath(source.readPath, cwd)) continue;
    const loaded = readSourceForUse(source, cwd, effectiveConfig);
    if (!loaded) continue;
    for (const importKind of loaded.imports ?? []) {
      if (!importKinds.includes(importKind)) importKinds.push(importKind);
    }
    effectiveConfig = mergeConfigs(effectiveConfig, expandImports(loaded, cwd).config);
  }
  return importKinds;
}

function isAgentsImportActive(sourceSpecs: ConfigSourceSpec[], cwd: string): boolean {
  return getConfiguredImportKinds(sourceSpecs, cwd).includes("agents");
}

function loadDiscoveredHostConfigs(cwd: string): LoadedHostConfig {
  let config: McpConfig = { mcpServers: {} };
  const serverSources = new Map<string, ImportedServerSource>();
  for (const importKind of HOST_IMPORT_KINDS) {
    const imported = loadImportedConfig(importKind, cwd, `Failed to discover imported MCP config from ${importKind}:`);
    if (!imported) continue;
    const servers = extractServers(imported.value, importKind);
    config = mergeConfigs(config, {
      mcpServers: servers,
    });
    for (const name of Object.keys(servers)) {
      const source = imported.serverSources.get(name);
      if (source?.scope === "project" || !serverSources.has(name)) serverSources.set(name, source ?? imported.source);
    }
  }
  return { config, serverSources };
}

function getConfigConflicts(
  sourceSpecs: ConfigSourceSpec[],
  imports: ImportConfigSummary[],
  cwd: string,
  overridePath?: string,
): McpConfigConflict[] {
  const seen = new Map<string, Array<{ kind: "shared" | "pi" | "explicit" | "host"; path: string }>>();
  const record = (name: string, source: { kind: "shared" | "pi" | "explicit" | "host"; path: string }): void => {
    const entries = seen.get(name) ?? [];
    if (!entries.some((entry) => entry.kind === source.kind && entry.path === source.path)) entries.push(source);
    seen.set(name, entries);
  };

  // Host candidates are listed first because, when enabled, they are the
  // lowest-precedence fallback. The fixed IMPORT_PATHS order is deterministic.
  const agentsImportActive = isAgentsImportActive(sourceSpecs, cwd);
  for (const entry of imports) {
    if (entry.kind === "agents" && !agentsImportActive) continue;
    const imported = loadImportedConfig(entry.kind, cwd, `Failed to inspect imported MCP config from ${entry.kind}:`);
    if (!imported) continue;
    for (const name of Object.keys(extractServers(imported.value, entry.kind))) {
      record(name, { kind: "host", path: imported.path });
    }
  }
  const hostDiscoveryOn = !isExclusiveConfigMode() && getConfiguredHostConfigDiscovery(overridePath, cwd) === "on";
  let effectiveConfig: McpConfig = hostDiscoveryOn ? loadDiscoveredHostConfigs(cwd).config : { mcpServers: {} };
  for (const source of sourceSpecs) {
    if (source.active === false) continue;
    const loaded = readSourceForUse(source, cwd, effectiveConfig);
    if (!loaded) continue;
    if (loaded.imports?.length) {
      for (const importKind of loaded.imports) {
        const imported = loadImportedConfig(importKind, cwd, `Failed to inspect imported MCP config from ${importKind}:`);
        if (!imported) continue;
        for (const name of Object.keys(extractServers(imported.value, importKind))) {
          record(name, { kind: "host", path: imported.path });
        }
      }
    }
    for (const name of Object.keys(loaded.mcpServers)) {
      record(name, {
        kind: source.id === "explicit-read-only" ? "explicit" : source.shared ? "shared" : "pi",
        path: source.readPath,
      });
    }
    effectiveConfig = mergeConfigs(effectiveConfig, expandImports(loaded, cwd).config);
  }

  return [...seen.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([serverName, sources]) => ({ serverName, sources, winner: sources[sources.length - 1]! }))
    .sort((left, right) => left.serverName.localeCompare(right.serverName));
}

function getConfigSources(overridePath?: string, cwd = process.cwd()): ConfigSourceSpec[] {
  const canonicalPiGlobalPath = getPiGlobalConfigPath(undefined, cwd);
  const userPath = getPiGlobalConfigPath(overridePath, cwd);
  const projectPath = getProjectConfigPath(cwd);
  const projectPiPath = getProjectPiConfigPath(cwd);
  const explicitOwnership = overridePath === undefined ? undefined : classifyConfigPath(userPath, cwd);
  const userPathOwnership = classifyConfigPath(userPath, cwd);
  const explicitGlobalSourceNeeded = overridePath !== undefined
    && explicitOwnership !== "pi-global"
    && explicitOwnership !== "pi-project";
  const sources: ConfigSourceSpec[] = [];

  const explicitSource = (): ConfigSourceSpec => ({
    id: "explicit-read-only",
    label: isExclusiveConfigMode() ? "Pi exclusive explicit config" : "Explicit read-only MCP config",
    readPath: userPath,
    writePath: userPath,
    kind: "user",
    shared: false,
    scope: "global",
    nativePi: explicitOwnership === "pi-native-global" || explicitOwnership === "pi-native-project",
  });
  const canonicalPiSource = (): ConfigSourceSpec => ({
    id: "pi-global",
    label: isExclusiveConfigMode() ? "Pi exclusive config" : "MCP adapter global override",
    readPath: canonicalPiGlobalPath,
    writePath: canonicalPiGlobalPath,
    kind: "user",
    shared: false,
    scope: "global",
    ...inactiveForPiAlias(canonicalPiGlobalPath, cwd),
  });
  const adapterOverlaySource = (): ConfigSourceSpec => ({
    id: "pi-adapter-overlay",
    label: "Pi adapter overlay",
    readPath: canonicalPiGlobalPath,
    writePath: canonicalPiGlobalPath,
    kind: "user",
    shared: false,
    scope: "global",
    projection: "adapter",
    ...inactiveForPiAlias(canonicalPiGlobalPath, cwd),
  });
  const canonicalProjectPiSource = (): ConfigSourceSpec => ({
    id: "pi-project",
    label: "project MCP adapter override",
    readPath: projectPiPath,
    writePath: projectPiPath,
    kind: "project",
    shared: false,
    scope: "project",
    ...inactiveForPiAlias(projectPiPath, cwd),
  });

  if (isExclusiveConfigMode()) {
    if (overridePath !== undefined) {
      if (explicitOwnership === "pi-global") return [canonicalPiSource()];
      if (explicitOwnership === "pi-project") return [canonicalProjectPiSource()];
      return [explicitSource(), adapterOverlaySource()];
    }
    return [canonicalPiSource()];
  }

  if (!sameConfigIdentity(GENERIC_GLOBAL_CONFIG_PATH, userPath)
    || (overridePath === undefined && userPathOwnership === "shared-global")) {
    sources.push({
      id: "shared-global",
      label: "user-global standard MCP",
      readPath: GENERIC_GLOBAL_CONFIG_PATH,
      writePath: canonicalPiGlobalPath,
      kind: "import",
      importKind: "global MCP config",
      shared: true,
      scope: "global",
      ...inactiveForExternalAlias(GENERIC_GLOBAL_CONFIG_PATH, cwd),
    });
  }

  for (const [index, agentsPath] of AGENTS_GLOBAL_CONFIG_PATHS.entries()) {
    if (sameConfigIdentity(agentsPath, userPath) || sameConfigIdentity(agentsPath, GENERIC_GLOBAL_CONFIG_PATH)) continue;
    sources.push({
      id: index === 0 ? "agents-global" : "agents-nested-global",
      label: index === 0 ? "user-global .agents MCP" : "user-global .agents nested MCP",
      readPath: agentsPath,
      writePath: canonicalPiGlobalPath,
      kind: "import",
      importKind: index === 0 ? ".agents MCP config" : ".agents/mcp MCP config",
      shared: true,
      scope: "global",
      active: false,
    });
  }

  const piMcpGlobalPath = getPiMcpGlobalConfigPath();
  if (piMcpConfigEnabled && !sameConfigIdentity(piMcpGlobalPath, userPath)
    && !sources.some((source) => sameConfigIdentity(source.readPath, piMcpGlobalPath))) {
    sources.push({
      id: "pi-mcp-global",
      label: "user-global Pi MCP",
      readPath: piMcpGlobalPath,
      writePath: canonicalPiGlobalPath,
      kind: "import",
      importKind: "Pi mcp.json",
      shared: true,
      scope: "global",
      ...inactiveForNativeAlias(piMcpGlobalPath, cwd),
    });
  }

  if (explicitGlobalSourceNeeded) {
    sources.push(explicitSource());
    sources.push(adapterOverlaySource());
  } else {
    sources.push(canonicalPiSource());
  }

  // Compare file identities so symlink aliases cannot reload a global source
  // at ancestor precedence. Keep original paths for display and writes.
  const projectPiMcpPath = getProjectPiMcpConfigPath(cwd);
  const reservedPaths = new Set([
    ...sources.map((source) => getConfigPathIdentity(source.readPath)),
    getConfigPathIdentity(projectPath),
    getConfigPathIdentity(projectPiPath),
    ...(piMcpConfigEnabled ? [getConfigPathIdentity(projectPiMcpPath)] : []),
  ]);
  // Only user-global files (including an explicit override) may opt in to
  // ancestor discovery. Project files cannot extend this trust boundary.
  const ancestorSources = new Map<string, ConfigSourceSpec>();
  const descriptors = [
    { id: "shared-project-ancestor", label: "ancestor standard MCP", path: getProjectConfigPath, shared: true },
    { id: "pi-project-ancestor", label: "ancestor MCP adapter override", path: getProjectPiConfigPath, shared: false },
  ] as const;
  const ancestorRoot = getConfiguredAncestorRoot(sources, cwd);
  if (ancestorRoot) {
    for (const dir of getAncestorProjectDirs(cwd, ancestorRoot)) {
      for (const descriptor of descriptors) {
        const path = descriptor.path(dir);
        const identity = getConfigPathIdentity(path);
        if (reservedPaths.has(identity) || !existsSync(path)) continue;
        ancestorSources.delete(identity);
        ancestorSources.set(identity, {
          id: descriptor.id,
          label: descriptor.label,
          readPath: path,
          writePath: path,
          kind: "project",
          shared: descriptor.shared,
          scope: "project",
          ...inactiveForExternalAlias(path, cwd),
        });
      }
    }
  }
  sources.push(...ancestorSources.values());

  if (!sameConfigIdentity(projectPath, userPath)
    || (overridePath === undefined && (userPathOwnership === "shared-project" || sameConfigIdentity(projectPiPath, projectPath)))) {
    sources.push({
      id: "shared-project",
      label: "project standard MCP",
      readPath: projectPath,
      writePath: projectPath,
      kind: "project",
      shared: true,
      scope: "project",
      ...inactiveForExternalAlias(projectPath, cwd),
    });
  }

  // Pi reads `.pi/mcp.json` only in the cwd, so it is not part of ancestor discovery.
  if (piMcpConfigEnabled && !sameConfigIdentity(projectPiMcpPath, userPath)
    && !sameConfigIdentity(projectPiMcpPath, piMcpGlobalPath)) {
    sources.push({
      id: "pi-mcp-project",
      label: "project Pi MCP",
      readPath: projectPiMcpPath,
      writePath: projectPiPath,
      kind: "import",
      importKind: "Pi project mcp.json",
      shared: true,
      scope: "project",
      ...inactiveForNativeAlias(projectPiMcpPath, cwd),
    });
  }

  if (explicitOwnership === "pi-project") {
    sources.push(canonicalProjectPiSource());
  } else if (!sameConfigIdentity(projectPiPath, userPath) && !sameConfigIdentity(projectPiPath, projectPath)) {
    sources.push(canonicalProjectPiSource());
  }

  return sources;
}

type ConfigOwnership = "pi-global" | "pi-project" | "pi-native-global" | "pi-native-project" | "shared-global" | "shared-project" | "agents" | "host" | "other";
type ConfigWriteIntent = "pi-global" | "pi-project" | "shared-global" | "shared-project" | "shared";

function getConfigPathIdentity(path: string, seen = new Set<string>()): string {
  const absolute = resolve(path);
  if (seen.has(absolute)) return absolute;
  const nextSeen = new Set(seen).add(absolute);
  try {
    return realpathSync(absolute);
  } catch {
    // Resolve symlink targets even when the target config has not been created
    // yet, then resolve existing parent symlinks for ordinary missing paths.
    try {
      const linkTarget = readlinkSync(absolute);
      return getConfigPathIdentity(isAbsolute(linkTarget) ? linkTarget : resolve(dirname(absolute), linkTarget), nextSeen);
    } catch {
      const parent = dirname(absolute);
      if (parent === absolute) return absolute;
      return join(getConfigPathIdentity(parent, nextSeen), relative(parent, absolute));
    }
  }
}

function sameConfigIdentity(left: string, right: string): boolean {
  return getConfigPathIdentity(left) === getConfigPathIdentity(right);
}

function classifyConfigPath(filePath: string, cwd: string): ConfigOwnership {
  const identity = getConfigPathIdentity(filePath);
  const matches = (candidate: string): boolean => identity === getConfigPathIdentity(candidate);

  // External/shared identities must win over an adapter path that happens to
  // be a symlink into them; otherwise an alias could bypass read-only rules.
  if (AGENTS_GLOBAL_CONFIG_PATHS.some(matches)) return "agents";
  if (HOST_IMPORT_KINDS.some((kind) => resolveImportCandidates(kind, cwd).some((candidate) => matches(candidate.path)))) return "host";
  if (matches(GENERIC_GLOBAL_CONFIG_PATH)) return "shared-global";
  if (matches(getProjectConfigPath(cwd))) return "shared-project";
  if (matches(getPiMcpGlobalConfigPath())) return "pi-native-global";
  if (matches(getProjectPiMcpConfigPath(cwd))) return "pi-native-project";
  if (matches(getPiGlobalConfigPath(undefined, cwd))) return "pi-global";
  if (matches(getProjectPiConfigPath(cwd))) return "pi-project";
  return "other";
}

function resolveWritableConfigPath(filePath: string, cwd: string, intent: ConfigWriteIntent): string {
  assertNotAliasedToHostTool(filePath, cwd);
  const targetPath = getConfigPathIdentity(resolve(cwd, filePath));
  const ownership = classifyConfigPath(targetPath, cwd);
  const allowed = intent === "pi-global"
    ? ownership === "pi-global"
    : intent === "pi-project"
      ? ownership === "pi-project"
      : intent === "shared-global"
        ? ownership === "shared-global"
        : intent === "shared-project"
          ? ownership === "other" || ownership === "shared-project"
          : ownership === "other" || ownership === "shared-global" || ownership === "shared-project";
  if (!allowed) {
    if (ownership === "agents" || ownership === "host" || ownership === "pi-native-global" || ownership === "pi-native-project") {
      throw new Error(`Refusing to write read-only imported MCP config at ${filePath}`);
    }
    throw new Error(`Refusing to write MCP config at ${filePath}: destination is not ${intent}-owned`);
  }
  return resolve(cwd, filePath);
}

function isReadOnlyImportedPath(filePath: string, cwd: string): boolean {
  const ownership = classifyConfigPath(filePath, cwd);
  // Native Pi files are active, read-only inputs. Only compatibility sources
  // are detection-only and must not contribute settings or self-activation.
  return ownership === "agents" || ownership === "host";
}

function inactiveForExternalAlias(filePath: string, cwd: string): { active: false } | Record<string, never> {
  return isReadOnlyImportedPath(filePath, cwd) ? { active: false } : {};
}

function inactiveForPiAlias(filePath: string, cwd: string): { active: false } | Record<string, never> {
  const ownership = classifyConfigPath(filePath, cwd);
  return ownership === "agents" || ownership === "host" || ownership === "shared-global" || ownership === "shared-project"
    || ownership === "pi-native-global" || ownership === "pi-native-project"
    ? { active: false }
    : {};
}

function inactiveForNativeAlias(filePath: string, cwd: string): { active: false } | Record<string, never> {
  const ownership = classifyConfigPath(filePath, cwd);
  return ownership === "agents" || ownership === "host" || ownership === "shared-global" || ownership === "shared-project"
    || ownership === "pi-global" || ownership === "pi-project"
    ? { active: false }
    : {};
}

/**
 * TLH fork: throw a write refusal if the target path is aliased (via symlink
 * or resolved identity) to a host tool's MCP config path. This prevents
 * silently overwriting Cursor, Windsurf, etc. through symlinks.
 */
function assertNotAliasedToHostTool(targetPath: string, cwd = process.cwd()): void {
  const identity = getConfigPathIdentity(resolve(cwd, targetPath));
  const hostImportKinds: ImportKind[] = ["cursor", "claude-code", "claude-desktop", "windsurf", "vscode", "codex", "opencode"];
  for (const kind of hostImportKinds) {
    const candidates = resolveImportCandidates(kind, cwd);
    if (candidates.some((c) => getConfigPathIdentity(c.path) === identity)) {
      throw new Error(`Refusing to write MCP config at ${targetPath}: destination is aliased to ${kind}'s config`);
    }
  }
}

function isWithin(base: string, target: string): boolean {
  const path = relative(base, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function getConfiguredAncestorRoot(globalSources: ConfigSourceSpec[], cwd: string): string | undefined {
  let configured: unknown;
  for (const source of globalSources) {
    if (source.active === false || isReadOnlyImportedPath(source.readPath, cwd)) continue;
    const roots = readSourceConfig(source.id, source.readPath, cwd, source.nativePi)?.settings?.ancestorConfigRoots;
    if (roots !== undefined) configured = roots;
  }
  if (configured === undefined || (Array.isArray(configured) && configured.length === 0)) return undefined;
  if (!Array.isArray(configured)) {
    console.warn("Invalid settings.ancestorConfigRoots: expected an array of paths");
    return undefined;
  }

  const home = getConfigPathIdentity(resolve(homedir()));
  const canonicalCwd = getConfigPathIdentity(resolve(cwd));
  const valid: string[] = [];
  for (const entry of configured) {
    const expanded = typeof entry === "string" && entry.startsWith("~/")
      ? join(homedir(), entry.slice(2))
      : entry;
    if (typeof expanded !== "string" || !isAbsolute(expanded)) {
      console.warn(`Invalid settings.ancestorConfigRoots entry ${JSON.stringify(entry)}: expected an absolute path or ~/...`);
      continue;
    }
    try {
      const root = realpathSync(expanded);
      if (!statSync(root).isDirectory() || !isWithin(home, root)) throw new Error();
      if (isWithin(root, canonicalCwd)) valid.push(root);
    } catch {
      console.warn(`Invalid settings.ancestorConfigRoots entry ${JSON.stringify(entry)}: expected an existing directory under HOME`);
    }
  }
  return valid.sort((left, right) => right.length - left.length)[0];
}

function getAncestorProjectDirs(cwd: string, root: string): string[] {
  const start = getConfigPathIdentity(resolve(cwd));
  const dirs: string[] = [];
  let current = dirname(start);
  while (isWithin(root, current)) {
    dirs.unshift(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function isExclusiveConfigMode(): boolean {
  return process.env.PI_MCP_CONFIG_MODE?.trim().toLowerCase() === "exclusive";
}

function mergeConfigs(base: McpConfig, next: McpConfig): McpConfig {
  const imports = mergeImports(base.imports, next.imports);
  const settings = next.settings ? { ...base.settings, ...next.settings } : base.settings;
  const claudePlugins = next.claudePlugins ?? base.claudePlugins;
  return {
    mcpServers: mergeServerMaps(base.mcpServers, next.mcpServers),
    ...(imports !== undefined ? { imports } : {}),
    ...(settings !== undefined ? { settings } : {}),
    ...(claudePlugins !== undefined ? { claudePlugins } : {}),
  };
}

// Credential-bearing fields whose value is bound to a specific server `url`.
// When a higher-precedence config source repoints an existing server at a
// different url, these MUST NOT be inherited from the lower-precedence entry —
// otherwise the original endpoint's credentials would be shipped to the new
// url. See the SECURITY note in mergeServerMaps.
const URL_BOUND_AUTH_FIELDS = ["headers", "bearerToken", "bearerTokenEnv", "bearerTokenStore", "requestHeadersCommand", "caFile"] as const;

function mergeServerMaps(
  base: Record<string, ServerEntry>,
  next: Record<string, ServerEntry>,
): Record<string, ServerEntry> {
  const merged = { ...base };
  for (const [name, definition] of Object.entries(next)) {
    const existing = merged[name];
    // SECURITY (credential/url binding): the merge is per-field, so a
    // higher-precedence source that supplies only a new `url` for an existing
    // server would otherwise retain the lower-precedence entry's auth material
    // (Authorization header, bearer token, OAuth config) and send it to the new
    // url — a credential-exfiltration vector when the higher-precedence source
    // is less trusted than the one that first defined the server. Bind auth to
    // the url that supplied it: when the url changes, drop inherited auth
    // material before merging. Auth explicitly re-supplied by `definition` still
    // applies (it is spread last). Behaviour is unchanged when the url is
    // identical or the override omits `url` (partial overrides still inherit).
    let baseEntry: ServerEntry = existing ?? {};
    if (existing && typeof definition.command === "string") {
      baseEntry = { ...existing };
      for (const field of [
        "url", "headers", "requestHeadersCommand", "caFile", "auth", "bearerToken",
        "bearerTokenEnv", "bearerTokenStore", "oauth", "httpTransport", "socket",
      ] as const) {
        delete baseEntry[field];
      }
    } else if (existing && typeof definition.url === "string") {
      baseEntry = { ...existing };
      for (const field of [
        "command", "args", "env", "cwd", "pluginDataDir", "literalEnv", "inheritEnv", "socket",
      ] as const) {
        delete baseEntry[field];
      }
    } else if (existing && typeof definition.socket === "string") {
      baseEntry = { ...existing };
      for (const field of [
        "command", "args", "env", "cwd", "pluginDataDir", "literalEnv", "inheritEnv", "url",
        "headers", "requestHeadersCommand", "caFile", "auth", "bearerToken", "bearerTokenEnv",
        "bearerTokenStore", "oauth", "httpTransport",
      ] as const) {
        delete baseEntry[field];
      }
    }
    if (existing && typeof definition.url === "string" && definition.url !== existing.url) {
      if (baseEntry === existing) baseEntry = { ...existing };
      for (const field of URL_BOUND_AUTH_FIELDS) {
        delete baseEntry[field];
      }
      // A provider token is bound to the url that asked for it, like the fields above.
      if (typeof baseEntry.auth === "object") delete baseEntry.auth;
      if (baseEntry.oauth !== false) {
        delete baseEntry.oauth;
      }
    }
    if (existing && Object.hasOwn(definition, "env") && isBuiltInAgentPlugin(existing, "env") && !Object.hasOwn(definition, "literalEnv")) {
      if (baseEntry === existing) baseEntry = { ...existing };
      delete baseEntry.literalEnv;
    }
    merged[name] = mergeBuiltInAgentPluginEntries(baseEntry, definition);
  }
  return merged;
}

function mergeImports(left: ImportKind[] | undefined, right: ImportKind[] | undefined): ImportKind[] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  if (merged.length === 0) return undefined;
  return [...new Set(merged)];
}

const ADAPTER_SERVER_FIELDS = [
  "directTools",
  "disabled",
  "toolPrefix",
  "includeTools",
  "excludeTools",
  "searchKeywords",
  "approveTools",
  "trace",
  "lifecycle",
  "idleTimeout",
  "requestTimeoutMs",
  "exposeResources",
  "debug",
  "protocolVersion",
  "tasks",
] as const;

function projectAdapterServerEntry(entry: ServerEntry): ServerEntry {
  const projected: Record<string, unknown> = {};
  for (const field of ADAPTER_SERVER_FIELDS) {
    if (Object.hasOwn(entry, field)) projected[field] = entry[field];
  }
  return projected as ServerEntry;
}

/**
 * Project adapter-owned state over an explicitly selected config without
 * importing complete server definitions or credentials from the adapter file.
 * This keeps an explicit config authoritative for transport and auth fields,
 * while still allowing the adapter's own settings and per-server controls.
 */
function projectAdapterOverlay(raw: McpConfig, base: McpConfig, cwd: string): McpConfig {
  const imported = raw.imports?.length
    ? expandImports({ imports: raw.imports, mcpServers: {} }, cwd)
    : { config: { mcpServers: {} }, serverSources: new Map<string, ImportedServerSource>() };
  const allowedServers = new Set([...Object.keys(base.mcpServers), ...Object.keys(imported.config.mcpServers)]);
  const mcpServers: Record<string, ServerEntry> = {};
  for (const [name, entry] of Object.entries(raw.mcpServers)) {
    if (!allowedServers.has(name)) continue;
    const projected = projectAdapterServerEntry(entry);
    if (Object.keys(projected).length > 0) mcpServers[name] = projected;
  }
  return {
    mcpServers,
    ...(raw.imports !== undefined ? { imports: raw.imports } : {}),
    ...(raw.settings !== undefined ? { settings: raw.settings } : {}),
  };
}

function expandImports(config: McpConfig, cwd = process.cwd()): LoadedHostConfig {
  if (!config.imports?.length) return { config, serverSources: new Map() };

  const importedServers: Record<string, ServerEntry> = {};
  const serverSources = new Map<string, ImportedServerSource>();
  for (const importKind of config.imports) {
    const imported = loadImportedConfig(importKind, cwd, `Failed to import MCP config from ${importKind}:`);
    if (!imported) continue;

    const servers = extractServers(imported.value, importKind);
    for (const [name, definition] of Object.entries(servers)) {
      if (!importedServers[name]) {
        importedServers[name] = definition;
        serverSources.set(name, imported.serverSources.get(name) ?? imported.source);
      }
    }
  }

  return {
    config: {
      imports: config.imports,
      ...(config.settings !== undefined ? { settings: config.settings } : {}),
      ...(config.claudePlugins !== undefined ? { claudePlugins: config.claudePlugins } : {}),
      mcpServers: mergeServerMaps(importedServers, config.mcpServers),
    },
    serverSources,
  };
}

function resolveImportCandidates(importKind: ImportKind, cwd: string): ImportedServerSource[] {
  return (IMPORT_PATHS[importKind] ?? []).map((candidate) => {
    const scope = candidate.startsWith(".") ? "project" : "user";
    if (importKind === "opencode" && candidate === "./opencode.json") {
      const start = resolve(cwd);
      let gitRoot: string | undefined;
      let current = start;
      while (true) {
        if (existsSync(join(current, ".git"))) {
          gitRoot = current;
          break;
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }

      if (!gitRoot) return { path: join(start, "opencode.json"), scope };
      current = start;
      while (true) {
        const projectConfig = join(current, "opencode.json");
        if (existsSync(projectConfig) || current === gitRoot) return { path: projectConfig, scope };
        current = dirname(current);
      }
    }
    return { path: candidate.startsWith(".") ? resolve(cwd, candidate) : candidate, scope };
  });
}

function readImportedConfig(path: string): unknown {
  const raw = readFileSync(path, "utf-8");
  return path.endsWith(".toml") ? parseToml(stripUtf8Bom(raw)) : parseJsonWithComments(raw);
}

function loadImportedConfig(
  importKind: ImportKind,
  cwd: string,
  warningPrefix: string,
): { path: string; value: unknown; source: ImportedServerSource; serverSources: Map<string, ImportedServerSource> } | null {
  if (importKind === "agents") {
    // .agents is a compatibility input, not an adapter config. Explicit
    // imports may use its server definitions, but never its settings/imports.
    let mergedServers: Record<string, ServerEntry> = {};
    let highestPrecedenceSource: ImportedServerSource | undefined;
    const serverSources = new Map<string, ImportedServerSource>();
    for (const source of resolveImportCandidates(importKind, cwd)) {
      if (!existsSync(source.path)) continue;
      try {
        const value = readImportedConfig(source.path);
        const servers = extractServers(value, importKind);
        mergedServers = mergeServerMaps(mergedServers, servers);
        for (const name of Object.keys(servers)) serverSources.set(name, source);
        highestPrecedenceSource = source;
      } catch (error) {
        console.warn(warningPrefix, error);
      }
    }
    if (!highestPrecedenceSource) return null;
    return {
      path: highestPrecedenceSource.path,
      value: { mcpServers: mergedServers },
      source: highestPrecedenceSource,
      serverSources,
    };
  }

  if (importKind === "opencode") {
    let merged: Record<string, unknown> = {};
    let highestPrecedenceSource: ImportedServerSource | undefined;
    const serverSources = new Map<string, ImportedServerSource>();

    for (const source of resolveImportCandidates(importKind, cwd)) {
      const { path } = source;
      if (!existsSync(path)) continue;

      try {
        const value = readImportedConfig(path);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const imported = value as Record<string, unknown>;
          const mcp = isRecord(imported.mcp) ? imported.mcp : {};
          // OpenCode v2 nests definitions under mcp.servers; normalize before
          // merging so project overrides retain the existing merge semantics.
          const entries = isRecord(mcp.servers)
            ? { ...Object.fromEntries(Object.entries(mcp).filter(([name]) => name !== "servers" && name !== "timeout")), ...mcp.servers }
            : mcp;
          const normalized = Object.fromEntries(Object.entries(entries).map(([name, entry]) => {
            if (!isRecord(entry) || !isRecord(entry.oauth)) return [name, entry];
            const { client_id, client_secret, auth_server_metadata_url, ...oauth } = entry.oauth;
            return [name, {
              ...entry,
              oauth: {
                ...oauth,
                ...(client_id !== undefined ? { clientId: client_id } : {}),
                ...(client_secret !== undefined ? { clientSecret: client_secret } : {}),
                ...(auth_server_metadata_url !== undefined ? { authServerMetadataUrl: auth_server_metadata_url } : {}),
              },
            }];
          }));
          merged = mergeOpenCodeConfigs(merged, { ...imported, mcp: normalized });
          for (const name of Object.keys(normalized)) serverSources.set(name, source);
          highestPrecedenceSource = source;
        }
      } catch (error) {
        console.warn(warningPrefix, error);
      }
    }

    if (!highestPrecedenceSource) return null;
    const finalNames = new Set(Object.keys(extractServers(merged, importKind)));
    for (const name of serverSources.keys()) {
      if (!finalNames.has(name)) serverSources.delete(name);
    }
    return {
      path: highestPrecedenceSource.path,
      value: merged,
      source: highestPrecedenceSource,
      serverSources,
    };
  }

  for (const source of resolveImportCandidates(importKind, cwd)) {
    const { path } = source;
    if (!existsSync(path)) continue;

    try {
      const value = readImportedConfig(path);
      return {
        path,
        value,
        source,
        serverSources: new Map(Object.keys(extractServers(value, importKind)).map(name => [name, source])),
      };
    } catch (error) {
      console.warn(warningPrefix, error);
    }
  }

  return null;
}

function resolveImportPath(importKind: ImportKind, cwd = process.cwd()): string | null {
  return loadImportedConfig(importKind, cwd, `Failed to discover imported MCP config from ${importKind}:`)?.path ?? null;
}

function readValidatedConfig(path: string, label: string): McpConfig | null {
  if (!existsSync(path)) return null;

  try {
    const text = readFileSync(path, "utf-8");
    if (stripJsonComments(text, { trailingCommas: true }).trim() === "") return null;
    return validateConfig(parseJsonWithComments(text));
  } catch (error) {
    console.warn(`Failed to load ${label}:`, error);
    return null;
  }
}

function isPiMcpSource(id: ConfigSourceSpec["id"]): boolean {
  return id === "pi-mcp-global" || id === "pi-mcp-project";
}

function readSourceConfig(
  id: ConfigSourceSpec["id"],
  path: string,
  cwd = process.cwd(),
  nativePi = false,
): (McpConfig & { ignoredSettings?: Map<string, string[]> }) | null {
  return isPiMcpSource(id) || nativePi || (id === "explicit-read-only" && isNativePiPath(path, cwd))
    ? readPiMcpConfig(path)
    : readValidatedConfig(path, `MCP config from ${path}`);
}

function isNativePiPath(path: string, cwd: string): boolean {
  return classifyConfigPath(path, cwd) === "pi-native-global" || classifyConfigPath(path, cwd) === "pi-native-project";
}

interface PiMcpConfigFile {
  mcpServers: Record<string, ServerEntry>;
  /** Top-level keys of old adapter configs, which only mcp-adapter.json reads. */
  adapterKeys: string[];
  skipped: string[];
  ignoredSettings: Map<string, string[]>;
}

const PI_MCP_EXPOSURES = ["codemode", "codemode-deferred", "deferred", "direct", "hidden"];

/** Pi's top-level `autoEnableCodemode` has no adapter equivalent and is ignored. */
function readPiMcpConfig(path: string): PiMcpConfigFile | null {
  if (!existsSync(path)) return null;
  let raw: Record<string, unknown>;
  try {
    const text = readFileSync(path, "utf-8");
    if (stripJsonComments(text, { trailingCommas: true }).trim() === "") return null;
    const parsed = parseJsonWithComments(text);
    if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
      throw new Error('expected an object with an "mcpServers" object');
    }
    raw = parsed;
  } catch (error) {
    console.warn(`Failed to load Pi MCP config from ${path}:`, error);
    return null;
  }
  const file: PiMcpConfigFile = {
    mcpServers: {},
    adapterKeys: ["settings", "imports", "claudePlugins", "mcp-servers"].filter((key) => raw[key] !== undefined),
    skipped: [],
    ignoredSettings: new Map(),
  };
  for (const [name, value] of Object.entries((raw.mcpServers ?? {}) as Record<string, unknown>)) {
    const translated = translatePiMcpServer(name, value);
    if (typeof translated === "string") {
      file.skipped.push(`"${name}" (${translated})`);
      continue;
    }
    file.mcpServers[name] = translated.entry;
    if (translated.ignored.length > 0) file.ignoredSettings.set(name, translated.ignored);
  }
  return file;
}

/** Returns why the entry is skipped when Pi would reject it or the adapter can't run it. */
export function translatePiMcpServer(name: string, value: unknown): { entry: ServerEntry; ignored: string[] } | string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return 'invalid server name (use letters, digits, "_" and "-")';
  if (!isRecord(value)) return "must be an object";
  const { type, command, args, env, cwd, url, headers, oauth, exposure, toolExposure, enabled, timeout, auth, description, ...unknown } = value;
  const isExposure = (candidate: unknown) => typeof candidate === "string" && PI_MCP_EXPOSURES.includes(candidate);
  if (exposure !== undefined && !isExposure(exposure)) return `exposure must be one of ${PI_MCP_EXPOSURES.join(", ")}`;
  if (toolExposure !== undefined && (!isRecord(toolExposure) || !Object.values(toolExposure).every(isExposure))) {
    return `toolExposure must map tool names to one of ${PI_MCP_EXPOSURES.join(", ")}`;
  }
  if (enabled !== undefined && typeof enabled !== "boolean") return "enabled must be a boolean";
  if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) return "timeout must be a positive number of seconds";
  if (description !== undefined && typeof description !== "string") return "description must be a string";
  if (type === "sse") return "legacy SSE transport is not supported; use the streamable HTTP URL";
  const ignored = Object.keys(unknown);

  let entry: ServerEntry;
  let otherTransportKeys: string[];
  if (typeof url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
    if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) return "url must be an http or https URL";
    if (headers !== undefined && !isStringRecord(headers)) return "headers must map names to strings";
    const translatedOAuth = oauth === undefined ? undefined : translatePiOAuth(oauth);
    if (typeof translatedOAuth === "string") return translatedOAuth;
    entry = { url, ...(headers !== undefined ? { headers } : {}), ...(translatedOAuth ? { oauth: translatedOAuth.oauth } : {}) };
    if (auth !== undefined) {
      if (!isRecord(auth) || typeof auth.provider !== "string" || !auth.provider) return "auth.provider must be a provider name";
      const urlError = providerAuthUrlError(url);
      if (urlError) return urlError;
      entry.auth = { provider: auth.provider };
    }
    ignored.push(...translatedOAuth?.ignored ?? []);
    otherTransportKeys = ["command", "args", "env", "cwd"];
  } else if (typeof command === "string" && (type === undefined || type === "stdio")) {
    if (args !== undefined && !(Array.isArray(args) && args.every((arg) => typeof arg === "string"))) return "args must be an array of strings";
    if (env !== undefined && !isStringRecord(env)) return "env must map names to strings";
    if (cwd !== undefined && typeof cwd !== "string") return "cwd must be a string";
    entry = {
      command,
      ...(args !== undefined ? { args: args as string[] } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    };
    otherTransportKeys = ["url", "headers", "oauth", "auth"];
  } else {
    return 'needs either "command" (stdio) or "url" (streamable HTTP)';
  }
  ignored.push(...otherTransportKeys.filter((key) => value[key] !== undefined));
  if (description !== undefined) entry.description = description;

  // `codemode-deferred` is an alias of `codemode` since Pi 0.99.2; both are proxy-only here.
  const serverExposure = exposure === undefined || exposure === "codemode-deferred" ? "codemode" : exposure;
  if (enabled === false || serverExposure === "hidden") entry.disabled = true;
  if (serverExposure === "direct") entry.directTools = true;
  if (serverExposure === "deferred") entry.directTools = "search";
  if (timeout !== undefined) entry.requestTimeoutMs = Math.round(timeout * 1000);

  // excludeTools matches a superset of Pi's hidden entries (prefixed names, aliases, `?` as a
  // wildcard), so it never exposes a tool Pi hides.
  const directTools: string[] = [];
  const excludeTools: string[] = [];
  for (const [tool, rawValue] of Object.entries(toolExposure ?? {})) {
    const toolValue = rawValue === "codemode-deferred" ? "codemode" : rawValue;
    if (toolValue === serverExposure) continue;
    if (toolValue === "hidden") excludeTools.push(tool);
    else if (toolValue === "direct" && !tool.includes("*") && serverExposure === "codemode") directTools.push(tool);
    else ignored.push(`toolExposure ${JSON.stringify(tool)}: ${toolValue}`);
  }
  if (directTools.length > 0) entry.directTools = directTools;
  if (excludeTools.length > 0) entry.excludeTools = excludeTools;
  return { entry, ignored };
}

function translatePiOAuth(oauth: unknown): { oauth: OAuthConfig; ignored: string[] } | string {
  if (!isRecord(oauth)) return "oauth must be an object";
  const { clientId, clientSecret, scope, clientName, callbackPort, callbackUrl, ...unknown } = oauth;
  const copied = { clientId, clientSecret, scope, clientName };
  for (const [key, field] of Object.entries(copied)) {
    if (field !== undefined && (typeof field !== "string" || (key === "clientName" && !field.trim()))) {
      return `oauth.${key} must be a ${key === "clientName" ? "non-empty " : ""}string`;
    }
  }
  if (callbackPort !== undefined && (typeof callbackPort !== "number" || !Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65535)) {
    return "oauth.callbackPort must be a port number";
  }
  const result = Object.fromEntries(Object.entries(copied).filter(([, field]) => field !== undefined)) as OAuthConfig;
  if (callbackUrl !== undefined) {
    const parsed = typeof callbackUrl === "string" && URL.canParse(callbackUrl) ? new URL(callbackUrl) : undefined;
    if (!parsed || parsed.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.search !== "" || parsed.hash !== "") {
      return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
    }
    if (parsed.port && callbackPort !== undefined && Number(parsed.port) !== callbackPort) {
      return "oauth.callbackUrl and oauth.callbackPort name different ports";
    }
    // Pi sends a URI with a port as written; without one it adds callbackPort or a free port.
    result.redirectUri = parsed.port ? callbackUrl as string : `http://${parsed.hostname}:${callbackPort ?? "{port}"}${parsed.pathname}`;
  } else if (callbackPort !== undefined) {
    result.redirectUri = `http://127.0.0.1:${callbackPort}/callback`;
  }
  return { oauth: result, ignored: Object.keys(unknown).map((key) => `oauth.${key}`) };
}

function validateConfig(raw: unknown): McpConfig {
  if (!isRecord(raw)) {
    return { mcpServers: {} };
  }

  return {
    mcpServers: toServerEntries(raw.mcpServers ?? raw["mcp-servers"]),
    ...(Array.isArray(raw.imports) ? { imports: raw.imports as ImportKind[] } : {}),
    ...(raw.settings !== undefined ? { settings: parseSettings(raw.settings) } : {}),
    ...(raw.claudePlugins !== undefined ? { claudePlugins: parseClaudePlugins(raw.claudePlugins) } : {}),
  };
}

function parseSettings(value: unknown): McpSettings {
  if (!isRecord(value)) throw new Error("settings must be an object");
  const settings = { ...value } as McpSettings;
  if (value.jev !== undefined) {
    validateJevSettings(value.jev);
    settings.jev = value.jev as NonNullable<McpSettings["jev"]>;
  }
  return settings;
}

function parseClaudePlugins(value: unknown): ClaudePluginConfig[] {
  if (!Array.isArray(value)) {
    console.warn("Invalid claudePlugins config: expected an array");
    return [];
  }

  const plugins: ClaudePluginConfig[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry) || typeof entry.path !== "string" || entry.path.trim().length === 0) {
      console.warn(`Invalid claudePlugins[${index}]: expected an object with a non-empty path`);
      continue;
    }
    if ((entry.mcp !== undefined && typeof entry.mcp !== "boolean") || (entry.skills !== undefined && typeof entry.skills !== "boolean")) {
      console.warn(`Invalid claudePlugins[${index}] for ${entry.path}: mcp and skills must be booleans`);
      continue;
    }
    if (entry.mcp !== true && entry.skills !== true) {
      console.warn(`Invalid claudePlugins[${index}] for ${entry.path}: enable mcp, skills, or both`);
      continue;
    }
    plugins.push({
      path: entry.path,
      ...(entry.mcp !== undefined ? { mcp: entry.mcp } : {}),
      ...(entry.skills !== undefined ? { skills: entry.skills } : {}),
    });
  }
  return plugins;
}

function toServerEntries(servers: unknown): Record<string, ServerEntry> {
  if (!isRecord(servers)) return {};
  const entries: Record<string, ServerEntry> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (!isServerEntry(entry)) continue;
    const auth: unknown = entry.auth;
    if (typeof auth === "object") {
      const provider = isRecord(auth) ? auth.provider : undefined;
      const error = typeof provider !== "string" || !provider ? "auth.provider must be a provider name"
        : typeof entry.url !== "string" ? "auth.provider requires a url"
        // A URL with env references is checked once resolved, when it connects.
        : getMissingEnvVars(entry.url, {}).length > 0 ? undefined
        : providerAuthUrlError(entry.url);
      if (error) {
        console.warn(`Ignoring MCP server "${name}": ${error}`);
        continue;
      }
    }
    if (entry.description !== undefined && typeof entry.description !== "string") {
      console.warn(`Ignoring invalid description for MCP server "${name}": expected a string`);
      const { description: _description, ...rest } = entry;
      entries[name] = rest;
      continue;
    }
    entries[name] = entry;
  }
  return entries;
}

function isServerEntry(value: unknown): value is ServerEntry {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function mergeOpenCodeConfigs(base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const baseMcp = base.mcp;
  const nextMcp = next.mcp;
  const mergedMcp: Record<string, unknown> = {
    ...(baseMcp && typeof baseMcp === "object" && !Array.isArray(baseMcp) ? baseMcp : {}),
  };

  if (nextMcp && typeof nextMcp === "object" && !Array.isArray(nextMcp)) {
    for (const [name, nextEntry] of Object.entries(nextMcp)) {
      const baseEntry = mergedMcp[name];
      if (
        baseEntry && typeof baseEntry === "object" && !Array.isArray(baseEntry)
        && nextEntry && typeof nextEntry === "object" && !Array.isArray(nextEntry)
      ) {
        const safeBase = { ...(baseEntry as Record<string, unknown>) };
        const override = nextEntry as Record<string, unknown>;
        if (typeof override.type === "string" && override.type !== safeBase.type) {
          for (const field of ["command", "environment", "cwd", "url", "headers", "oauth"]) delete safeBase[field];
        }
        if (typeof override.url === "string" && override.url !== safeBase.url) {
          delete safeBase.headers;
          delete safeBase.oauth;
        }
        if (Array.isArray(override.command)) {
          const baseCommand = safeBase.command;
          const commandChanged = !Array.isArray(baseCommand)
            || override.command.length !== baseCommand.length
            || override.command.some((value, index) => value !== baseCommand[index]);
          if (commandChanged) {
            delete safeBase.environment;
            delete safeBase.cwd;
          }
        }

        const mergedEntry = { ...safeBase, ...override };
        for (const field of ["environment", "headers", "oauth"]) {
          const baseField = safeBase[field];
          const nextField = override[field];
          if (
            baseField && typeof baseField === "object" && !Array.isArray(baseField)
            && nextField && typeof nextField === "object" && !Array.isArray(nextField)
          ) {
            mergedEntry[field] = { ...(baseField as Record<string, unknown>), ...(nextField as Record<string, unknown>) };
          }
        }
        mergedMcp[name] = mergedEntry;
      } else {
        mergedMcp[name] = nextEntry;
      }
    }
  }

  return { ...base, ...next, mcp: mergedMcp };
}

function extractServers(config: unknown, kind: ImportKind): Record<string, ServerEntry> {
  if (!config || typeof config !== "object") return {};

  const obj = config as Record<string, unknown>;

  let servers: unknown;
  switch (kind) {
    case "claude-desktop":
    case "claude-code":
      servers = obj.mcpServers;
      break;
    case "codex":
      servers = obj.mcp_servers ?? obj.mcpServers;
      break;
    case "agents":
    case "cursor":
    case "windsurf":
    case "vscode":
      servers = obj.mcpServers ?? obj["mcp-servers"];
      break;
    case "opencode":
      servers = obj.mcp;
      break;
    default:
      return {};
  }

  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return {};
  }

  const mappedServers: Record<string, ServerEntry> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (kind === "opencode") {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const raw = entry as Record<string, unknown>;
      if (raw.enabled === false || raw.disabled === true) continue;

      if (raw.type === "local" && Array.isArray(raw.command) && raw.command.length > 0 && raw.command.every((value): value is string => typeof value === "string")) {
        const env = toStringRecord(raw.environment);
        const command = raw.command[0];
        if (command === undefined) continue;
        const mapped: ServerEntry = {
          command,
          args: raw.command.slice(1),
          ...(env ? { env } : {}),
          ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
        };
        mappedServers[name] = mapped;
        continue;
      }

      if (raw.type === "remote" && typeof raw.url === "string") {
        const headers = toStringRecord(raw.headers);
        const mapped: ServerEntry = {
          url: raw.url,
          ...(headers ? { headers } : {}),
        };
        if (raw.oauth === false) {
          mapped.oauth = false;
        } else if (raw.oauth && typeof raw.oauth === "object" && !Array.isArray(raw.oauth)) {
          const oauth = raw.oauth as Record<string, unknown>;
          mapped.auth = "oauth";
          const clientId = oauth.clientId;
          const clientSecret = oauth.clientSecret;
          const authServerMetadataUrl = oauth.authServerMetadataUrl;
          mapped.oauth = {
            ...(typeof clientId === "string" ? { clientId } : {}),
            ...(typeof clientSecret === "string" ? { clientSecret } : {}),
            ...(typeof oauth.clientMetadataUrl === "string" ? { clientMetadataUrl: oauth.clientMetadataUrl } : {}),
            ...(typeof oauth.scope === "string" ? { scope: oauth.scope } : {}),
            ...(typeof authServerMetadataUrl === "string" ? { authServerMetadataUrl } : {}),
            ...(typeof oauth.skipIssuerMetadataValidation === "boolean"
              ? { skipIssuerMetadataValidation: oauth.skipIssuerMetadataValidation }
              : {}),
          };
        }
        mappedServers[name] = mapped;
      }
      continue;
    }

    if (!isRecord(entry)) continue;
    if (kind !== "codex") {
      mappedServers[name] = entry;
      continue;
    }

    const mapped = { ...entry };
    const bearerTokenEnv = mapped.bearer_token_env_var;
    const httpHeaders = mapped.http_headers;
    const envHttpHeaders = mapped.env_http_headers;

    if (typeof bearerTokenEnv === "string") {
      mapped.bearerTokenEnv = bearerTokenEnv;
      if (mapped.auth === undefined) mapped.auth = "bearer";
    }
    if (httpHeaders && typeof httpHeaders === "object" && !Array.isArray(httpHeaders)) {
      mapped.headers = { ...(mapped.headers as Record<string, string> | undefined), ...(httpHeaders as Record<string, string>) };
    }
    if (envHttpHeaders && typeof envHttpHeaders === "object" && !Array.isArray(envHttpHeaders)) {
      const headers = { ...(mapped.headers as Record<string, string> | undefined) };
      for (const [header, envVar] of Object.entries(envHttpHeaders)) {
        if (typeof envVar === "string" && headers[header] === undefined) headers[header] = `$env:${envVar}`;
      }
      mapped.headers = headers;
    }

    delete mapped.bearer_token_env_var;
    delete mapped.http_headers;
    delete mapped.env_http_headers;
    mappedServers[name] = mapped as ServerEntry;
  }

  return toServerEntries(mappedServers);
}

function serializeRawConfig(raw: Record<string, unknown>): string {
  return `${JSON.stringify(raw, null, 2)}\n`;
}

function buildUnifiedDiff(beforeText: string, afterText: string): string {
  if (beforeText === afterText) return "(no changes)";

  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  const rows = before.length;
  const cols = after.length;
  const lcs = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));

  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      const row = lcs[i];
      const nextRow = lcs[i + 1];
      if (!row || !nextRow) continue;
      row[j] = before[i] === after[j]
        ? (nextRow[j + 1] ?? 0) + 1
        : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const lines: string[] = ["--- before", "+++ after"];
  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    if (i < rows && j < cols && before[i] === after[j]) {
      lines.push(`  ${before[i]}`);
      i++;
      j++;
      continue;
    }
    if (j < cols && (i === rows || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      lines.push(`+ ${after[j]}`);
      j++;
      continue;
    }
    if (i < rows) {
      lines.push(`- ${before[i]}`);
      i++;
    }
  }

  return lines.join("\n");
}

function buildConfigWritePreview(filePath: string, nextRaw: Record<string, unknown>, beforePath = filePath): ConfigWritePreview {
  const existed = existsSync(filePath);
  const beforeExists = existsSync(beforePath);
  const beforeRaw = readRawConfigObject(beforePath);
  const beforeText = beforeExists ? serializeRawConfig(beforeRaw) : "";
  const afterText = serializeRawConfig(nextRaw);
  return {
    path: filePath,
    existed,
    changed: beforeText !== afterText,
    beforeText,
    afterText,
    diffText: buildUnifiedDiff(beforeText, afterText),
  };
}

function readRawConfigObject(filePath: string): Record<string, unknown> {
  if (!lstatSync(filePath, { throwIfNoEntry: false })) return {};

  try {
    const text = readFileSync(filePath, "utf-8");
    if (text.trim() === "") return {};
    const raw = parseJsonWithComments(text);
    if (!isRecord(raw)) throw new Error("top-level value must be an object");
    return raw;
  } catch (error) {
    throw new Error(`Failed to read MCP config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function writeConfigText(
  writePath: string,
  text: string,
  cwd = process.cwd(),
  intent: ConfigWriteIntent = "shared",
): void {
  // Resolve the final identity before writing. This preserves safe symlinks,
  // follows legitimate dangling adapter symlinks, and refuses aliases into
  // imported, shared, or native Pi inputs when the intent is adapter-owned.
  writePath = getConfigPathIdentity(resolveWritableConfigPath(writePath, cwd, intent));
  let mode: number | undefined;
  try {
    mode = statSync(writePath).mode & 0o777;
  } catch {}
  mkdirSync(dirname(writePath), { recursive: true });
  const tmpPath = `${writePath}.${process.pid}.tmp`;
  rmSync(tmpPath, { force: true });
  try {
    writeFileSync(tmpPath, text, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
    if (mode !== undefined) chmodSync(tmpPath, mode);
    renameSync(tmpPath, writePath);
  } catch (error) {
    try { rmSync(tmpPath, { force: true }); } catch {}
    throw error;
  }
}

function writeRawConfigObject(
  filePath: string,
  raw: Record<string, unknown>,
  cwd = process.cwd(),
  intent: ConfigWriteIntent = "shared",
): void {
  writeConfigText(filePath, `${JSON.stringify(raw, null, 2)}\n`, cwd, intent);
}

export function writeSharedConfigText(filePath: string, text: string, cwd = process.cwd()): void {
  if (!isRecord(parseJsonWithComments(text))) throw new Error("top-level value must be an object");
  writeConfigText(filePath, text, cwd, "shared");
}

/** Resolve Jev policy writes to the adapter-owned project layer by default. */
function getJevSettingsWritePath(overridePath: string | undefined, cwd: string): string {
  const projectPath = getProjectPiConfigPath(cwd);
  const globalPath = getPiGlobalConfigPath(undefined, cwd);
  const selectedPath = overridePath === undefined ? projectPath : getPiGlobalConfigPath(overridePath, cwd);
  const selectedIdentity = getConfigPathIdentity(selectedPath);
  const isAlias = (canonicalPath: string): boolean => (
    selectedIdentity === getConfigPathIdentity(canonicalPath)
    && (resolve(selectedPath) !== resolve(canonicalPath) || lstatSync(selectedPath, { throwIfNoEntry: false })?.isSymbolicLink() === true)
  );
  if (isAlias(projectPath) || isAlias(globalPath)) {
    throw new Error(`Refusing to write Jev settings through aliased MCP config at ${selectedPath}`);
  }
  if (overridePath === undefined) return projectPath;
  if (resolve(selectedPath) === resolve(projectPath)) return projectPath;
  if (resolve(selectedPath) === resolve(globalPath)) return globalPath;
  // Arbitrary explicit files remain read-only; use the existing guarded
  // adapter-owned global overlay rather than mutating or copying them.
  return getPiOwnedGlobalConfigPath(overridePath, cwd);
}

/**
 * Preview the adapter-owned Jev policy change without writing either the
 * selected read-only config or a shared/native MCP file.
 */
export function previewJevSemanticSearchConfig(
  overridePath: string | undefined,
  cwd: string,
  allowedServers: string[],
  effectiveJev?: unknown,
): ConfigWritePreview {
  const filePath = getJevSettingsWritePath(overridePath, cwd);
  const intent = getPiWriteIntent(filePath, cwd);
  const writablePath = resolveWritableConfigPath(filePath, cwd, intent);
  const rawPath = getConfigPathIdentity(writablePath);
  const raw = readRawConfigObject(rawPath);
  if (raw.settings !== undefined && !isRecord(raw.settings)) {
    throw new Error(`Failed to update Jev settings at ${rawPath}: settings must be an object`);
  }
  const settings = raw.settings as Record<string, unknown> | undefined;
  const currentJev = settings?.jev;
  if (currentJev !== undefined && currentJev !== false && !isRecord(currentJev)) {
    throw new Error(`Failed to update Jev settings at ${rawPath}: settings.jev must be an object or false`);
  }
  const jev = isRecord(effectiveJev) ? effectiveJev : isRecord(currentJev) ? currentJev : {};
  const nextServers = [...new Set(allowedServers)].sort((a, b) => a.localeCompare(b));
  const nextJev = { ...jev, semanticSearch: true, allowedServers: nextServers };
  validateJevSettings(nextJev);
  const nextRaw = { ...raw, settings: { ...settings, jev: nextJev } };
  return buildConfigWritePreview(writablePath, nextRaw, rawPath);
}

/** Persist Jev settings only in the Pi-owned adapter layer. */
export function writeJevSemanticSearchConfig(
  overridePath: string | undefined,
  cwd: string,
  allowedServers: string[],
  effectiveJev?: unknown,
): { path: string; changed: boolean } {
  const filePath = getJevSettingsWritePath(overridePath, cwd);
  const intent = getPiWriteIntent(filePath, cwd);
  const writablePath = resolveWritableConfigPath(filePath, cwd, intent);
  const rawPath = getConfigPathIdentity(writablePath);
  const preview = previewJevSemanticSearchConfig(overridePath, cwd, allowedServers, effectiveJev);
  if (!preview.changed) return { path: filePath, changed: false };
  const raw = readRawConfigObject(rawPath);
  const settings = raw.settings as Record<string, unknown> | undefined;
  const currentJev = settings?.jev;
  const jev = isRecord(effectiveJev) ? effectiveJev : isRecord(currentJev) ? currentJev : {};
  const nextJev = {
    ...jev,
    semanticSearch: true,
    allowedServers: [...new Set(allowedServers)].sort((a, b) => a.localeCompare(b)),
  };
  validateJevSettings(nextJev);
  writeRawConfigObject(writablePath, { ...raw, settings: { ...settings, jev: nextJev } }, cwd, intent);
  return { path: filePath, changed: true };
}

function getServersObject(raw: Record<string, unknown>, filePath: string): Record<string, ServerEntry> {
  for (const key of ["mcpServers", "mcp-servers"]) {
    if (Object.hasOwn(raw, key) && !isRecord(raw[key])) {
      throw new Error(`Failed to update MCP config at ${filePath}: ${key} must be an object`);
    }
  }
  return (raw.mcpServers ?? raw["mcp-servers"] ?? {}) as Record<string, ServerEntry>;
}

function getConfigImports(raw: Record<string, unknown>, filePath: string): ImportKind[] {
  if (raw.imports === undefined) return [];
  if (!Array.isArray(raw.imports) || raw.imports.some((value) => typeof value !== "string")) {
    throw new Error(`Failed to update MCP config at ${filePath}: imports must be an array of strings`);
  }
  return raw.imports as ImportKind[];
}

function setServersObject(raw: Record<string, unknown>, servers: Record<string, ServerEntry>): void {
  delete raw["mcp-servers"];
  raw.mcpServers = servers;
}

export interface ServerDisabledOverrideResult {
  path: string;
  changed: boolean;
}

/**
 * Persist only the disabled field in the project Pi layer. Enabling writes an
 * explicit false only when a lower-precedence source is itself disabled; this
 * writer never copies a server definition or its credentials into the file.
 */
export function writeProjectServerDisabledOverride(
  overridePath: string | undefined,
  cwd: string,
  serverName: string,
  disabled: boolean,
): ServerDisabledOverrideResult {
  const filePath = getProjectPiConfigPath(cwd);
  const raw = readRawConfigObject(filePath);

  const serverKey = raw.mcpServers !== undefined ? "mcpServers" : raw["mcp-servers"] !== undefined ? "mcp-servers" : "mcpServers";
  const rawServers = raw[serverKey];
  if (rawServers !== undefined && (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers))) {
    throw new Error(`Failed to update project MCP override at ${filePath}: ${serverKey} must be an object`);
  }
  const servers = (rawServers ?? {}) as Record<string, unknown>;
  const previous = servers[serverName];
  if (previous !== undefined && (!previous || typeof previous !== "object" || Array.isArray(previous))) {
    throw new Error(`Failed to update project MCP override at ${filePath}: server "${serverName}" must be an object`);
  }
  const existing = previous as Record<string, unknown> | undefined;

  let next: Record<string, unknown>;
  if (disabled) {
    next = { ...existing, disabled: true };
  } else {
    next = Object.fromEntries(Object.entries(existing ?? {}).filter(([key]) => key !== "disabled"));
    let lowerConfig: McpConfig = { mcpServers: {} };
    for (const source of getConfigSources(overridePath, cwd)) {
      if (sameConfigIdentity(source.readPath, filePath) || source.active === false) continue;
      const loaded = readSourceForUse(source, cwd, lowerConfig);
      if (loaded) lowerConfig = mergeConfigs(lowerConfig, expandImports(loaded, cwd).config);
    }
    if (raw.imports !== undefined) {
      if (!Array.isArray(raw.imports) || raw.imports.some((kind) => typeof kind !== "string" || !Object.hasOwn(IMPORT_PATHS, kind))) {
        throw new Error(`Failed to update project MCP override at ${filePath}: imports contains an unsupported config kind`);
      }
      lowerConfig = mergeConfigs(lowerConfig, expandImports({ mcpServers: {}, imports: raw.imports as ImportKind[] }, cwd).config);
    }
    if (isServerDisabled(lowerConfig.mcpServers[serverName])) next.disabled = false;
  }

  if ((!existing && Object.keys(next).length === 0) || JSON.stringify(existing) === JSON.stringify(next)) {
    return { path: filePath, changed: false };
  }
  if (Object.keys(next).length === 0) delete servers[serverName];
  else servers[serverName] = next;

  raw[serverKey] = servers;
  writeRawConfigObject(filePath, raw, cwd, "pi-project");
  return { path: filePath, changed: true };
}

function isRepoPromptServer(name: string, entry: ServerEntry): boolean {
  const normalizedName = name.toLowerCase();
  if (normalizedName.includes("repoprompt") || normalizedName === "rp") {
    return true;
  }

  const command = entry.command?.toLowerCase() ?? "";
  if (command.includes("repoprompt") || command.includes("rp-mcp") || command.endsWith("repoprompt_cli")) {
    return true;
  }

  return (entry.args ?? []).some((arg) => typeof arg === "string" && arg.toLowerCase().includes("repoprompt"));
}

function findProjectRoot(cwd = process.cwd()): string | null {
  let current = resolve(cwd);
  while (true) {
    if (
      existsSync(join(current, ".git"))
      || existsSync(join(current, "package.json"))
      || existsSync(join(current, PROJECT_CONFIG_NAME))
      || existsSync(join(current, ".pi"))
    ) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function buildRepoPromptEntry(executablePath: string): ServerEntry {
  return {
    command: executablePath,
    args: [],
    lifecycle: "lazy",
  };
}

function detectRepoPrompt(summary: Omit<McpDiscoverySummary, "fingerprint" | "repoPrompt" | "knownServerPresets">, cwd = process.cwd()): RepoPromptDiscovery {
  for (const source of summary.sources) {
    if (source.id === "agents-global" || source.id === "agents-nested-global" || source.kind !== "shared" || source.serverCount === 0) continue;
    const config = readSourceConfig(source.id, source.path);
    if (!config) continue;
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      if (isRepoPromptServer(name, entry)) {
        return { configured: true, configuredPath: source.path };
      }
    }
  }

  const executablePath = REPOPROMPT_BINARY_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!executablePath) {
    return { configured: false };
  }

  const projectRoot = findProjectRoot(cwd);
  const targetPath = projectRoot ? join(projectRoot, PROJECT_CONFIG_NAME) : GENERIC_GLOBAL_CONFIG_PATH;
  return {
    configured: false,
    executablePath,
    targetPath,
    serverName: "repoprompt",
    entry: buildRepoPromptEntry(executablePath),
  };
}

export function getPiOwnedGlobalConfigPath(overridePath?: string, cwd = process.cwd()): string {
  const canonicalGlobalPath = getPiGlobalConfigPath(undefined, cwd);
  if (overridePath === undefined) return canonicalGlobalPath;

  const targetPath = getPiGlobalConfigPath(overridePath, cwd);
  return classifyConfigPath(targetPath, cwd) === "pi-project"
    ? getProjectPiConfigPath(cwd)
    : canonicalGlobalPath;
}

function getPiWriteIntent(filePath: string, cwd: string): "pi-global" | "pi-project" {
  return classifyConfigPath(filePath, cwd) === "pi-project" ? "pi-project" : "pi-global";
}

export function previewCompatibilityImports(importKinds: ImportKind[], overridePath?: string, cwd = process.cwd()): ConfigWritePreview {
  const targetPath = getPiOwnedGlobalConfigPath(overridePath, cwd);
  const writablePath = resolveWritableConfigPath(targetPath, cwd, getPiWriteIntent(targetPath, cwd));
  const rawPath = getConfigPathIdentity(writablePath);
  const raw = readRawConfigObject(rawPath);
  const currentImports = getConfigImports(raw, rawPath);
  const merged = [...new Set([...currentImports, ...importKinds])];
  const nextRaw = { ...raw, imports: merged };
  setServersObject(nextRaw, getServersObject(nextRaw, rawPath));
  return buildConfigWritePreview(writablePath, nextRaw, rawPath);
}

export function ensureCompatibilityImports(importKinds: ImportKind[], overridePath?: string, cwd = process.cwd()): { path: string; added: ImportKind[] } {
  const targetPath = getPiOwnedGlobalConfigPath(overridePath, cwd);
  const writablePath = resolveWritableConfigPath(targetPath, cwd, getPiWriteIntent(targetPath, cwd));
  const rawPath = getConfigPathIdentity(writablePath);
  const raw = readRawConfigObject(rawPath);
  const currentImports = getConfigImports(raw, rawPath);
  const merged = [...new Set([...currentImports, ...importKinds])];
  const added = merged.filter((kind) => !currentImports.includes(kind));
  if (added.length === 0) {
    return { path: writablePath, added: [] };
  }

  raw.imports = merged;
  const servers = getServersObject(raw, rawPath);
  setServersObject(raw, servers);
  writeRawConfigObject(writablePath, raw, cwd, getPiWriteIntent(writablePath, cwd));
  return { path: writablePath, added };
}

export function buildStarterProjectConfig(): McpConfig {
  return {
    mcpServers: {},
  };
}

function assertScaffoldTargetAbsent(filePath: string): void {
  if (lstatSync(filePath, { throwIfNoEntry: false })) throw new Error(`Cannot scaffold MCP config at ${filePath}: file already exists`);
}

function getSharedWriteIntent(target: SharedConfigTarget): "shared-global" | "shared-project" {
  return target === "global" ? "shared-global" : "shared-project";
}

export function previewStarterSharedConfig(target: SharedConfigTarget, cwd = process.cwd()): ConfigWritePreview {
  const targetPath = getSharedConfigPath(target, cwd);
  resolveWritableConfigPath(targetPath, cwd, getSharedWriteIntent(target));
  assertScaffoldTargetAbsent(targetPath);
  const nextRaw = { mcpServers: buildStarterProjectConfig().mcpServers };
  return buildConfigWritePreview(targetPath, nextRaw);
}

export function writeStarterSharedConfig(target: SharedConfigTarget, cwd = process.cwd()): string {
  const targetPath = getSharedConfigPath(target, cwd);
  resolveWritableConfigPath(targetPath, cwd, getSharedWriteIntent(target));
  assertScaffoldTargetAbsent(targetPath);
  const raw = { mcpServers: buildStarterProjectConfig().mcpServers };
  writeRawConfigObject(targetPath, raw, cwd, getSharedWriteIntent(target));
  return targetPath;
}

export function previewStarterProjectConfig(cwd = process.cwd()): ConfigWritePreview {
  return previewStarterSharedConfig("project", cwd);
}

export function writeStarterProjectConfig(cwd = process.cwd()): string {
  return writeStarterSharedConfig("project", cwd);
}

/**
 * Fields in ServerEntry that belong in the Pi adapter config, not in shared MCP configs.
 * directTools is a TLH-specific field: it controls adapter behavior and is not part of
 * the standard MCP config spec, so it must not be written to shared ~/.config/mcp/mcp.json.
 */
export const ADAPTER_ONLY_SERVER_FIELDS: ReadonlyArray<keyof ServerEntry> = ["directTools"];

/**
 * Split a server entry into shared-config fields and adapter-only fields.
 * Returns [sharedEntry, adapterEntry | undefined].
 */
export function splitSharedAndAdapterEntry(entry: ServerEntry): [ServerEntry, Partial<ServerEntry> | undefined] {
  const shared: Record<string, unknown> = {};
  const adapter: Record<string, unknown> = {};
  const adapterKeys = new Set<string>(ADAPTER_ONLY_SERVER_FIELDS);
  for (const [key, value] of Object.entries(entry)) {
    if (adapterKeys.has(key as keyof ServerEntry)) {
      adapter[key] = value;
    } else {
      shared[key] = value;
    }
  }
  const adapterResult = Object.keys(adapter).length > 0 ? adapter as Partial<ServerEntry> : undefined;
  return [shared as ServerEntry, adapterResult];
}

export function previewSharedServerEntry(
  filePath: string,
  serverName: string,
  entry: ServerEntry,
  cwd = process.cwd(),
  target?: SharedConfigTarget,
): ConfigWritePreview {
  const intent = target === undefined ? "shared" : getSharedWriteIntent(target);
  const writablePath = resolveWritableConfigPath(filePath, cwd, intent);
  const rawPath = target === undefined ? writablePath : getConfigPathIdentity(writablePath);
  const [sharedEntry] = splitSharedAndAdapterEntry(entry);
  const raw = readRawConfigObject(rawPath);
  const nextRaw = { ...raw };
  const servers = getServersObject(nextRaw, rawPath);
  servers[serverName] = sharedEntry;
  setServersObject(nextRaw, servers);
  return buildConfigWritePreview(writablePath, nextRaw, rawPath);
}

export function previewPiAdapterServerEntry(
  filePath: string,
  serverName: string,
  adapterEntry: Partial<ServerEntry>,
  cwd = process.cwd(),
): ConfigWritePreview {
  const writablePath = resolveWritableConfigPath(filePath, cwd, getPiWriteIntent(filePath, cwd));
  const rawPath = getConfigPathIdentity(writablePath);
  const raw = readRawConfigObject(rawPath);
  const nextRaw = { ...raw };
  const servers = getServersObject(nextRaw, rawPath);
  servers[serverName] = projectAdapterServerEntry(adapterEntry as ServerEntry);
  setServersObject(nextRaw, servers);
  return buildConfigWritePreview(writablePath, nextRaw, rawPath);
}

export function writeSharedServerEntry(
  filePath: string,
  serverName: string,
  entry: ServerEntry,
  cwd = process.cwd(),
  target?: SharedConfigTarget,
): string {
  const intent = target === undefined ? "shared" : getSharedWriteIntent(target);
  const writablePath = resolveWritableConfigPath(filePath, cwd, intent);
  const rawPath = target === undefined ? writablePath : getConfigPathIdentity(writablePath);
  const [sharedEntry] = splitSharedAndAdapterEntry(entry);
  const raw = readRawConfigObject(rawPath);
  const servers = getServersObject(raw, rawPath);
  servers[serverName] = sharedEntry;
  setServersObject(raw, servers);
  writeRawConfigObject(writablePath, raw, cwd, intent);
  return filePath;
}

export function writePiAdapterServerEntry(
  filePath: string,
  serverName: string,
  adapterEntry: Partial<ServerEntry>,
  cwd = process.cwd(),
): void {
  const writablePath = resolveWritableConfigPath(filePath, cwd, getPiWriteIntent(filePath, cwd));
  const rawPath = getConfigPathIdentity(writablePath);
  const raw = readRawConfigObject(rawPath);
  const servers = getServersObject(raw, rawPath);
  servers[serverName] = {
    ...projectAdapterServerEntry(servers[serverName] ?? {}),
    ...projectAdapterServerEntry(adapterEntry as ServerEntry),
  };
  setServersObject(raw, servers);
  writeRawConfigObject(writablePath, raw, cwd, getPiWriteIntent(writablePath, cwd));
}

function getAdapterWritePath(source: ConfigSourceSpec, cwd: string): string {
  const ownership = classifyConfigPath(source.readPath, cwd);
  if (source.scope === "project" || source.id === "pi-project" || source.id === "pi-mcp-project" || ownership === "pi-native-project") {
    return getProjectPiConfigPath(cwd);
  }
  return getPiGlobalConfigPath(undefined, cwd);
}

export function getServerProvenance(overridePath?: string, cwd = process.cwd()): Map<string, ServerProvenance> {
  const provenance = new Map<string, ServerProvenance>();
  const globalAdapterPath = getPiGlobalConfigPath(undefined, cwd);
  const hostDiscoveryOn = !isExclusiveConfigMode() && getConfiguredHostConfigDiscovery(overridePath, cwd) === "on";

  if (hostDiscoveryOn) {
    for (const importKind of HOST_IMPORT_KINDS) {
      const imported = loadImportedConfig(importKind, cwd, `Failed to inspect imported MCP config from ${importKind}:`);
      if (!imported) continue;
      for (const name of Object.keys(extractServers(imported.value, importKind))) {
        // Keep writes inside adapter-owned storage even though the source is external.
        provenance.set(name, { path: globalAdapterPath, kind: "import", importKind });
      }
    }
  }

  let effectiveConfig: McpConfig = hostDiscoveryOn
    ? loadDiscoveredHostConfigs(cwd).config
    : { mcpServers: {} };
  for (const source of getConfigSources(overridePath, cwd)) {
    if (source.active === false) continue;
    const loaded = readSourceForUse(source, cwd, effectiveConfig);
    if (!loaded) continue;
    const adapterPath = getAdapterWritePath(source, cwd);
    if (loaded.imports?.length) {
      for (const importKind of loaded.imports) {
        const imported = loadImportedConfig(importKind, cwd, `Failed to inspect imported MCP config from ${importKind}:`);
        if (!imported) continue;

        const servers = extractServers(imported.value, importKind);
        for (const name of Object.keys(servers)) {
          if (!provenance.has(name)) {
            provenance.set(name, { path: adapterPath, kind: "import", importKind });
          }
        }
      }
    }

    for (const name of Object.keys(loaded.mcpServers)) {
      // Adapter writes always target adapter-owned files, even when the entry
      // originated in a shared/native/imported source.
      const ignoredSettings = loaded.ignoredSettings ? loaded.ignoredSettings.get(name) : provenance.get(name)?.ignoredSettings;
      provenance.set(name, {
        path: adapterPath,
        kind: source.kind,
        ...(source.importKind !== undefined ? { importKind: source.importKind } : {}),
        ...(ignoredSettings !== undefined ? { ignoredSettings } : {}),
      });
    }
    effectiveConfig = mergeConfigs(effectiveConfig, expandImports(loaded, cwd).config);
  }

  return provenance;
}

interface DirectToolsWriteEntry {
  name: string;
  value: true | string[] | false;
}

function getDirectToolsWriteTarget(provenance: ServerProvenance, cwd: string): string {
  const ownership = classifyConfigPath(provenance.path, cwd);
  if (ownership === "pi-project") return getProjectPiConfigPath(cwd);
  if (ownership === "pi-global") return getPiGlobalConfigPath(undefined, cwd);
  return provenance.kind === "project"
    ? getProjectPiConfigPath(cwd)
    : getPiGlobalConfigPath(undefined, cwd);
}

function getDirectToolsWriteEntries(
  changes: Map<string, true | string[] | false>,
  provenance: Map<string, ServerProvenance>,
  cwd: string,
): Map<string, DirectToolsWriteEntry[]> {
  const byPath = new Map<string, DirectToolsWriteEntry[]>();
  for (const [serverName, value] of changes) {
    const prov = provenance.get(serverName);
    if (!prov) continue;
    const targetPath = getConfigPathIdentity(getDirectToolsWriteTarget(prov, cwd));
    const entries = byPath.get(targetPath) ?? [];
    entries.push({ name: serverName, value });
    byPath.set(targetPath, entries);
  }
  return byPath;
}

function buildDirectToolsNextRaw(filePath: string, entries: DirectToolsWriteEntry[]): Record<string, unknown> {
  const raw = readRawConfigObject(filePath);
  const servers = getServersObject(raw, filePath);
  for (const { name, value } of entries) {
    // Adapter-only state must be a Pi-owned partial override. Keep shared and
    // imported definitions read-only, and do not copy credentials into the
    // override just to change direct-tool registration.
    const existing = servers[name] ? projectAdapterServerEntry(servers[name]) : {};
    servers[name] = { ...existing, directTools: value };
  }
  setServersObject(raw, servers);
  return raw;
}

export function previewDirectToolsConfig(
  changes: Map<string, true | string[] | false>,
  provenance: Map<string, ServerProvenance>,
  cwd = process.cwd(),
): ConfigWritePreview[] {
  return [...getDirectToolsWriteEntries(changes, provenance, cwd)].map(([filePath, entries]) => {
    const intent = getPiWriteIntent(filePath, cwd);
    const targetPath = resolveWritableConfigPath(filePath, cwd, intent);
    return buildConfigWritePreview(targetPath, buildDirectToolsNextRaw(targetPath, entries));
  });
}

export function writeDirectToolsConfig(
  changes: Map<string, true | string[] | false>,
  provenance: Map<string, ServerProvenance>,
  _fullConfig: McpConfig,
  onFileWrittenOrCwd?: (() => void) | string,
  cwd = process.cwd(),
): void {
  const onFileWritten = typeof onFileWrittenOrCwd === "function" ? onFileWrittenOrCwd : undefined;
  if (typeof onFileWrittenOrCwd === "string") cwd = onFileWrittenOrCwd;
  const byPath = getDirectToolsWriteEntries(changes, provenance, cwd);
  const targets = [...byPath.keys()].map((filePath) => ({ filePath, intent: getPiWriteIntent(filePath, cwd) }));

  // Validate every target before writing any, then re-read each one: two paths
  // can alias one adapter file without losing either change.
  for (const { filePath, intent } of targets) {
    const writablePath = resolveWritableConfigPath(filePath, cwd, intent);
    getServersObject(readRawConfigObject(writablePath), writablePath);
  }

  for (const { filePath, intent } of targets) {
    const writablePath = resolveWritableConfigPath(filePath, cwd, intent);
    writeRawConfigObject(writablePath, buildDirectToolsNextRaw(writablePath, byPath.get(filePath)!), cwd, intent);
    onFileWritten?.();
  }
}

export function resolveConfiguredOAuthDir(raw: unknown, cwd = process.cwd()): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error("settings.oauthDir must be a string");
  }

  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return resolve(cwd, trimmed);
}
