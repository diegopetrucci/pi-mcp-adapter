import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadMcpConfig } from "./config.ts";
import { toolErrorOverride } from "./error-signal.ts";
import { loadMetadataCache } from "./metadata-cache.ts";
import type { McpRuntime } from "./mcp-runtime.ts";
import {
  buildProxyDescription,
  createMcpDirectToolCallRenderer,
  getDirectToolParametersSchema,
  getMissingConfiguredDirectToolServers,
  MCP_PROXY_TOOL_PARAMETERS_SCHEMA,
  renderMcpProxyToolCall,
  renderMcpToolResult,
  resolveDirectTools,
} from "./startup-mcp-facade.ts";
import { getConfigPathFromArgv, truncateAtWord } from "./utils.ts";

function shouldInitializeRuntimeOnSessionStart(
  config: ReturnType<typeof loadMcpConfig>,
  missingConfiguredDirectToolServers: string[],
  directToolBootstrapDisabled: boolean,
): boolean {
  if (!directToolBootstrapDisabled && missingConfiguredDirectToolServers.length > 0) return true;

  return Object.values(config.mcpServers).some(server => (
    server.lifecycle === "eager" || server.lifecycle === "keep-alive"
  ));
}

export default function mcpAdapter(pi: ExtensionAPI) {
  const earlyConfigPath = getConfigPathFromArgv();
  const earlyConfig = loadMcpConfig(earlyConfigPath);
  const earlyCache = loadMetadataCache();
  const prefix = earlyConfig.settings?.toolPrefix ?? "server";

  const envRaw = process.env.MCP_DIRECT_TOOLS;
  const directToolBootstrapDisabled = envRaw === "__none__";
  const directSpecs = directToolBootstrapDisabled
    ? []
    : resolveDirectTools(
        earlyConfig,
        earlyCache,
        prefix,
        envRaw?.split(",").map(s => s.trim()).filter(Boolean),
      );
  const missingConfiguredDirectToolServers = getMissingConfiguredDirectToolServers(earlyConfig, earlyCache);
  const shouldRegisterProxyTool =
    earlyConfig.settings?.disableProxyTool !== true
    || directSpecs.length === 0
    || missingConfiguredDirectToolServers.length > 0;

  let runtimePromise: Promise<McpRuntime> | null = null;
  let latestSessionStart: { event: unknown; ctx: ExtensionContext; generation: number } | null = null;
  let nextSessionGeneration = 0;
  let startedGeneration = 0;
  let startupGeneration = 0;
  let startupPromise: Promise<void> | null = null;

  const loadRuntime = () => {
    if (!runtimePromise) {
      runtimePromise = import("./mcp-runtime.ts").then(({ createMcpRuntime }) => (
        createMcpRuntime(pi, { earlyConfigPath })
      ));
    }
    return runtimePromise;
  };

  const ensureRuntimeStarted = async (session = latestSessionStart) => {
    const runtime = await loadRuntime();
    if (!session) return runtime;
    if (startedGeneration >= session.generation) return runtime;

    if (startupPromise && startupGeneration === session.generation) {
      await startupPromise;
      return runtime;
    }

    startupGeneration = session.generation;
    const currentStartupPromise = runtime.handleSessionStart(session.event, session.ctx)
      .then(() => {
        if (latestSessionStart?.generation === session.generation) {
          startedGeneration = session.generation;
        }
      })
      .finally(() => {
        if (startupPromise === currentStartupPromise) {
          startupPromise = null;
        }
      });
    startupPromise = currentStartupPromise;
    await currentStartupPromise;
    return runtime;
  };

  for (const spec of directSpecs) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: spec.prefixedName,
      label: `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
      parameters: getDirectToolParametersSchema(spec),
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        const runtime = await ensureRuntimeStarted();
        return runtime.executeDirectTool(spec, toolCallId, params, signal, onUpdate, ctx);
      },
      renderCall: createMcpDirectToolCallRenderer(spec.prefixedName),
      renderResult: renderMcpToolResult,
    });
  }

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  pi.on("session_start", async (event, ctx) => {
    latestSessionStart = {
      event,
      ctx,
      generation: ++nextSessionGeneration,
    };

    const sessionConfig = loadMcpConfig(earlyConfigPath, ctx.cwd);
    const sessionCache = loadMetadataCache();
    const sessionMissingConfiguredDirectToolServers = getMissingConfiguredDirectToolServers(
      sessionConfig,
      sessionCache,
    );
    const shouldInitialize = shouldInitializeRuntimeOnSessionStart(
      sessionConfig,
      sessionMissingConfiguredDirectToolServers,
      directToolBootstrapDisabled,
    );
    const hasActiveOrInflightRuntimeStart = startedGeneration > 0 || startupPromise !== null;

    if (!shouldInitialize && !hasActiveOrInflightRuntimeStart) {
      return;
    }

    await ensureRuntimeStarted(latestSessionStart);
  });

  pi.on("session_shutdown", async () => {
    latestSessionStart = null;
    startupPromise = null;
    startupGeneration = 0;
    startedGeneration = 0;

    if (!runtimePromise) {
      return;
    }

    const runtime = await runtimePromise;
    await runtime.handleSessionShutdown();
  });

  pi.on("tool_result", (event) => toolErrorOverride(event.details));

  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args, ctx) => {
      const runtime = await ensureRuntimeStarted();
      await runtime.handleMcpCommand(args, ctx);
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const serverName = args?.trim();
      if (!serverName && !ctx.hasUI) return;

      const runtime = await ensureRuntimeStarted();
      await runtime.handleMcpAuthCommand(args, ctx);
    },
  });

  if (shouldRegisterProxyTool) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: "mcp",
      label: "MCP",
      description: buildProxyDescription(earlyConfig, earlyCache, directSpecs),
      promptSnippet: "MCP gateway - connect to MCP servers and call their tools",
      renderCall: renderMcpProxyToolCall,
      parameters: MCP_PROXY_TOOL_PARAMETERS_SCHEMA,
      renderResult: renderMcpToolResult,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const runtime = await ensureRuntimeStarted();
        return runtime.executeProxyTool(toolCallId, params, signal, onUpdate, ctx);
      },
    });
  }
}
