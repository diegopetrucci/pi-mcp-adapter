# Prompts, elicitation, and MCP UI

Features that go beyond tool calls: server prompt templates, servers asking the user for input, and interactive MCP UI windows.

## MCP Prompts

MCP servers can advertise prompt templates alongside tools and resources. The adapter registers cached prompt definitions as Pi slash commands under `/mcp__<server>__<prompt>`, and refreshes their metadata whenever a server connects. Arguments support positional and `key=value` forms with quoting; required arguments are validated before `prompts/get` is called.

```text
/mcp__agent_board__create_plan "harden retry policy"
/mcp__agent_board__review_pipeline status=paused
/mcp-adapter prompts
```

Prompt results are flattened into one user message, preserving `[user]` and `[assistant]` role markers for multi-message results. Servers without the `prompts` capability are not probed.

## MCP Elicitation

When Pi exposes dialog-capable UI, the adapter advertises form elicitation support. Forms use Pi's stock `select()` and `input()` dialogs, validate the response, and provide a review/edit step before submission. Empty forms use one confirmation dialog. Explicit refusal maps to MCP `decline`; dismissing a dialog maps to `cancel`.

URL mode is advertised only in TUI mode. The adapter displays the requesting server, target host, and full URL, and always requires consent before opening the browser. It also handles URL-required tool errors (`-32042`) and completion notifications; after completing the browser interaction, retry the original tool call.

Time spent answering a server's prompt does not count against its tool calls' `requestTimeoutMs` (or the SDK's 60-second default). The timeout pauses while a prompt from that server is open and resumes with the time that was left. Task-backed calls are unchanged: their timeout applies to each task request, not to the whole task.

## MCP UI Integration

MCP servers can ship interactive UIs via the [MCP UI](https://github.com/MCP-UI-Org/mcp-ui) standard. When you call a tool that has a UI resource and UI is enabled, the adapter opens it in a native macOS window via [Glimpse](https://github.com/hazat/glimpse) if available, otherwise falls back to the browser.

**Off by default.** The adapter does not advertise the `io.modelcontextprotocol/ui` client capability and never starts a UI session, opens a browser or native window, or posts a notification unless you opt in by setting `MCP_UI_VIEWER`. This matches terminal hosts such as Claude Code and Codex CLI, which do not render MCP Apps. The capability is optional in the spec, and servers must keep a text fallback, so a tool with a `ui://` resource behaves exactly like an ordinary tool by default: its result has the same shape, with no UI fields on the details.

Opt in with one of these `MCP_UI_VIEWER` values (case-insensitive):

| Value | Behaviour |
|-------|-----------|
| `auto` | The earlier default: a Glimpse window on macOS when Glimpse is installed, otherwise the system browser |
| `browser` | The system browser |
| `glimpse` | The Glimpse native WKWebView window (macOS; requires `pi install npm:glimpseui`) |
| `orca` | The [Orca](https://github.com/orca) built-in browser, falling back to the system browser if Orca is unavailable |

Leaving `MCP_UI_VIEWER` unset — or setting it to `none`, `off`, `disabled`, or any other value — keeps MCP Apps UI off. Remote (SSH) sessions get the remote-access hint whenever UI is enabled.

**How it works:**

1. Agent calls a tool like `launch_dashboard`
2. The tool's metadata includes `_meta.ui.resourceUri` pointing to a UI resource
3. pi-mcp-adapter fetches the UI HTML and opens it in an iframe
4. The UI can call MCP tools and send messages back to the agent

**Viewer selection (opt-in only):** `MCP_UI_VIEWER=auto` keeps the previous resolution — Glimpse on macOS when installed (`pi install npm:glimpseui`), otherwise the browser. `browser`, `glimpse`, and `orca` force one viewer. In remote sessions the adapter skips Glimpse and prints an SSH port-forward hint instead. With UI off, none of this runs: no capability is advertised, no UI server starts, and no window or notification appears.

**Bidirectional communication:** The UI talks back. When it sends a prompt or intent, the message is stored and `triggerTurn()` wakes the agent. The agent retrieves messages via `mcp({ action: "ui-messages" })` and responds, enabling conversational UIs where the app and agent collaborate in real-time.

**Session reuse:** When the agent calls the same tool again while its UI is already open, the adapter pushes the new result to the existing window instead of replacing it. This enables live updates — the agent can refine a chart, add data, or respond to user input without losing the current view. Different tools still replace the session as before.

**Message types from UI:**

| Type | Purpose |
|------|---------|
| `prompt` | User message that triggers an agent response |
| `intent` | Structured action with name + params |
| `notify` | Fire-and-forget notification |
| `message` | Generic message payload |
| (custom) | Any other type forwarded as intent |

**Retrieving UI messages:**

```
mcp({ action: "ui-messages" })
```

Returns accumulated messages from UI sessions. Each message includes `type`, `sessionId`, `serverName`, `toolName`, and `timestamp`. Prompt messages include `prompt`, intent messages include `intent` and `params`.

**Browser controls:**

- **Cmd/Ctrl+Enter** — Complete and close
- **Escape** — Cancel and close
- **Done/Cancel buttons** — Same as keyboard shortcuts

**Technical notes:**

- Tool consent gates whether UIs can call MCP tools (never/once-per-server/always)
- `_meta.ui.visibility` controls audience: tools marked app-only stay out of the model tool list, and tools marked model-only cannot be called from the UI iframe.
- Works with both stdio and HTTP MCP servers
- Uses a local 408KB AppBridge bundle (MCP SDK + Zod) for browser↔server communication
- Enforces CSP from standard `_meta.ui.csp` and OpenAI-compatible `_meta["openai/widgetCSP"]` metadata in the response header while preserving provider HTML.

## Local Example: Interactive Visualizer

A minimal MCP UI example at `examples/interactive-visualizer` demonstrating charts, bidirectional messaging, and streaming. From that directory:

```bash
npm install
npm run build
npm run install-local
```

Restart pi, then set `MCP_UI_VIEWER=auto` (or `browser`/`glimpse`/`orca`) and ask the agent to show a chart — it calls `show_chart` and opens the UI in Glimpse (macOS) or the browser. MCP Apps UI is off by default, so nothing opens without that opt-in. Use `npm run uninstall-local` to remove the MCP entry.
