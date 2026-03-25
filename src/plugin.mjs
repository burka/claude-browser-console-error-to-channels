/**
 * Vite plugin that captures browser console errors and forwards them
 * to the claude-console-errors MCP channel server.
 *
 * The channel server writes its dynamic port and auth token to a temp file
 * keyed by CWD. This plugin reads that file on dev server start.
 * If the channel server isn't running, the plugin is a silent no-op.
 *
 * Usage in vite.config.ts:
 *   import consoleErrorChannel from 'claude-browser-console-error-to-channels'
 *   export default defineConfig({ plugins: [consoleErrorChannel()] })
 */

import { readPortFile } from "./port-file.mjs";

const DISCOVERY_ATTEMPTS = 10;
const DISCOVERY_INTERVAL_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function consoleErrorChannel(opts = {}) {
  const {
    cwd,
    discoveryAttempts = DISCOVERY_ATTEMPTS,
    discoveryIntervalMs = DISCOVERY_INTERVAL_MS,
  } = opts;

  let endpoint = null;
  let token = null;
  let logger = null;
  let warnedFetchFail = false;

  function onFetchFail() {
    if (warnedFetchFail || !logger) return;
    warnedFetchFail = true;
    logger.warn("[claude-console] channel server unreachable — errors may not be forwarded");
  }

  return {
    name: "claude-console-errors",
    apply: "serve", // dev mode only

    async configureServer(server) {
      logger = server.config.logger;

      // The channel server may still be starting — retry a few times.
      for (let i = 0; i < discoveryAttempts; i++) {
        const info = cwd !== undefined ? readPortFile(cwd) : readPortFile();
        if (info) {
          endpoint = `http://127.0.0.1:${info.port}`;
          token = info.token;
          logger.info(
            `[claude-console] discovered channel server\n` +
              `  server:  http://127.0.0.1:${info.port}\n` +
              `  project: ${info.cwd}`,
            { timestamp: true },
          );
          // Let the channel server know we're connected — informational only
          fetch(`${endpoint}/status`, {
            method: "POST",
            body: JSON.stringify({ event: "vite-connected", cwd: info.cwd, port: info.port }),
            headers: { "Content-Type": "application/json", "X-Token": token },
          }).catch(onFetchFail);
          return;
        }
        if (i < discoveryAttempts - 1) await sleep(discoveryIntervalMs);
      }
      logger.warn(
        "[claude-console] channel server not found — plugin disabled.\n" +
          "  Ensure the console-errors MCP server is registered in .mcp.json\n" +
          "  and Claude Code is running with --dangerously-load-development-channels server:console-errors",
      );
    },

    transformIndexHtml() {
      if (!endpoint || !token) return [];
      return [
        {
          tag: "script",
          attrs: { type: "module" },
          children: clientScript(endpoint, token),
          injectTo: "head-prepend",
        },
      ];
    },

    handleHotUpdate({ modules }) {
      if (!endpoint || !token) return;
      const hasJsModule = modules.some(
        (m) => m.url && /\.(js|ts|jsx|tsx|vue|svelte)(\?|$)/.test(m.url),
      );
      if (!hasJsModule) return;
      fetch(`${endpoint}/hmr`, {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json", "X-Token": token },
      }).catch(onFetchFail);
    },
  };
}

// ---------------------------------------------------------------------------
// Client-side script injected into the browser
// ---------------------------------------------------------------------------
// TOKEN is intentionally embedded in the browser script — this only runs in dev mode,
// served to localhost. The token rotates on each channel server restart.
function clientScript(errorEndpoint, authToken) {
  return `
(function() {
  // Uses var and ES5 patterns intentionally for maximum browser compatibility
  var ENDPOINT = ${JSON.stringify(`${errorEndpoint}/error`)};
  var TOKEN = ${JSON.stringify(authToken)};

  function post(data) {
    try {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Token": TOKEN },
        body: JSON.stringify(data),
      }).catch(function() {});
    } catch(e) {}
  }

  function stringify(val) {
    if (val instanceof Error) return val.message;
    if (typeof val === "string") return val;
    try { return JSON.stringify(val); } catch(e) { return String(val); }
  }

  function makePayload(msg, src, stk) {
    return { message: msg, source: src, stack: stk };
  }

  // --- console.error -------------------------------------------------------
  var origError = console.error;
  console.error = function() {
    origError.apply(console, arguments);
    var args = Array.prototype.slice.call(arguments);
    var message = args.map(stringify).join(" ");
    var err = args.find(function(a) { return a instanceof Error; });
    post(makePayload(message, "console.error", err ? err.stack || "" : ""));
  };

  // --- uncaught errors ------------------------------------------------------
  window.addEventListener("error", function(e) {
    post(makePayload(
      e.message || "Unknown error",
      e.filename ? e.filename + ":" + e.lineno + ":" + e.colno : "unknown",
      e.error && e.error.stack ? e.error.stack : ""
    ));
  });

  // --- unhandled promise rejections -----------------------------------------
  window.addEventListener("unhandledrejection", function(e) {
    var reason = e.reason;
    post(makePayload(
      reason instanceof Error ? reason.message : String(reason),
      "unhandledrejection",
      reason instanceof Error ? (reason.stack || "") : ""
    ));
  });

  // --- public API for application code --------------------------------------
  Object.defineProperty(window, "__claudeConsole", {
    value: Object.freeze({
      report: function(messageOrError, opts) {
        opts = opts || {};
        var isErr = messageOrError instanceof Error;
        post(makePayload(
          isErr ? messageOrError.message : String(messageOrError),
          opts.source || "app",
          isErr ? messageOrError.stack || "" : ""
        ));
      },
    }),
    writable: false,
    configurable: false,
  });
})();
`;
}
