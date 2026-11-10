import { basename } from "node:path";
import type { ServerEntry } from "./types.ts";

/**
 * Whether a server definition launches Xcode's MCP bridge (`xcrun [options] mcpbridge`, or a command
 * named `mcpbridge`). Matched if `mcpbridge` appears anywhere in the args.
 */
function launchesXcodeMcpBridge(definition: Pick<ServerEntry, "command" | "args">): boolean {
  if (typeof definition.command !== "string") return false;
  const command = basename(definition.command.replace(/\\/g, "/"));
  if (command === "mcpbridge") return true;
  return command === "xcrun" && Array.isArray(definition.args) && definition.args.includes("mcpbridge");
}

/**
 * Default idle timeout (minutes) for a server definition, or undefined for no special default.
 *
 * Xcode's MCP bridge makes Xcode ask "Allow <agent> to access Xcode?" for every new
 * connection from an agent without a stable developer signature, so closing an idle bridge re-prompts on
 * the next use. Keep it connected once started. Applied at lifecycle registration only; it is never stored
 * in the definition, so config/approval/cache hashes are unchanged.
 */
export function defaultIdleTimeoutFor(definition: Pick<ServerEntry, "command" | "args">): number | undefined {
  return launchesXcodeMcpBridge(definition) ? 0 : undefined;
}

/**
 * Whether a server must not connect until its first use.
 *
 * Xcode also prompts for approval on every new bridge connection, so probing the bridge during startup
 * (startup discovery, direct-tool cache bootstrap) prompts even in sessions that never use Xcode.
 * Xcode bridge servers therefore connect only on first use unless the user explicitly asked for a
 * startup connection with `lifecycle: "eager"` or `"keep-alive"`. `lazy-keep-alive` keeps the
 * connect-on-first-use contract and only becomes resident after that first connection.
 */
export function connectsOnFirstUseOnly(
  definition: Pick<ServerEntry, "command" | "args" | "lifecycle">,
): boolean {
  const lifecycle = definition.lifecycle ?? "lazy";
  if (lifecycle === "eager" || lifecycle === "keep-alive") return false;
  return launchesXcodeMcpBridge(definition);
}
