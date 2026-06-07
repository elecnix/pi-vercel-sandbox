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
 *
 * Accepts both flat and nested config formats:
 *   Flat:    { "createCommands": ["npm install"] }
 *   Nested:  { "create": { "commands": ["npm install"] } }
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

function readJsonFile(filePath: string): Record<string, unknown> | null {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Normalize config from various accepted JSON shapes.
 * Supports both flat (`createCommands`) and nested (`create: { commands }`) formats.
 */
export function normalizeConfig(raw: Record<string, unknown>): Partial<SandboxConfig> {
	const result: Record<string, unknown> = { ...raw };

	// Handle nested `create: { commands: [...] }` → `createCommands: [...]`
	if (!result.createCommands && typeof result.create === "object" && result.create !== null) {
		const create = result.create as Record<string, unknown>;
		if (Array.isArray(create.commands)) {
			result.createCommands = create.commands;
		}
	}

	// Handle nested `resume: { commands: [...] }` → `resumeCommands: [...]`
	if (!result.resumeCommands && typeof result.resume === "object" && result.resume !== null) {
		const resume = result.resume as Record<string, unknown>;
		if (Array.isArray(resume.commands)) {
			result.resumeCommands = resume.commands;
		}
	}

	// Handle `resources: { vcpus: N }` → `vcpus: N`
	if (result.vcpus === undefined && typeof result.resources === "object" && result.resources !== null) {
		const resources = result.resources as Record<string, unknown>;
		if (typeof resources.vcpus === "number") {
			result.vcpus = resources.vcpus;
		}
	}

	return result as Partial<SandboxConfig>;
}

function deriveSandboxName(localCwd: string): string {
	const dirName = path.basename(localCwd);
	return `pi-${dirName}`;
}

export function loadConfig(localCwd: string, flagOverrides?: Partial<SandboxConfig>): SandboxConfig {
	const globalPath = path.join(os.homedir(), ".pi", "agent", "extensions", "vercel-sandbox.json");
	const projectPath = path.join(localCwd, ".pi", "vercel-sandbox.json");

	const globalConfig = normalizeConfig(readJsonFile(globalPath) ?? {});
	const projectConfig = normalizeConfig(readJsonFile(projectPath) ?? {});

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