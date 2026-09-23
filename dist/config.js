// config.ts - Config loading with import support
import { chmodSync, existsSync, readFileSync, realpathSync, readlinkSync, rmSync, statSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import stripJsonComments from "strip-json-comments";
import { getAgentPath, getConfigDirName } from "./agent-dir.js";
import { getAgentPluginSummaries, loadAgentPluginConfigs } from "./agent-plugin-loader.js";
import { cloneBuiltInAgentPluginEntry, isBuiltInAgentPlugin, mergeBuiltInAgentPluginEntries } from "./agent-plugin-provenance.js";
import { loadClaudePluginBundles } from "./claude-plugin-loader.js";
import { loadPackageMcpConfigs } from "./package-mcp-loader.js";
import { formatServerNamespace, isServerDisabled } from "./types.js";
import { parseJsonWithComments, toStringRecord } from "./utils.js";
const GENERIC_GLOBAL_CONFIG_PATH = join(homedir(), ".config", "mcp", "mcp.json");
const AGENTS_GLOBAL_CONFIG_PATHS = [
    join(homedir(), ".agents", "mcp.json"),
    join(homedir(), ".agents", "mcp", "mcp.json"),
];
const PROJECT_CONFIG_NAME = ".mcp.json";
const PROJECT_PI_CONFIG_NAME = "mcp.json";
const REPOPROMPT_BINARY_CANDIDATES = [
    join(homedir(), "RepoPrompt", "repoprompt_cli"),
    "/Applications/Repo Prompt.app/Contents/MacOS/repoprompt-mcp",
];
export const KNOWN_SERVER_PRESETS = [
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
];
const HOST_IMPORT_KINDS = [
    "cursor",
    "claude-code",
    "claude-desktop",
    "codex",
    "opencode",
    "windsurf",
    "vscode",
];
const IMPORT_PATHS = {
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
export function getPiGlobalConfigPath(overridePath, cwd = process.cwd()) {
    return overridePath ? resolve(cwd, overridePath) : getAgentPath("mcp.json");
}
export function getGenericGlobalConfigPath() {
    return GENERIC_GLOBAL_CONFIG_PATH;
}
export function getProjectConfigPath(cwd = process.cwd()) {
    return resolve(cwd, PROJECT_CONFIG_NAME);
}
export function getProjectPiConfigPath(cwd = process.cwd()) {
    return resolve(cwd, getConfigDirName(), PROJECT_PI_CONFIG_NAME);
}
export function getSharedConfigPath(target, cwd = process.cwd()) {
    return target === "project" ? getProjectConfigPath(cwd) : getGenericGlobalConfigPath();
}
export function getConfigDiscoveryPaths(overridePath, cwd = process.cwd()) {
    return getConfigSources(overridePath, cwd).map((source) => ({
        label: source.label,
        path: source.readPath,
        exists: existsSync(source.readPath),
    }));
}
export function findAvailableImportConfigs(cwd = process.cwd()) {
    if (isExclusiveConfigMode())
        return [];
    const discovered = [];
    for (const importKind of Object.keys(IMPORT_PATHS)) {
        if (importKind === "agents") {
            for (const candidate of resolveImportCandidates(importKind, cwd)) {
                if (existsSync(candidate))
                    discovered.push({ kind: importKind, path: candidate });
            }
            continue;
        }
        const importPath = resolveImportPath(importKind, cwd);
        if (importPath) {
            discovered.push({ kind: importKind, path: importPath });
        }
    }
    return discovered;
}
function getConfigSourceSummaries(sourceSpecs, cwd = process.cwd()) {
    let effectiveConfig = { mcpServers: {} };
    return sourceSpecs.map((source) => {
        const rawLoaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
        const loaded = rawLoaded && source.projection === "adapter"
            ? projectAdapterOverlay(rawLoaded, effectiveConfig, cwd)
            : rawLoaded && isReadOnlyImportedPath(source.readPath, cwd) ? { mcpServers: rawLoaded.mcpServers } : rawLoaded;
        if (loaded && source.active !== false)
            effectiveConfig = mergeConfigs(effectiveConfig, expandImports(loaded, cwd));
        return {
            id: source.id,
            label: source.label,
            path: source.readPath,
            exists: existsSync(source.readPath),
            scope: source.scope,
            kind: source.id === "explicit-read-only" ? "explicit" : source.shared ? "shared" : "pi",
            serverCount: loaded ? Object.keys(loaded.mcpServers).length : 0,
            active: source.active !== false,
        };
    });
}
export function getMcpStandardConfigSummary(overridePath, cwd = process.cwd()) {
    const sources = getConfigSourceSummaries(getConfigSources(overridePath, cwd), cwd);
    return {
        sources,
        hasSharedServers: sources.some((source) => source.active && source.kind === "shared" && source.serverCount > 0),
        fingerprint: JSON.stringify({ sources: sources.map((source) => [source.id, source.exists, source.serverCount, source.active]) }),
    };
}
export function getMcpDiscoverySummary(overridePath, cwd = process.cwd(), options = {}) {
    const sourceSpecs = getConfigSources(overridePath, cwd);
    const sources = getConfigSourceSummaries(sourceSpecs, cwd);
    const includeHostConfigs = options.includeHostConfigs !== false;
    const importKinds = isExclusiveConfigMode()
        ? getConfiguredImportKinds(sourceSpecs, cwd)
        : includeHostConfigs
            ? [...HOST_IMPORT_KINDS, "agents"]
            : ["agents"];
    const imports = importKinds
        .map((kind) => {
        const imported = loadImportedConfig(kind, cwd, `Failed to inspect imported MCP config from ${kind}:`);
        if (!imported)
            return null;
        return {
            kind,
            path: imported.path,
            serverCount: Object.keys(extractServers(imported.value, kind)).length,
        };
    })
        .filter((value) => value !== null);
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
    const activeSources = sources.filter((source) => source.active);
    const activeAgentsImport = isAgentsImportActive(sourceSpecs, cwd);
    const activeAgentsServerCount = activeAgentsImport
        ? imports.find((entry) => entry.kind === "agents")?.serverCount ?? 0
        : 0;
    const totalServerCount = activeSources.reduce((sum, source) => sum + source.serverCount, 0)
        + activeAgentsServerCount
        + agentPlugins.reduce((sum, plugin) => sum + plugin.serverCount, 0);
    const hasSharedServers = activeSources.some((source) => source.kind === "shared" && source.serverCount > 0)
        || agentPlugins.some(plugin => plugin.serverCount > 0);
    const hasPiOwnedServers = activeSources.some((source) => source.kind === "pi" && source.serverCount > 0);
    const hasAnyDetectedPaths = sources.some((source) => source.exists) || imports.length > 0 || agentPlugins.length > 0;
    const hasAnyConfig = totalServerCount > 0 || imports.some((entry) => entry.serverCount > 0) || hasAnyDetectedPaths;
    const summaryWithoutRepoPrompt = {
        sources,
        imports,
        hostConfigs,
        hostConfigDiscovery,
        agentPlugins,
        conflicts: getConfigConflicts(sourceSpecs, imports, cwd),
        hasAnyConfig,
        hasAnyDetectedPaths,
        hasSharedServers,
        hasPiOwnedServers,
        totalServerCount,
    };
    const fingerprint = JSON.stringify({
        sources: sources.map((source) => [source.id, source.exists, source.serverCount, source.active]),
        imports: imports.map((entry) => [entry.kind, entry.path, entry.serverCount]),
        agentPlugins: agentPlugins.map((entry) => [entry.path, entry.name, entry.serverCount]),
        hostConfigDiscovery,
        conflicts: summaryWithoutRepoPrompt.conflicts,
    });
    return {
        ...summaryWithoutRepoPrompt,
        fingerprint,
        repoPrompt: detectRepoPrompt(summaryWithoutRepoPrompt, cwd),
    };
}
export function cloneMcpConfig(config) {
    const cloned = structuredClone(config);
    for (const [name, source] of Object.entries(config.mcpServers)) {
        const builtInClone = cloneBuiltInAgentPluginEntry(source);
        if (builtInClone)
            cloned.mcpServers[name] = builtInClone;
    }
    return cloned;
}
export function loadMcpConfig(overridePath, cwd = process.cwd()) {
    const sourceSpecs = getConfigSources(overridePath, cwd);
    const hostConfigDiscovery = getConfiguredHostConfigDiscovery(overridePath, cwd);
    // Host files are a lower-precedence fallback. This ordering means an opt-in
    // discovery cannot override a shared or Pi-owned definition, and all normal
    // URL-bound credential stripping remains in mergeServerMaps.
    let config = !isExclusiveConfigMode() && hostConfigDiscovery === "on"
        ? loadDiscoveredHostConfigs(cwd)
        : { mcpServers: {} };
    for (const source of sourceSpecs) {
        if (source.active === false)
            continue;
        const rawLoaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
        if (!rawLoaded)
            continue;
        const loaded = source.projection === "adapter"
            ? projectAdapterOverlay(rawLoaded, config, cwd)
            : isReadOnlyImportedPath(source.readPath, cwd) ? { mcpServers: rawLoaded.mcpServers } : rawLoaded;
        config = mergeConfigs(config, expandImports(loaded, cwd));
    }
    if (isExclusiveConfigMode())
        return resolveConfiguredClaudePluginMcp(config, cwd);
    const packageConfig = loadPackageMcpConfigs(cwd);
    const pluginConfig = loadAgentPluginConfigs(config.settings?.agentPluginPaths, cwd);
    const packageServers = Object.fromEntries(Object.entries(packageConfig.mcpServers).filter(([name]) => !Object.hasOwn(pluginConfig.mcpServers, name)));
    const higherPrecedenceConfig = mergeConfigs({ mcpServers: packageServers }, mergeConfigs(pluginConfig, config));
    return mergeClaudePluginMcpDefaults(config.claudePlugins, higherPrecedenceConfig, cwd);
}
export function resolveConfiguredClaudePluginMcp(config, cwd = process.cwd()) {
    return mergeClaudePluginMcpDefaults(config.claudePlugins, config, cwd);
}
export function discoverConfiguredClaudePluginSkills(config, cwd = process.cwd()) {
    return loadClaudePluginBundles(config.claudePlugins, cwd, validateConfig, { mcp: false, skills: true }).skillPaths;
}
function mergeClaudePluginMcpDefaults(plugins, higherPrecedenceConfig, cwd) {
    const pluginServers = loadClaudePluginBundles(plugins, cwd, validateConfig, { mcp: true, skills: false }).mcpServers;
    const higherNamesByNamespace = new Map(Object.keys(higherPrecedenceConfig.mcpServers).map(name => [formatServerNamespace(name), name]));
    const defaults = Object.fromEntries(Object.entries(pluginServers).filter(([name]) => {
        const higherName = higherNamesByNamespace.get(formatServerNamespace(name));
        if (!higherName || higherName === name)
            return true;
        console.warn(`Claude plugin MCP server "${name}" is shadowed by higher-precedence server "${higherName}" because both normalize to the same namespace`);
        return false;
    }));
    return mergeConfigs({ mcpServers: defaults }, higherPrecedenceConfig);
}
function getMergedSettings(overridePath, cwd = process.cwd()) {
    let settings;
    for (const source of getConfigSources(overridePath, cwd)) {
        if (source.active === false || isReadOnlyImportedPath(source.readPath, cwd))
            continue;
        const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
        if (loaded?.settings)
            settings = { ...settings, ...loaded.settings };
    }
    return settings;
}
function getConfiguredHostConfigDiscovery(overridePath, cwd = process.cwd()) {
    let configured = "off";
    const settings = getMergedSettings(overridePath, cwd);
    const value = settings?.hostConfigDiscovery;
    if (value === "off" || value === "prompt" || value === "on")
        configured = value;
    return configured;
}
function getConfiguredImportKinds(sourceSpecs, cwd) {
    const importKinds = [];
    for (const source of sourceSpecs) {
        if (source.active === false || isReadOnlyImportedPath(source.readPath, cwd))
            continue;
        const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
        for (const importKind of loaded?.imports ?? []) {
            if (!importKinds.includes(importKind))
                importKinds.push(importKind);
        }
    }
    return importKinds;
}
function isAgentsImportActive(sourceSpecs, cwd) {
    return getConfiguredImportKinds(sourceSpecs, cwd).includes("agents");
}
function loadDiscoveredHostConfigs(cwd) {
    let config = { mcpServers: {} };
    for (const importKind of HOST_IMPORT_KINDS) {
        const imported = loadImportedConfig(importKind, cwd, `Failed to discover imported MCP config from ${importKind}:`);
        if (!imported)
            continue;
        config = mergeConfigs(config, {
            mcpServers: extractServers(imported.value, importKind),
        });
    }
    return config;
}
function getConfigConflicts(sourceSpecs, imports, cwd) {
    const seen = new Map();
    const record = (name, source) => {
        const entries = seen.get(name) ?? [];
        if (!entries.some((entry) => entry.kind === source.kind && entry.path === source.path))
            entries.push(source);
        seen.set(name, entries);
    };
    // Host candidates are listed first because, when enabled, they are the
    // lowest-precedence fallback. The fixed IMPORT_PATHS order is deterministic.
    const agentsImportActive = isAgentsImportActive(sourceSpecs, cwd);
    for (const entry of imports) {
        if (entry.kind === "agents" && !agentsImportActive)
            continue;
        const imported = loadImportedConfig(entry.kind, cwd, `Failed to inspect imported MCP config from ${entry.kind}:`);
        if (!imported)
            continue;
        for (const name of Object.keys(extractServers(imported.value, entry.kind))) {
            record(name, { kind: "host", path: imported.path });
        }
    }
    let effectiveConfig = { mcpServers: {} };
    for (const source of sourceSpecs) {
        if (source.active === false)
            continue;
        const rawLoaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
        if (!rawLoaded)
            continue;
        const loaded = source.projection === "adapter"
            ? projectAdapterOverlay(rawLoaded, effectiveConfig, cwd)
            : isReadOnlyImportedPath(source.readPath, cwd) ? { mcpServers: rawLoaded.mcpServers } : rawLoaded;
        if (loaded.imports?.length) {
            for (const importKind of loaded.imports) {
                const imported = loadImportedConfig(importKind, cwd, `Failed to inspect imported MCP config from ${importKind}:`);
                if (!imported)
                    continue;
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
        effectiveConfig = mergeConfigs(effectiveConfig, expandImports(loaded, cwd));
    }
    return [...seen.entries()]
        .filter(([, sources]) => sources.length > 1)
        .map(([serverName, sources]) => ({ serverName, sources, winner: sources[sources.length - 1] }))
        .sort((left, right) => left.serverName.localeCompare(right.serverName));
}
function getConfigSources(overridePath, cwd = process.cwd()) {
    const canonicalPiGlobalPath = getPiGlobalConfigPath(undefined, cwd);
    const userPath = getPiGlobalConfigPath(overridePath, cwd);
    const projectPath = getProjectConfigPath(cwd);
    const projectPiPath = getProjectPiConfigPath(cwd);
    const explicitOwnership = overridePath === undefined ? undefined : classifyConfigPath(userPath, cwd);
    const userPathOwnership = classifyConfigPath(userPath, cwd);
    const explicitGlobalSourceNeeded = explicitOwnership !== undefined
        && explicitOwnership !== "pi-global"
        && explicitOwnership !== "pi-project";
    const sources = [];
    const explicitSource = () => ({
        id: "explicit-read-only",
        label: "Explicit read-only MCP config",
        readPath: userPath,
        writePath: userPath,
        kind: "user",
        shared: false,
        scope: "global",
    });
    const canonicalPiSource = (id) => ({
        id,
        label: "Pi global override",
        readPath: canonicalPiGlobalPath,
        writePath: canonicalPiGlobalPath,
        kind: "user",
        shared: false,
        scope: "global",
        ...inactiveForPiAlias(canonicalPiGlobalPath, cwd),
    });
    const canonicalProjectPiSource = () => ({
        id: "pi-project",
        label: "project Pi override",
        readPath: projectPiPath,
        writePath: projectPiPath,
        kind: "project",
        shared: false,
        scope: "project",
        ...inactiveForPiAlias(projectPiPath, cwd),
    });
    const adapterOverlaySource = () => ({
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
    if (isExclusiveConfigMode()) {
        if (overridePath !== undefined) {
            if (explicitOwnership === "pi-global")
                return [canonicalPiSource("pi-global")];
            if (explicitOwnership === "pi-project")
                return [canonicalProjectPiSource()];
            return [explicitSource(), adapterOverlaySource()];
        }
        return [canonicalPiSource("pi-global")];
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
        if (sameConfigIdentity(agentsPath, userPath) || sameConfigIdentity(agentsPath, GENERIC_GLOBAL_CONFIG_PATH))
            continue;
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
    if (explicitGlobalSourceNeeded) {
        sources.push(explicitSource());
        sources.push(canonicalPiSource("pi-global-canonical"));
    }
    else {
        sources.push(canonicalPiSource("pi-global"));
    }
    // Compare file identities so symlink aliases cannot reload a global source
    // at ancestor precedence. Keep original paths for display and writes.
    const reservedPaths = new Set([
        ...sources.map((source) => getConfigPathIdentity(source.readPath)),
        getConfigPathIdentity(projectPath),
        getConfigPathIdentity(projectPiPath),
    ]);
    // Only user-global files (including an explicit override) may opt in to
    // ancestor discovery. Project files cannot extend this trust boundary.
    const ancestorSources = new Map();
    const descriptors = [
        { id: "shared-project-ancestor", label: "ancestor standard MCP", path: getProjectConfigPath, shared: true },
        { id: "pi-project-ancestor", label: "ancestor Pi override", path: getProjectPiConfigPath, shared: false },
    ];
    const ancestorRoot = getConfiguredAncestorRoot(sources, cwd);
    if (ancestorRoot) {
        for (const dir of getAncestorProjectDirs(cwd, ancestorRoot)) {
            for (const descriptor of descriptors) {
                const path = descriptor.path(dir);
                const identity = getConfigPathIdentity(path);
                if (reservedPaths.has(identity) || !existsSync(path))
                    continue;
                // Reinsert aliases at their nearest precedence position.
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
    if (explicitOwnership === "pi-project") {
        sources.push(canonicalProjectPiSource());
    }
    else if (!sameConfigIdentity(projectPiPath, userPath) && !sameConfigIdentity(projectPiPath, projectPath)) {
        sources.push(canonicalProjectPiSource());
    }
    return sources;
}
function getConfigPathIdentity(path, seen = new Set()) {
    const absolute = resolve(path);
    if (seen.has(absolute))
        return absolute;
    const nextSeen = new Set(seen).add(absolute);
    try {
        return realpathSync(absolute);
    }
    catch {
        // Resolve symlink targets even when the target config has not been created
        // yet, then resolve existing parent symlinks for ordinary missing paths.
        try {
            const linkTarget = readlinkSync(absolute);
            return getConfigPathIdentity(isAbsolute(linkTarget) ? linkTarget : resolve(dirname(absolute), linkTarget), nextSeen);
        }
        catch {
            const parent = dirname(absolute);
            if (parent === absolute)
                return absolute;
            return join(getConfigPathIdentity(parent, nextSeen), relative(parent, absolute));
        }
    }
}
function sameConfigIdentity(left, right) {
    return getConfigPathIdentity(left) === getConfigPathIdentity(right);
}
function classifyConfigPath(filePath, cwd) {
    const identity = getConfigPathIdentity(filePath);
    const matches = (candidate) => identity === getConfigPathIdentity(candidate);
    // External/shared identities must win over a Pi path that happens to be a
    // symlink into one of them; otherwise an alias could bypass read-only rules.
    if (AGENTS_GLOBAL_CONFIG_PATHS.some(matches))
        return "agents";
    if (HOST_IMPORT_KINDS.some((kind) => resolveImportCandidates(kind, cwd).some(matches)))
        return "host";
    if (matches(GENERIC_GLOBAL_CONFIG_PATH))
        return "shared-global";
    if (matches(getProjectConfigPath(cwd)))
        return "shared-project";
    if (matches(getPiGlobalConfigPath(undefined, cwd)))
        return "pi-global";
    if (matches(getProjectPiConfigPath(cwd)))
        return "pi-project";
    return "other";
}
function resolveWritableConfigPath(filePath, cwd, intent) {
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
        if (ownership === "agents" || ownership === "host") {
            throw new Error(`Refusing to write read-only imported MCP config at ${filePath}`);
        }
        throw new Error(`Refusing to write MCP config at ${filePath}: destination is not ${intent}-owned`);
    }
    return resolve(cwd, filePath);
}
function isReadOnlyImportedPath(filePath, cwd) {
    const ownership = classifyConfigPath(filePath, cwd);
    return ownership === "agents" || ownership === "host";
}
function inactiveForExternalAlias(filePath, cwd) {
    return isReadOnlyImportedPath(filePath, cwd) ? { active: false } : {};
}
function inactiveForPiAlias(filePath, cwd) {
    const ownership = classifyConfigPath(filePath, cwd);
    return ownership === "agents" || ownership === "host" || ownership === "shared-global" || ownership === "shared-project"
        ? { active: false }
        : {};
}
function isWithin(base, target) {
    const path = relative(base, target);
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function getConfiguredAncestorRoot(globalSources, cwd) {
    let configured;
    for (const source of globalSources) {
        if (source.active === false || isReadOnlyImportedPath(source.readPath, cwd))
            continue;
        const roots = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`)?.settings?.ancestorConfigRoots;
        if (roots !== undefined)
            configured = roots;
    }
    if (configured === undefined || (Array.isArray(configured) && configured.length === 0))
        return undefined;
    if (!Array.isArray(configured)) {
        console.warn("Invalid settings.ancestorConfigRoots: expected an array of paths");
        return undefined;
    }
    const home = getConfigPathIdentity(resolve(homedir()));
    const canonicalCwd = getConfigPathIdentity(resolve(cwd));
    const valid = [];
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
            if (!statSync(root).isDirectory() || !isWithin(home, root) || !isWithin(root, canonicalCwd))
                throw new Error();
            valid.push(root);
        }
        catch {
            console.warn(`Invalid settings.ancestorConfigRoots entry ${JSON.stringify(entry)}: expected an existing directory under HOME containing cwd`);
        }
    }
    return valid.sort((left, right) => right.length - left.length)[0];
}
function getAncestorProjectDirs(cwd, root) {
    const start = getConfigPathIdentity(resolve(cwd));
    const dirs = [];
    let current = dirname(start);
    while (isWithin(root, current)) {
        dirs.unshift(current);
        if (current === root)
            break;
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return dirs;
}
function isExclusiveConfigMode() {
    return process.env.PI_MCP_CONFIG_MODE?.trim().toLowerCase() === "exclusive";
}
function mergeConfigs(base, next) {
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
const URL_BOUND_AUTH_FIELDS = ["headers", "bearerToken", "bearerTokenEnv", "bearerTokenStore", "requestHeadersCommand", "caFile"];
function mergeServerMaps(base, next) {
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
        let baseEntry = existing ?? {};
        if (existing && typeof definition.command === "string") {
            baseEntry = { ...existing };
            for (const field of [
                "url", "headers", "requestHeadersCommand", "caFile", "auth", "bearerToken",
                "bearerTokenEnv", "bearerTokenStore", "oauth", "httpTransport", "socket",
            ]) {
                delete baseEntry[field];
            }
        }
        else if (existing && typeof definition.url === "string") {
            baseEntry = { ...existing };
            for (const field of [
                "command", "args", "env", "cwd", "pluginDataDir", "literalEnv", "inheritEnv", "socket",
            ]) {
                delete baseEntry[field];
            }
        }
        else if (existing && typeof definition.socket === "string") {
            baseEntry = { ...existing };
            for (const field of [
                "command", "args", "env", "cwd", "pluginDataDir", "literalEnv", "inheritEnv", "url",
                "headers", "requestHeadersCommand", "caFile", "auth", "bearerToken", "bearerTokenEnv",
                "bearerTokenStore", "oauth", "httpTransport",
            ]) {
                delete baseEntry[field];
            }
        }
        if (existing && typeof definition.url === "string" && definition.url !== existing.url) {
            if (baseEntry === existing)
                baseEntry = { ...existing };
            for (const field of URL_BOUND_AUTH_FIELDS) {
                delete baseEntry[field];
            }
            if (baseEntry.oauth !== false) {
                delete baseEntry.oauth;
            }
        }
        if (existing && Object.hasOwn(definition, "env") && isBuiltInAgentPlugin(existing, "env") && !Object.hasOwn(definition, "literalEnv")) {
            if (baseEntry === existing)
                baseEntry = { ...existing };
            delete baseEntry.literalEnv;
        }
        merged[name] = mergeBuiltInAgentPluginEntries(baseEntry, definition);
    }
    return merged;
}
function mergeImports(left, right) {
    const merged = [...(left ?? []), ...(right ?? [])];
    if (merged.length === 0)
        return undefined;
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
];
function projectAdapterServerEntry(entry) {
    const projected = {};
    for (const field of ADAPTER_SERVER_FIELDS) {
        if (Object.hasOwn(entry, field))
            projected[field] = entry[field];
    }
    return projected;
}
function projectAdapterOverlay(raw, base, cwd) {
    const imported = raw.imports?.length
        ? expandImports({ imports: raw.imports, mcpServers: {} }, cwd)
        : { mcpServers: {} };
    const allowedServers = new Set([...Object.keys(base.mcpServers), ...Object.keys(imported.mcpServers)]);
    const mcpServers = {};
    for (const [name, entry] of Object.entries(raw.mcpServers)) {
        if (!allowedServers.has(name))
            continue;
        const projected = projectAdapterServerEntry(entry);
        if (Object.keys(projected).length > 0)
            mcpServers[name] = projected;
    }
    return {
        mcpServers,
        ...(raw.imports !== undefined ? { imports: raw.imports } : {}),
        ...(raw.settings !== undefined ? { settings: raw.settings } : {}),
    };
}
function expandImports(config, cwd = process.cwd()) {
    if (!config.imports?.length)
        return config;
    const importedServers = {};
    for (const importKind of config.imports) {
        const imported = loadImportedConfig(importKind, cwd, `Failed to import MCP config from ${importKind}:`);
        if (!imported)
            continue;
        const servers = extractServers(imported.value, importKind);
        for (const [name, definition] of Object.entries(servers)) {
            if (!importedServers[name]) {
                importedServers[name] = definition;
            }
        }
    }
    return {
        imports: config.imports,
        ...(config.settings !== undefined ? { settings: config.settings } : {}),
        ...(config.claudePlugins !== undefined ? { claudePlugins: config.claudePlugins } : {}),
        mcpServers: mergeServerMaps(importedServers, config.mcpServers),
    };
}
function resolveImportCandidates(importKind, cwd) {
    return (IMPORT_PATHS[importKind] ?? []).map((candidate) => {
        if (importKind === "opencode" && candidate === "./opencode.json") {
            const start = resolve(cwd);
            let gitRoot;
            let current = start;
            while (true) {
                if (existsSync(join(current, ".git"))) {
                    gitRoot = current;
                    break;
                }
                const parent = dirname(current);
                if (parent === current)
                    break;
                current = parent;
            }
            if (!gitRoot)
                return join(start, "opencode.json");
            current = start;
            while (true) {
                const projectConfig = join(current, "opencode.json");
                if (existsSync(projectConfig) || current === gitRoot)
                    return projectConfig;
                current = dirname(current);
            }
        }
        return candidate.startsWith(".") ? resolve(cwd, candidate) : candidate;
    });
}
function readImportedConfig(path) {
    const raw = readFileSync(path, "utf-8");
    return path.endsWith(".toml") ? parseToml(raw) : parseJsonWithComments(raw);
}
function loadImportedConfig(importKind, cwd, warningPrefix) {
    if (importKind === "agents") {
        // Keep both .agents files read-only while applying the same server merge
        // semantics as ordinary config layers; the nested path is visited second.
        let mergedServers = {};
        let highestPrecedencePath;
        for (const path of resolveImportCandidates(importKind, cwd)) {
            if (!existsSync(path))
                continue;
            try {
                const value = readImportedConfig(path);
                const servers = extractServers(value, importKind);
                mergedServers = mergeServerMaps(mergedServers, servers);
                highestPrecedencePath = path;
            }
            catch (error) {
                console.warn(warningPrefix, error);
            }
        }
        return highestPrecedencePath
            ? { path: highestPrecedencePath, value: { mcpServers: mergedServers } }
            : null;
    }
    if (importKind === "opencode") {
        let merged = {};
        let highestPrecedencePath;
        for (const path of resolveImportCandidates(importKind, cwd)) {
            if (!existsSync(path))
                continue;
            try {
                const value = readImportedConfig(path);
                if (value && typeof value === "object" && !Array.isArray(value)) {
                    merged = mergeOpenCodeConfigs(merged, value);
                    highestPrecedencePath = path;
                }
            }
            catch (error) {
                console.warn(warningPrefix, error);
            }
        }
        return highestPrecedencePath ? { path: highestPrecedencePath, value: merged } : null;
    }
    for (const path of resolveImportCandidates(importKind, cwd)) {
        if (!existsSync(path))
            continue;
        try {
            return { path, value: readImportedConfig(path) };
        }
        catch (error) {
            console.warn(warningPrefix, error);
        }
    }
    return null;
}
function resolveImportPath(importKind, cwd = process.cwd()) {
    return loadImportedConfig(importKind, cwd, `Failed to discover imported MCP config from ${importKind}:`)?.path ?? null;
}
function readValidatedConfig(path, label) {
    if (!existsSync(path))
        return null;
    try {
        const text = readFileSync(path, "utf-8");
        if (stripJsonComments(text, { trailingCommas: true }).trim() === "")
            return null;
        return validateConfig(parseJsonWithComments(text));
    }
    catch (error) {
        console.warn(`Failed to load ${label}:`, error);
        return null;
    }
}
function validateConfig(raw) {
    if (!isRecord(raw)) {
        return { mcpServers: {} };
    }
    return {
        mcpServers: toServerEntries(raw.mcpServers ?? raw["mcp-servers"]),
        ...(Array.isArray(raw.imports) ? { imports: raw.imports } : {}),
        ...(raw.settings !== undefined ? { settings: parseSettings(raw.settings) } : {}),
        ...(raw.claudePlugins !== undefined ? { claudePlugins: parseClaudePlugins(raw.claudePlugins) } : {}),
    };
}
function parseSettings(value) {
    if (!isRecord(value))
        throw new Error("settings must be an object");
    return { ...value };
}
function parseClaudePlugins(value) {
    if (!Array.isArray(value)) {
        console.warn("Invalid claudePlugins config: expected an array");
        return [];
    }
    const plugins = [];
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
function toServerEntries(servers) {
    if (!isRecord(servers))
        return {};
    const entries = {};
    for (const [name, entry] of Object.entries(servers)) {
        if (isServerEntry(entry))
            entries[name] = entry;
    }
    return entries;
}
function isServerEntry(value) {
    return isRecord(value);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function mergeOpenCodeConfigs(base, next) {
    const baseMcp = base.mcp;
    const nextMcp = next.mcp;
    const mergedMcp = {
        ...(baseMcp && typeof baseMcp === "object" && !Array.isArray(baseMcp) ? baseMcp : {}),
    };
    if (nextMcp && typeof nextMcp === "object" && !Array.isArray(nextMcp)) {
        for (const [name, nextEntry] of Object.entries(nextMcp)) {
            const baseEntry = mergedMcp[name];
            if (baseEntry && typeof baseEntry === "object" && !Array.isArray(baseEntry)
                && nextEntry && typeof nextEntry === "object" && !Array.isArray(nextEntry)) {
                const safeBase = { ...baseEntry };
                const override = nextEntry;
                if (typeof override.type === "string" && override.type !== safeBase.type) {
                    for (const field of ["command", "environment", "cwd", "url", "headers", "oauth"])
                        delete safeBase[field];
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
                    if (baseField && typeof baseField === "object" && !Array.isArray(baseField)
                        && nextField && typeof nextField === "object" && !Array.isArray(nextField)) {
                        mergedEntry[field] = { ...baseField, ...nextField };
                    }
                }
                mergedMcp[name] = mergedEntry;
            }
            else {
                mergedMcp[name] = nextEntry;
            }
        }
    }
    return { ...base, ...next, mcp: mergedMcp };
}
function extractServers(config, kind) {
    if (!config || typeof config !== "object")
        return {};
    const obj = config;
    let servers;
    switch (kind) {
        case "agents":
            servers = obj.mcpServers ?? obj["mcp-servers"];
            break;
        case "claude-desktop":
        case "claude-code":
            servers = obj.mcpServers;
            break;
        case "codex":
            servers = obj.mcp_servers ?? obj.mcpServers;
            break;
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
    const mappedServers = {};
    for (const [name, entry] of Object.entries(servers)) {
        if (kind === "opencode") {
            if (!entry || typeof entry !== "object" || Array.isArray(entry))
                continue;
            const raw = entry;
            if (raw.enabled === false)
                continue;
            if (raw.type === "local" && Array.isArray(raw.command) && raw.command.length > 0 && raw.command.every((value) => typeof value === "string")) {
                const env = toStringRecord(raw.environment);
                const command = raw.command[0];
                if (command === undefined)
                    continue;
                const mapped = {
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
                const mapped = {
                    url: raw.url,
                    ...(headers ? { headers } : {}),
                };
                if (raw.oauth === false) {
                    mapped.oauth = false;
                }
                else if (raw.oauth && typeof raw.oauth === "object" && !Array.isArray(raw.oauth)) {
                    const oauth = raw.oauth;
                    mapped.auth = "oauth";
                    mapped.oauth = {
                        ...(typeof oauth.clientId === "string" ? { clientId: oauth.clientId } : {}),
                        ...(typeof oauth.clientSecret === "string" ? { clientSecret: oauth.clientSecret } : {}),
                        ...(typeof oauth.clientMetadataUrl === "string" ? { clientMetadataUrl: oauth.clientMetadataUrl } : {}),
                        ...(typeof oauth.scope === "string" ? { scope: oauth.scope } : {}),
                        ...(typeof oauth.authServerMetadataUrl === "string" ? { authServerMetadataUrl: oauth.authServerMetadataUrl } : {}),
                        ...(typeof oauth.skipIssuerMetadataValidation === "boolean"
                            ? { skipIssuerMetadataValidation: oauth.skipIssuerMetadataValidation }
                            : {}),
                    };
                }
                mappedServers[name] = mapped;
            }
            continue;
        }
        if (!isRecord(entry))
            continue;
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
            if (mapped.auth === undefined)
                mapped.auth = "bearer";
        }
        if (httpHeaders && typeof httpHeaders === "object" && !Array.isArray(httpHeaders)) {
            mapped.headers = { ...mapped.headers, ...httpHeaders };
        }
        if (envHttpHeaders && typeof envHttpHeaders === "object" && !Array.isArray(envHttpHeaders)) {
            const headers = { ...mapped.headers };
            for (const [header, envVar] of Object.entries(envHttpHeaders)) {
                if (typeof envVar === "string" && headers[header] === undefined)
                    headers[header] = `$env:${envVar}`;
            }
            mapped.headers = headers;
        }
        delete mapped.bearer_token_env_var;
        delete mapped.http_headers;
        delete mapped.env_http_headers;
        mappedServers[name] = mapped;
    }
    return mappedServers;
}
function serializeRawConfig(raw) {
    return `${JSON.stringify(raw, null, 2)}\n`;
}
function buildUnifiedDiff(beforeText, afterText) {
    if (beforeText === afterText)
        return "(no changes)";
    const before = beforeText.split("\n");
    const after = afterText.split("\n");
    const rows = before.length;
    const cols = after.length;
    const lcs = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(0));
    for (let i = rows - 1; i >= 0; i--) {
        for (let j = cols - 1; j >= 0; j--) {
            const row = lcs[i];
            const nextRow = lcs[i + 1];
            if (!row || !nextRow)
                continue;
            row[j] = before[i] === after[j]
                ? (nextRow[j + 1] ?? 0) + 1
                : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
        }
    }
    const lines = ["--- before", "+++ after"];
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
function buildConfigWritePreview(filePath, nextRaw) {
    const existed = existsSync(filePath);
    const beforeRaw = readRawConfigObject(filePath);
    const beforeText = existed ? serializeRawConfig(beforeRaw) : "";
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
function readRawConfigObject(filePath) {
    if (!existsSync(filePath))
        return {};
    try {
        const raw = parseJsonWithComments(readFileSync(filePath, "utf-8"));
        return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    }
    catch {
        return {};
    }
}
function writeConfigText(writePath, text, cwd, intent) {
    writePath = getConfigPathIdentity(resolveWritableConfigPath(writePath, cwd, intent));
    let mode;
    try {
        mode = statSync(writePath).mode & 0o777;
    }
    catch { }
    mkdirSync(dirname(writePath), { recursive: true });
    const tmpPath = `${writePath}.${process.pid}.tmp`;
    rmSync(tmpPath, { force: true });
    try {
        writeFileSync(tmpPath, text, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
        if (mode !== undefined)
            chmodSync(tmpPath, mode);
        renameSync(tmpPath, writePath);
    }
    catch (error) {
        try {
            rmSync(tmpPath, { force: true });
        }
        catch { }
        throw error;
    }
}
function writeRawConfigObject(filePath, raw, cwd, intent) {
    writeConfigText(filePath, `${JSON.stringify(raw, null, 2)}\n`, cwd, intent);
}
export function writeSharedConfigText(filePath, text, cwd = process.cwd()) {
    if (!isRecord(parseJsonWithComments(text)))
        throw new Error("top-level value must be an object");
    writeConfigText(filePath, text, cwd, "shared");
}
function getServersObject(raw) {
    const existing = raw.mcpServers ?? raw["mcp-servers"] ?? {};
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
        return {};
    }
    return existing;
}
function setServersObject(raw, servers) {
    delete raw["mcp-servers"];
    raw.mcpServers = servers;
}
/**
 * Persist only the disabled field in the project Pi layer. Enabling writes an
 * explicit false only when a lower-precedence source is itself disabled; this
 * writer never copies a server definition or its credentials into the file.
 */
export function writeProjectServerDisabledOverride(overridePath, cwd, serverName, disabled) {
    const filePath = resolveWritableConfigPath(getProjectPiConfigPath(cwd), cwd, "pi-project");
    let raw = {};
    if (existsSync(filePath)) {
        try {
            const parsed = parseJsonWithComments(readFileSync(filePath, "utf-8"));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("root value must be an object");
            }
            raw = parsed;
        }
        catch (error) {
            throw new Error(`Failed to read project MCP override at ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
    }
    const serverKey = raw.mcpServers !== undefined ? "mcpServers" : raw["mcp-servers"] !== undefined ? "mcp-servers" : "mcpServers";
    const rawServers = raw[serverKey];
    if (rawServers !== undefined && (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers))) {
        throw new Error(`Failed to update project MCP override at ${filePath}: ${serverKey} must be an object`);
    }
    const servers = (rawServers ?? {});
    const previous = servers[serverName];
    if (previous !== undefined && (!previous || typeof previous !== "object" || Array.isArray(previous))) {
        throw new Error(`Failed to update project MCP override at ${filePath}: server "${serverName}" must be an object`);
    }
    const existing = previous;
    let next;
    if (disabled) {
        next = { ...existing, disabled: true };
    }
    else {
        next = Object.fromEntries(Object.entries(existing ?? {}).filter(([key]) => key !== "disabled"));
        let lowerConfig = { mcpServers: {} };
        for (const source of getConfigSources(overridePath, cwd)) {
            if (sameConfigIdentity(source.readPath, filePath) || source.active === false)
                continue;
            const rawLoaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
            if (!rawLoaded)
                continue;
            const loaded = isReadOnlyImportedPath(source.readPath, cwd) ? { mcpServers: rawLoaded.mcpServers } : rawLoaded;
            lowerConfig = mergeConfigs(lowerConfig, expandImports(loaded, cwd));
        }
        if (raw.imports !== undefined) {
            if (!Array.isArray(raw.imports) || raw.imports.some((kind) => typeof kind !== "string" || !Object.hasOwn(IMPORT_PATHS, kind))) {
                throw new Error(`Failed to update project MCP override at ${filePath}: imports contains an unsupported config kind`);
            }
            lowerConfig = mergeConfigs(lowerConfig, expandImports({ mcpServers: {}, imports: raw.imports }, cwd));
        }
        if (isServerDisabled(lowerConfig.mcpServers[serverName]))
            next.disabled = false;
    }
    if ((!existing && Object.keys(next).length === 0) || JSON.stringify(existing) === JSON.stringify(next)) {
        return { path: filePath, changed: false };
    }
    if (Object.keys(next).length === 0)
        delete servers[serverName];
    else
        servers[serverName] = next;
    raw[serverKey] = servers;
    writeRawConfigObject(filePath, raw, cwd, "pi-project");
    return { path: filePath, changed: true };
}
function isRepoPromptServer(name, entry) {
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
function findProjectRoot(cwd = process.cwd()) {
    let current = resolve(cwd);
    while (true) {
        if (existsSync(join(current, ".git"))
            || existsSync(join(current, "package.json"))
            || existsSync(join(current, PROJECT_CONFIG_NAME))
            || existsSync(join(current, ".pi"))) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
}
function buildRepoPromptEntry(executablePath) {
    return {
        command: executablePath,
        args: [],
        lifecycle: "lazy",
    };
}
function detectRepoPrompt(summary, cwd = process.cwd()) {
    for (const source of summary.sources) {
        if (!source.active || source.kind !== "shared" || source.serverCount === 0)
            continue;
        const config = readValidatedConfig(source.path, `MCP config from ${source.path}`);
        if (!config)
            continue;
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
export function getPiOwnedGlobalConfigPath(overridePath, cwd = process.cwd()) {
    const canonicalGlobalPath = getPiGlobalConfigPath(undefined, cwd);
    if (overridePath === undefined)
        return canonicalGlobalPath;
    // An explicit path is writable only when its canonical identity is already
    // one of the Pi-owned global/project overrides. All other sources, including
    // aliases to shared, host, or .agents files, route to canonical global Pi
    // storage instead of being rewritten.
    const targetPath = getPiGlobalConfigPath(overridePath, cwd);
    return classifyConfigPath(targetPath, cwd) === "pi-project"
        ? getProjectPiConfigPath(cwd)
        : canonicalGlobalPath;
}
function getPiWriteIntent(filePath, cwd) {
    return classifyConfigPath(filePath, cwd) === "pi-project" ? "pi-project" : "pi-global";
}
export function previewCompatibilityImports(importKinds, overridePath, cwd = process.cwd()) {
    const targetPath = resolveWritableConfigPath(getPiOwnedGlobalConfigPath(overridePath, cwd), cwd, getPiWriteIntent(getPiOwnedGlobalConfigPath(overridePath, cwd), cwd));
    const raw = readRawConfigObject(targetPath);
    const currentImports = Array.isArray(raw.imports) ? raw.imports.filter((value) => typeof value === "string") : [];
    const merged = [...new Set([...currentImports, ...importKinds])];
    const nextRaw = { ...raw, imports: merged };
    setServersObject(nextRaw, getServersObject(nextRaw));
    return buildConfigWritePreview(targetPath, nextRaw);
}
export function ensureCompatibilityImports(importKinds, overridePath, cwd = process.cwd()) {
    const targetPath = resolveWritableConfigPath(getPiOwnedGlobalConfigPath(overridePath, cwd), cwd, getPiWriteIntent(getPiOwnedGlobalConfigPath(overridePath, cwd), cwd));
    const raw = readRawConfigObject(targetPath);
    const currentImports = Array.isArray(raw.imports) ? raw.imports.filter((value) => typeof value === "string") : [];
    const merged = [...new Set([...currentImports, ...importKinds])];
    const added = merged.filter((kind) => !currentImports.includes(kind));
    if (added.length === 0) {
        return { path: targetPath, added: [] };
    }
    raw.imports = merged;
    const servers = getServersObject(raw);
    setServersObject(raw, servers);
    writeRawConfigObject(targetPath, raw, cwd, getPiWriteIntent(targetPath, cwd));
    return { path: targetPath, added };
}
export function buildStarterProjectConfig() {
    return {
        mcpServers: {},
    };
}
function assertWritableSharedPath(filePath, cwd, intent = "shared") {
    return resolveWritableConfigPath(filePath, cwd, intent);
}
function getSharedWriteIntent(target) {
    return target === "global" ? "shared-global" : "shared-project";
}
export function previewStarterSharedConfig(target, cwd = process.cwd()) {
    const targetPath = assertWritableSharedPath(getSharedConfigPath(target, cwd), cwd, getSharedWriteIntent(target));
    const nextRaw = { mcpServers: buildStarterProjectConfig().mcpServers };
    return buildConfigWritePreview(targetPath, nextRaw);
}
export function writeStarterSharedConfig(target, cwd = process.cwd()) {
    const targetPath = assertWritableSharedPath(getSharedConfigPath(target, cwd), cwd, getSharedWriteIntent(target));
    const raw = { mcpServers: buildStarterProjectConfig().mcpServers };
    writeRawConfigObject(targetPath, raw, cwd, getSharedWriteIntent(target));
    return targetPath;
}
export function previewStarterProjectConfig(cwd = process.cwd()) {
    return previewStarterSharedConfig("project", cwd);
}
export function writeStarterProjectConfig(cwd = process.cwd()) {
    return writeStarterSharedConfig("project", cwd);
}
export function previewSharedServerEntry(filePath, serverName, entry, cwd = process.cwd(), target) {
    const intent = target === undefined ? "shared" : getSharedWriteIntent(target);
    const targetPath = assertWritableSharedPath(filePath, cwd, intent);
    const raw = readRawConfigObject(targetPath);
    const nextRaw = { ...raw };
    const servers = getServersObject(nextRaw);
    servers[serverName] = entry;
    setServersObject(nextRaw, servers);
    return buildConfigWritePreview(targetPath, nextRaw);
}
export function writeSharedServerEntry(filePath, serverName, entry, cwd = process.cwd(), target) {
    const intent = target === undefined ? "shared" : getSharedWriteIntent(target);
    const targetPath = assertWritableSharedPath(filePath, cwd, intent);
    const raw = readRawConfigObject(targetPath);
    const servers = getServersObject(raw);
    servers[serverName] = entry;
    setServersObject(raw, servers);
    writeRawConfigObject(targetPath, raw, cwd, intent);
    return filePath;
}
function getAdapterWritePath(source, cwd) {
    return source.scope === "project"
        ? getProjectPiConfigPath(cwd)
        : getPiGlobalConfigPath(undefined, cwd);
}
export function getServerProvenance(overridePath, cwd = process.cwd()) {
    const provenance = new Map();
    const userPath = getPiOwnedGlobalConfigPath(overridePath, cwd);
    if (!isExclusiveConfigMode() && getConfiguredHostConfigDiscovery(overridePath, cwd) === "on") {
        for (const importKind of HOST_IMPORT_KINDS) {
            const imported = loadImportedConfig(importKind, cwd, `Failed to inspect imported MCP config from ${importKind}:`);
            if (!imported)
                continue;
            for (const name of Object.keys(extractServers(imported.value, importKind))) {
                // Keep writes inside Pi-owned storage even though the source is external.
                // Later import kinds win in the same deterministic order as loadDiscoveredHostConfigs.
                provenance.set(name, { path: userPath, kind: "import", importKind });
            }
        }
    }
    let effectiveConfig = !isExclusiveConfigMode() && getConfiguredHostConfigDiscovery(overridePath, cwd) === "on"
        ? loadDiscoveredHostConfigs(cwd)
        : { mcpServers: {} };
    for (const source of getConfigSources(overridePath, cwd)) {
        if (source.active === false)
            continue;
        const rawLoaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
        if (!rawLoaded)
            continue;
        const loaded = source.projection === "adapter"
            ? projectAdapterOverlay(rawLoaded, effectiveConfig, cwd)
            : isReadOnlyImportedPath(source.readPath, cwd) ? { mcpServers: rawLoaded.mcpServers } : rawLoaded;
        if (loaded.imports?.length) {
            for (const importKind of loaded.imports) {
                const imported = loadImportedConfig(importKind, cwd, `Failed to inspect imported MCP config from ${importKind}:`);
                if (!imported)
                    continue;
                const servers = extractServers(imported.value, importKind);
                for (const name of Object.keys(servers)) {
                    if (!provenance.has(name)) {
                        provenance.set(name, { path: getAdapterWritePath(source, cwd), kind: "import", importKind });
                    }
                }
            }
        }
        for (const name of Object.keys(loaded.mcpServers)) {
            provenance.set(name, {
                path: getAdapterWritePath(source, cwd),
                kind: source.kind,
                ...(source.importKind !== undefined ? { importKind: source.importKind } : {}),
            });
        }
        effectiveConfig = mergeConfigs(effectiveConfig, expandImports(loaded, cwd));
    }
    return provenance;
}
function getDirectToolsWriteTarget(provenance, cwd) {
    const ownership = classifyConfigPath(provenance.path, cwd);
    if (ownership === "pi-project")
        return getProjectPiConfigPath(cwd);
    if (ownership === "pi-global")
        return getPiGlobalConfigPath(undefined, cwd);
    return provenance.kind === "project"
        ? getProjectPiConfigPath(cwd)
        : getPiGlobalConfigPath(undefined, cwd);
}
function getDirectToolsWriteEntries(changes, provenance, cwd) {
    const byPath = new Map();
    for (const [serverName, value] of changes) {
        const prov = provenance.get(serverName);
        if (!prov)
            continue;
        const targetPath = getDirectToolsWriteTarget(prov, cwd);
        const entries = byPath.get(targetPath) ?? [];
        entries.push({ name: serverName, value });
        byPath.set(targetPath, entries);
    }
    return byPath;
}
function buildDirectToolsNextRaw(filePath, entries) {
    const raw = readRawConfigObject(filePath);
    const servers = getServersObject(raw);
    for (const { name, value } of entries) {
        // Adapter-only state must be a Pi-owned partial override. Keep shared and
        // imported definitions read-only, and do not copy credentials into the
        // override just to change direct-tool registration.
        servers[name] = { ...(servers[name] ?? {}), directTools: value };
    }
    setServersObject(raw, servers);
    return raw;
}
export function previewDirectToolsConfig(changes, provenance, cwd = process.cwd()) {
    return [...getDirectToolsWriteEntries(changes, provenance, cwd)].map(([filePath, entries]) => {
        const targetPath = resolveWritableConfigPath(filePath, cwd, getPiWriteIntent(filePath, cwd));
        return buildConfigWritePreview(targetPath, buildDirectToolsNextRaw(targetPath, entries));
    });
}
export function writeDirectToolsConfig(changes, provenance, _fullConfig, cwd = process.cwd()) {
    for (const [filePath, entries] of getDirectToolsWriteEntries(changes, provenance, cwd)) {
        writeRawConfigObject(filePath, buildDirectToolsNextRaw(filePath, entries), cwd, getPiWriteIntent(filePath, cwd));
    }
}
export function resolveConfiguredOAuthDir(raw, cwd = process.cwd()) {
    if (raw === undefined || raw === null)
        return undefined;
    if (typeof raw !== "string") {
        throw new Error("settings.oauthDir must be a string");
    }
    const trimmed = raw.trim();
    if (!trimmed)
        return undefined;
    return resolve(cwd, trimmed);
}
//# sourceMappingURL=config.js.map