import type { ResolvedJevSettings } from "./jev-contracts.ts";
export type { ResolvedJevSettings } from "./jev-contracts.ts";
/** Pure Jev settings validation shared by config discovery and the lazy client. */
export declare function validateJevSettings(value: unknown): ResolvedJevSettings;
/**
 * Resolves settings without touching credentials. Callers that have a real
 * credential resolver may override the default semantic admission separately.
 */
export declare function resolveConfiguredSemanticJevSettings(value: unknown, enabledServers: readonly string[], credentialAvailable: boolean): ResolvedJevSettings;
