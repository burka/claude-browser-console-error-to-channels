/**
 * Comprehensive test suite for claude-browser-console-error-to-channels.
 * Uses Node.js built-in test runner (node:test + node:assert).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  generateToken,
  portFilePath,
  readPortFile,
  removePortFile,
  writePortFile,
} from "../src/port-file.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const SERVER_PATH = join(PROJECT_ROOT, "src/server.mjs");

/**
 * Return a scratch directory path that is unique to the label + current time.
 * The directory is created on first use by writePortFile or mkdirSync callers.
 */
function scratchCwd(label) {
  const hash = createHash("sha256")
    .update(label + Date.now() + Math.random())
    .digest("hex")
    .slice(0, 8);
  return join(tmpdir(), `test-cce-${hash}`);
}

/**
 * Poll until predicate() returns truthy or timeout expires.
 */
function waitFor(predicate, timeoutMs = 3000, intervalMs = 50) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function check() {
      const result = predicate();
      if (result) return resolve(result);
      if (Date.now() >= deadline) return reject(new Error("waitFor timed out"));
      setTimeout(check, intervalMs);
    }
    check();
  });
}

/**
 * Start the server as a child process.
 *
 * The server detects whether another session is already running by reading the
 * port file keyed to its CWD. By giving each server test its own unique CWD,
 * they never collide with each other or with a real running Claude session.
 *
 * `tail -f /dev/null |` keeps stdin open so the stdin "end" cleanup handler
 * does not fire immediately.  `detached: true` puts the shell and all its
 * children into a new process group so we can kill the entire group at once
 * with `process.kill(-child.pid, signal)`.
 *
 * Returns { child, cwd, getPortFile }.
 */
function startServer(label = "server") {
  const cwd = scratchCwd(label);
  mkdirSync(cwd, { recursive: true });

  const child = spawn(`tail -f /dev/null | node ${SERVER_PATH}`, [], {
    shell: true,
    cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Drain stderr/stdout so the subprocess buffer does not block.
  child.stderr.on("data", () => {});
  child.stdout.on("data", () => {});

  async function getPortFile(timeoutMs = 5000) {
    return waitFor(() => readPortFile(cwd), timeoutMs);
  }

  return { child, cwd, getPortFile };
}

/**
 * Kill a server started with startServer() by sending SIGTERM to the whole
 * process group, then wait for the shell process to exit.
 */
function killServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Process group may already be gone — fall back to direct kill.
      child.kill("SIGTERM");
    }
  });
}

// ---------------------------------------------------------------------------
// port-file.mjs tests
// ---------------------------------------------------------------------------

describe("portFilePath", () => {
  it("returns a deterministic path for the same CWD", () => {
    const cwd = "/some/project";
    const p1 = portFilePath(cwd);
    const p2 = portFilePath(cwd);
    assert.equal(p1, p2);
  });

  it("returns a different path for a different CWD", () => {
    const p1 = portFilePath("/project/a");
    const p2 = portFilePath("/project/b");
    assert.notEqual(p1, p2);
  });

  it("path is inside the OS temp directory", () => {
    const p = portFilePath("/any/project");
    assert.ok(p.startsWith(tmpdir()), `expected path under tmpdir, got: ${p}`);
  });

  it("filename contains a 12-char hex hash segment", () => {
    const p = portFilePath("/test/cwd");
    const filename = p.split("/").pop();
    const match = filename.match(/claude-console-([0-9a-f]{12})\.json$/);
    assert.ok(match, `filename does not match expected pattern: ${filename}`);
  });
});

describe("generateToken", () => {
  it("returns a 64-character hex string", () => {
    const token = generateToken();
    assert.equal(typeof token, "string");
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  it("returns a different token each time", () => {
    const t1 = generateToken();
    const t2 = generateToken();
    assert.notEqual(t1, t2);
  });
});

describe("writePortFile + readPortFile round-trip", () => {
  it("written data is read back correctly", () => {
    const cwd = scratchCwd("roundtrip");
    const port = 12345;
    const token = generateToken();

    writePortFile(port, token, cwd);
    const data = readPortFile(cwd);

    assert.ok(data, "readPortFile should return data");
    assert.equal(data.port, port);
    assert.equal(data.token, token);
    assert.equal(data.cwd, cwd);
    assert.equal(data.pid, process.pid);

    removePortFile(cwd);
  });
});

describe("readPortFile", () => {
  it("returns null for a nonexistent file", () => {
    const cwd = scratchCwd("nonexistent");
    assert.equal(readPortFile(cwd), null);
  });

  it("returns null when the stored CWD does not match (hash collision guard)", () => {
    const cwd = scratchCwd("collision-guard");
    const token = generateToken();

    // Write the file manually with a different cwd field to simulate a hash
    // collision between two distinct directories.
    const filePath = portFilePath(cwd);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ port: 1234, pid: process.pid, token, cwd: "/different/cwd" }),
      { mode: 0o600 },
    );

    assert.equal(readPortFile(cwd), null, "CWD mismatch should return null");
    removePortFile(cwd);
  });

  it("returns null for a dead PID", () => {
    const cwd = scratchCwd("dead-pid");
    const token = generateToken();
    const filePath = portFilePath(cwd);
    mkdirSync(dirname(filePath), { recursive: true });

    // Spawn a trivially short-lived process, capture its PID, wait for it to
    // exit, then write a port file pointing at that now-dead PID.
    const dead = spawn("true", [], { shell: true });
    const deadPid = dead.pid;

    return new Promise((resolve) => {
      dead.on("exit", () => {
        writeFileSync(filePath, JSON.stringify({ port: 1234, pid: deadPid, token, cwd }), {
          mode: 0o600,
        });
        // Brief pause so the OS fully reaps the process.
        setTimeout(() => {
          const result = readPortFile(cwd);
          removePortFile(cwd);
          assert.equal(result, null, "dead PID should return null");
          resolve();
        }, 50);
      });
    });
  });

  it("returns null for corrupt JSON", () => {
    const cwd = scratchCwd("corrupt-json");
    const filePath = portFilePath(cwd);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "not-valid-json{{{", { mode: 0o600 });
    assert.equal(readPortFile(cwd), null);
    removePortFile(cwd);
  });

  it("returns null when required fields are missing", () => {
    const cwd = scratchCwd("missing-fields");
    const filePath = portFilePath(cwd);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ port: 1234 }), { mode: 0o600 });
    assert.equal(readPortFile(cwd), null);
    removePortFile(cwd);
  });
});

describe("removePortFile", () => {
  it("is idempotent — calling twice does not throw", () => {
    const cwd = scratchCwd("idempotent");
    writePortFile(1234, generateToken(), cwd);
    assert.doesNotThrow(() => removePortFile(cwd));
    assert.doesNotThrow(() => removePortFile(cwd));
  });

  it("does not throw when file never existed", () => {
    const cwd = scratchCwd("never-existed");
    assert.doesNotThrow(() => removePortFile(cwd));
  });
});

// Unix-only permission tests
if (platform() !== "win32") {
  describe("port file permissions (Unix)", () => {
    it("port file has 0o600 permissions", () => {
      const cwd = scratchCwd("perms-file");
      writePortFile(1234, generateToken(), cwd);
      const filePath = portFilePath(cwd);
      const mode = statSync(filePath).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
      removePortFile(cwd);
    });

    it("port file is inside a user-private directory with 0o700 permissions", () => {
      const cwd = scratchCwd("perms-dir");
      writePortFile(1234, generateToken(), cwd);
      const filePath = portFilePath(cwd);
      const dirPath = dirname(filePath);
      const mode = statSync(dirPath).mode & 0o777;
      assert.equal(mode, 0o700, `expected 0o700 on parent dir, got 0o${mode.toString(8)}`);
      removePortFile(cwd);
    });
  });
}

// ---------------------------------------------------------------------------
// server.mjs integration tests
// ---------------------------------------------------------------------------

describe("server.mjs integration", () => {
  let child;
  let serverCwd;
  let serverInfo; // { port, token, pid, cwd }

  before(async () => {
    const started = startServer("integration");
    child = started.child;
    serverCwd = started.cwd;
    serverInfo = await started.getPortFile(5000);
  });

  after(async () => {
    if (child) {
      await killServer(child);
      child = null;
    }
  });

  it("writes port file on startup", () => {
    assert.ok(serverInfo, "port file should exist after server starts");
    assert.equal(typeof serverInfo.port, "number");
    assert.equal(typeof serverInfo.token, "string");
    assert.equal(serverInfo.token.length, 64);
  });

  it("POST /error without token returns 403", async () => {
    const { port } = serverInfo;
    const res = await fetch(`http://127.0.0.1:${port}/error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "test", source: "test", stack: "" }),
    });
    assert.equal(res.status, 403);
  });

  it("POST /error with wrong token returns 403", async () => {
    const { port } = serverInfo;
    const wrongToken = generateToken();
    const res = await fetch(`http://127.0.0.1:${port}/error`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Token": wrongToken },
      body: JSON.stringify({ message: "test", source: "test", stack: "" }),
    });
    assert.equal(res.status, 403);
  });

  it("POST /error with correct token returns 200", async () => {
    const { port, token } = serverInfo;
    const res = await fetch(`http://127.0.0.1:${port}/error`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Token": token },
      body: JSON.stringify({ message: "test error", source: "test.js:1:1", stack: "" }),
    });
    assert.equal(res.status, 200);
  });

  it("POST /error with body > 64KB returns 413", async () => {
    const { port, token } = serverInfo;
    const bigPayload = "x".repeat(65537);
    const res = await fetch(`http://127.0.0.1:${port}/error`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Token": token },
      body: bigPayload,
    });
    assert.equal(res.status, 413);
  });

  it("GET /error returns 405", async () => {
    const { port, token } = serverInfo;
    const res = await fetch(`http://127.0.0.1:${port}/error`, {
      method: "GET",
      headers: { "X-Token": token },
    });
    assert.equal(res.status, 405);
  });

  it("POST /unknown-path returns 404", async () => {
    const { port, token } = serverInfo;
    const res = await fetch(`http://127.0.0.1:${port}/unknown`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Token": token },
      body: "{}",
    });
    assert.equal(res.status, 404);
  });

  it("POST /error with invalid JSON returns 400", async () => {
    const { port, token } = serverInfo;
    const res = await fetch(`http://127.0.0.1:${port}/error`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Token": token },
      body: "not-valid-json{{",
    });
    assert.equal(res.status, 400);
  });

  it("CORS: localhost origin is reflected in Access-Control-Allow-Origin", async () => {
    const { port, token } = serverInfo;
    const res = await fetch(`http://127.0.0.1:${port}/error`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Token": token,
        Origin: "http://localhost:5173",
      },
      body: JSON.stringify({ message: "cors test", source: "", stack: "" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5173");
  });

  it("CORS: non-localhost origin gets no Access-Control-Allow-Origin header", async () => {
    const { port, token } = serverInfo;
    const res = await fetch(`http://127.0.0.1:${port}/error`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Token": token,
        Origin: "http://evil.com",
      },
      body: JSON.stringify({ message: "cors test", source: "", stack: "" }),
    });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  it("POST /hmr with correct token returns 200", async () => {
    const { port, token } = serverInfo;
    const res = await fetch(`http://127.0.0.1:${port}/hmr`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Token": token },
      body: "{}",
    });
    assert.equal(res.status, 200);
  });

  it("POST /error with <script> in message is accepted (sanitised server-side)", async () => {
    const { port, token } = serverInfo;
    const res = await fetch(`http://127.0.0.1:${port}/error`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Token": token },
      body: JSON.stringify({
        message: "<script>alert('xss')</script>",
        source: "test.js",
        stack: "",
      }),
    });
    // Server accepts it and sanitises before forwarding to MCP.
    assert.equal(res.status, 200);
  });

  it("OPTIONS preflight with localhost origin returns 204", async () => {
    const { port } = serverInfo;
    const res = await fetch(`http://127.0.0.1:${port}/error`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5173");
  });

  it("server cleanup: killing server removes the port file", async () => {
    const before = readPortFile(serverCwd);
    assert.ok(before, "port file should exist before kill");

    await killServer(child);
    child = null; // prevent after() from double-killing.

    // Give the process up to 1 second to remove the port file.
    await waitFor(() => readPortFile(serverCwd) === null, 1000).catch(() => {});

    const after = readPortFile(serverCwd);
    assert.equal(after, null, "port file should be removed after server exits");
  });
});

// ---------------------------------------------------------------------------
// client.mjs tests
// ---------------------------------------------------------------------------

describe("client.mjs — reportToClaude", () => {
  it("does not throw when window is undefined (Node.js environment)", async () => {
    const { reportToClaude } = await import("../src/client.mjs");
    assert.doesNotThrow(() => reportToClaude("test message"));
    assert.doesNotThrow(() => reportToClaude(new Error("test error")));
    assert.doesNotThrow(() => reportToClaude("msg", { source: "test" }));
  });

  it("does not throw when called repeatedly (warn-once guard)", async () => {
    const { reportToClaude } = await import("../src/client.mjs");
    for (let i = 0; i < 5; i++) {
      assert.doesNotThrow(() => reportToClaude("repeat call"));
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers shared by new test suites
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Short timing overrides so batcher tests don't take seconds.
const FAST = {
  batchWaitMs: 50,
  cooldownMs: 200,
  expiryMs: 500,
  hmrSettleMs: 50,
  hmrRateLimitMs: 100,
  hmrMaxPauseMs: 300,
  maxEntries: 5,
};

// ---------------------------------------------------------------------------
// ErrorBatcher unit tests
// ---------------------------------------------------------------------------

import { ErrorBatcher } from "../src/batcher.mjs";

describe("ErrorBatcher — track + flush basics", () => {
  it("calls onFlush with error message after batchWaitMs", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      b.track({ message: "hello world", source: "", stack: "" });
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed.length, 1);
      assert.ok(flushed[0].content.includes("hello world"));
    } finally {
      b.destroy();
    }
  });

  it("onFlush meta contains error_count as string", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      b.track({ message: "err one", source: "", stack: "" });
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed[0].meta.error_count, "1");
    } finally {
      b.destroy();
    }
  });
});

describe("ErrorBatcher — deduplication", () => {
  it("tracking the same error 3 times produces '3x' prefix", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      const err = { message: "dupe error", source: "", stack: "" };
      b.track(err);
      b.track(err);
      b.track(err);
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed.length, 1);
      assert.ok(flushed[0].content.includes("3x "), `expected "3x " in "${flushed[0].content}"`);
    } finally {
      b.destroy();
    }
  });

  it("same message from different sources counts as distinct errors", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      b.track({ message: "shared msg", source: "a.js", stack: "" });
      b.track({ message: "shared msg", source: "b.js", stack: "" });
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed[0].meta.error_count, "2");
    } finally {
      b.destroy();
    }
  });
});

describe("ErrorBatcher — cooldown", () => {
  it("same error flushed once is suppressed on immediate re-track", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      const err = { message: "cooldown error", source: "", stack: "" };

      // First flush
      b.track(err);
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed.length, 1);

      // Track again immediately — cooldown should suppress it
      b.track(err);
      await sleep(FAST.batchWaitMs + 30);
      // Still only one flush
      assert.equal(flushed.length, 1);
    } finally {
      b.destroy();
    }
  });

  it("same error is flushed again after cooldown expires", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      const err = { message: "post-cooldown error", source: "", stack: "" };

      b.track(err);
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed.length, 1);

      // Wait for cooldown to expire
      await sleep(FAST.cooldownMs + 50);

      b.track(err);
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed.length, 2);
    } finally {
      b.destroy();
    }
  });
});

describe("ErrorBatcher — expiry", () => {
  it("same error tracked after expiryMs is treated as new (no count prefix)", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      const err = { message: "expiry test", source: "", stack: "" };

      // First track + flush
      b.track(err);
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed.length, 1);

      // Wait for cooldown AND expiry
      await sleep(Math.max(FAST.cooldownMs, FAST.expiryMs) + 50);

      // Re-track: entry should be treated as new — no count prefix
      b.track(err);
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed.length, 2);
      // No count prefix — it's a fresh entry with count=1
      assert.ok(
        !flushed[1].content.match(/^\d+x /),
        `did not expect count prefix: "${flushed[1].content}"`,
      );
    } finally {
      b.destroy();
    }
  });
});

describe("ErrorBatcher — frequency prefix >= 100", () => {
  it("100+ occurrences use 'Nx in M minute(s)!!!!' prefix", () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      const err = { message: "high freq error", source: "", stack: "" };
      for (let i = 0; i < 100; i++) {
        b.track(err);
      }
      // Call flush directly to avoid waiting for batchWaitMs
      b.flush();
      assert.equal(flushed.length, 1);
      assert.ok(
        flushed[0].content.match(/\d+x in \d+ minute/),
        `expected "Nx in M minute" in "${flushed[0].content}"`,
      );
      assert.ok(flushed[0].content.includes("!!!!"));
    } finally {
      b.destroy();
    }
  });
});

describe("ErrorBatcher — max entries eviction", () => {
  it("oldest entry is evicted when maxEntries is exceeded", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      // Track maxEntries unique errors — oldest first
      for (let i = 0; i < FAST.maxEntries; i++) {
        b.track({ message: `error-${i}`, source: "", stack: "" });
      }
      // Map is now full; tracking one more should evict the oldest
      b.track({ message: "error-new", source: "", stack: "" });
      assert.equal(b._tracked.size, FAST.maxEntries);

      // The oldest entry (error-0) should have been evicted
      const key = "error-0\0";
      assert.ok(!b._tracked.has(key), "oldest entry should have been evicted");
    } finally {
      b.destroy();
    }
  });
});

describe("ErrorBatcher — multiple errors batched", () => {
  it("three distinct errors appear in one flush separated by blank lines", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      b.track({ message: "alpha", source: "", stack: "" });
      b.track({ message: "beta", source: "", stack: "" });
      b.track({ message: "gamma", source: "", stack: "" });
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed.length, 1);
      assert.equal(flushed[0].meta.error_count, "3");
      assert.ok(flushed[0].content.includes("alpha"));
      assert.ok(flushed[0].content.includes("beta"));
      assert.ok(flushed[0].content.includes("gamma"));
      // Errors are joined by double newlines
      assert.ok(flushed[0].content.includes("\n\n"));
    } finally {
      b.destroy();
    }
  });
});

describe("ErrorBatcher — sanitise", () => {
  it("HTML characters in message are escaped", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      b.track({ message: "<script>alert('xss')</script>", source: "", stack: "" });
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed.length, 1);
      assert.ok(flushed[0].content.includes("&lt;script&gt;"));
      assert.ok(!flushed[0].content.includes("<script>"));
    } finally {
      b.destroy();
    }
  });

  it("stack frames are included and capped at 4 frames", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      const stack = [
        "Error: boom",
        "  at fn1 (a.js:1:1)",
        "  at fn2 (b.js:2:2)",
        "  at fn3 (c.js:3:3)",
        "  at fn4 (d.js:4:4)",
        "  at fn5 (e.js:5:5)",
      ].join("\n");
      b.track({ message: "boom", source: "", stack });
      await sleep(FAST.batchWaitMs + 30);
      // Should include at most 4 stack frames
      const content = flushed[0].content;
      const frames = content.split("\n").filter((l) => l.trim().startsWith("at "));
      assert.ok(frames.length <= 4, `expected at most 4 frames, got ${frames.length}`);
    } finally {
      b.destroy();
    }
  });
});

describe("ErrorBatcher — input validation", () => {
  it("track(null) does not throw and does not call onFlush", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      assert.doesNotThrow(() => b.track(null));
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed.length, 0);
    } finally {
      b.destroy();
    }
  });

  it("track('string') does not throw and does not call onFlush", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      assert.doesNotThrow(() => b.track("plain string"));
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed.length, 0);
    } finally {
      b.destroy();
    }
  });

  it("track({}) (no message) does not throw and does not call onFlush", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      assert.doesNotThrow(() => b.track({}));
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed.length, 0);
    } finally {
      b.destroy();
    }
  });

  it("track with numeric message does not call onFlush", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      assert.doesNotThrow(() => b.track({ message: 42 }));
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed.length, 0);
    } finally {
      b.destroy();
    }
  });
});

describe("ErrorBatcher — destroy", () => {
  it("after destroy(), timers are cancelled and onFlush is never called", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    b.track({ message: "should be dropped", source: "", stack: "" });
    b.destroy();
    await sleep(FAST.batchWaitMs + 30);
    assert.equal(flushed.length, 0);
  });
});

// ---------------------------------------------------------------------------
// ErrorBatcher — HMR tests
// ---------------------------------------------------------------------------

describe("ErrorBatcher — HMR pause drops errors", () => {
  it("errors tracked while paused are never flushed", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      b.hmrPause();
      b.track({ message: "dropped during hmr", source: "", stack: "" });
      // Wait well past batchWaitMs and hmrSettleMs
      await sleep(FAST.hmrSettleMs + FAST.batchWaitMs + 60);
      assert.equal(flushed.length, 0, "no flush should occur while HMR-paused");
    } finally {
      b.destroy();
    }
  });
});

describe("ErrorBatcher — HMR pause resume", () => {
  it("after hmrSettleMs the batcher accepts new errors again", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      b.hmrPause();
      // Wait for HMR settle
      await sleep(FAST.hmrSettleMs + 30);
      // Now track a new error — should be processed
      b.track({ message: "post-hmr error", source: "", stack: "" });
      await sleep(FAST.batchWaitMs + 30);
      assert.equal(flushed.length, 1);
      assert.ok(flushed[0].content.includes("post-hmr error"));
    } finally {
      b.destroy();
    }
  });
});

describe("ErrorBatcher — HMR pause resets counts", () => {
  it("accumulated count is zeroed after hmrPause resume", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      const err = { message: "hmr-reset error", source: "", stack: "" };

      // Track 3 times to accumulate count
      b.track(err);
      b.track(err);
      b.track(err);

      // Pause before flush fires
      b.hmrPause();

      // Wait for settle
      await sleep(FAST.hmrSettleMs + 30);

      // Now track once more — count should start fresh (no "3x" accumulated)
      b.track(err);
      await sleep(FAST.batchWaitMs + 30);

      assert.equal(flushed.length, 1);
      // Expect no multi-count prefix — count was reset during hmrResume
      assert.ok(
        !flushed[0].content.startsWith("3x "),
        `expected no accumulated count, got: "${flushed[0].content}"`,
      );
      assert.ok(
        !flushed[0].content.startsWith("4x "),
        `expected no accumulated count, got: "${flushed[0].content}"`,
      );
    } finally {
      b.destroy();
    }
  });
});

describe("ErrorBatcher — HMR rate limit", () => {
  it("second hmrPause within hmrRateLimitMs is ignored", async () => {
    const flushed = [];
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), FAST);
    try {
      b.hmrPause(); // accepted — sets _lastHmrAt
      // Record the settle timer start time
      const pauseStart = Date.now();

      // Immediately call again — should be rate-limited (ignored)
      b.hmrPause();

      // Wait for the original settle timer to fire
      await sleep(FAST.hmrSettleMs + 30);

      // Track an error — batcher should now be resumed
      b.track({ message: "after rate-limited hmr", source: "", stack: "" });
      await sleep(FAST.batchWaitMs + 30);

      // Should flush exactly once — confirming the second hmrPause didn't extend the pause
      assert.equal(flushed.length, 1);
      const elapsed = Date.now() - pauseStart;
      // Total time should be close to hmrSettleMs + batchWaitMs, not 2x settle
      assert.ok(
        elapsed < FAST.hmrSettleMs * 2 + FAST.batchWaitMs + 100,
        `rate-limited second pause should not have extended pause, elapsed=${elapsed}ms`,
      );
    } finally {
      b.destroy();
    }
  });
});

describe("ErrorBatcher — HMR max pause watchdog", () => {
  it("force-resumes after hmrMaxPauseMs even if settle timer has not fired yet", async () => {
    const flushed = [];
    // hmrSettleMs (300) > hmrMaxPauseMs (150): the settle timer would fire at 300ms,
    // but the watchdog should force-resume at 150ms when triggered manually.
    const b = new ErrorBatcher((content, meta) => flushed.push({ content, meta }), {
      ...FAST,
      hmrMaxPauseMs: 150,
      hmrSettleMs: 300,
      batchWaitMs: 50,
    });
    try {
      b.hmrPause();

      // Wait past hmrMaxPauseMs but before hmrSettleMs so the settle timer
      // hasn't fired yet
      await sleep(180); // > hmrMaxPauseMs=150, < hmrSettleMs=300

      // The internal watchdog fires every 1000ms (too slow for tests),
      // so drive it manually to simulate the watchdog tick
      b._checkHmrTimeout();

      // Batcher should now be force-resumed; new errors should be tracked
      b.track({ message: "after watchdog", source: "", stack: "" });
      await sleep(b._opts.batchWaitMs + 30);
      assert.equal(flushed.length, 1);
      assert.ok(flushed[0].content.includes("after watchdog"));
    } finally {
      b.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// readBody tests
// ---------------------------------------------------------------------------

import { Readable } from "node:stream";
import { readBody } from "../src/http.mjs";

function mockReq(body) {
  return Readable.from([Buffer.from(body)]);
}

function mockRes() {
  let status = null;
  const res = {
    writeHead(s) {
      status = s;
      return this;
    },
    end() {
      return this;
    },
    get status() {
      return status;
    },
  };
  return res;
}

describe("readBody", () => {
  it("reads a normal body and returns its string content", async () => {
    const req = mockReq("hello");
    const res = mockRes();
    const result = await readBody(req, res, 1024);
    assert.equal(result, "hello");
  });

  it("returns empty string for an empty body", async () => {
    const req = mockReq("");
    const res = mockRes();
    const result = await readBody(req, res, 1024);
    assert.equal(result, "");
  });

  it("returns null and sends 413 when body exceeds maxBytes", async () => {
    const bigBody = "x".repeat(200);
    const req = mockReq(bigBody);
    const res = mockRes();
    const result = await readBody(req, res, 100);
    assert.equal(result, null);
    assert.equal(res.status, 413);
  });

  it("accepts a body exactly at the limit", async () => {
    const body = "x".repeat(100);
    const req = mockReq(body);
    const res = mockRes();
    const result = await readBody(req, res, 100);
    assert.equal(result, body);
  });

  it("handles multi-chunk streams correctly", async () => {
    const chunks = [Buffer.from("foo"), Buffer.from("bar"), Buffer.from("baz")];
    const req = Readable.from(chunks);
    const res = mockRes();
    const result = await readBody(req, res, 1024);
    assert.equal(result, "foobarbaz");
  });
});

// ---------------------------------------------------------------------------
// client.mjs — with window mock (browser-like path)
// ---------------------------------------------------------------------------

describe("client.mjs — with window mock", () => {
  afterEach(() => {
    delete globalThis.window;
  });

  it("calls __claudeConsole.report when available", async () => {
    const calls = [];
    globalThis.window = {
      __claudeConsole: {
        report: (msg, opts) => calls.push({ msg, opts }),
      },
    };
    const mod = await import(`../src/client.mjs?t=${Date.now()}`);
    mod.reportToClaude("test error", { source: "unit-test" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].msg, "test error");
    assert.deepEqual(calls[0].opts, { source: "unit-test" });
  });

  it("calls report with Error objects passed through unchanged", async () => {
    const calls = [];
    globalThis.window = {
      __claudeConsole: { report: (msg, opts) => calls.push({ msg, opts }) },
    };
    const mod = await import(`../src/client.mjs?t=${Date.now() + 1}`);
    const err = new Error("boom");
    mod.reportToClaude(err);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].msg instanceof Error);
    assert.equal(calls[0].msg.message, "boom");
  });

  it("warns once when window exists but __claudeConsole is missing", async () => {
    const warnings = [];
    globalThis.window = {};
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
      const mod = await import(`../src/client.mjs?t=${Date.now() + 2}`);
      mod.reportToClaude("call1");
      mod.reportToClaude("call2");
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes("not active"), `expected "not active" in "${warnings[0]}"`);
    } finally {
      console.warn = origWarn;
    }
  });

  it("does not warn at all when __claudeConsole.report is present", async () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    globalThis.window = {
      __claudeConsole: { report: () => {} },
    };
    try {
      const mod = await import(`../src/client.mjs?t=${Date.now() + 3}`);
      mod.reportToClaude("silent call");
      assert.equal(warnings.length, 0);
    } finally {
      console.warn = origWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// plugin.mjs unit tests
// ---------------------------------------------------------------------------

describe("plugin.mjs", () => {
  it("default export is a factory function", async () => {
    const { default: factory } = await import("../src/plugin.mjs");
    assert.equal(typeof factory, "function");
  });

  it("returns a plugin object with correct name and apply fields", async () => {
    const { default: factory } = await import("../src/plugin.mjs");
    const plugin = factory();
    assert.equal(plugin.name, "claude-console-errors");
    assert.equal(plugin.apply, "serve");
  });

  it("exposes configureServer, transformIndexHtml, and handleHotUpdate methods", async () => {
    const { default: factory } = await import("../src/plugin.mjs");
    const plugin = factory();
    assert.equal(typeof plugin.configureServer, "function");
    assert.equal(typeof plugin.transformIndexHtml, "function");
    assert.equal(typeof plugin.handleHotUpdate, "function");
  });

  it("configureServer discovers a running server and logs info", {
    timeout: 10000,
  }, async () => {
    const { default: factory } = await import("../src/plugin.mjs");
    const cwd = scratchCwd("plugin-discover");
    mkdirSync(cwd, { recursive: true });

    const httpServer = createHttpServer((_req, res) => res.writeHead(200).end("ok"));
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = httpServer.address().port;

    try {
      writePortFile(port, generateToken(), cwd);
      const plugin = factory({ cwd });
      const logs = [];
      const mockServer = {
        config: {
          logger: {
            info: (msg) => logs.push({ level: "info", msg }),
            warn: (msg) => logs.push({ level: "warn", msg }),
          },
        },
      };
      await plugin.configureServer(mockServer);
      const infoLog = logs.find((l) => l.level === "info");
      assert.ok(
        infoLog?.msg.includes("discovered"),
        `expected "discovered" in info log: "${infoLog?.msg}"`,
      );
    } finally {
      await new Promise((resolve) => httpServer.close(resolve));
      removePortFile(cwd);
    }
  });

  it("configureServer logs warn when no server is found", {
    timeout: 10000,
  }, async () => {
    const { default: factory } = await import("../src/plugin.mjs");
    const cwd = scratchCwd("plugin-not-found");
    mkdirSync(cwd, { recursive: true });

    const plugin = factory({ cwd, discoveryAttempts: 1 });
    const logs = [];
    const mockServer = {
      config: {
        logger: {
          info: (msg) => logs.push({ level: "info", msg }),
          warn: (msg) => logs.push({ level: "warn", msg }),
        },
      },
    };
    await plugin.configureServer(mockServer);
    const warnLog = logs.find((l) => l.level === "warn");
    assert.ok(
      warnLog?.msg.includes("not found"),
      `expected "not found" in warning: "${warnLog?.msg}"`,
    );
  });

  it("transformIndexHtml returns empty array when not connected", async () => {
    const { default: factory } = await import("../src/plugin.mjs");
    const plugin = factory();
    const result = plugin.transformIndexHtml();
    assert.deepEqual(result, []);
  });

  it("handleHotUpdate returns undefined when not connected", async () => {
    const { default: factory } = await import("../src/plugin.mjs");
    const plugin = factory();
    const result = plugin.handleHotUpdate({ modules: [] });
    assert.equal(result, undefined);
  });

  it("handleHotUpdate returns undefined for non-JS module updates", async () => {
    const { default: factory } = await import("../src/plugin.mjs");
    const plugin = factory();
    // Even with a connected endpoint, CSS-only HMR should return undefined
    // (this test exercises the no-endpoint path)
    const result = plugin.handleHotUpdate({ modules: [{ url: "style.css" }] });
    assert.equal(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// Task #32: /status endpoint
// ---------------------------------------------------------------------------

describe("server.mjs — /status endpoint", () => {
  let child;
  let info; // { port, token, pid, cwd }

  before(async () => {
    const started = startServer("status-endpoint");
    child = started.child;
    info = await started.getPortFile(5000);
  });

  after(async () => {
    if (child) {
      await killServer(child);
      child = null;
    }
  });

  it("POST /status with correct token returns 200", async () => {
    const base = `http://127.0.0.1:${info.port}`;
    const res = await fetch(`${base}/status`, {
      method: "POST",
      headers: { "X-Token": info.token, "Content-Type": "application/json" },
      body: JSON.stringify({ event: "test" }),
    });
    assert.strictEqual(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Task: 415 Unsupported Media Type
// ---------------------------------------------------------------------------

describe("server.mjs — Content-Type validation", () => {
  let child;
  let info;

  before(async () => {
    const started = startServer("content-type-validation");
    child = started.child;
    info = await started.getPortFile(5000);
  });

  after(async () => {
    if (child) {
      await killServer(child);
      child = null;
    }
  });

  it("POST /error without Content-Type: application/json returns 415", async () => {
    const base = `http://127.0.0.1:${info.port}`;
    const res = await fetch(`${base}/error`, {
      method: "POST",
      headers: { "X-Token": info.token },
      body: "not json",
    });
    assert.strictEqual(res.status, 415);
  });
});

// ---------------------------------------------------------------------------
// Task #33: dual-instance idle guard
// ---------------------------------------------------------------------------

describe("server.mjs — dual instance idle guard", () => {
  let childA;
  let childB;
  let cwdA;
  let pidA; // PID recorded in the port file when server A started
  let stderrB = "";

  before(async () => {
    // Start server A and wait for its port file.
    const startedA = startServer("dual-instance-a");
    childA = startedA.child;
    cwdA = startedA.cwd;
    const portFileA = await startedA.getPortFile(5000);
    // The port file stores the node process PID (not the shell wrapper PID).
    pidA = portFileA.pid;

    // Start server B against the same CWD so it detects server A's port file.
    childB = spawn(`tail -f /dev/null | node ${SERVER_PATH}`, [], {
      shell: true,
      cwd: cwdA,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Collect stderr from server B to assert the idle-guard message.
    childB.stderr.on("data", (chunk) => {
      stderrB += chunk.toString();
    });
    // Drain stdout so the buffer does not block.
    childB.stdout.on("data", () => {});

    // Give server B up to 2 seconds to detect the existing port file and write
    // its idle-guard message to stderr.
    await waitFor(() => stderrB.includes("Another Claude session"), 2000).catch(() => {});
  });

  after(async () => {
    if (childB) {
      await killServer(childB);
      childB = null;
    }
    if (childA) {
      await killServer(childA);
      childA = null;
    }
  });

  it("server B's stderr contains 'Another Claude session'", () => {
    assert.ok(
      stderrB.includes("Another Claude session"),
      `expected idle-guard message in server B stderr, got: "${stderrB}"`,
    );
  });

  it("port file PID still belongs to server A", () => {
    const portData = readPortFile(cwdA);
    assert.ok(portData, "port file should still exist");
    assert.strictEqual(
      portData.pid,
      pidA,
      `expected port file PID ${pidA} (server A), got ${portData?.pid}`,
    );
  });
});
