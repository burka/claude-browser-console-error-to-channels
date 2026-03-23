/**
 * Client-side helper for reporting to the Claude console error channel.
 *
 * Safe to import unconditionally — no-ops gracefully when the Vite plugin
 * isn't active (production builds, SSR, tests, plugin not installed).
 *
 * Usage:
 *   import { reportToClaude } from 'claude-browser-console-error-to-channels/client'
 *
 *   reportToClaude('Checkout flow entered invalid state', { source: 'checkout' })
 *   reportToClaude(caughtError)
 *   reportToClaude(new Error('this should not happen'))
 */

/**
 * Report an error or message to the active Claude Code session.
 *
 * @param {string|Error} messageOrError — what to report
 * @param {object} [opts]
 * @param {string} [opts.source] — label for where this came from (default: "app")
 */
let _warnedOnce = false;

export function reportToClaude(messageOrError, opts) {
  if (
    typeof window !== "undefined" &&
    window.__claudeConsole &&
    typeof window.__claudeConsole.report === "function"
  ) {
    window.__claudeConsole.report(messageOrError, opts);
  } else if (typeof window !== "undefined" && !_warnedOnce) {
    _warnedOnce = true;
    console.warn(
      "[claude-console] reportToClaude called but plugin is not active — call will be ignored",
    );
  }
}
