/**
 * Pi Vercel Sandbox Extension
 *
 * Routes all built-in tools into a Vercel Sandbox — a persistent cloud
 * microVM that automatically snapshots filesystem state on stop and
 * resumes where you left off.
 *
 * Usage:
 *   pi -e /path/to/pi-vercel-sandbox --vercel-sandbox
 *
 * Flags:
 *   --vercel-sandbox             Enable Vercel Sandbox routing
 *   --vercel-sandbox-name NAME   Override sandbox name
 *   --vercel-sandbox-keepalive   Keep sandbox alive between turns
 *   --no-vercel-sandbox          Disable (useful when enabled in config)
 *
 * Commands:
 *   /vercel-sandbox              Show sandbox status
 *   /vercel-sandbox stop          Stop sandbox (snapshots filesystem)
 *   /vercel-sandbox delete        Permanently delete sandbox and snapshots
 */

import type { Sandbox } from "@vercel/sandbox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type SandboxConfig } from "./config.js";
import { SANDBOX_WORKSPACE } from "./paths.js";
import {
	createSandboxBashOps,
	createSandboxEditOps,
	createSandboxFindOps,
	createSandboxLsOps,
	createSandboxReadOps,
	createSandboxWriteOps,
	executeSandboxGrep,
} from "./sandbox-ops.js";

export default function (pi: ExtensionAPI) {
	const localCwd = process.cwd();

	// Register CLI flags
	pi.registerFlag("vercel-sandbox", {
		description: "Enable Vercel Sandbox routing for all tools",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("vercel-sandbox-name", {
		description: "Override Vercel Sandbox name",
		type: "string",
	});

	pi.registerFlag("vercel-sandbox-keepalive", {
		description: "Keep Vercel Sandbox alive between turns",
		type: "boolean",
		default: false,
	});

	// Sandbox state
	let sandbox: Sandbox | undefined;
	let sandboxStarting: Promise<Sandbox> | undefined;
	let config: SandboxConfig | undefined;
	let toolsRegistered = false;

	/**
	 * Check if Vercel Sandbox mode is active.
	 * Must be called after session_start (flags are resolved then).
	 */
	function isSandboxEnabled(): boolean {
		if (pi.getFlag("no-vercel-sandbox")) return false;
		if (pi.getFlag("vercel-sandbox")) return true;
		// Also enabled if a sandbox is already running (e.g., resumed from config)
		return sandbox !== undefined;
	}

	/**
	 * Start or resume the Vercel Sandbox.
	 */
	async function ensureSandbox(ctx?: ExtensionContext): Promise<Sandbox> {
		if (sandbox) return sandbox;
		if (!config) throw new Error("Sandbox config not loaded — session_start not called?");

		if (!sandboxStarting) {
			sandboxStarting = startSandbox(ctx).finally(() => {
				sandboxStarting = undefined;
			});
		}
		return sandboxStarting;
	}

	/**
	 * Create or resume a sandbox using the Vercel SDK.
	 * On failure, clears sandbox state and notifies the user.
	 */
	async function startSandbox(ctx?: ExtensionContext): Promise<Sandbox> {
		const cfg = config!;
		ctx?.ui.setStatus("vercel-sandbox", ctx.ui.theme.fg("accent", `Vercel Sandbox: starting ${cfg.name}`));

		let SandboxClass: typeof Sandbox;
		try {
			const mod = await import("@vercel/sandbox");
			SandboxClass = mod.Sandbox;
		} catch (error) {
			sandbox = undefined;
			const msg = error instanceof Error ? error.message : String(error);
			ctx?.ui.setStatus("vercel-sandbox", ctx.ui.theme.fg("error", "Vercel Sandbox: load failed"));
			ctx?.ui.notify(`Vercel Sandbox: failed to load SDK: ${msg}`, "error");
			throw new Error(`Failed to load @vercel/sandbox: ${msg}`);
		}

		let sandboxInstance: Sandbox;
		try {
			sandboxInstance = await SandboxClass.getOrCreate({
				name: cfg.name,
				runtime: cfg.runtime,
				timeout: cfg.timeout,
				...(cfg.ports && cfg.ports.length > 0 ? { ports: cfg.ports } : {}),
				onCreate: async (sbx) => {
					ctx?.ui.setStatus("vercel-sandbox", ctx.ui.theme.fg("accent", `Vercel Sandbox: ${cfg.name} (creating)`));
					for (const cmd of cfg.createCommands) {
						await sbx.runCommand({ cmd: "bash", args: ["-lc", cmd] });
					}
				},
			// NOTE: Do NOT use onResume here. It fires on every auto-resume
			// (including those triggered internally by runCommand), causing
			// repeated execution of resume commands and potential hangs.
			// Resume commands are run once below after getOrCreate resolves.
			});

		} catch (error) {
			sandbox = undefined;
			const msg = error instanceof Error ? error.message : String(error);
			ctx?.ui.setStatus("vercel-sandbox", ctx.ui.theme.fg("error", "Vercel Sandbox: connect failed"));
			ctx?.ui.notify(`Vercel Sandbox: failed to start: ${msg}`, "error");
			throw error;
		}

		sandbox = sandboxInstance;

		// Run resume commands once after sandbox is ready.
		if (cfg.resumeCommands.length > 0) {
			ctx?.ui.setStatus("vercel-sandbox", ctx.ui.theme.fg("accent", `Vercel Sandbox: ${cfg.name} (resuming)`));
			for (const cmd of cfg.resumeCommands) {
				try {
					await sandboxInstance.runCommand({ cmd: "bash", args: ["-lc", cmd], detached: true });
				} catch {
					// Resume commands are best-effort
				}
			}
		}

		// Build status bar
		let portInfo = "";
		if (cfg.ports && cfg.ports.length > 0) {
			const urls = cfg.ports
				.map((p) => {
					try {
						return sandboxInstance.domain(p);
					} catch {
						return `port:${p}`;
					}
				})
				.join(", ");
			portInfo = ` | ${urls}`;
		}
		ctx?.ui.setStatus(
			"vercel-sandbox",
			ctx.ui.theme.fg("accent", `☁ ${cfg.name}${portInfo}`),
		);
		ctx?.ui.notify(`Vercel Sandbox ready. Working in ${SANDBOX_WORKSPACE}.`, "info");

		return sandboxInstance;
	}

	/**
	 * Stop the sandbox (auto-snapshots filesystem).
	 */
	async function stopSandbox(ctx?: ExtensionContext): Promise<void> {
		const activeSandbox = sandbox;
		sandbox = undefined;
		sandboxStarting = undefined;

		if (!activeSandbox) return;

		ctx?.ui.setStatus("vercel-sandbox", ctx.ui.theme.fg("muted", "Vercel Sandbox: stopping"));
		try {
			await activeSandbox.stop();
		} finally {
			ctx?.ui.setStatus("vercel-sandbox", undefined);
		}
	}

	// ─── Lifecycle Events ──────────────────────────────────────────────

	/**
	 * Register tool overrides that route operations into the sandbox.
	 * Only called when --vercel-sandbox is active to avoid conflicts with
	 * other tool-routing extensions (e.g., SSH, Gondolin).
	 */
	function registerSandboxTools() {
		if (toolsRegistered) return;
		toolsRegistered = true;

		const localRead = createReadTool(localCwd);
		const localWrite = createWriteTool(localCwd);
		const localEdit = createEditTool(localCwd);
		const localBash = createBashTool(localCwd);
		const localGrep = createGrepTool(localCwd);
		const localFind = createFindTool(localCwd);
		const localLs = createLsTool(localCwd);

		pi.registerTool({
			...localRead,
			async execute(id, params, signal, onUpdate, ctx) {
				if (!isSandboxEnabled()) return localRead.execute(id, params, signal, onUpdate);
				const activeSandbox = await ensureSandbox(ctx);
				const tool = createReadTool(SANDBOX_WORKSPACE, {
					operations: createSandboxReadOps(activeSandbox),
				});
				return tool.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localWrite,
			async execute(id, params, signal, onUpdate, ctx) {
				if (!isSandboxEnabled()) return localWrite.execute(id, params, signal, onUpdate);
				const activeSandbox = await ensureSandbox(ctx);
				const tool = createWriteTool(SANDBOX_WORKSPACE, {
					operations: createSandboxWriteOps(activeSandbox),
				});
				return tool.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localEdit,
			async execute(id, params, signal, onUpdate, ctx) {
				if (!isSandboxEnabled()) return localEdit.execute(id, params, signal, onUpdate);
				const activeSandbox = await ensureSandbox(ctx);
				const tool = createEditTool(SANDBOX_WORKSPACE, {
					operations: createSandboxEditOps(activeSandbox),
				});
				return tool.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localBash,
			async execute(id, params, signal, onUpdate, ctx) {
				if (!isSandboxEnabled()) return localBash.execute(id, params, signal, onUpdate);
				const activeSandbox = await ensureSandbox(ctx);

				// Extend timeout if keep-alive mode is enabled
				if (config?.keepAlive) {
					try {
						await activeSandbox.extendTimeout(5 * 60 * 1000);
					} catch {
						// Timeout extension is best-effort; ignore errors
					}
				}

				const tool = createBashTool(SANDBOX_WORKSPACE, {
					operations: createSandboxBashOps(activeSandbox),
				});
				return tool.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localLs,
			async execute(id, params, signal, onUpdate, ctx) {
				if (!isSandboxEnabled()) return localLs.execute(id, params, signal, onUpdate);
				const activeSandbox = await ensureSandbox(ctx);
				const tool = createLsTool(SANDBOX_WORKSPACE, {
					operations: createSandboxLsOps(activeSandbox),
				});
				return tool.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localFind,
			async execute(id, params, signal, onUpdate, ctx) {
				if (!isSandboxEnabled()) return localFind.execute(id, params, signal, onUpdate);
				const activeSandbox = await ensureSandbox(ctx);
				const tool = createFindTool(SANDBOX_WORKSPACE, {
					operations: createSandboxFindOps(activeSandbox),
				});
				return tool.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localGrep,
			async execute(_id, params, signal, _onUpdate, ctx) {
				if (!isSandboxEnabled()) return localGrep.execute(_id, params, signal, _onUpdate);
				const activeSandbox = await ensureSandbox(ctx);
				return executeSandboxGrep(activeSandbox, params, signal);
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		// Build config from files + flags
		const flagOverrides: Partial<SandboxConfig> = {};
		if (pi.getFlag("vercel-sandbox-keepalive")) flagOverrides.keepAlive = true;
		const nameFlag = pi.getFlag("vercel-sandbox-name") as string | undefined;
		if (nameFlag) flagOverrides.name = nameFlag;

		config = loadConfig(localCwd, flagOverrides);

		if (!isSandboxEnabled()) {
			ctx.ui.setStatus("vercel-sandbox", undefined);
			return;
		}

		// Register tools only when sandbox is active to avoid conflicts
		// with other tool-routing extensions (e.g., SSH, Gondolin)
		registerSandboxTools();

		await ensureSandbox(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await stopSandbox(ctx);
	});

	// ─── System Prompt Modification ─────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isSandboxEnabled()) return;

		// Ensure sandbox is ready before the agent starts
		await ensureSandbox(ctx);

		const cfg = config!;
		const localLine = `Current working directory: ${localCwd}`;
		const sandboxLine = `Current working directory: ${SANDBOX_WORKSPACE} (Vercel Sandbox; sandbox: ${cfg.name})`;
		const systemPrompt = event.systemPrompt.includes(localLine)
			? event.systemPrompt.replace(localLine, sandboxLine)
			: `${event.systemPrompt}\n\n${sandboxLine}`;

		return { systemPrompt };
	});

	// ─── User Bash ──────────────────────────────────────────────────────

	pi.on("user_bash", async (_event, ctx) => {
		if (!isSandboxEnabled()) return;
		const activeSandbox = await ensureSandbox(ctx);
		return { operations: createSandboxBashOps(activeSandbox) };
	});

	// ─── Commands ───────────────────────────────────────────────────────

	pi.registerCommand("vercel-sandbox", {
		description: "Show Vercel Sandbox status, or stop/delete the sandbox",
		getArgumentCompletions: (prefix: string) => {
			const actions = ["stop", "delete"];
			const filtered = actions.filter((a) => a.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((a) => ({ value: a, label: a }))
				: null;
		},
		handler: async (args, ctx) => {
			const subcommand = args?.trim();

			if (subcommand === "stop") {
				if (!sandbox) {
					ctx.ui.notify("No active Vercel Sandbox.", "warning");
					return;
				}
				await stopSandbox(ctx);
				ctx.ui.notify("Vercel Sandbox stopped (filesystem snapshotted).", "info");
				return;
			}

			if (subcommand === "delete") {
				if (!sandbox) {
					ctx.ui.notify("No active Vercel Sandbox.", "warning");
					return;
				}
				const activeSandbox = sandbox;
				sandbox = undefined;
				sandboxStarting = undefined;
				await activeSandbox.delete();
				ctx.ui.setStatus("vercel-sandbox", undefined);
				ctx.ui.notify("Vercel Sandbox deleted (all snapshots removed).", "info");
				return;
			}

			// Status display
			if (!sandbox || !config) {
				ctx.ui.notify("Vercel Sandbox: not active. Use --vercel-sandbox flag to enable.", "info");
				return;
			}

			const cfg = config;
			const lines = [
				`Vercel Sandbox: ${cfg.name}`,
				`  Status: ${sandbox.status}`,
				`  Runtime: ${cfg.runtime}`,
				`  Workspace: ${SANDBOX_WORKSPACE}`,
				`  Timeout: ${cfg.timeout}ms`,
				`  Keep-alive: ${cfg.keepAlive ? "on" : "off"}`,
			];

			if (cfg.ports && cfg.ports.length > 0) {
				const urls = cfg.ports
					.map((p) => {
						try {
							return sandbox!.domain(p);
						} catch {
							return `port:${p} (no route)`;
						}
					})
					.join(", ");
				lines.push(`  Preview: ${urls}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}