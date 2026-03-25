# claude-browser-console-error-to-channels

Push browser console errors from your Vite dev server straight into a [Claude Code](https://claude.com/claude-code) session via the [Channels](https://code.claude.com/docs/en/channels-reference) API.

Claude sees every `console.error`, uncaught exception, and unhandled promise rejection as it happens — and can immediately analyze and fix the root cause in your codebase.

## Quick start

Four steps — under a minute:

```bash
npm install -D claude-browser-console-error-to-channels
```

```js
// vite.config.ts — add one line
import consoleErrorChannel from 'claude-browser-console-error-to-channels'
export default defineConfig({ plugins: [consoleErrorChannel()] })
```

```jsonc
// .mcp.json — register the channel server
{ "mcpServers": { "console-errors": {
  "command": "node",
  "args": ["./node_modules/claude-browser-console-error-to-channels/src/server.mjs"]
}}}
```

```bash
# Start Claude Code with channel support, then start Vite
claude --dangerously-load-development-channels server:console-errors
npm run dev
```

That's it. Browser errors now flow into your Claude Code session automatically.

## How it works

```
Browser (Vite dev)                     Local machine
+------------------+    POST /error    +------------------------+  stdio   +--------------+
| injected script  | ----------------> | MCP channel server     | -------> | Claude Code  |
| console.error    |   127.0.0.1:*     | batches & debounces    |          |              |
| onerror          |                   | errors, then pushes    |          |              |
| unhandledrej.    |                   | channel notifications  |          |              |
+------------------+                   +------------------------+          +--------------+
                                          ^
Vite plugin ---- POST /hmr (on HMR) ------+
```

**Two pieces, one package:**

| Component | What it does |
|-----------|-------------|
| **MCP channel server** (`src/server.mjs`) | Spawned by Claude Code. Listens on a dynamic port, receives errors from the browser, batches them, and pushes `notifications/claude/channel` over stdio. |
| **Vite plugin** (`src/plugin.mjs`) | Added to your Vite config. Injects a small error-capture script into your dev HTML. Signals the server on HMR updates so it can pause during module replacement. |

### Port discovery

The server listens on an OS-assigned port (no conflicts, multiple instances safe) and writes it to a temp file:

```
<os.tmpdir()>/claude-console-<sha256(cwd)[0:12]>.json
```

The Vite plugin reads this file on dev server start. If the channel server isn't running, the plugin is a silent no-op. The file includes the server's PID — stale files from crashed processes are detected and ignored.

### Smart batching

Errors aren't sent one-by-one. Instead:

- **3s batch window** — after the first error, wait 3 seconds to collect more before sending
- **1 minute cooldown** — the same error is sent at most once per minute
- **5 minute expiry** — if an error hasn't fired in 5 minutes and reappears, it's treated as new
- **Frequency prefix** — Claude sees how hard the error hits:
  - `TypeError: x is undefined` — happened once
  - `3x TypeError: x is undefined` — happened 3 times
  - `200x in 1 minute!!!! TypeError: x is undefined` — spamming hard

### HMR awareness

During hot module replacement, errors from stale modules are noise. When Vite triggers HMR:

1. The plugin signals the channel server (`POST /hmr`)
2. The server pauses error forwarding for 2 seconds
3. Any errors during the pause are discarded
4. After settling, the browser re-fires any errors that persist in the new code

## Setup

### 1. Install

```bash
npm install -D claude-browser-console-error-to-channels
```

### 2. Add the Vite plugin

```js
// vite.config.ts
import consoleErrorChannel from 'claude-browser-console-error-to-channels'

export default defineConfig({
  plugins: [
    consoleErrorChannel(),
    // ... your other plugins
  ],
})
```

The plugin only activates in dev mode (`apply: "serve"`) and adds zero bytes to production builds. The `reportToClaude` client import is a no-op when the plugin is inactive, so it's safe to leave in production code.

### 3. Register the MCP channel server

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "console-errors": {
      "command": "node",
      "args": ["./node_modules/claude-browser-console-error-to-channels/src/server.mjs"]
    }
  }
}
```

With npm you can also use `"command": "npx", "args": ["claude-console-errors"]`. The direct path is more reliable across package managers (pnpm, yarn).

### 4. Start Claude Code

During the [research preview](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview), custom channels require a flag:

```bash
claude --dangerously-load-development-channels server:console-errors
```

This flag is required during the research preview to load custom channel servers. It only affects channel loading and does not disable any other safety checks.

Then start your Vite dev server as usual. Console errors in the browser will now appear in your Claude Code session.

## What Claude sees

Errors arrive as `<channel>` tags in Claude's context:

```
<channel source="console-errors" error_count="2">
3x TypeError: Cannot read properties of undefined (reading 'map')
  at console.error
  at App.tsx:42:15
  at renderWithHooks (react-dom.development.js:16305:18)

Uncaught ReferenceError: fetchData is not defined
  at http://localhost:5173/src/utils.ts:8:3
  at utils.ts:8:3
</channel>
```

## Reporting from application code

Beyond automatic error capture, you can report anything to Claude from your app code:

```js
import { reportToClaude } from 'claude-browser-console-error-to-channels/client'

// Report a string
reportToClaude('Checkout flow entered invalid state', { source: 'checkout' })

// Report a caught error
try {
  await riskyOperation()
} catch (err) {
  reportToClaude(err, { source: 'riskyOperation' })
}

// Report from a React error boundary
componentDidCatch(error, info) {
  reportToClaude(error, { source: 'ErrorBoundary' })
}
```

The import is safe to use unconditionally — it no-ops when the plugin isn't active (production builds, SSR, tests). The `source` option labels where the report came from; it defaults to `"app"`.

You can also use the global API directly without importing:

```js
window.__claudeConsole?.report('something unexpected happened')
window.__claudeConsole?.report(new Error('bad state'), { source: 'auth' })
```

## Security

The port file and HTTP endpoint are hardened against prompt injection — without this, any local process could push arbitrary text into your Claude session.

- **File permissions**: the port file is written with mode `0600` (owner-only) so other users on the machine can't read the port or token. On Windows, where Unix permissions don't apply, the token alone provides protection.
- **Auth token**: a cryptographically random 256-bit token is generated per server session and stored in the port file. Every HTTP request must include it as `X-Token` header — requests without a valid token get a `403`. The comparison uses `timingSafeEqual` to prevent timing attacks.
- **localhost-only**: the HTTP server binds to `127.0.0.1`, never `0.0.0.0`.

The auth token is embedded in the injected dev script and visible in browser devtools. Since the server only binds to 127.0.0.1 and CORS is restricted to localhost origins, this is equivalent to any localhost dev server's trust model.

## Multiple instances

Each project gets its own port file based on CWD hash, so you can run multiple Vite dev servers with their own Claude Code sessions simultaneously — no port conflicts.

## Try the example

A minimal Vite app is included to test all error capture paths:

```bash
# Install dependencies (root + example)
npm install && cd example && npm install && cd ..

# Terminal 1 — start Claude Code with channel support:
claude --dangerously-load-development-channels server:console-errors

# Terminal 2 — start the Vite dev server (from project root):
npm run dev
```

**Important:** Start Claude Code *first* — the channel server needs ~1 second to write its port file before Vite can discover it.

Open http://localhost:5173 and click the buttons to trigger different error types. The page shows a green/red connection indicator. Watch errors appear in your Claude Code session — try the spam button to see `90x` batching in action.

## Troubleshooting

**"channel server not found — plugin disabled"**
The Vite plugin could not discover the MCP channel server. Make sure:
1. The `console-errors` entry exists in your `.mcp.json`
2. Claude Code is running with `--dangerously-load-development-channels server:console-errors`
3. Claude Code was started *before* the Vite dev server (the server needs ~1s to write its port file)

**"Another Claude session (PID ...) is already collecting..."**
Another Claude Code instance is already monitoring this project directory. Close that session first, or if it crashed, delete the stale port file. Find it with:
```bash
node --input-type=module -e "import('./node_modules/claude-browser-console-error-to-channels/src/port-file.mjs').then(m => console.log(m.portFilePath()))"
```

**Errors not appearing in Claude**
- Check that the Vite plugin logs `connected to channel server on port <N>` on startup
- Open browser devtools → Network tab → look for POST requests to `127.0.0.1:<port>/error`
- If requests show 403, the token may be stale — restart both Claude Code and Vite

## Uninstall

1. Remove `consoleErrorChannel()` from your `vite.config.ts` plugins array
2. Remove the `console-errors` entry from `.mcp.json`
3. `npm uninstall claude-browser-console-error-to-channels`

## Requirements

- Node.js >= 18
- Vite >= 5
- Claude Code >= 2.1.80

## License

MIT
