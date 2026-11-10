import type { CachedPrompt, CachedResource, CachedTool, McpConfig, McpTool, McpResource, McpPrompt, MetadataCache, ServerCacheEntry, ServerEntry, ToolMetadata, PromptMetadata } from "./types.ts";
import { type ToolPrefix, type ToolSelectorCandidateIndex } from "./types.ts";
/** The per-server slots of a cache: the primary slot older adapters read, plus the remaining config variants. */
export type MetadataCacheSnapshot = Pick<MetadataCache, "servers" | "variants">;
export type { CachedPrompt, CachedResource, CachedTool, MetadataCache, ServerCacheEntry } from "./types.ts";
export declare function getMetadataCachePath(): string;
export declare function loadMetadataCache(): MetadataCache | null;
export declare function saveMetadataCache(cache: MetadataCache, options?: {
    startupSnapshot?: StartupSnapshot;
}): void;
/** The startup snapshot: the per-server slots, or the servers map older callers pass. */
export type StartupSnapshot = MetadataCacheSnapshot | MetadataCache["servers"];
/**
 * Entries cached for one server name: the primary slot first, then its config variants.
 * The primary slot is kept for older adapters that only know that slot; readers should resolve by hash.
 */
export declare function serverCacheEntries(cache: MetadataCacheSnapshot | null | undefined, serverName: string): ServerCacheEntry[];
/** The entry cached for this exact config hash, without any validity check. */
export declare function findServerCacheEntry(cache: MetadataCacheSnapshot | null | undefined, serverName: string, configHash: string | undefined): ServerCacheEntry | undefined;
/**
 * The cached entry for the definition's current config, when it is still usable: same config hash, cached,
 * not authorization-scoped, not a failure marker, and within the declared TTL.
 */
export declare function resolveServerCacheEntry(cache: MetadataCacheSnapshot | null | undefined, serverName: string, definition: ServerEntry, maxAgeMs?: number, environmentOrCwd?: HashEnvironment): ServerCacheEntry | undefined;
/**
 * Stores an entry under its own config hash and updates the primary slot to the newest entry, keeping the other
 * configs' entries as variants and dropping the oldest once a server holds more than `MAX_ENTRIES_PER_SERVER`.
 * Mutates `cache`.
 */
export declare function setServerCacheEntry(cache: MetadataCacheSnapshot, serverName: string, entry: ServerCacheEntry): void;
/** The config hash, or undefined when the config can't be resolved yet (for example a missing env var in the URL). */
export declare function tryComputeServerHash(definition: ServerEntry, environmentOrCwd?: HashEnvironment): string | undefined;
type HashEnvironment = NodeJS.ProcessEnv | string;
export declare function computeServerHash(definition: ServerEntry, environmentOrCwd?: HashEnvironment): string;
/**
 * Identifies the tool definition an output shape was learned against. A shape is only used or saved while
 * the tool's description and input schema still match, since a change there can mean a different result.
 */
export declare function outputShapeKey(tool: Pick<CachedTool, "description" | "inputSchema">): string;
/**
 * Saves one tool's observed output shape into its server's cache entry, if the entry matches the running config
 * and tool. The entry comes from the same read the write replaces, so newer metadata from other Pi processes is kept.
 */
export declare function saveObservedOutput(serverName: string, definition: ServerEntry, toolName: string, toolKey: string, output: NonNullable<ServerCacheEntry["outputShapes"]>[string], defaultCwd?: string): void;
/** Output shapes to carry into a rewritten cache entry: same config, not private, and only tools whose definition kept its shape key. */
export declare function keepOutputShapes(previous: ServerCacheEntry | undefined, configHash: string, tools: CachedTool[]): ServerCacheEntry["outputShapes"];
export declare function isServerCacheValid(entry: ServerCacheEntry, definition: ServerEntry, maxAgeMs?: number, environmentOrCwd?: HashEnvironment): boolean;
export declare function parseDirectToolSelectors(selectors: string[]): {
    servers: Set<string>;
    tools: Map<string, Set<string>>;
};
export declare function getMissingConfiguredDirectToolServers(config: McpConfig, cache: MetadataCache | null, envOverride?: string[], defaultCwd?: string): string[];
export declare function reconstructToolMetadata(serverName: string, entry: ServerCacheEntry, prefix: ToolPrefix, definition: Pick<ServerEntry, "exposeResources" | "includeTools" | "excludeTools" | "toolPrefix">, configuredServers?: Record<string, ServerEntry>, cache?: MetadataCache, sharedSelectorCandidateIndex?: ToolSelectorCandidateIndex, defaultCwd?: string): ToolMetadata[];
export declare function createCachedToolSelectorCandidateIndex(configuredServers: Record<string, ServerEntry>, cache: MetadataCache, prefix: ToolPrefix, defaultCwd?: string): ToolSelectorCandidateIndex;
export declare function serializeTools(tools: McpTool[]): CachedTool[];
export declare function serializeResources(resources: McpResource[]): CachedResource[];
export declare function serializePrompts(prompts: McpPrompt[]): CachedPrompt[];
export declare function reconstructPromptMetadata(serverName: string, prompts: ReadonlyArray<McpPrompt | CachedPrompt>, prefix: ToolPrefix, definition?: Pick<ServerEntry, "toolPrefix">): PromptMetadata[];
