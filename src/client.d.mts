export interface ReportOptions {
  /** Label for where this report came from (default: "app") */
  source?: string;
}

/**
 * Report an error or message to the active Claude Code session.
 * Safe to call unconditionally — no-ops when the plugin is not active.
 */
export function reportToClaude(messageOrError: string | Error, opts?: ReportOptions): void;
