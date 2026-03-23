/**
 * Batches, deduplicates, and rate-limits error notifications.
 * HMR-aware: pauses during hot module replacement.
 */

export const DEFAULTS = {
  batchWaitMs: 3_000,
  cooldownMs: 60_000,
  expiryMs: 5 * 60_000,
  hmrSettleMs: 2_000,
  hmrRateLimitMs: 5_000,
  hmrMaxPauseMs: 30_000,
  maxEntries: 1_000,
};

// ---------------------------------------------------------------------------
// Escapes HTML/XML markup in error content to prevent tag injection in MCP channel payloads
// ---------------------------------------------------------------------------
function sanitize(str, maxLen) {
  return String(str).slice(0, maxLen).replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errorKey({ message, source }) {
  return `${message}\0${source}`;
}

export class ErrorBatcher {
  constructor(onFlush, opts = {}) {
    this._opts = { ...DEFAULTS, ...opts };
    this._onFlush = onFlush;
    this._tracked = new Map();
    this._batchTimer = null;
    this._hmrTimer = null;
    this._hmrPaused = false;
    this._hmrPausedSince = 0;
    this._lastHmrAt = 0;
    this._hmrWatchdog = setInterval(() => this._checkHmrTimeout(), 1000);
    this._hmrWatchdog.unref();
  }

  track(err) {
    if (!err || typeof err !== "object" || typeof err.message !== "string") return;
    if (this._hmrPaused) return;

    const message = sanitize(err.message, 500);
    const source = sanitize(err.source || "", 256);
    const stack = sanitize(err.stack || "", 4096);
    const key = errorKey({ message, source });
    const now = Date.now();
    const entry = this._tracked.get(key);

    if (entry && now - entry.lastSeenAt < this._opts.expiryMs) {
      entry.count++;
      entry.lastSeenAt = now;
    } else {
      if (this._tracked.size >= this._opts.maxEntries) {
        this._evictOldest();
      }

      this._tracked.set(key, {
        lastSentAt: 0,
        count: 1,
        firstSeenInWindow: now,
        lastSeenAt: now,
        message,
        source,
        stack,
      });
    }

    if (!this._batchTimer) {
      this._batchTimer = setTimeout(() => this.flush(), this._opts.batchWaitMs);
    }
  }

  flush() {
    this._batchTimer = null;
    if (this._hmrPaused) return;

    const now = Date.now();
    const lines = [];

    for (const entry of this._tracked.values()) {
      if (entry.count === 0) continue; // skip entries with no new occurrences since last flush
      if (entry.lastSentAt && now - entry.lastSentAt < this._opts.cooldownMs) continue;

      const elapsed = now - entry.firstSeenInWindow;
      let prefix = "";
      if (entry.count >= 100) {
        const mins = Math.max(1, Math.round(elapsed / 60_000));
        prefix = `${entry.count}x in ${mins} minute${mins !== 1 ? "s" : ""}!!!! `;
      } else if (entry.count > 1) {
        prefix = `${entry.count}x `;
      }

      let line = `${prefix}${entry.message}`;
      if (entry.source) line += `\n  at ${entry.source}`;
      if (entry.stack) {
        const frames = entry.stack
          .split("\n")
          .filter((l) => l.trimStart().startsWith("at "))
          .slice(0, 4)
          .map((l) => `  ${l.trim()}`)
          .join("\n");
        if (frames) line += `\n${frames}`;
      }
      lines.push(line);

      entry.lastSentAt = now;
      entry.count = 0;
      entry.firstSeenInWindow = now;
    }

    if (lines.length === 0) return;

    this._onFlush(lines.join("\n\n"), { error_count: String(lines.length) });
  }

  hmrPause() {
    const now = Date.now();

    if (now - this._lastHmrAt < this._opts.hmrRateLimitMs) return;
    this._lastHmrAt = now;

    this._hmrPaused = true;
    this._hmrPausedSince = now;
    clearTimeout(this._batchTimer);
    this._batchTimer = null;
    clearTimeout(this._hmrTimer);

    this._hmrTimer = setTimeout(() => this._hmrResume(), this._opts.hmrSettleMs);
  }

  _hmrResume() {
    this._hmrPaused = false;
    this._hmrPausedSince = 0;
    for (const entry of this._tracked.values()) {
      entry.count = 0;
    }
  }

  _checkHmrTimeout() {
    if (this._hmrPaused && this._hmrPausedSince > 0) {
      const pausedMs = Date.now() - this._hmrPausedSince;
      if (pausedMs > this._opts.hmrMaxPauseMs) {
        process.stderr.write(
          `[claude-console] HMR pause exceeded ${this._opts.hmrMaxPauseMs}ms — force-resuming\n`,
        );
        clearTimeout(this._hmrTimer);
        this._hmrTimer = null;
        this._hmrResume();
      }
    }
  }

  _evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of this._tracked) {
      if (v.lastSeenAt < oldestTime) {
        oldestTime = v.lastSeenAt;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) this._tracked.delete(oldestKey);
  }

  destroy() {
    clearInterval(this._hmrWatchdog);
    clearTimeout(this._batchTimer);
    clearTimeout(this._hmrTimer);
  }
}
