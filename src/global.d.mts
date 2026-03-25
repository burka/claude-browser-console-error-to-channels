import type { ReportOptions } from "./client.d.mts";

interface ClaudeConsole {
  report(messageOrError: string | Error, opts?: ReportOptions): void;
}

declare global {
  interface Window {
    __claudeConsole?: ClaudeConsole;
  }
}

export {};
