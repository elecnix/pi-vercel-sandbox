/**
 * Native tool detection and command building for Vercel Sandbox.
 *
 * The sandbox runs Amazon Linux 2023 with sudo access, so native tools
 * like ripgrep (rg) and GNU find can be installed via dnf. Once installed,
 * they persist across sandbox stop/resume cycles (snapshotted filesystem).
 *
 * This module provides:
 * - Detection of available native tools in the sandbox (rg, find)
 * - Command builders that use native tools when available
 * - Fallback to JS-based operations when native tools are missing
 */

import type { Sandbox } from "@vercel/sandbox";
import path from "node:path";

/** Cached availability of native tools in the sandbox */
export interface NativeToolAvailability {
	/** Whether ripgrep (rg) is available */ rg: boolean;
	/** Whether GNU find with -name/-path support is available */ find: boolean;
}

const UNCHECKED: unique symbol = Symbol("unchecked");

/**
 * Lazy checker for native tool availability in the sandbox.
 * Caches results after first check to avoid repeated probes.
 */
export class NativeToolDetector {
	private rgResult: boolean | typeof UNCHECKED = UNCHECKED;
	private findResult: boolean | typeof UNCHECKED = UNCHECKED;
	private sandbox: Sandbox;

	constructor(sandbox: Sandbox) {
		this.sandbox = sandbox;
	}

	/**
	 * Check if ripgrep (rg) is available in the sandbox.
	 */
	async hasRg(): Promise<boolean> {
		if (this.rgResult !== UNCHECKED) return this.rgResult;
		try {
			const result = await this.sandbox.runCommand({
				cmd: "bash",
				args: ["-lc", "command -v rg >/dev/null 2>&1 && echo yes || echo no"],
			});
			const output = await result.stdout();
			this.rgResult = output.trim() === "yes";
		} catch {
			this.rgResult = false;
		}
		return this.rgResult;
	}

	/**
	 * Check if GNU find is available in the sandbox.
	 */
	async hasFind(): Promise<boolean> {
		if (this.findResult !== UNCHECKED) return this.findResult;
		try {
			const result = await this.sandbox.runCommand({
				cmd: "bash",
				args: ["-lc", "command -v find >/dev/null 2>&1 && echo yes || echo no"],
			});
			const output = await result.stdout();
			this.findResult = output.trim() === "yes";
		} catch {
			this.findResult = false;
		}
		return this.findResult;
	}

	/**
	 * Get full availability info.
	 */
	async getAvailability(): Promise<NativeToolAvailability> {
		const [rg, find] = await Promise.all([this.hasRg(), this.hasFind()]);
		return { rg, find };
	}

	/**
	 * Reset cached results (useful after installing tools).
	 */
	reset(): void {
		this.rgResult = UNCHECKED;
		this.findResult = UNCHECKED;
	}
}

/**
 * Build the dnf install command for native tools.
 * Returns the shell command string, or undefined if nothing to install.
 */
export function buildInstallCommand(): string | undefined {
	// Amazon Linux 2023 packages
	const packages = ["ripgrep"];
	if (packages.length === 0) return undefined;
	return `sudo dnf install -y ${packages.join(" ")}`;
}

/**
 * Build a ripgrep command line for the given grep parameters.
 * Returns the command parts or null if rg is not available / params not supported.
 */
export function buildRgCommand(
	params: {
		pattern: string;
		path?: string;
		literal?: boolean;
		ignoreCase?: boolean;
		context?: number;
		glob?: string;
		limit?: number;
	},
	sandboxWorkspace: string,
): { cmd: string; args: string[] } | null {
	const args: string[] = [];

	// Line number flag (always on for Pi grep output format)
	args.push("--line-number");

	// Case sensitivity
	if (!params.ignoreCase) {
		// rg is case-sensitive by default; add -i for ignoreCase
	} else {
		args.push("-i");
	}

	// Literal matching
	if (params.literal) {
		args.push("--fixed-strings");
	}

	// Context lines
	if (params.context && params.context > 0) {
		args.push("-C", String(params.context));
	}

	// Glob filter
	if (params.glob) {
		args.push("--glob", params.glob);
	}

	// Skip .git and node_modules (consistent with JS walker)
	args.push("--glob", "!.git");
	args.push("--glob", "!node_modules");

	// Max matches (rg uses --max-count for per-file, we want total)
	// rg doesn't have a global match limit, but we can use --max-count per file
	// and let the output truncation handle the rest.
	// For now, don't set --max-count to avoid missing cross-file context.

	// Pattern
	args.push("--", params.pattern);

	// Search path (rg searches recursively by default)
	const searchPath = params.path
		? (params.path.startsWith("/") ? params.path : path.posix.resolve(sandboxWorkspace, params.path))
		: sandboxWorkspace;
	args.push(searchPath);

	return { cmd: "rg", args };
}

/**
 * Build a find command line for the given find parameters.
 * Returns the command parts or null if find is not available / params not supported.
 */
export function buildFindCommand(
	pattern: string,
	cwd: string,
	options: { limit: number },
	sandboxWorkspace: string,
): { cmd: string; args: string[] } | null {
	const searchDir = cwd.startsWith("/") ? cwd : path.posix.resolve(sandboxWorkspace, cwd);

	// Use find with -name for simple glob patterns
	// For complex patterns with **/ we still need JS-based walking
	// because GNU find doesn't support ** globbing the same way.
	// Only use native find for simple patterns (no **/ in the middle).
	if (pattern.includes("**")) {
		// Complex glob — fall back to JS-based walking
		return null;
	}

	const args: string[] = [searchDir, "-name", pattern, "-not", "-path", "*/.git/*", "-not", "-path", "*/node_modules/*"];

	if (options.limit && options.limit > 0) {
		// find doesn't have a -limit flag; we'll truncate in the caller
	}

	return { cmd: "find", args };
}