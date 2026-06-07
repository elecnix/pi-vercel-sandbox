/**
 * Vercel Sandbox operations for Pi built-in tool routing.
 *
 * Implements the Operations interfaces that Pi's createXTool() factory
 * functions accept, delegating each operation to the Vercel Sandbox SDK.
 *
 * When native tools (ripgrep, find) are available in the sandbox,
 * grep and find operations use them for significantly better performance
 * on large codebases. Native tools are installed on first sandbox creation
 * (configurable via installNativeTools in .pi/vercel-sandbox.json).
 */

import type { Sandbox } from "@vercel/sandbox";
import type {
	BashOperations,
	EditOperations,
	FindOperations,
	GrepToolDetails,
	GrepToolInput,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import { SANDBOX_WORKSPACE, toSandboxPath } from "./paths.js";
import { NativeToolDetector, buildRgCommand, buildFindCommand } from "./native-tools.js";
import path from "node:path";

// ─── Read ───────────────────────────────────────────────────────────

export function createSandboxReadOps(sandbox: Sandbox): ReadOperations {
	return {
		readFile: async (filePath: string) => {
			const sandboxPath = toSandboxPath(filePath);
			const buf = await sandbox.readFileToBuffer({ path: sandboxPath });
			if (!buf) throw new Error(`Cannot read file: ${sandboxPath}`);
			return buf;
		},
		access: async (filePath: string) => {
			await sandbox.fs.access(toSandboxPath(filePath));
		},
		detectImageMimeType: async (filePath: string) => {
			const ext = path.posix.extname(toSandboxPath(filePath)).toLowerCase();
			if (ext === ".png") return "image/png";
			if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
			if (ext === ".gif") return "image/gif";
			if (ext === ".webp") return "image/webp";
			return null;
		},
	};
}

// ─── Write ───────────────────────────────────────────────────────────

export function createSandboxWriteOps(sandbox: Sandbox): WriteOperations {
	return {
		writeFile: async (filePath: string, content: string) => {
			const sandboxPath = toSandboxPath(filePath);
			await sandbox.fs.writeFile(sandboxPath, content);
		},
		mkdir: async (dirPath: string) => {
			await sandbox.mkDir(toSandboxPath(dirPath));
		},
	};
}

// ─── Edit ────────────────────────────────────────────────────────────

export function createSandboxEditOps(sandbox: Sandbox): EditOperations {
	const readOps = createSandboxReadOps(sandbox);
	const writeOps = createSandboxWriteOps(sandbox);
	return {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: readOps.access,
	};
}

// ─── Ls ──────────────────────────────────────────────────────────────

export function createSandboxLsOps(sandbox: Sandbox): LsOperations {
	return {
		exists: async (filePath: string) => {
			try {
				await sandbox.fs.access(toSandboxPath(filePath));
				return true;
			} catch {
				return false;
			}
		},
		stat: async (filePath: string) => {
			return sandbox.fs.stat(toSandboxPath(filePath));
		},
		readdir: async (dirPath: string) => {
			const entries = await sandbox.fs.readdir(toSandboxPath(dirPath));
			// LsOperations.readdir expects string[].
			// The SDK with { withFileTypes: true } returns Dirent[], without it returns string[].
			// We request string mode to match the interface.
			return entries as unknown as string[];
		},
	};
}

// ─── Find ────────────────────────────────────────────────────────────

function matchesGlob(relativePath: string, pattern: string): boolean {
	const normalizedPattern = pattern.split(path.sep).join(path.posix.sep);
	if (normalizedPattern.includes("/")) {
		return (
			path.posix.matchesGlob(relativePath, normalizedPattern) ||
			path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
		);
	}
	return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

async function walkSandboxFiles(
	sandbox: Sandbox,
	root: string,
	visit: (sandboxPath: string, relativePath: string) => Promise<boolean>,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) throw new Error("Operation aborted");

	let stat: Awaited<ReturnType<typeof sandbox.fs.stat>>;
	try {
		stat = await sandbox.fs.stat(root);
	} catch {
		return false;
	}

	if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

	const walkDir = async (dir: string, relativeDir: string): Promise<boolean> => {
		if (signal?.aborted) throw new Error("Operation aborted");
		let entries: string[];
		try {
			entries = await sandbox.fs.readdir(dir);
		} catch {
			return true;
		}

		for (const entry of entries) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const entryName = typeof entry === "string" ? entry : (entry as { name: string }).name;
			if (entryName === ".git" || entryName === "node_modules") continue;

			const entryPath = path.posix.join(dir, entryName);
			const relativePath = relativeDir ? path.posix.join(relativeDir, entryName) : entryName;

			let entryStat: Awaited<ReturnType<typeof sandbox.fs.stat>>;
			try {
				entryStat = await sandbox.fs.stat(entryPath);
			} catch {
				continue;
			}

			if (entryStat.isDirectory()) {
				if (!(await walkDir(entryPath, relativePath))) return false;
			} else if (!(await visit(entryPath, relativePath))) {
				return false;
			}
		}
		return true;
	};

	return walkDir(root, "");
}

// ─── Find Operations Factory ─────────────────────────────────────────

/**
 * Create find operations that use native `find` when available,
 * falling back to JS-based file walking.
 */
export function createSandboxFindOps(sandbox: Sandbox, detector: NativeToolDetector): FindOperations {
	return {
		exists: async (filePath: string) => {
			try {
				await sandbox.fs.access(toSandboxPath(filePath));
				return true;
			} catch {
				return false;
			}
		},
		glob: async (pattern: string, cwd: string, options: { limit: number }) => {
			// Try native find first
			if (await detector.hasFind()) {
				const cmd = buildFindCommand(pattern, cwd, options, SANDBOX_WORKSPACE);
				if (cmd) {
					try {
						const result = await sandbox.runCommand({
							cmd: cmd.cmd,
							args: cmd.args,
						});
						const output = await result.stdout();
						if (result.exitCode === 0 && output.trim()) {
							const allResults = output.trim().split("\n");
							return allResults.slice(0, options.limit);
						}
					} catch {
						// Fall through to JS-based walking
					}
				}
			}

			// Fallback: JS-based file walking
			const root = toSandboxPath(cwd);
			const results: string[] = [];
			await walkSandboxFiles(sandbox, root, async (sandboxPath, relativePath) => {
				if (results.length >= options.limit) return false;
				if (matchesGlob(relativePath, pattern)) results.push(sandboxPath);
				return results.length < options.limit;
			});
			return results;
		},
	};
}

// ─── Grep ────────────────────────────────────────────────────────────

const DEFAULT_GREP_LIMIT = 100;

function createLineMatcher(pattern: string, literal: boolean | undefined, ignoreCase: boolean | undefined) {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
	return (line: string) => regex.test(line);
}

function appendGrepBlock(params: {
	outputLines: string[];
	lines: string[];
	relativePath: string;
	lineIndex: number;
	contextLines: number;
}): boolean {
	let linesTruncated = false;
	const start = params.contextLines > 0 ? Math.max(0, params.lineIndex - params.contextLines) : params.lineIndex;
	const end =
		params.contextLines > 0
			? Math.min(params.lines.length - 1, params.lineIndex + params.contextLines)
			: params.lineIndex;

	for (let index = start; index <= end; index++) {
		const rawLine = params.lines[index] ?? "";
		const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
		if (wasTruncated) linesTruncated = true;
		const separator = index === params.lineIndex ? ":" : "-";
		params.outputLines.push(`${params.relativePath}${separator}${index + 1}${separator} ${text}`);
	}
	return linesTruncated;
}

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

/**
 * Execute grep using native ripgrep when available, falling back to JS.
 */
export async function executeSandboxGrep(
	sandbox: Sandbox,
	params: GrepToolInput,
	signal?: AbortSignal,
	detector?: NativeToolDetector,
): Promise<TextToolResult<GrepToolDetails>> {
	// Try native ripgrep first
	if (detector && await detector.hasRg()) {
		const rgCmd = buildRgCommand(
			{
				pattern: params.pattern,
				path: params.path,
				literal: params.literal,
				ignoreCase: params.ignoreCase,
				context: params.context,
				glob: params.glob,
				limit: params.limit,
			},
			SANDBOX_WORKSPACE,
		);
		if (rgCmd) {
			try {
				const result = await sandbox.runCommand({
					cmd: rgCmd.cmd,
					args: rgCmd.args,
			});
	

				// rg exits with 1 when no matches found, 2+ for errors
				if (result.exitCode > 1) {
					// Real error from rg — fall back to JS
				} else if (result.exitCode === 0) {
					// Matches found — format and return
					const output = (await result.stdout()).trim();
					if (output) {
						return formatRgOutput(output);
					}
				} else if (result.exitCode === 1) {
					// No matches found
					return { content: [{ type: "text", text: "No matches found" }], details: undefined };
				}
			} catch {
				// Fall through to JS-based grep
			}
		}
	}

	// Fallback: JS-based file walking grep
	return executeSandboxGrepJs(sandbox, params, signal);
}

/**
 * Format ripgrep output for Pi display.
 * rg output is already in file:line:content format with context lines
 * using - separator, which is the same format Pi expects.
 */
function formatRgOutput(
	rawOutput: string,
): TextToolResult<GrepToolDetails> {
	const details: GrepToolDetails = {};

	// rg output is already properly formatted with file:line:content
	// and file-line-content for context lines.
	// Just apply truncation like the JS path does.
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	const notices: string[] = [];
	let output = truncation.content;

	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return {
		content: [{ type: "text", text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

/**
 * JS-based fallback grep — walks sandbox filesystem and matches lines in JS.
 * This is the original implementation, used when rg is not available.
 */
async function executeSandboxGrepJs(
	sandbox: Sandbox,
	params: GrepToolInput,
	signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
	const root = toSandboxPath(params.path ?? ".");
	let rootStat: Awaited<ReturnType<typeof sandbox.fs.stat>>;
	try {
		rootStat = await sandbox.fs.stat(root);
	} catch {
		return { content: [{ type: "text", text: `Cannot access path: ${root}` }], details: undefined };
	}
	const rootIsDirectory = rootStat.isDirectory();
	const matcher = createLineMatcher(params.pattern, params.literal, params.ignoreCase);
	const contextLines = params.context && params.context > 0 ? params.context : 0;
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const outputLines: string[] = [];
	const details: GrepToolDetails = {};
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;

	await walkSandboxFiles(
		sandbox,
		root,
		async (sandboxPath, relativePath) => {
			if (matchCount >= effectiveLimit) return false;
			if (params.glob && !matchesGlob(relativePath, params.glob)) return true;

			let content: string;
			try {
				const buf = await sandbox.readFileToBuffer({ path: sandboxPath });
				content = buf?.toString("utf8") ?? "";
			} catch {
				return true;
			}

			const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			const displayPath = rootIsDirectory ? relativePath : path.posix.basename(sandboxPath);

			for (let index = 0; index < lines.length; index++) {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (!matcher(lines[index] ?? "")) continue;
				matchCount++;
				if (appendGrepBlock({ outputLines, lines, relativePath: displayPath, lineIndex: index, contextLines })) {
					linesTruncated = true;
				}
				if (matchCount >= effectiveLimit) {
					matchLimitReached = true;
					return false;
				}
			}
			return true;
		},
		signal,
	);

	if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const rawOutput = outputLines.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	const notices: string[] = [];
	let output = truncation.content;

	if (matchLimitReached) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return {
		content: [{ type: "text", text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

// ─── Bash ────────────────────────────────────────────────────────────

/**
 * Sanitize and filter environment variables before passing to the sandbox.
 * We strip PATH, HOME, and other host-specific vars to avoid overriding
 * the sandbox's own environment.
 */
function sanitizeEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
	if (!env) return undefined;
	const blocked = new Set([
		"PATH", "HOME", "USER", "SHELL", "PWD", "OLDPWD",
		"HOSTNAME", "LANG", "LC_ALL", "TERM",
		"NVM_DIR", "NVM_HOME", "NVM_BIN",
	]);
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string" && !blocked.has(key)) {
			result[key] = value;
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export function createSandboxBashOps(sandbox: Sandbox): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (signal?.aborted) throw new Error("aborted");

			const sandboxCwd = SANDBOX_WORKSPACE;
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			let timedOut = false;
			const timer =
				timeout && timeout > 0
					? setTimeout(() => {
							timedOut = true;
							controller.abort();
						}, timeout * 1000)
					: undefined;

			try {
				const cleanEnv = sanitizeEnv(env);

				// Vercel SDK rejects env with empty keys or non-string values;
				// double-check after sanitizeEnv and omit if empty.
				if (cleanEnv) {
					for (const k of Object.keys(cleanEnv)) {
						if (!k || typeof cleanEnv[k] !== "string") delete cleanEnv[k];
					}
				}

				// Run as detached to get a Command back immediately,
				// then stream its logs and wait for completion.
				const cmd = await sandbox.runCommand({
					cmd: "bash",
					args: ["-lc", command],
					cwd: sandboxCwd,
					...(cleanEnv && Object.keys(cleanEnv).length > 0 ? { env: cleanEnv } : {}),
					detached: true,
				});

				// Stream output via logs()
				for await (const log of cmd.logs({ signal: controller.signal })) {
					onData(Buffer.from(log.data));
				}

				// Wait for the command to finish and get exit code
				const finished = await cmd.wait();
				return { exitCode: finished.exitCode };
			} catch (error) {
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw error;
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}