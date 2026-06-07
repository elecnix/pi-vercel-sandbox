import { describe, it, expect } from "vitest";
import { buildRgCommand, buildFindCommand, buildInstallCommand } from "./native-tools.js";

// ─── Install Command Tests ─────────────────────────────────────────

describe("buildInstallCommand", () => {
	it("returns a dnf install command for ripgrep", () => {
		const cmd = buildInstallCommand();
		expect(cmd).toBeTruthy();
		expect(cmd).toContain("sudo dnf install -y");
		expect(cmd).toContain("ripgrep");
	});
});

// ─── rg Command Builder Tests ──────────────────────────────────────

describe("buildRgCommand", () => {
	const workspace = "/vercel/sandbox";

	it("builds a basic rg command with pattern and path", () => {
		const result = buildRgCommand({ pattern: "TODO", path: "." }, workspace);
		expect(result).not.toBeNull();
		expect(result!.cmd).toBe("rg");
		expect(result!.args).toContain("--line-number");
		expect(result!.args).toContain("--");
		expect(result!.args).toContain("TODO");
		expect(result!.args[result!.args.length - 1]).toBe(workspace);
	});

	it("adds -i for ignoreCase", () => {
		const result = buildRgCommand({ pattern: "todo", ignoreCase: true }, workspace);
		expect(result).not.toBeNull();
		expect(result!.args).toContain("-i");
	});

	it("does not add -i when ignoreCase is false", () => {
		const result = buildRgCommand({ pattern: "todo", ignoreCase: false }, workspace);
		expect(result).not.toBeNull();
		expect(result!.args).not.toContain("-i");
	});

	it("adds --fixed-strings for literal matching", () => {
		const result = buildRgCommand({ pattern: "v1.0.0", literal: true }, workspace);
		expect(result).not.toBeNull();
		expect(result!.args).toContain("--fixed-strings");
	});

	it("does not add --fixed-strings for regex matching", () => {
		const result = buildRgCommand({ pattern: "v1.0.0", literal: false }, workspace);
		expect(result).not.toBeNull();
		expect(result!.args).not.toContain("--fixed-strings");
	});

	it("adds -C for context lines", () => {
		const result = buildRgCommand({ pattern: "TODO", context: 3 }, workspace);
		expect(result).not.toBeNull();
		expect(result!.args).toContain("-C");
		expect(result!.args).toContain("3");
	});

	it("adds --glob for glob filter", () => {
		const result = buildRgCommand({ pattern: "TODO", glob: "*.ts" }, workspace);
		expect(result).not.toBeNull();
		expect(result!.args).toContain("--glob");
		expect(result!.args).toContain("*.ts");
	});

	it("excludes .git and node_modules", () => {
		const result = buildRgCommand({ pattern: "TODO" }, workspace);
		expect(result).not.toBeNull();
		expect(result!.args).toContain("!.git");
		expect(result!.args).toContain("!node_modules");
	});

	it("resolves relative paths against workspace", () => {
		const result = buildRgCommand({ pattern: "TODO", path: "src" }, workspace);
		expect(result).not.toBeNull();
		expect(result!.args[result!.args.length - 1]).toBe(`${workspace}/src`);
	});

	it("keeps absolute paths unchanged", () => {
		const result = buildRgCommand({ pattern: "TODO", path: "/tmp/test" }, workspace);
		expect(result).not.toBeNull();
		expect(result!.args[result!.args.length - 1]).toBe("/tmp/test");
	});
});

// ─── find Command Builder Tests ─────────────────────────────────────

describe("buildFindCommand", () => {
	const workspace = "/vercel/sandbox";

	it("builds a find command for simple glob patterns", () => {
		const result = buildFindCommand("*.ts", ".", { limit: 100 }, workspace);
		expect(result).not.toBeNull();
		expect(result!.cmd).toBe("find");
		expect(result!.args[0]).toBe(workspace);
		expect(result!.args).toContain("-name");
		expect(result!.args).toContain("*.ts");
	});

	it("excludes .git and node_modules", () => {
		const result = buildFindCommand("*.ts", ".", { limit: 100 }, workspace);
		expect(result).not.toBeNull();
		expect(result!.args).toContain("*/.git/*");
		expect(result!.args).toContain("*/node_modules/*");
	});

	it("returns null for patterns with ** (complex globs)", () => {
		const result = buildFindCommand("**/*.ts", ".", { limit: 100 }, workspace);
		expect(result).toBeNull();
	});

	it("resolves relative cwd against workspace", () => {
		const result = buildFindCommand("*.ts", "src", { limit: 100 }, workspace);
		expect(result).not.toBeNull();
		expect(result!.args[0]).toBe(`${workspace}/src`);
	});

	it("keeps absolute cwd paths unchanged", () => {
		const result = buildFindCommand("*.ts", "/tmp/test", { limit: 100 }, workspace);
		expect(result).not.toBeNull();
		expect(result!.args[0]).toBe("/tmp/test");
	});
});