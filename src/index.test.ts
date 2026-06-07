import { describe, it, expect } from "vitest";
import { loadConfig, normalizeConfig } from "./config.js";
import { toSandboxPath, SANDBOX_WORKSPACE, stripAtPrefix, toPosix } from "./paths.js";

// ─── Config Tests ────────────────────────────────────────────────────

describe("loadConfig", () => {
	it("returns default config when no files exist", () => {
		const config = loadConfig("/tmp/nonexistent-project-dir-for-test");
		expect(config.name).toBe("pi-nonexistent-project-dir-for-test");
		expect(config.runtime).toBe("node24");
		expect(config.timeout).toBe(5 * 60 * 1000);
		expect(config.keepAlive).toBe(false);
		expect(config.createCommands).toEqual([]);
		expect(config.resumeCommands).toEqual([]);
	});

	it("derives sandbox name from directory basename", () => {
		const config = loadConfig("/home/user/my-cool-project");
		expect(config.name).toBe("pi-my-cool-project");
	});

	it("sanitizes sandbox name to lowercase with hyphens", () => {
		const config = loadConfig("/home/user/My_Cool_Project");
		expect(config.name).toBe("pi-my-cool-project");
	});

	it("applies flag overrides", () => {
		const config = loadConfig("/home/user/myproject", {
			name: "custom-name",
			keepAlive: true,
			timeout: 600000,
		});
		expect(config.name).toBe("custom-name");
		expect(config.keepAlive).toBe(true);
		expect(config.timeout).toBe(600000);
	});

	it("uses explicit name over derived name", () => {
		const config = loadConfig("/home/user/myproject", { name: "my-explicit-name" });
		expect(config.name).toBe("my-explicit-name");
	});
});

describe("normalizeConfig", () => {
	it("handles flat format: createCommands / resumeCommands", () => {
		const result = normalizeConfig({
			name: "test",
			createCommands: ["npm install"],
			resumeCommands: ["npm run dev"],
		});
		expect(result.createCommands).toEqual(["npm install"]);
		expect(result.resumeCommands).toEqual(["npm run dev"]);
	});

	it("handles nested format: create.commands / resume.commands", () => {
		const result = normalizeConfig({
			name: "test",
			create: { commands: ["git clone .", "npm install"] },
			resume: { commands: ["npm run dev"] },
		});
		expect(result.createCommands).toEqual(["git clone .", "npm install"]);
		expect(result.resumeCommands).toEqual(["npm run dev"]);
	});

	it("flat format takes precedence over nested", () => {
		const result = normalizeConfig({
			name: "test",
			createCommands: ["flat"],
			create: { commands: ["nested"] },
		});
		expect(result.createCommands).toEqual(["flat"]);
	});

	it("handles resources.vcpus → vcpus normalization", () => {
		const result = normalizeConfig({
			name: "test",
			resources: { vcpus: 4 },
		});
		expect(result.vcpus).toBe(4);
	});

	it("top-level vcpus takes precedence over resources.vcpus", () => {
		const result = normalizeConfig({
			name: "test",
			vcpus: 2,
			resources: { vcpus: 4 },
		});
		expect(result.vcpus).toBe(2);
	});

	it("handles empty nested objects gracefully", () => {
		const result = normalizeConfig({
			name: "test",
			create: {},
			resume: {},
			resources: {},
		});
		expect(result.createCommands).toBeUndefined();
		expect(result.resumeCommands).toBeUndefined();
		expect(result.vcpus).toBeUndefined();
	});

	it("passes through unknown keys unchanged", () => {
		const result = normalizeConfig({
			name: "test",
			customField: "value",
		});
		expect((result as Record<string, unknown>).customField).toBe("value");
	});
});

// ─── Path Mapping Tests ──────────────────────────────────────────────

describe("stripAtPrefix", () => {
	it("strips leading @", () => {
		expect(stripAtPrefix("@src/index.ts")).toBe("src/index.ts");
	});

	it("leaves paths without @ unchanged", () => {
		expect(stripAtPrefix("src/index.ts")).toBe("src/index.ts");
	});

	it("handles empty string", () => {
		expect(stripAtPrefix("")).toBe("");
	});

	it("does not strip @ in the middle", () => {
		expect(stripAtPrefix("foo@bar")).toBe("foo@bar");
	});
});

describe("toPosix", () => {
	it("leaves forward slashes unchanged", () => {
		expect(toPosix("src/index.ts")).toBe("src/index.ts");
	});

	it("converts platform separator to forward slashes", () => {
		const platformPath = ["src", "index.ts"].join(require("node:path").sep);
		if (require("node:path").sep !== "/") {
			expect(toPosix(platformPath)).toBe("src/index.ts");
		} else {
			// On POSIX, paths are already forward-slash
			expect(toPosix(platformPath)).toBe("src/index.ts");
		}
	});
});

describe("toSandboxPath", () => {
	it("maps empty path to sandbox workspace", () => {
		expect(toSandboxPath("")).toBe(SANDBOX_WORKSPACE);
	});

	it("maps relative path to sandbox workspace child", () => {
		expect(toSandboxPath("src/index.ts")).toBe(`${SANDBOX_WORKSPACE}/src/index.ts`);
	});

	it("maps . (dot) to sandbox workspace", () => {
		expect(toSandboxPath(".")).toBe(SANDBOX_WORKSPACE);
	});

	it("maps @-prefixed relative path to sandbox workspace child", () => {
		expect(toSandboxPath("@src/index.ts")).toBe(`${SANDBOX_WORKSPACE}/src/index.ts`);
	});

	it("keeps sandbox-absolute paths unchanged", () => {
		expect(toSandboxPath(`${SANDBOX_WORKSPACE}/src/index.ts`)).toBe(
			`${SANDBOX_WORKSPACE}/src/index.ts`,
		);
	});

	it("keeps other absolute paths unchanged", () => {
		expect(toSandboxPath("/tmp/test")).toBe("/tmp/test");
		expect(toSandboxPath("/etc/hosts")).toBe("/etc/hosts");
	});

	it("resolves .. paths", () => {
		expect(toSandboxPath("src/../test.txt")).toBe(`${SANDBOX_WORKSPACE}/test.txt`);
	});

	it("handles whitespace in input", () => {
		expect(toSandboxPath("  src/index.ts  ")).toBe(`${SANDBOX_WORKSPACE}/src/index.ts`);
	});

	it("maps nested relative paths correctly", () => {
		expect(toSandboxPath("a/b/c.txt")).toBe(`${SANDBOX_WORKSPACE}/a/b/c.txt`);
	});

	it("handles paths with dots in directory names", () => {
		expect(toSandboxPath("node_modules/.package-lock.json")).toBe(
			`${SANDBOX_WORKSPACE}/node_modules/.package-lock.json`,
		);
	});
});