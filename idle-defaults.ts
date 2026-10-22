import { basename } from "node:path";
import type { ServerEntry } from "./types.ts";

/**
 * Default idle timeout (minutes) for a server definition, or undefined for no special default.
 *
 * Xcode's MCP bridge (`xcrun [options] mcpbridge`; matched if `mcpbridge` appears anywhere in args) makes Xcode ask "Allow <agent> to access Xcode?" for every new
 * connection from an agent without a stable developer signature, so closing an idle bridge re-prompts on
 * the next use. Keep it connected once started. Applied at lifecycle registration only; it is never stored
 * in the definition, so config/approval/cache hashes are unchanged.
 */
export function defaultIdleTimeoutFor(definition: Pick<ServerEntry, "command" | "args">): number | undefined {
  if (typeof definition.command !== "string") return undefined;
  const command = basename(definition.command.replace(/\\/g, "/"));
  if (command === "mcpbridge") return 0;
  if (command === "xcrun" && Array.isArray(definition.args) && definition.args.includes("mcpbridge")) return 0;
  return undefined;
}
