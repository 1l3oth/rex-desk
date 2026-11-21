// A poll that slows down when nothing happens: every minMs after activity, doubling up to maxMs while idle, and back to
// minMs at once when something happens (wake). It runs on one timer at a time, so a computer that slept does not fire a
// burst of missed polls when it wakes; a gap much longer than the wait (sleep) starts again from the slow end.
export class BackoffPoll {
  constructor(tick, { minMs = 5000, maxMs = 60000, now = Date.now, timers = { setTimeout, clearTimeout } } = {}) {
    Object.assign(this, { tick, minMs, maxMs, now, timers, waitMs: minMs, timer: null, running: false, dueAt: 0, inFlight: false, woken: false });
  }
  start() { if (this.running) return; this.running = true; this.waitMs = this.minMs; this.schedule(); }
  stop() { this.running = false; if (this.timer) this.timers.clearTimeout(this.timer); this.timer = null; }
  // Something happened (a message sent or received): poll soon and at the quick pace again. While a poll is on its way, it
  // only notes that; the finishing poll then sets the one next timer, so there is never more than one loop.
  wake() { if (!this.running) return; this.waitMs = this.minMs; if (this.inFlight) { this.woken = true; return; } this.schedule(); }
  schedule() {
    if (this.timer) this.timers.clearTimeout(this.timer); this.timer = null;
    this.dueAt = this.now() + this.waitMs;
    this.timer = this.timers.setTimeout(() => void this.fire(), this.waitMs); this.timer?.unref?.();
  }
  async fire() {
    this.timer = null; if (!this.running) return;
    const slept = this.now() - this.dueAt > Math.max(30000, this.waitMs * 2);
    let busy = false; this.inFlight = true; this.woken = false;
    try { busy = Boolean(await this.tick()); } catch { busy = false; } finally { this.inFlight = false; }
    if (!this.running) return;
    this.waitMs = busy || this.woken ? this.minMs : slept ? this.maxMs : Math.min(this.maxMs, this.waitMs * 2); this.woken = false;
    this.schedule();
  }
}
