# pi-vercel-sandbox

A [Pi Coding Agent](https://pi.dev) extension that routes all built-in tools into a [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) — a persistent cloud microVM that automatically snapshots filesystem state on stop and resumes where you left off.

## Why

Pi runs on your machine with full access to your filesystem and network. Existing sandboxing options each make a different tradeoff:

| | **Vercel Sandbox** (this) | **Gondolin** | **OS Sandbox** (`@anthropic-ai/sandbox-runtime`) | **SSH** |
|---|---|---|---|---|
| **Where it runs** | Cloud (Firecracker microVM) | Local (QEMU micro-VM) | Local (OS-level) | Remote (any machine) |
| **Filesystem persistence** | ✅ Auto-snapshots, resume by name | ❌ VM destroyed on session end | ❌ No persistence | Depends on remote |
| **Compute persistence** | ❌ Processes killed on stop; use `onResume` | ❌ VM destroyed on session end | ❌ No persistence | Depends on remote |
| **Source of truth** | Sandbox filesystem (self-contained) | Host filesystem (mounted bidirectionally) | Host filesystem | Remote filesystem |
| **Network isolation** | Configurable egress policy | Local network | OS-level (macOS/Linux) | Remote network |
| **Public URLs** | ✅ `sandbox.domain(port)` | ❌ | ❌ | ❌ |
| **Setup** | `vercel link` + API token | QEMU + Node ≥ 23.6 | sandbox-exec / bubblewrap | SSH key auth |
| **Cost** | Vercel compute + snapshot storage | Free (local) | Free (local) | Free (your server) |

### How it differs from Gondolin

Gondolin and this extension follow the same Pi pattern — override built-in tools and route operations into an isolated environment. The architectural difference is **where state lives**:

- **Gondolin** mounts your host project directory at `/workspace` inside a local VM. The VM provides isolation for command execution, but your host filesystem is the source of truth. When the VM closes, only the VM-local state (installed packages outside `/workspace`, running processes) is lost. There is no checkpoint — the VM boots fresh every time.

- **Vercel Sandbox** is self-contained. The sandbox filesystem *is* the workspace. When the sandbox stops, the entire filesystem is auto-snapshotted. When you start Pi again, `Sandbox.get({ name })` resumes from that snapshot — installed packages, project files, and configuration all survive. Running processes don't survive stop (they never do across VM boundaries), but the `onResume` hook lets you restart dev servers automatically.

This means:

- You can close Pi, come back tomorrow, and your `node_modules/`, build artifacts, and project files are still there.
- You can expose ports and get public URLs for dev server previews.
- You pay for compute time and snapshot storage.
- There is no host filesystem mount — files live in the cloud sandbox.

## Setup

### Prerequisites

1. Install the extension:
   ```bash
   pi install npm:pi-vercel-sandbox
   ```

2. Link a Vercel project and pull an OIDC token (one-time per project):
   ```bash
   cd /path/to/your/project
   vercel link
   vercel env pull .env.local
   ```

   The extension reads `VERCEL_OIDC_TOKEN` from `.env.local` or the environment. Alternatively, set `VERCEL_ACCESS_TOKEN` for non-OIDC authentication.

3. Run Pi with the sandbox flag:
   ```bash
   pi --vercel-sandbox
   ```

### Configuration

Create `.pi/vercel-sandbox.json` in your project (or `~/.pi/agent/extensions/vercel-sandbox.json` for global defaults):

```json
{
  "name": "pi-my-project",
  "runtime": "node24",
  "vcpus": 2,
  "ports": [3000, 8080],
  "timeout": 300000,
  "networkPolicy": "allow-all",
  "keepAlive": false,
  "createCommands": [
    "git clone https://github.com/org/repo .",
    "npm install"
  ],
  "resumeCommands": [
    "npm run dev"
  ]
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | `"pi-<project-dir-name>"` | Sandbox name (used for `Sandbox.get()` resume) |
| `runtime` | `string` | `"node24"` | Runtime image (`node26`, `node24`, `node22`, `python3.13`) |
| `vcpus` | `number` | `2` | Number of vCPUs (2 GB RAM per vCPU) |
| `ports` | `number[]` | `[]` | Ports to expose (required for `sandbox.domain()`) |
| `timeout` | `number` | `300000` (5 min) | Session timeout in milliseconds |
| `networkPolicy` | `string \| object` | `"allow-all"` | Egress firewall policy (see Vercel docs) |
| `keepAlive` | `boolean` | `false` | Extend timeout while background processes are detected |
| `createCommands` | `string[]` | `[]` | Commands to run on first sandbox creation |
| `resumeCommands` | `string[]` | `[]` | Commands to run on every sandbox resume |

## Usage

### Basic

```bash
# Start Pi with the Vercel sandbox
cd /path/to/your/project
pi --vercel-sandbox

# Pi opens normally, but all tools run inside the cloud sandbox
# Files read/write/edit go to the sandbox filesystem
# Bash commands execute inside the sandbox
```

### Resuming a session

When you quit Pi, the sandbox auto-stops and snapshots. When you start Pi again with `--vercel-sandbox`, the extension calls `Sandbox.get({ name })` which resumes from the snapshot:

```bash
# Day 1: work on a project
pi --vercel-sandbox
# → Creates sandbox "pi-my-project", runs create.commands
# → Work normally: edit files, run tests, install packages
# → Close Pi → sandbox stops, filesystem snapshotted

# Day 2: continue where you left off
pi --vercel-sandbox
# → Resumes sandbox "pi-my-project" from snapshot
# → All files, installed packages, config still there
# → resume.commands run (e.g., restart dev server)
```

### Keep-alive mode

If Pi starts background processes (dev servers, file watchers), the sandbox must stay running between turns. Enable keep-alive to extend the timeout automatically:

```bash
pi --vercel-sandbox --vercel-sandbox-keepalive
```

Or in config:

```json
{
  "keepAlive": true
}
```

With keep-alive, the extension extends the sandbox timeout before each tool execution. When Pi goes idle and no tool calls happen for 5 minutes, the sandbox auto-stops as normal.

### Preview URLs

If your config includes `ports`, the extension displays the public URL in the Pi status bar:

```
☁ pi-my-project | https://sb-abc123.vercel.run
```

This URL routes to the port exposed in the sandbox — useful for reviewing dev server output in a browser.

### Commands

| Command | Description |
|---|---|
| `/vercel-sandbox` | Show sandbox status, name, region, timeout, and preview URL |
| `/vercel-sandbox stop` | Stop the sandbox (snapshots filesystem) |
| `/vercel-sandbox delete` | Permanently delete the sandbox and all snapshots |

### Flags

| Flag | Type | Description |
|---|---|---|
| `--vercel-sandbox` | `boolean` | Enable Vercel Sandbox routing |
| `--vercel-sandbox-name` | `string` | Override sandbox name |
| `--vercel-sandbox-keepalive` | `boolean` | Keep sandbox alive between turns |
| `--no-vercel-sandbox` | `boolean` | Disable (useful when enabled in config) |

## How it works

### Architecture

```
┌─────────────────────────────────────────────────┐
│  Host Machine (Pi)                              │
│                                                 │
│  Pi Agent ──► read/write/edit/bash/grep/find/ls │
│       │              │                          │
│       │    Extension intercepts all tool calls   │
│       │              │                          │
│       │     ┌────────▼────────┐                │
│       │     │ @vercel/sandbox │                │
│       │     │    SDK calls    │                │
│       └────────┬─────────────┘                │
│                │ HTTPS                          │
└────────────────┼────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┐
│  Vercel Sandbox (Firecracker microVM)           │
│                                                 │
│  /vercel/sandbox/  ← project workspace          │
│  Node.js, git, python3, sudo                    │
│  Auto-snapshots on stop → resume by name         │
└─────────────────────────────────────────────────┘
```

The extension follows the same [tool routing pattern](https://pi.dev/docs/containerization) as Gondolin and the SSH extension:

1. **`session_start`** — The extension calls `Sandbox.getOrCreate()` with the configured name. On first run, `onCreate` fires to run setup commands (git clone, npm install). On subsequent runs, `onResume` fires to restart services.

2. **Tool routing** — The extension re-registers Pi's built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) with operations that delegate to the sandbox:
   - `bash` → `sandbox.runCommand()`
   - `read` → `sandbox.fs.readFile()` / `sandbox.readFileToBuffer()`
   - `write` → `sandbox.fs.writeFile()` / `sandbox.writeFiles()`
   - `edit` → `sandbox.fs.readFile()` + `sandbox.fs.writeFile()`
   - `grep` → file walking + JS line matching via `sandbox.fs.readdir/readFileToBuffer` (no `rg` in sandbox)
   - `find` → `sandbox.fs.readdir()` recursive walking with glob matching
   - `ls` → `sandbox.fs.readdir()` + `sandbox.fs.stat()`

3. **Path mapping** — Pi sees paths relative to `/vercel/sandbox` (the sandbox default working directory). The extension updates the system prompt to inform the LLM of the remote working directory, just like the SSH extension does.

4. **User bash** — The `user_bash` hook routes `!` and `!!` shell commands into the sandbox.

5. **`session_shutdown`** — The extension calls `sandbox.stop()` to snapshot the filesystem and stop compute billing.

### Session graph navigation

- **`/tree` navigation** within the same session: The sandbox keeps running. No disruption.
- **`/fork` or `/clone`**: Pi fires `session_shutdown` then `session_start`. The extension stops the sandbox, then resumes it. Filesystem state survives because `Sandbox.get({ name })` restores from snapshot.
- **`/new` or `/resume`** (switch to a different session): Same as fork — stop and resume. Each Pi session could use a different sandbox name.

### Cost management

The extension balances responsiveness and billing:

1. **During active use**: The sandbox stays running. Each tool call naturally keeps the sandbox alive within its timeout window.
2. **On idle**: After 5 minutes of inactivity (no SDK calls), the Vercel sandbox auto-stops. Filesystem is snapshotted. Compute billing stops. Only snapshot storage is billed.
3. **On resume**: The next Pi tool call triggers `Sandbox.get({ name })`, which resumes from the snapshot in ~2 seconds.
4. **On explicit quit**: `session_shutdown` calls `sandbox.stop()` immediately rather than waiting for the idle timeout.

With `keepAlive` enabled, the extension calls `sandbox.extendTimeout(5min)` before each bash tool execution, preventing the sandbox from auto-stopping while Pi is actively working on long-running tasks.

## Limitations

- **No host filesystem mount** — Files exist only in the sandbox. Use `sandbox.writeFiles()` / `sandbox.readFileToBuffer()` for explicit sync if you need files on your host machine. A future `/vercel-sandbox sync` command could automate this.
- **Process state doesn't survive stop** — Only filesystem persists. Running dev servers are killed when the sandbox stops. Configure `resume.commands` in `.pi/vercel-sandbox.json` to restart them automatically.
- **Network latency** — Every file read, write, and command execution goes over HTTPS to the cloud sandbox. Operations that make many small reads (e.g., large `grep` across many files) may be slower than local execution.
- **Resume latency** — The first command after sandbox resume takes ~2 seconds while the VM boots from the snapshot.
- **Cost** — Vercel bills compute per vCPU-minute and snapshot storage per GB-month. See [Vercel Sandbox pricing](https://vercel.com/docs/vercel-sandbox/pricing).

## License

Apache-2.0