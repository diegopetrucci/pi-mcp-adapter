import { type AgentPluginSummary } from "./agent-plugin-loader.ts";
import { type HostConfigDiscovery, type McpConfig, type ServerEntry, type ImportKind, type ServerProvenance } from "./types.ts";
export interface KnownServerPreset {
    id: string;
    name: string;
    summary: string;
    entry: ServerEntry;
    /** Offered only when one of these app paths exists; the local server is probed after adding. */
    desktopApp?: {
        paths: readonly string[];
        enableSteps: string;
    };
}
export declare const KNOWN_SERVER_PRESETS: readonly KnownServerPreset[];
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
    sources: Array<{
        kind: "shared" | "pi" | "explicit" | "host";
        path: string;
    }>;
    winner: {
        kind: "shared" | "pi" | "explicit" | "host";
        path: string;
    };
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
export declare function getPiGlobalConfigPath(overridePath?: string, cwd?: string): string;
export declare function getPiMcpGlobalConfigPath(): string;
export declare function getGenericGlobalConfigPath(): string;
export declare function getProjectConfigPath(cwd?: string): string;
export declare function getProjectPiConfigPath(cwd?: string): string;
export declare function getProjectPiMcpConfigPath(cwd?: string): string;
export declare function getLegacyMcpMigrationNotices(cwd?: string, overridePath?: string): string[];
export declare function getSharedConfigPath(target: SharedConfigTarget, cwd?: string): string;
export declare function getConfigDiscoveryPaths(overridePath?: string, cwd?: string): ConfigDiscoveryPath[];
export declare function findAvailableImportConfigs(cwd?: string): DiscoveredImportConfig[];
export declare function getMcpStandardConfigSummary(overridePath?: string, cwd?: string): McpStandardConfigSummary;
export declare function getMcpDiscoverySummary(overridePath?: string, cwd?: string, options?: {
    includeHostConfigs?: boolean;
}): McpDiscoverySummary;
export declare function cloneMcpConfig(config: McpConfig): McpConfig;
export interface ProjectServerSource {
    path: string;
}
export interface LoadedMcpConfig {
    config: McpConfig;
    projectServers: Map<string, ProjectServerSource>;
    projectServerPolicy: "ask" | "allow";
}
export declare const MCP_CONFIG_SOURCE_METADATA: unique symbol;
export declare function loadMcpConfig(overridePath?: string, cwd?: string): McpConfig;
export declare function loadMcpConfigWithSources(overridePath?: string, cwd?: string): LoadedMcpConfig;
export declare function resolveConfiguredClaudePluginMcp(config: McpConfig, cwd?: string): McpConfig;
export declare function discoverConfiguredClaudePluginSkills(config: McpConfig, cwd?: string): string[];
/** Returns why the entry is skipped when Pi would reject it or the adapter can't run it. */
export declare function translatePiMcpServer(name: string, value: unknown): {
    entry: ServerEntry;
    ignored: string[];
} | string;
export declare function writeSharedConfigText(filePath: string, text: string, cwd?: string): void;
/**
 * Preview the adapter-owned Jev policy change without writing either the
 * selected read-only config or a shared/native MCP file.
 */
export declare function previewJevSemanticSearchConfig(overridePath: string | undefined, cwd: string, allowedServers: string[], effectiveJev?: unknown): ConfigWritePreview;
/** Persist Jev settings only in the Pi-owned adapter layer. */
export declare function writeJevSemanticSearchConfig(overridePath: string | undefined, cwd: string, allowedServers: string[], effectiveJev?: unknown): {
    path: string;
    changed: boolean;
};
export interface ServerDisabledOverrideResult {
    path: string;
    changed: boolean;
}
/**
 * Persist only the disabled field in the project Pi layer. Enabling writes an
 * explicit false only when a lower-precedence source is itself disabled; this
 * writer never copies a server definition or its credentials into the file.
 */
export declare function writeProjectServerDisabledOverride(overridePath: string | undefined, cwd: string, serverName: string, disabled: boolean): ServerDisabledOverrideResult;
export declare function getPiOwnedGlobalConfigPath(overridePath?: string, cwd?: string): string;
export declare function previewCompatibilityImports(importKinds: ImportKind[], overridePath?: string, cwd?: string): ConfigWritePreview;
export declare function ensureCompatibilityImports(importKinds: ImportKind[], overridePath?: string, cwd?: string): {
    path: string;
    added: ImportKind[];
};
export declare function buildStarterProjectConfig(): McpConfig;
export declare function previewStarterSharedConfig(target: SharedConfigTarget, cwd?: string): ConfigWritePreview;
export declare function writeStarterSharedConfig(target: SharedConfigTarget, cwd?: string): string;
export declare function previewStarterProjectConfig(cwd?: string): ConfigWritePreview;
export declare function writeStarterProjectConfig(cwd?: string): string;
/**
 * Fields in ServerEntry that belong in the Pi adapter config, not in shared MCP configs.
 * directTools is a TLH-specific field: it controls adapter behavior and is not part of
 * the standard MCP config spec, so it must not be written to shared ~/.config/mcp/mcp.json.
 */
export declare const ADAPTER_ONLY_SERVER_FIELDS: ReadonlyArray<keyof ServerEntry>;
/**
 * Split a server entry into shared-config fields and adapter-only fields.
 * Returns [sharedEntry, adapterEntry | undefined].
 */
export declare function splitSharedAndAdapterEntry(entry: ServerEntry): [ServerEntry, Partial<ServerEntry> | undefined];
export declare function previewSharedServerEntry(filePath: string, serverName: string, entry: ServerEntry, cwd?: string, target?: SharedConfigTarget): ConfigWritePreview;
export declare function previewPiAdapterServerEntry(filePath: string, serverName: string, adapterEntry: Partial<ServerEntry>, cwd?: string): ConfigWritePreview;
export declare function writeSharedServerEntry(filePath: string, serverName: string, entry: ServerEntry, cwd?: string, target?: SharedConfigTarget): string;
export declare function writePiAdapterServerEntry(filePath: string, serverName: string, adapterEntry: Partial<ServerEntry>, cwd?: string): void;
export declare function getServerProvenance(overridePath?: string, cwd?: string): Map<string, ServerProvenance>;
export declare function previewDirectToolsConfig(changes: Map<string, true | string[] | false>, provenance: Map<string, ServerProvenance>, cwd?: string): ConfigWritePreview[];
export declare function writeDirectToolsConfig(changes: Map<string, true | string[] | false>, provenance: Map<string, ServerProvenance>, _fullConfig: McpConfig, onFileWrittenOrCwd?: (() => void) | string, cwd?: string): void;
export declare function resolveConfiguredOAuthDir(raw: unknown, cwd?: string): string | undefined;
export {};
