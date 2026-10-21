/** Minimum supported releases containing the October 2026 Node security fixes. */
export function assertSupportedNodeRuntime(version = process.versions.node): void {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const minimums: Record<number, [number, number]> = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
  if (match) {
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    const minimum = minimums[major];
    if (minimum && (minor > minimum[0] || (minor === minimum[0] && patch >= minimum[1]))) return;
  }
  throw new UnsupportedNodeRuntimeError(
    `MCP HTTP requires Node.js ^22.23.4, ^24.22.1, or ^26.12.1; running ${version}. ` +
    "Upgrade the hosting Node runtime and restart it to apply the October 2026 security fixes " +
    "(including native Brotli and eMudhra CA remediation). Updating npm dependencies is insufficient.",
  );
}

export class UnsupportedNodeRuntimeError extends Error {
  override name = "UnsupportedNodeRuntimeError";
}
