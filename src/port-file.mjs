/**
 * Cross-OS port discovery via a temp file keyed to the project directory.
 *
 * The MCP channel server writes { port, pid, token } on startup.
 * The Vite plugin reads it to discover the port and auth token.
 * File path: <tmpdir>/claude-console-<sha256(cwd)[0:12]>.json
 *
 * Security:
 * - File permissions 0o600 (owner-only read/write) on Linux/macOS
 * - Random token required on every HTTP request to prevent prompt injection
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function cwdHash(cwd) {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

function userDir() {
  const dir = join(tmpdir(), `claude-console-${process.getuid ? process.getuid() : "default"}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function portFilePath(cwd = process.cwd()) {
  return join(userDir(), `claude-console-${cwdHash(cwd)}.json`);
}

/**
 * Generate a cryptographically random token for request authentication.
 */
export function generateToken() {
  return randomBytes(32).toString("hex");
}

/**
 * Atomically write the port file (write to .tmp, rename, chmod 600).
 */
export function writePortFile(port, token, cwd = process.cwd()) {
  const target = portFilePath(cwd);
  const tmp = `${target}.tmp`;
  const data = JSON.stringify({ port, pid: process.pid, token, cwd });
  writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, target);
  // chmod the final file too — rename preserves source permissions on most
  // OSes, but be explicit to be safe.
  try {
    chmodSync(target, 0o600);
  } catch {
    // Windows doesn't support Unix permissions — the token still protects us.
  }
  return target;
}

/**
 * Read the port file. Returns { port, pid, token, cwd } or null if:
 * - file doesn't exist
 * - file is corrupt
 * - the CWD in the file doesn't match (hash collision)
 * - the PID in the file is no longer running
 */
export function readPortFile(cwd = process.cwd()) {
  const filePath = portFilePath(cwd);
  let raw;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    !data ||
    typeof data.port !== "number" ||
    typeof data.pid !== "number" ||
    typeof data.token !== "string" ||
    typeof data.cwd !== "string"
  ) {
    return null;
  }

  // Guard against hash collisions — the stored CWD must match exactly
  if (data.cwd !== cwd) {
    return null;
  }

  // Check if the PID is still alive
  try {
    process.kill(data.pid, 0); // signal 0 = existence check, no actual signal
  } catch {
    // Process is gone — stale file
    return null;
  }

  return data;
}

/**
 * Remove the port file (best-effort, ignores errors).
 */
export function removePortFile(cwd = process.cwd()) {
  try {
    unlinkSync(portFilePath(cwd));
  } catch {
    // already gone — fine
  }
}
