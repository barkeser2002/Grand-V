// Fixed-window rate limiter keyed by bucket+client. Memory is bounded: expired windows are
// purged whenever the table grows past a fixed size.
export class RateLimiter {
  constructor({ now = Date.now, maxKeys = 10_000 } = {}) {
    this.now = now;
    this.maxKeys = maxKeys;
    this.windows = new Map();
  }

  hit(key, limit, windowMs) {
    const now = this.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= windowMs) {
      if (!w && this.windows.size >= this.maxKeys) this.#purge(now);
      w = { start: now, count: 0, windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    if (w.count > limit) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((w.start + windowMs - now) / 1000)) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  #purge(now) {
    for (const [key, w] of this.windows) {
      if (now - w.start >= w.windowMs) this.windows.delete(key);
    }
  }
}
