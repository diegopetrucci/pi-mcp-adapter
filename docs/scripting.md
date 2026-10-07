# MCP scripting

The opt-in `mcpScript` tool supports composable lexical search and multi-call MCP workflows.

For multi-call MCP work, write ordinary JavaScript: discover, inspect, call, loop, filter, chain, or fan out, then return one result. Run that code with the `mcpScript` tool, which is off by default; set `settings.scriptMode` to `true` to register it and its bundled skill. For a single MCP call, search, describe, status check, or auth action, use `mcp` instead.

## Jev semantic search and evaluation

Semantic search is explicit while lexical search remains the default. When a matching credential is available, an explicit `mcp({ searchMode: "semantic" })` request can use Jev; `settings.jev.semanticSearch: true` also enables it, while `settings.jev.semanticSearch: false` or `settings.jev: false` opts out. Without an explicit `allowedServers` list, all enabled eligible servers are considered; an explicit list restricts the request. The compact candidate catalog is sent to the configured Jev provider, not tool results, and ranked tools are returned without execution. The normal trust, approval, cancellation, and result-budget boundaries still apply.

Jev evaluation is also opt-in. Script evaluation remains disabled until `settings.jev.scriptEvaluation` is explicitly enabled, and it uses the same configured server allowlist. Keep provider credentials in the adapter's credential store or supported environment configuration; do not put keys in scripts or tool arguments. The default provider endpoint is `https://api.typesafe.ai`.

TypeSafe's provider privacy and retention terms are documented at `https://docs.typesafe.ai/legal` and include a no-training commitment; that no-training commitment does not mean zero retention. Stdio MCP subprocesses inherit the host environment, so a key present in the adapter process environment can propagate to an MCP child. The isolated script worker itself runs with an empty environment (`env: {}`) and does not receive provider keys or endpoints.

The bundled `mcp-scripting` skill is manual-only: use `/skill:mcp-scripting`, or set `settings.scriptSkill` to `"model"` so the `mcpScript` description tells the model where to read it.

For example, this is the JavaScript passed as the `code` argument to `mcpScript`:

```js
const { items } = await tools.search({ query: "search issues", server: "github" });
const candidate = items[0];
if (!candidate) return { error: "No matching tool" };

const details = await tools.describe({ path: candidate.path });
if (details.error) return details;

const result = await tools.call(details.path, { query: "is:open label:bug" });
if (!result.ok) return result;
emit({ tool: details.path, completed: true });
return result.data;
```

For tool calls, successful `result.data` is the raw MCP `CallToolResult`, not the domain payload; resource reads return text. Use `result.data.structuredContent` when present. Otherwise most JSON APIs return their payload as text, so parse `result.data.content[0].text`. If neither shape is understood, return the envelope for inspection instead of coercing it to an empty collection.

## Composable tool search

Use JavaScript to filter, sort, or combine search results before describing or calling tools. This adds no model context until a script runs.

```js
const found = await tools.search({ query: "issue", server: "github", limit: 50 });
if (found.error) return found.error;

const readOnly = [];
for (const hit of found.items) {
  const details = await tools.describe({ path: hit.path, server: hit.server });
  if (details.annotations?.readOnlyHint) readOnly.push(hit.path);
}
return readOnly;
```

- `tools.search` runs the same lexical search as `mcp({ search })`; set `regex: true` for a pattern. An empty `query` with a `server` lists that server's tools. Results come one page at a time (`limit` defaults to 12); follow `nextOffset` for the rest.
- Every hit carries its `server`. Pass it on with `tools.describe({ path, server })` and `tools.call(path, args, { server })`, so the script reaches the tool it found even when two servers expose the same name, as with `toolPrefix: "none"`.
- A search that cannot run returns `items: []` with `error: { code, message }`, using the same codes as `mcp({ search })`, such as `empty_query`, `server_disabled`, `server_backoff`, and `invalid_pattern`.
- Annotations are the server's own hints, not guarantees. Script searches never activate `directTools: "search"` tools, and every call still goes through the normal approval gate.

See the bundled `mcp-scripting` skill for the complete workflow guide. The API is `await tools.search({ query, server?, regex?, limit?, offset? })`, `await tools.describe({ path, server? })`, `tools.call(path, args, { server }?)`, direct flat calls, `emit(value)`, and a captured `console`. Use ordinary JavaScript loops and Promise utilities for composition; fluent helpers such as `tools.find(...).one()`, `tools.parallel(...)`, and `tools.retry(...)` are not provided. MCP calls return `{ ok: true, data }` or `{ ok: false, error: { code, message } }`, so a failed call does not stop the rest of the script. Result details include a concise `calls` trace with each operation, its path or query, outcome, and duration. Emitted values and console output appear before the script's final return value, and the combined result uses the normal MCP output guard. The default timeout is 30 seconds; each script runs in a worker thread that is terminated at the deadline, including for infinite loops.

Successful intermediate results reach the script without presentation truncation, details summaries, or output-guard spill files. Each script has a fixed **16 MiB cumulative UTF-8 JSON transfer budget** for successful intermediate data, shared by sequential and parallel calls. A result that cannot fit returns `{ ok: false, error: { code: "intermediate_result_too_large", message } }` and a failed call trace; rejected bytes do not consume the budget, and the script can continue. Request less data or start a new script; there is no configuration option for this cap. Resource calls retain their text-result semantics. Only script-selected output (`emit`, captured console, and `return`) reaches the final output guard; ordinary MCP calls remain guarded as before.

The upstream tool executes before this check and may already have side effects. This is a transfer budget, not a total-memory limit: SDK responses, JSON serialization (including rejected results), copies, concurrent responses, and script-created values still allocate memory. Synchronous serialization can delay deadline handling.

For a tool-restricted subagent, launch the child Pi with its tool allowlist set to `["mcpScript"]`. Have the parent discover MCP tool names with `mcp({ search: "..." })` and include the relevant prefixed names in the child's task; the child can then loop, filter, and chain those MCP calls without filesystem, shell, or edit tools. The adapter's ordinary lazy connection, authentication, abort handling, and approval gates still apply to every call.

`mcpScript` runs in an isolated QuickJS/WASM VM with a 64 MiB memory cap, a 16 MiB serialized output-block budget, and no Node.js, filesystem, network, timer, or process globals. Script error messages are capped at 64 KiB. MCP tool calls can still have external side effects and remain subject to the adapter's normal approval gates. It is distinct from Pi's code-mode skill: Pi's skill batches general Pi tools, while `mcpScript` exposes MCP calls only and can be the child's sole tool.
