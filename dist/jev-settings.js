const DEFAULTS = {
    semanticSearch: false,
    scriptEvaluation: false,
    allowedServers: [],
    model: "jev-1.13.0",
    requestTimeoutMs: 5_000,
    maxRetries: 0,
    maxStateBytes: 262_144,
    maxQuestionsPerRequest: 64,
    maxEvaluationsPerScript: 8,
    maxEvaluationBytesPerScript: 524_288,
    maxEvaluationTokensPerScript: 32_768,
    semanticCandidateLimit: 127,
    semanticMinProbability: 0.2,
};
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function record(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        throw new Error(`${label} must be a plain object`);
    return value;
}
function boolean(value, fallback, label) {
    if (value === undefined)
        return fallback;
    if (typeof value !== "boolean")
        throw new Error(`${label} must be a boolean`);
    return value;
}
function integer(value, fallback, min, max, label) {
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${label} must be an integer from ${min} to ${max}`);
    }
    return value;
}
/** Pure Jev settings validation shared by config discovery and the lazy client. */
export function validateJevSettings(value) {
    if (value === undefined || value === false)
        return { ...DEFAULTS, allowedServers: [...DEFAULTS.allowedServers] };
    const input = record(value, "settings.jev");
    const allowed = new Set(Object.keys(DEFAULTS));
    for (const key of Object.keys(input)) {
        if (!allowed.has(key))
            throw new Error(`settings.jev.${key} is not supported`);
    }
    if (input.allowedServers !== undefined && (!Array.isArray(input.allowedServers)
        || input.allowedServers.some(name => typeof name !== "string" || name.length === 0 || DANGEROUS_KEYS.has(name) || /[\u0000-\u001f\u007f]/.test(name)))) {
        throw new Error("settings.jev.allowedServers must contain non-empty safe server names");
    }
    const model = input.model ?? DEFAULTS.model;
    if (typeof model !== "string" || model.length === 0 || model.length > 128 || /(?:latest|preview)/i.test(model)) {
        throw new Error("settings.jev.model must be a pinned model name");
    }
    const probability = input.semanticMinProbability ?? DEFAULTS.semanticMinProbability;
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error("settings.jev.semanticMinProbability must be from 0 to 1");
    }
    return {
        semanticSearch: boolean(input.semanticSearch, DEFAULTS.semanticSearch, "settings.jev.semanticSearch"),
        scriptEvaluation: boolean(input.scriptEvaluation, DEFAULTS.scriptEvaluation, "settings.jev.scriptEvaluation"),
        allowedServers: [...new Set(input.allowedServers ?? DEFAULTS.allowedServers)],
        model,
        requestTimeoutMs: integer(input.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 100, 30_000, "settings.jev.requestTimeoutMs"),
        maxRetries: integer(input.maxRetries, DEFAULTS.maxRetries, 0, 2, "settings.jev.maxRetries"),
        maxStateBytes: integer(input.maxStateBytes, DEFAULTS.maxStateBytes, 1, 1_048_576, "settings.jev.maxStateBytes"),
        maxQuestionsPerRequest: integer(input.maxQuestionsPerRequest, DEFAULTS.maxQuestionsPerRequest, 1, 128, "settings.jev.maxQuestionsPerRequest"),
        maxEvaluationsPerScript: integer(input.maxEvaluationsPerScript, DEFAULTS.maxEvaluationsPerScript, 1, 32, "settings.jev.maxEvaluationsPerScript"),
        maxEvaluationBytesPerScript: integer(input.maxEvaluationBytesPerScript, DEFAULTS.maxEvaluationBytesPerScript, 1, 4_194_304, "settings.jev.maxEvaluationBytesPerScript"),
        maxEvaluationTokensPerScript: integer(input.maxEvaluationTokensPerScript, DEFAULTS.maxEvaluationTokensPerScript, 1, 1_000_000, "settings.jev.maxEvaluationTokensPerScript"),
        semanticCandidateLimit: integer(input.semanticCandidateLimit, DEFAULTS.semanticCandidateLimit, 2, 127, "settings.jev.semanticCandidateLimit"),
        semanticMinProbability: probability,
    };
}
/**
 * Resolves settings without touching credentials. Callers that have a real
 * credential resolver may override the default semantic admission separately.
 */
export function resolveConfiguredSemanticJevSettings(value, enabledServers, credentialAvailable) {
    const settings = validateJevSettings(value);
    if (value === false || (value && typeof value === "object" && value.semanticSearch === false)) {
        return settings;
    }
    const semanticSearch = settings.semanticSearch || credentialAvailable;
    const hasExplicitAllowlist = value !== undefined && value !== false && value !== null && typeof value === "object"
        && Object.hasOwn(value, "allowedServers");
    const allowedServers = hasExplicitAllowlist
        ? settings.allowedServers
        : enabledServers.filter(name => !DANGEROUS_KEYS.has(name));
    return { ...settings, semanticSearch, allowedServers: [...allowedServers] };
}
//# sourceMappingURL=jev-settings.js.map