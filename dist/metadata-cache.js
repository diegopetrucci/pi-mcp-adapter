// metadata-cache.ts - Persistent MCP metadata cache
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentPath } from "./agent-dir.js";
import { createHash } from "node:crypto";
import { isBuiltInAgentPlugin } from "./agent-plugin-provenance.js";
import { getToolUiResourceUri } from "./ui-app-bridge-helpers.js";
import { createToolSelectorCandidateIndex, formatPromptCommandName, formatToolName, getToolNameCandidates, isServerDisabled, isToolAllowed, resolveToolPrefix, resolveUniqueNameOwnership } from "./types.js";
import { resourceNameToToolName } from "./resource-tools.js";
import { extractToolAnnotations, extractToolUiStreamMode, interpolateEnvRecord, interpolateEnvVars, resolveBearerToken, resolveConfigPath, resolveServerUrl, stableStringify, } from "./utils.js";
import { extractUiToolVisibility, isUiToolVisibleToModel } from "./ui-tool-visibility.js";
// Stays 1 although entries are now per config: `servers[name]` keeps its entry-object shape, and the extra entries
// live in an optional top-level map older adapters ignore. A version bump would make 5.0.x/5.1.x discard the file
// outright (`version !== 1` reads as corrupt) and rewrite it from scratch, which is a bigger loss than the extra
// entries they already cannot represent.
const CACHE_VERSION = 1;
// One entry per server config, so a few checkouts of the same repo can keep their stdio entries side by side.
const MAX_ENTRIES_PER_SERVER = 8;
export function getMetadataCachePath() {
    return getAgentPath("mcp-cache.json");
}
export function loadMetadataCache() {
    const cachePath = getMetadataCachePath();
    if (!existsSync(cachePath))
        return null;
    try {
        const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
        if (!raw || typeof raw !== "object")
            return null;
        if (raw.version !== CACHE_VERSION)
            return null;
        if (!raw.servers || typeof raw.servers !== "object")
            return null;
        const slots = normalizeCacheSlots({
            servers: raw.servers,
            ...(raw.variants !== undefined ? { variants: raw.variants } : {}),
        });
        return {
            version: CACHE_VERSION,
            servers: slots.servers,
            ...(slots.variants !== undefined && Object.keys(slots.variants).length > 0 ? { variants: slots.variants } : {}),
        };
    }
    catch {
        return null;
    }
}
export function saveMetadataCache(cache, options = {}) {
    const snapshot = options.startupSnapshot === undefined ? undefined : toCacheSnapshot(options.startupSnapshot);
    updateMetadataCacheFile(state => {
        for (const [name, entry] of Object.entries(cache.servers)) {
            // Everything here works on the config's own hash, so another checkout's entry for the same server name is
            // never treated as this config's disk state.
            const disk = findServerCacheEntry(state, name, entry.configHash);
            // Startup batch: a catalog is written unless disk has a newer catalog for the same config, and keeps output shapes
            // saved meanwhile. A failure marker is written only if that config's disk entry is unchanged since the startup
            // snapshot, so it does not discard what another session wrote before the pass.
            if (!snapshot) {
                setServerCacheEntry(state, name, entry);
            }
            else if (entry.discoveryFailed) {
                const snapshotEntry = findServerCacheEntry(snapshot, name, entry.configHash);
                if (sameCacheEntry(disk, snapshotEntry))
                    setServerCacheEntry(state, name, entry);
            }
            else if (disk && !disk.discoveryFailed) {
                if ((disk.cachedAt ?? 0) > entry.cachedAt)
                    continue;
                const outputShapes = { ...entry.outputShapes, ...keepOutputShapes(disk, entry.configHash, entry.tools) };
                setServerCacheEntry(state, name, Object.keys(outputShapes).length > 0 ? { ...entry, outputShapes } : entry);
            }
            else {
                setServerCacheEntry(state, name, entry);
            }
        }
        return state;
    });
}
function sameCacheEntry(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
function toCacheSnapshot(source) {
    const servers = source.servers;
    // A cache entry always carries a configHash, so a "servers" key holding one is a server of that name, not a snapshot.
    const isSlots = servers !== undefined
        && typeof servers === "object"
        && typeof servers.configHash !== "string";
    if (!isSlots)
        return { servers: source };
    const variants = source.variants;
    return { servers: servers, ...(variants !== undefined ? { variants } : {}) };
}
/** Reads the cache file, applies one update, and writes the result; an update returning undefined skips the write. */
function updateMetadataCacheFile(update) {
    const cachePath = getMetadataCachePath();
    const dir = dirname(cachePath);
    mkdirSync(dir, { recursive: true });
    let state = { servers: {}, variants: {} };
    try {
        if (existsSync(cachePath)) {
            const existing = JSON.parse(readFileSync(cachePath, "utf-8"));
            if (existing && existing.version === CACHE_VERSION && existing.servers) {
                state = normalizeCacheSlots({
                    servers: existing.servers,
                    ...(existing.variants !== undefined ? { variants: existing.variants } : {}),
                });
            }
        }
    }
    catch {
        // Ignore parse errors and proceed with empty cache
    }
    const next = update(state);
    if (!next)
        return;
    // The update sees the same read the write replaces, so entries another session wrote earlier are kept.
    // There is no cross-process lock, so two writes in the same instant can still lose one entry, which is
    // rediscovered on next use (pre-existing behavior, unchanged here).
    const slots = normalizeCacheSlots(next);
    const payload = { version: CACHE_VERSION, servers: slots.servers };
    if (slots.variants !== undefined && Object.keys(slots.variants).length > 0)
        payload.variants = slots.variants;
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload), "utf-8");
    renameSync(tmpPath, cachePath);
}
/**
 * Entries cached for one server name: the primary slot first, then its config variants.
 * The primary slot is kept for older adapters that only know that slot; readers should resolve by hash.
 */
export function serverCacheEntries(cache, serverName) {
    return collectServerCacheEntries(cache, serverName);
}
/** The entry cached for this exact config hash, without any validity check. */
export function findServerCacheEntry(cache, serverName, configHash) {
    if (!configHash)
        return undefined;
    return collectServerCacheEntries(cache, serverName).find(entry => entry.configHash === configHash);
}
/**
 * The cached entry for the definition's current config, when it is still usable: same config hash, cached,
 * not authorization-scoped, not a failure marker, and within the declared TTL.
 */
export function resolveServerCacheEntry(cache, serverName, definition, maxAgeMs = 0, environmentOrCwd = process.env) {
    const configHash = tryComputeServerHash(definition, environmentOrCwd);
    const entry = findServerCacheEntry(cache, serverName, configHash);
    return entry && isServerCacheValid(entry, definition, maxAgeMs, environmentOrCwd) ? entry : undefined;
}
/**
 * Stores an entry under its own config hash and updates the primary slot to the newest entry, keeping the other
 * configs' entries as variants and dropping the oldest once a server holds more than `MAX_ENTRIES_PER_SERVER`.
 * Mutates `cache`.
 */
export function setServerCacheEntry(cache, serverName, entry) {
    writeServerCacheSlots(cache, serverName, [
        entry,
        ...collectServerCacheEntries(cache, serverName).filter(existing => existing.configHash !== entry.configHash),
    ]);
}
function collectServerCacheEntries(cache, serverName) {
    if (!cache)
        return [];
    const primary = cache.servers?.[serverName];
    const variants = cache.variants?.[serverName];
    const entries = primary ? [primary] : [];
    if (variants && typeof variants === "object") {
        for (const variant of Object.values(variants)) {
            if (variant && typeof variant === "object" && variant.configHash !== primary?.configHash)
                entries.push(variant);
        }
    }
    return entries;
}
/** Writes one server's entries as slots: newest in the primary slot, the rest keyed by config hash. */
function writeServerCacheSlots(cache, serverName, entries) {
    const byHash = new Map();
    for (const entry of entries) {
        if (!entry || typeof entry !== "object" || typeof entry.configHash !== "string")
            continue;
        if (!byHash.has(entry.configHash))
            byHash.set(entry.configHash, entry);
    }
    // Newest first; the order of equal timestamps is the caller's (the entry being written comes first).
    const [primary, ...variants] = [...byHash.values()]
        .sort((a, b) => (b.cachedAt ?? 0) - (a.cachedAt ?? 0))
        .slice(0, MAX_ENTRIES_PER_SERVER);
    if (primary === undefined)
        delete cache.servers[serverName];
    else
        cache.servers[serverName] = primary;
    if (variants.length === 0) {
        if (cache.variants)
            delete cache.variants[serverName];
        return;
    }
    cache.variants ??= {};
    cache.variants[serverName] = Object.fromEntries(variants.map(entry => [entry.configHash, entry]));
}
/** Rebuilds every server's slots, dropping malformed, duplicate, and over-cap entries. */
function normalizeCacheSlots(source) {
    const slots = { servers: {}, variants: {} };
    const names = new Set([
        ...Object.keys(source.servers ?? {}),
        ...Object.keys(source.variants ?? {}),
    ]);
    for (const name of names) {
        const primary = source.servers?.[name];
        const variants = source.variants?.[name];
        const entries = primary ? [primary] : [];
        if (variants && typeof variants === "object")
            entries.push(...Object.values(variants));
        writeServerCacheSlots(slots, name, entries);
    }
    return slots;
}
/** The config hash, or undefined when the config can't be resolved yet (for example a missing env var in the URL). */
export function tryComputeServerHash(definition, environmentOrCwd = process.env) {
    try {
        return computeServerHash(definition, environmentOrCwd);
    }
    catch {
        return undefined;
    }
}
function normalizeHashEnvironment(value) {
    if (typeof value === "string")
        return { environment: process.env, defaultCwd: value };
    return { environment: value ?? process.env };
}
export function computeServerHash(definition, environmentOrCwd = process.env) {
    // Hash only fields that affect server identity and tool/resource output.
    // Exclude lifecycle, idleTimeout, requestTimeoutMs, debug — those are runtime behavior settings
    // that don't change which tools a server exposes.
    const { environment, defaultCwd } = normalizeHashEnvironment(environmentOrCwd);
    const isStdio = !!definition.command;
    const literalEnv = isBuiltInAgentPlugin(definition, "env") || (isStdio && definition.literalEnv === true);
    const identity = {
        command: resolveConfigPath(definition.command, environment),
        args: definition.args,
        socket: resolveConfigPath(definition.socket, environment),
        env: literalEnv ? definition.env : interpolateEnvRecord(definition.env, environment),
        ...(isStdio ? { inheritEnv: definition.inheritEnv !== false, literalEnv } : {}),
        cwd: isBuiltInAgentPlugin(definition, "cwd")
            ? definition.cwd
            : resolveConfigPath(definition.cwd, environment) ?? (definition.command ? defaultCwd : undefined),
        url: resolveServerUrl(definition, environment),
        headers: isBuiltInAgentPlugin(definition, "headers") ? definition.headers : interpolateEnvRecord(definition.headers, environment),
        requestHeadersCommand: definition.requestHeadersCommand
            ? {
                command: interpolateEnvVars(definition.requestHeadersCommand.command, environment),
                args: definition.requestHeadersCommand.args?.map((argument) => interpolateEnvVars(argument, environment)),
                env: interpolateEnvRecord(definition.requestHeadersCommand.env, environment),
                timeoutMs: definition.requestHeadersCommand.timeoutMs,
            }
            : undefined,
        auth: definition.auth,
        protocolVersion: definition.protocolVersion,
        bearerToken: resolveBearerToken(definition, environment),
        bearerTokenEnv: definition.bearerTokenEnv,
        exposeResources: definition.exposeResources,
        includeTools: definition.includeTools,
        excludeTools: definition.excludeTools,
    };
    const normalized = stableStringify(identity);
    return createHash("sha256").update(normalized).digest("hex");
}
/**
 * Identifies the tool definition an output shape was learned against. A shape is only used or saved while
 * the tool's description and input schema still match, since a change there can mean a different result.
 */
export function outputShapeKey(tool) {
    return stableStringify({ description: tool.description ?? "", inputSchema: tool.inputSchema ?? null });
}
/**
 * Saves one tool's observed output shape into its server's cache entry, if the entry matches the running config
 * and tool. The entry comes from the same read the write replaces, so newer metadata from other Pi processes is kept.
 */
export function saveObservedOutput(serverName, definition, toolName, toolKey, output, defaultCwd) {
    const configHash = computeServerHash(definition, defaultCwd ?? process.env);
    updateMetadataCacheFile(state => {
        const entry = findServerCacheEntry(state, serverName, configHash);
        const cachedTool = entry?.tools?.find(tool => tool.name === toolName);
        if (!entry || !cachedTool || outputShapeKey(cachedTool) !== toolKey)
            return undefined;
        setServerCacheEntry(state, serverName, { ...entry, outputShapes: { ...entry.outputShapes, [toolName]: output } });
        return state;
    });
}
/** Output shapes to carry into a rewritten cache entry: same config, not private, and only tools whose definition kept its shape key. */
export function keepOutputShapes(previous, configHash, tools) {
    if (!previous?.outputShapes || previous.configHash !== configHash || previous.cacheScope === "private")
        return undefined;
    const kept = Object.entries(previous.outputShapes).filter(([toolName]) => {
        const before = previous.tools?.find(tool => tool.name === toolName);
        const after = tools.find(tool => tool.name === toolName);
        return before !== undefined && after !== undefined && outputShapeKey(before) === outputShapeKey(after);
    });
    return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}
// 0 means no age limit: without a server-declared TTL, an entry stays valid until the next connect refreshes it.
export function isServerCacheValid(entry, definition, maxAgeMs = 0, environmentOrCwd = process.env) {
    let configHash;
    try {
        configHash = computeServerHash(definition, environmentOrCwd);
    }
    catch {
        return false;
    }
    if (!entry || entry.configHash !== configHash)
        return false;
    if (!entry.cachedAt || typeof entry.cachedAt !== "number")
        return false;
    // The persistent cache is not partitioned by authorization context.
    if (entry.cacheScope === "private")
        return false;
    if (entry.discoveryFailed)
        return false;
    const declaredTtlMs = entry.ttlMs;
    if (typeof declaredTtlMs === "number" && Number.isSafeInteger(declaredTtlMs) && declaredTtlMs >= 0) {
        if (declaredTtlMs === 0)
            return false;
        const ageMs = Date.now() - entry.cachedAt;
        const effectiveMaxAge = maxAgeMs > 0 ? Math.min(maxAgeMs, declaredTtlMs) : declaredTtlMs;
        return ageMs < effectiveMaxAge;
    }
    if (maxAgeMs > 0 && Date.now() - entry.cachedAt > maxAgeMs)
        return false;
    return true;
}
export function parseDirectToolSelectors(selectors) {
    const servers = new Set();
    const tools = new Map();
    for (let selector of selectors) {
        selector = selector.replace(/\/+$/, "");
        if (selector.includes("/")) {
            const [server, tool] = selector.split("/", 2);
            if (server && tool) {
                const serverTools = tools.get(server) ?? new Set();
                serverTools.add(tool);
                tools.set(server, serverTools);
            }
            else if (server) {
                servers.add(server);
            }
        }
        else if (selector) {
            servers.add(selector);
        }
    }
    return { servers, tools };
}
export function getMissingConfiguredDirectToolServers(config, cache, envOverride, defaultCwd) {
    const missing = [];
    const globalDirect = config.settings?.directTools;
    const envSelection = envOverride ? parseDirectToolSelectors(envOverride) : null;
    for (const [serverName, definition] of Object.entries(config.mcpServers)) {
        if (isServerDisabled(definition))
            continue;
        const hasDirectTools = envSelection
            ? envSelection.servers.has(serverName) || envSelection.tools.has(serverName)
            : definition.directTools !== undefined
                ? !!definition.directTools
                : !!globalDirect;
        if (!hasDirectTools)
            continue;
        if (!resolveServerCacheEntry(cache, serverName, definition, undefined, defaultCwd ?? process.env)) {
            missing.push(serverName);
        }
    }
    return missing;
}
export function reconstructToolMetadata(serverName, entry, prefix, definition, configuredServers, cache, sharedSelectorCandidateIndex, defaultCwd) {
    const metadata = [];
    const effectivePrefix = resolveToolPrefix(definition, prefix);
    const hasToolFilters = (Array.isArray(definition.includeTools) && definition.includeTools.length > 0) ||
        (Array.isArray(definition.excludeTools) && definition.excludeTools.length > 0);
    const selectorCandidateIndex = hasToolFilters
        ? sharedSelectorCandidateIndex ?? (configuredServers && cache
            ? createCachedToolSelectorCandidateIndex(configuredServers, cache, prefix, defaultCwd)
            : undefined)
        : undefined;
    for (const tool of entry.tools ?? []) {
        if (!tool?.name)
            continue;
        if (!isUiToolVisibleToModel(tool.uiVisibility)) {
            continue;
        }
        if (!isToolAllowed(tool.name, serverName, effectivePrefix, definition.includeTools, definition.excludeTools, selectorCandidateIndex)) {
            continue;
        }
        const name = formatToolName(tool.name, serverName, effectivePrefix);
        const annotations = extractToolAnnotations(tool.annotations);
        metadata.push({
            name,
            originalName: tool.name,
            description: tool.description ?? "",
            ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
            ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
            ...(tool.uiResourceUri !== undefined ? { uiResourceUri: tool.uiResourceUri } : {}),
            ...(tool.uiVisibility !== undefined ? { uiVisibility: tool.uiVisibility } : {}),
            ...(tool.uiStreamMode !== undefined ? { uiStreamMode: tool.uiStreamMode } : {}),
            ...(annotations !== undefined ? { annotations } : {}),
        });
    }
    if (definition.exposeResources !== false) {
        for (const resource of entry.resources ?? []) {
            if (!resource?.name || !resource?.uri)
                continue;
            const baseName = `read_${resourceNameToToolName(resource.name)}`;
            if (!isToolAllowed(baseName, serverName, effectivePrefix, definition.includeTools, definition.excludeTools, selectorCandidateIndex)) {
                continue;
            }
            const name = formatToolName(baseName, serverName, effectivePrefix);
            metadata.push({
                name,
                originalName: baseName,
                description: resource.description ?? `Read resource: ${resource.uri}`,
                resourceUri: resource.uri,
            });
        }
    }
    return resolveUniqueNameOwnership(metadata, (tool) => tool.name).unique;
}
export function createCachedToolSelectorCandidateIndex(configuredServers, cache, prefix, defaultCwd) {
    const candidates = new Set();
    for (const [serverName, definition] of Object.entries(configuredServers)) {
        if (isServerDisabled(definition))
            continue;
        const entry = resolveServerCacheEntry(cache, serverName, definition, undefined, defaultCwd ?? process.env);
        if (!entry)
            continue;
        const effectivePrefix = resolveToolPrefix(definition, prefix);
        for (const tool of entry.tools ?? []) {
            if (!isUiToolVisibleToModel(tool.uiVisibility))
                continue;
            for (const candidate of getToolNameCandidates(tool.name, serverName, effectivePrefix, false))
                candidates.add(candidate);
        }
        if (definition.exposeResources !== false) {
            for (const resource of entry.resources ?? []) {
                const baseName = `read_${resourceNameToToolName(resource.name)}`;
                for (const candidate of getToolNameCandidates(baseName, serverName, effectivePrefix, false))
                    candidates.add(candidate);
            }
        }
    }
    return createToolSelectorCandidateIndex(candidates);
}
export function serializeTools(tools) {
    return tools
        .filter(t => t?.name)
        .map(t => {
        const uiResourceUri = tryGetToolUiResourceUri(t);
        const uiVisibility = extractUiToolVisibility(t._meta);
        const uiStreamMode = extractToolUiStreamMode(t._meta);
        const annotations = extractToolAnnotations(t.annotations);
        return {
            name: t.name,
            ...(t.description !== undefined ? { description: t.description } : {}),
            ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
            ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
            ...(uiResourceUri !== undefined ? { uiResourceUri } : {}),
            ...(uiVisibility !== undefined ? { uiVisibility } : {}),
            ...(uiStreamMode !== undefined ? { uiStreamMode } : {}),
            ...(annotations !== undefined ? { annotations } : {}),
        };
    });
}
export function serializeResources(resources) {
    return resources
        .filter(r => r?.name && r?.uri)
        .map(r => ({
        uri: r.uri,
        name: r.name,
        ...(r.description !== undefined ? { description: r.description } : {}),
    }));
}
export function serializePrompts(prompts) {
    return (prompts ?? [])
        .filter(prompt => prompt?.name)
        .map(prompt => ({
        name: prompt.name,
        ...(prompt.title !== undefined ? { title: prompt.title } : {}),
        ...(prompt.description !== undefined ? { description: prompt.description } : {}),
        ...(Array.isArray(prompt.arguments)
            ? {
                arguments: prompt.arguments.filter(argument => argument?.name).map(argument => ({
                    name: argument.name,
                    ...(argument.description !== undefined ? { description: argument.description } : {}),
                    ...(argument.required !== undefined ? { required: argument.required } : {}),
                })),
            }
            : {}),
    }));
}
export function reconstructPromptMetadata(serverName, prompts, prefix, definition) {
    const effectivePrefix = resolveToolPrefix(definition, prefix);
    return (prompts ?? []).filter(prompt => prompt?.name).map(prompt => {
        const args = Array.isArray(prompt.arguments)
            ? prompt.arguments.filter(argument => argument?.name).map(argument => ({
                name: argument.name,
                ...(argument.description !== undefined ? { description: argument.description } : {}),
                ...(argument.required !== undefined ? { required: argument.required } : {}),
            }))
            : [];
        return {
            serverName,
            originalName: prompt.name,
            commandName: formatPromptCommandName(prompt.name, serverName, effectivePrefix),
            ...(prompt.title !== undefined ? { title: prompt.title } : {}),
            description: prompt.description ?? "",
            arguments: args,
        };
    });
}
function tryGetToolUiResourceUri(tool) {
    try {
        return getToolUiResourceUri({ _meta: tool._meta });
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=metadata-cache.js.map