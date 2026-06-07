/**
 * Configuration loading for pi-vercel-sandbox.
 *
 * Reads from:
 *   1. `.pi/vercel-sandbox.json` in the project directory
 *   2. `~/.pi/agent/extensions/vercel-sandbox.json` for global defaults
 *   3. CLI flags (`--vercel-sandbox-name`, `--vercel-sandbox-keepalive`)
 *   4. Built-in defaults
 *
 * Later sources override earlier ones.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface SandboxConfig {
	/** Sandbox name (used for Sandbox.get() resume) */
	name: string;
	/** Runtime image (node24, node22, python3.13, etc.) */
	runtime: string;
	/** Number of vCPUs */
	vcpus?: number;
	/** Ports to expose for public URLs */
	ports?: number[];
	/** Session timeout in milliseconds */
	timeout: number;
	/** Network egress policy */
	networkPolicy?: string;
	/** Keep sandbox alive while background processes are detected */
	keepAlive: boolean;
	/** Commands to run on first sandbox creation */
	createCommands: string[];
	/** Commands to run on every sandbox resume */
	resumeCommands: string[];
}

const DEFAULT_CONFIG: SandboxConfig = {
	name: "",
	runtime: "node24",
	timeout: 5 * 60 * 1000,
	keepAlive: false,
	createCommands: [],
	resumeCommands: [],
};

function readJsonFile(filePath: string): Partial<SandboxConfig> | null {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw) as Partial<SandboxConfig>;
	} catch {
		return null;
	}
}

function deriveSandboxName(localCwd: string): string {
	const dirName = path.basename(localCwd);
	return `pi-${dirName}`;
}

export function loadConfig(localCwd: string, flagOverrides?: Partial<SandboxConfig>): SandboxConfig {
	const globalPath = path.join(os.homedir(), ".pi", "agent", "extensions", "vercel-sandbox.json");
	const projectPath = path.join(localCwd, ".pi", "vercel-sandbox.json");

	const globalConfig = readJsonFile(globalPath);
	const projectConfig = readJsonFile(projectPath);

	// Merge: defaults → global → project → flags
	const merged: SandboxConfig = {
		...DEFAULT_CONFIG,
		...globalConfig,
		...projectConfig,
		...flagOverrides,
	};

	// Derive name from cwd if not set
	if (!merged.name) {
		merged.name = deriveSandboxName(localCwd);
	}

	// Sanitize name: lowercase, replace non-alphanumeric with hyphens
	merged.name = merged.name
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+|-+$/g, "");

	return merged;
}