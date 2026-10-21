/** Minimum supported releases containing the October 2026 Node security fixes. */
export declare function assertSupportedNodeRuntime(version?: string): void;
export declare class UnsupportedNodeRuntimeError extends Error {
    name: string;
}
