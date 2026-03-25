import type { Plugin } from "vite";

export interface ConsoleErrorChannelOptions {
  /** Override the working directory used for port-file discovery. */
  cwd?: string;
  /** Number of port-file read attempts before giving up (default: 10). */
  discoveryAttempts?: number;
  /** Milliseconds between discovery attempts (default: 1000). */
  discoveryIntervalMs?: number;
}

export default function consoleErrorChannel(opts?: ConsoleErrorChannelOptions): Plugin;
