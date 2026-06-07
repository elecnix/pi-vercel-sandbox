/**
 * Path mapping between host paths and Vercel Sandbox paths.
 *
 * The Vercel Sandbox workspace is at /vercel/sandbox.
 * All Pi tool operations work relative to the sandbox workspace.
 * The LLM is told it's working inside /vercel/sandbox.
 */

import path from "node:path";

/** Default sandbox workspace directory */
export const SANDBOX_WORKSPACE = "/vercel/sandbox";

/**
 * Strip leading @ prefix that some models add to paths.
 */
export function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

/**
 * Convert a host-style path to a POSIX path (replace backslashes).
 */
export function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

/**
 * Map a path as the LLM would provide it to the absolute sandbox path.
 *
 * The LLM sees paths relative to /vercel/sandbox (the sandbox cwd).
 * - Relative paths → resolve against SANDBOX_WORKSPACE
 * - Absolute paths starting with SANDBOX_WORKSPACE → keep as-is
 * - Other absolute paths → keep as-is (e.g., /tmp, /usr)
 */
export function toSandboxPath(inputPath: string): string {
	const trimmed = stripAtPrefix(inputPath.trim());
	if (!trimmed) return SANDBOX_WORKSPACE;

	// Already a sandbox-absolute path
	if (trimmed.startsWith(SANDBOX_WORKSPACE + "/") || trimmed === SANDBOX_WORKSPACE) {
		return path.posix.resolve(trimmed);
	}

	// Absolute but outside sandbox workspace — keep as-is (e.g., /tmp, /etc)
	if (path.posix.isAbsolute(trimmed)) {
		return path.posix.resolve(trimmed);
	}

	// Relative path — resolve against sandbox workspace
	return path.posix.resolve(SANDBOX_WORKSPACE, toPosix(trimmed));
}

/**
 * Convert a sandbox path to a display path for the LLM.
 *
 * Paths under /vercel/sandbox are shown relative to /vercel/sandbox.
 * Other paths are shown as-is.
 */
export function toDisplayPath(sandboxPath: string): string {
	if (sandboxPath === SANDBOX_WORKSPACE) return SANDBOX_WORKSPACE;
	if (sandboxPath.startsWith(SANDBOX_WORKSPACE + "/")) {
		return sandboxPath;
	}
	return sandboxPath;
}