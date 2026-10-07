import { afterEach, describe, expect, it, vi } from "vitest";
import { runMcpScript, type McpScriptJevEvaluator } from "../mcp-code.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import { getTestSecureKeyringReadCount, resetTestSecureKeyring } from "../secure-keyring.ts";
import type { McpExtensionState } from "../state.ts";
import type { ToolMetadata } from "../types.ts";
import type { JevEvaluateInput, JevEvaluationEnvelope } from "../jev-contracts.ts";

function makeState(jev: Record<string, unknown> | false = { scriptEvaluation: true }): McpExtensionState {
  return {
    owner: createMcpRuntimeOwner(),
    config: { settings: { jev }, mcpServers: { allowed: { command: "unused" }, blocked: { command: "unused" } } },
    manager: { getConnection: vi.fn(() => undefined), isConnecting: vi.fn(() => false) },
    toolMetadata: new Map(),
    failureTracker: new Map(),
    completedUiSessions: [],
  } as unknown as McpExtensionState;
}

function text(result: Awaited<ReturnType<typeof runMcpScript>>): string {
  return result.content.filter(block => block.type === "text").map(block => block.text).at(-1)!;
}

const input: JevEvaluateInput = {
  state: { issue: "redacted-state" },
  questions: {
    route: { type: "choice", criteria: { fix: "Fix", close: "Close" } },
    severity: { type: "score", criteria: ["low", "high"] },
    relevant: { type: "noul" },
  },
};

const success: JevEvaluationEnvelope = {
  ok: true,
  data: {
    answers: {
      route: { type: "choice", choice: "fix", confidence: 0.9, probabilities: { fix: 0.9, close: 0.1 } },
      severity: { type: "score", score: 1, confidence: 0.8, probabilities: { "0": 0.2, "1": 0.8 } },
      relevant: { type: "noul", noul: 0.75 },
    },
    model: "jev-1.13.0",
    usage: { inputTokens: 12, outputTokens: 7 },
  },
};

function evaluatorReturning(envelope: JevEvaluationEnvelope): McpScriptJevEvaluator {
  return vi.fn(async () => envelope);
}

function discoveryState(jev: Record<string, unknown> = { scriptEvaluation: true, allowedServers: ["allowed"] }): McpExtensionState {
  const state = makeState(jev);
  state.toolMetadata = new Map<string, ToolMetadata[]>([
    ["allowed", [{ name: "allowed_tool", originalName: "allowed_tool", description: "Allowed metadata" }]],
    ["blocked", [{ name: "blocked_tool", originalName: "blocked_tool", description: "Excluded metadata" }]],
  ]);
  return state;
}

function duplicateDiscoveryState(): McpExtensionState {
  const state = discoveryState();
  state.toolMetadata.set("allowed", [
    ...state.toolMetadata.get("allowed")!,
    { name: "shared_tool", originalName: "shared_tool", description: "Allowed duplicate metadata" },
  ]);
  state.toolMetadata.set("blocked", [
    ...state.toolMetadata.get("blocked")!,
    { name: "shared_tool", originalName: "shared_tool", description: "Excluded duplicate metadata" },
  ]);
  return state;
}

function excludedSuggestionState(mode: "disabled" | "backoff"): McpExtensionState {
  const state = duplicateDiscoveryState();
  if (mode === "disabled") {
    state.config.mcpServers.blocked = { ...state.config.mcpServers.blocked, disabled: true };
  } else {
    state.failureTracker.set("blocked", Date.now());
  }
  return state;
}

function scopedCallDiscoveryState(): McpExtensionState {
  const state = duplicateDiscoveryState();
  state.config.settings = { ...state.config.settings, toolPrefix: "none" };
  const definition = state.config.mcpServers.allowed!;
  const connection = {
    definition,
    tools: [{ name: "shared_tool", description: "Allowed duplicate metadata" }],
    resources: [],
    prompts: [],
    status: "connected" as const,
    listenState: "legacy" as const,
    lastUsedAt: Date.now(),
    inFlight: 0,
  };
  state.provisionalInstalls = new Set(["allowed"]);
  state.manager = {
    getConnection: vi.fn(() => connection),
    isConnecting: vi.fn(() => false),
    ensureListen: vi.fn(),
  } as unknown as McpExtensionState["manager"];
  return state;
}

function isolateJevEnvironment(): void {
  for (const name of ["SYSTEMONE_API_KEY", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "SYSTEMONE_ENDPOINT"]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
  vi.stubEnv("PI_MCP_ADAPTER_DISABLE_AUTH_CACHE", "1");
  resetTestSecureKeyring();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetTestSecureKeyring();
});

describe("mcpScript jev.evaluate", () => {
  it("returns typed Choice, Score, and Noul answers through the host evaluator", async () => {
    const evaluator = evaluatorReturning(success);
    const result = await runMcpScript(makeState(), `return await jev.evaluate(${JSON.stringify(input)});`, 2_000, undefined, undefined, evaluator);

    expect(JSON.parse(text(result))).toEqual(success);
    expect(evaluator).toHaveBeenCalledWith(expect.anything(), input, expect.objectContaining({ purpose: "script", signal: expect.any(AbortSignal) }));
    expect(result.details).toMatchObject({ calls: [{ operation: "evaluate", ok: true, model: "jev-1.13.0", inputTokens: 12, outputTokens: 7, durationMs: expect.any(Number) }] });
    expect(JSON.stringify(result.details)).not.toMatch(/redacted-state|route|fix|confidence|probabilities/);
  });

  it("exposes only a frozen host RPC without process, env, SDK, credentials, or fetch", async () => {
    const evaluator = evaluatorReturning(success);
    const result = await runMcpScript(makeState(), `return {
      frozen: Object.isFrozen(jev), keys: Object.keys(jev),
      globals: [typeof process, typeof require, typeof fetch, typeof TypeSafeClient],
      leaks: [jev.apiKey, jev.endpoint, jev.headers, jev.env, jev.client, jev.sdk].map(value => value ?? null)
    };`, 2_000, undefined, undefined, evaluator);

    expect(JSON.parse(text(result))).toEqual({
      frozen: true,
      keys: ["evaluate"],
      globals: ["undefined", "undefined", "undefined", "undefined"],
      leaks: [null, null, null, null, null, null],
    });
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("enforces the attempt budget before dispatch and lets the script continue", async () => {
    const evaluator = evaluatorReturning(success);
    const state = makeState({ scriptEvaluation: true, maxEvaluationsPerScript: 1 });
    const result = await runMcpScript(state, `
      const first = await jev.evaluate(${JSON.stringify(input)});
      const second = await jev.evaluate(${JSON.stringify(input)});
      return { first: first.ok, second, continued: true };
    `, 2_000, undefined, undefined, evaluator);

    expect(JSON.parse(text(result))).toMatchObject({ first: true, continued: true, second: { ok: false, error: { code: "budget_exhausted" } } });
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ calls: [{ operation: "evaluate", ok: true }, { operation: "evaluate", ok: false, error: "budget_exhausted" }] });
  });

  it("enforces cumulative UTF-8 input bytes before provider work", async () => {
    let providerCalls = 0;
    const evaluator: McpScriptJevEvaluator = vi.fn(async () => {
      providerCalls += 1;
      return success;
    });
    const one = { state: "😀", questions: { q: { type: "noul" } } };
    const bytes = Buffer.byteLength(JSON.stringify(one), "utf8");
    const state = makeState({ scriptEvaluation: true, maxEvaluationBytesPerScript: bytes * 2 - 1 });
    const result = await runMcpScript(state, `return [await jev.evaluate(${JSON.stringify(one)}), await jev.evaluate(${JSON.stringify(one)})];`, 2_000, undefined, undefined, evaluator);

    expect(JSON.parse(text(result))).toMatchObject([{ ok: true }, { ok: false, error: { code: "budget_exhausted" } }]);
    expect(providerCalls).toBe(1);
  });

  it("enforces cumulative provider-reported tokens at exact and overshoot boundaries", async () => {
    const exactEvaluator = evaluatorReturning(success);
    const exact = await runMcpScript(
      makeState({ scriptEvaluation: true, maxEvaluationTokensPerScript: 19 }),
      `return [await jev.evaluate(${JSON.stringify(input)}), await jev.evaluate(${JSON.stringify(input)})];`,
      2_000, undefined, undefined, exactEvaluator,
    );
    expect(JSON.parse(text(exact))).toMatchObject([{ ok: true }, { ok: false, error: { code: "budget_exhausted" } }]);
    expect(exactEvaluator).toHaveBeenCalledTimes(1);

    const overshootEvaluator = evaluatorReturning(success);
    const overshoot = await runMcpScript(
      makeState({ scriptEvaluation: true, maxEvaluationTokensPerScript: 18 }),
      `return [await jev.evaluate(${JSON.stringify(input)}), await jev.evaluate(${JSON.stringify(input)})];`,
      2_000, undefined, undefined, overshootEvaluator,
    );
    const results = JSON.parse(text(overshoot));
    expect(results).toMatchObject([{ ok: false, error: { code: "budget_exhausted" } }, { ok: false, error: { code: "budget_exhausted" } }]);
    expect(JSON.stringify(results)).not.toContain("answers");
    expect(overshootEvaluator).toHaveBeenCalledTimes(1);
  });

  it("charges evaluation responses to the shared 16 MiB transfer budget", async () => {
    const oversized = { ok: true, data: { ...success.data, padding: "x".repeat(16 * 1024 * 1024) } } as unknown as JevEvaluationEnvelope;
    const result = await runMcpScript(makeState(), `const value = await jev.evaluate(${JSON.stringify(input)}); return value.ok ? "unexpected" : value.error.code;`, 4_000, undefined, undefined, evaluatorReturning(oversized));

    expect(text(result)).toBe("budget_exhausted");
    expect(result.details).toMatchObject({ calls: [{ operation: "evaluate", ok: false, error: "budget_exhausted" }] });
  });

  it("returns source policy denial from the A-owned evaluator without provider access", async () => {
    const state = makeState({ scriptEvaluation: true, allowedServers: ["allowed"] });
    const denied = { ...input, sources: ["blocked"] };
    const result = await runMcpScript(state, `return await jev.evaluate(${JSON.stringify(denied)});`);

    expect(JSON.parse(text(result))).toMatchObject({ ok: false, error: { code: "data_policy_denied" } });
    expect(result.details).toMatchObject({ calls: [{ operation: "evaluate", ok: false, error: "data_policy_denied" }] });
  });

  it.each([
    { label: "search", discovery: 'const metadata = await tools.search({ query: "blocked" });' },
    { label: "describe", discovery: 'const metadata = await tools.describe({ path: "blocked_tool" });' },
  ])("denies excluded $label metadata before credential or provider access", async ({ discovery }) => {
    isolateJevEnvironment();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider access was not expected"));
    for (const [label, sources] of [
      ["omitted", undefined],
      ["empty", []],
      ["misleading", ["allowed"]],
    ] as const) {
      resetTestSecureKeyring();
      const evaluation = sources === undefined ? input : { ...input, sources };
      const result = await runMcpScript(
        discoveryState(),
        `${discovery} const evaluation = ${JSON.stringify(evaluation)}; evaluation.state.metadata = metadata; return await jev.evaluate(evaluation);`,
        2_000,
      );

      expect(JSON.parse(text(result)), label).toMatchObject({ ok: false, error: { code: "data_policy_denied" } });
      expect(getTestSecureKeyringReadCount(), label).toBe(0);
      expect(fetchSpy, label).not.toHaveBeenCalled();
    }
  });

  it("evaluates after allowed-only search and describe metadata", async () => {
    const observed: Array<readonly string[] | undefined> = [];
    const evaluator: McpScriptJevEvaluator = vi.fn(async (_state, _value, options) => {
      observed.push(options.observedSources);
      return success;
    });
    const result = await runMcpScript(
      discoveryState(),
      `await tools.search({ query: "allowed" }); await tools.describe({ path: "allowed_tool" }); return await jev.evaluate(${JSON.stringify(input)});`,
      2_000, undefined, undefined, evaluator,
    );

    expect(JSON.parse(text(result))).toEqual(success);
    expect(observed).toEqual([["allowed"]]);
    expect(evaluator).toHaveBeenCalledOnce();
  });

  it("does not taint evaluation for empty or non-returned search pages", async () => {
    const observed: Array<readonly string[] | undefined> = [];
    const evaluator: McpScriptJevEvaluator = vi.fn(async (_state, _value, options) => {
      observed.push(options.observedSources);
      return success;
    });
    const result = await runMcpScript(
      discoveryState(),
      `await tools.search({ query: "does-not-exist" }); await tools.search({ query: "blocked", offset: 1 }); return await jev.evaluate(${JSON.stringify(input)});`,
      2_000, undefined, undefined, evaluator,
    );

    expect(JSON.parse(text(result))).toEqual(success);
    expect(observed).toEqual([undefined]);
  });

  it("keeps metadata taint local to a script", async () => {
    const observed: Array<readonly string[] | undefined> = [];
    const evaluator: McpScriptJevEvaluator = vi.fn(async (_state, _value, options) => {
      observed.push(options.observedSources);
      return success;
    });
    const first = await runMcpScript(
      discoveryState(),
      `await tools.search({ query: "blocked" }); return await jev.evaluate(${JSON.stringify(input)});`,
      2_000, undefined, undefined, evaluator,
    );
    const second = await runMcpScript(
      discoveryState(),
      `return await jev.evaluate(${JSON.stringify(input)});`,
      2_000, undefined, undefined, evaluator,
    );

    expect(JSON.parse(text(first))).toEqual(success);
    expect(JSON.parse(text(second))).toEqual(success);
    expect(observed).toEqual([["blocked"], undefined]);
  });

  it.each([
    { operation: "call", sourceMode: "omitted", discovery: 'const returned = await tools.call("blockedto", {});' },
    { operation: "call", sourceMode: "empty", discovery: 'const returned = await tools.call("blockedto", {});' },
    { operation: "call", sourceMode: "misleading", discovery: 'const returned = await tools.call("blockedto", {});' },
    { operation: "describe", sourceMode: "omitted", discovery: 'const returned = await tools.describe({ path: "blockedto" });' },
    { operation: "describe", sourceMode: "empty", discovery: 'const returned = await tools.describe({ path: "blockedto" });' },
    { operation: "describe", sourceMode: "misleading", discovery: 'const returned = await tools.describe({ path: "blockedto" });' },
  ] as const)(
    "denies excluded $operation suggestion metadata with $sourceMode sources before provider work",
    async ({ discovery, sourceMode }) => {
      isolateJevEnvironment();
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider access was not expected"));
      const evaluation = sourceMode === "omitted"
        ? input
        : { ...input, sources: sourceMode === "empty" ? [] : ["allowed"] };
      const result = await runMcpScript(
        discoveryState(),
        `${discovery} const evaluation = ${JSON.stringify(evaluation)}; evaluation.state.metadata = returned.error; return await jev.evaluate(evaluation);`,
        2_000,
      );

      expect(JSON.parse(text(result))).toMatchObject({ ok: false, error: { code: "data_policy_denied" } });
      expect(getTestSecureKeyringReadCount()).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    { operation: "call", discovery: 'const returned = await tools.call("allowedto", {});' },
    { operation: "describe", discovery: 'const returned = await tools.describe({ path: "allowedto" });' },
  ] as const)("keeps allowed-only $operation suggestions permitted", async ({ discovery, operation }) => {
    const observed: Array<readonly string[] | undefined> = [];
    const forwarded: JevEvaluateInput[] = [];
    const evaluator: McpScriptJevEvaluator = vi.fn(async (_state, value, options) => {
      forwarded.push(value);
      observed.push(options.observedSources);
      return success;
    });
    const result = await runMcpScript(
      discoveryState(),
      `${discovery} const evaluation = ${JSON.stringify(input)}; evaluation.state.metadata = returned.error; return await jev.evaluate(evaluation);`,
      2_000, undefined, undefined, evaluator,
    );

    expect(JSON.parse(text(result))).toEqual(success);
    expect(observed).toEqual([["allowed"]]);
    if (operation === "call") {
      expect(forwarded[0]?.state).toMatchObject({ metadata: { message: expect.stringContaining("allowed_tool") } });
    } else {
      expect(forwarded[0]?.state).toMatchObject({ metadata: { suggestions: ["allowed_tool"] } });
    }
  });

  it.each([
    { operation: "call", discovery: 'const returned = await tools.call("tool", {});' },
    { operation: "describe", discovery: 'const returned = await tools.describe({ path: "tool" });' },
  ] as const)("accounts for all origins in unscoped mixed $operation suggestions", async ({ discovery, operation }) => {
    const observed: Array<readonly string[] | undefined> = [];
    const forwarded: JevEvaluateInput[] = [];
    const evaluator: McpScriptJevEvaluator = vi.fn(async (_state, value, options) => {
      forwarded.push(value);
      observed.push(options.observedSources);
      return success;
    });
    const result = await runMcpScript(
      discoveryState(),
      `${discovery} const evaluation = ${JSON.stringify(input)}; evaluation.state.metadata = returned.error; return await jev.evaluate(evaluation);`,
      2_000, undefined, undefined, evaluator,
    );

    expect(JSON.parse(text(result))).toEqual(success);
    expect(observed).toEqual([["allowed", "blocked"]]);
    if (operation === "call") {
      expect(forwarded[0]?.state).toMatchObject({ metadata: { message: expect.stringContaining("allowed_tool") } });
      expect(forwarded[0]?.state).toMatchObject({ metadata: { message: expect.stringContaining("blocked_tool") } });
    } else {
      expect(forwarded[0]?.state).toMatchObject({ metadata: { suggestions: ["allowed_tool", "blocked_tool"] } });
    }
  });

  it("keeps a scoped duplicate-name suggestion on its selected server", async () => {
    const observed: Array<readonly string[] | undefined> = [];
    const forwarded: JevEvaluateInput[] = [];
    const evaluator: McpScriptJevEvaluator = vi.fn(async (_state, value, options) => {
      forwarded.push(value);
      observed.push(options.observedSources);
      return success;
    });
    const result = await runMcpScript(
      duplicateDiscoveryState(),
      `const returned = await tools.describe({ path: "sharedtoop", server: "allowed" }); const evaluation = ${JSON.stringify(input)}; evaluation.state.metadata = returned.error; return await jev.evaluate(evaluation);`,
      2_000, undefined, undefined, evaluator,
    );

    expect(JSON.parse(text(result))).toEqual(success);
    expect(observed).toEqual([["allowed"]]);
    expect(forwarded[0]?.state).toMatchObject({ metadata: { suggestions: ["shared_tool"] } });
  });

  it.each([
    { mode: "disabled", operation: "call", discovery: 'const returned = await tools.call("sharedtoop", {});' },
    { mode: "disabled", operation: "describe", discovery: 'const returned = await tools.describe({ path: "sharedtoop" });' },
    { mode: "backoff", operation: "call", discovery: 'const returned = await tools.call("sharedtoop", {});' },
    { mode: "backoff", operation: "describe", discovery: 'const returned = await tools.describe({ path: "sharedtoop" });' },
  ] as const)("does not taint an eligible $operation suggestion with a $mode collision", async ({ mode, operation, discovery }) => {
    const observed: Array<readonly string[] | undefined> = [];
    const forwarded: JevEvaluateInput[] = [];
    const evaluator: McpScriptJevEvaluator = vi.fn(async (_state, value, options) => {
      forwarded.push(value);
      observed.push(options.observedSources);
      return success;
    });
    const result = await runMcpScript(
      excludedSuggestionState(mode),
      `${discovery} const evaluation = ${JSON.stringify(input)}; evaluation.state.metadata = returned.error; return await jev.evaluate(evaluation);`,
      2_000, undefined, undefined, evaluator,
    );

    expect(JSON.parse(text(result))).toEqual(success);
    expect(observed).toEqual([["allowed"]]);
    if (operation === "call") {
      expect(forwarded[0]?.state).toMatchObject({ metadata: { message: expect.stringContaining("shared_tool") } });
    } else {
      expect(forwarded[0]?.state).toMatchObject({ metadata: { suggestions: ["shared_tool"] } });
    }
  });

  it("keeps a scoped duplicate-name call on its selected server", async () => {
    const observed: Array<readonly string[] | undefined> = [];
    const forwarded: JevEvaluateInput[] = [];
    const evaluator: McpScriptJevEvaluator = vi.fn(async (_state, value, options) => {
      forwarded.push(value);
      observed.push(options.observedSources);
      return success;
    });
    const result = await runMcpScript(
      scopedCallDiscoveryState(),
      `const returned = await tools.call("sharedtoop", {}, { server: "allowed" }); const evaluation = ${JSON.stringify(input)}; evaluation.state.metadata = returned.error; return await jev.evaluate(evaluation);`,
      2_000, undefined, undefined, evaluator,
    );

    expect(JSON.parse(text(result))).toEqual(success);
    expect(observed).toEqual([["allowed"]]);
    expect(forwarded[0]?.state).toMatchObject({ metadata: { message: expect.stringContaining("shared_tool") } });
  });

  it("does not derive sources from errors without suggestions", async () => {
    const observed: Array<readonly string[] | undefined> = [];
    const evaluator: McpScriptJevEvaluator = vi.fn(async (_state, _value, options) => {
      observed.push(options.observedSources);
      return success;
    });
    const result = await runMcpScript(
      discoveryState(),
      `const call = await tools.call("no_such_tool", {}); const describe = await tools.describe({ path: "no_such_tool" }); const evaluation = ${JSON.stringify(input)}; evaluation.state.metadata = { call, describe }; return await jev.evaluate(evaluation);`,
      2_000, undefined, undefined, evaluator,
    );

    expect(JSON.parse(text(result))).toEqual(success);
    expect(observed).toEqual([undefined]);
  });

  it.each(["authentication_failed", "timeout", "invalid_response"] as const)(
    "forwards actionable %s failures without secret trace data",
    async code => {
      const evaluator = evaluatorReturning({ ok: false, error: { code, message: `actionable ${code}`, retryable: code === "timeout" } });
      const result = await runMcpScript(makeState(), `return await jev.evaluate(${JSON.stringify(input)});`, 2_000, undefined, undefined, evaluator);

      expect(JSON.parse(text(result))).toMatchObject({ ok: false, error: { code, message: `actionable ${code}` } });
      expect(result.details).toMatchObject({ calls: [{ operation: "evaluate", ok: false, error: code, durationMs: expect.any(Number) }] });
      expect(JSON.stringify(result.details)).not.toContain("redacted-state");
    },
  );

  it("aborts pending evaluation on timeout and records a nonsecret incomplete trace", async () => {
    // The deadline also covers worker startup, so it only fires once the evaluation is in flight.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let evaluationStarted!: () => void;
      const evaluating = new Promise<void>(resolve => { evaluationStarted = resolve; });
      const evaluator: McpScriptJevEvaluator = vi.fn((_state, _value, options) => new Promise(resolve => {
        options.signal?.addEventListener("abort", () => resolve({ ok: false, error: { code: "aborted", message: "aborted" } }), { once: true });
        evaluationStarted();
      }));
      const run = runMcpScript(makeState(), `await jev.evaluate(${JSON.stringify(input)});`, 150, undefined, undefined, evaluator);
      await Promise.race([evaluating, run]);
      await vi.advanceTimersByTimeAsync(150);
      const result = await run;

      expect(result.details).toMatchObject({ error: "timeout", calls: [{ operation: "evaluate", ok: false, error: "incomplete" }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts unawaited evaluation on early return and owner shutdown", async () => {
    const signals: AbortSignal[] = [];
    const evaluator: McpScriptJevEvaluator = vi.fn((_state, _value, options) => {
      signals.push(options.signal!);
      return new Promise(resolve => options.signal?.addEventListener("abort", () => resolve({ ok: false, error: { code: "aborted", message: "aborted" } }), { once: true }));
    });
    const earlyState = makeState();
    const early = await runMcpScript(earlyState, `jev.evaluate(${JSON.stringify(input)}); return "done";`, 2_000, undefined, undefined, evaluator);
    expect(text(early)).toBe("done");
    expect(early.details).toMatchObject({ calls: [{ operation: "evaluate", ok: false, error: "incomplete" }] });
    expect(signals[0]?.aborted).toBe(true);

    const ownerState = makeState();
    const pending = runMcpScript(ownerState, `await jev.evaluate(${JSON.stringify(input)});`, 2_000, undefined, undefined, evaluator);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    await ownerState.owner.stop("shutdown");
    const stopped = await pending;
    expect(stopped.details).toMatchObject({ error: "aborted", calls: [{ operation: "evaluate", ok: false, error: "incomplete" }] });
    expect(text(stopped)).toContain("shutdown");
  });
});
