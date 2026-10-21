const { calculateTiming } = require('./progress-math');

class JobProgress {
  constructor(stats, emit, { total = null, phase = 'preview', now = Date.now, startedAt } = {}) {
    this.stats = stats;
    this.emitStats = emit;
    this.total = total;
    this.phase = phase;
    this.now = now;
    this.rateStartedAt = now();
    this.startedAt = startedAt ?? this.rateStartedAt;
    this.processed = 0;
    this.waitUntilMs = null;
    this.waitReason = null;
    this.completedItem = null;
  }

  complete(item) {
    this.processed++;
    this.completedItem = { id: item.id, channel_id: item.channel_id, action: item.action, emoji: item.emoji };
  }

  wait({ reason, untilMs }) {
    this.waitReason = reason;
    this.waitUntilMs = untilMs;
    this.emit();
  }

  snapshot() {
    const progress = {
      scanned: this.stats.scanned, matched: this.stats.matched, deleted: this.stats.deleted, skipped: this.stats.skipped,
      phase: this.phase, total: this.total, processed: this.processed,
      startedAt: this.startedAt, rateStartedAt: this.rateStartedAt,
      waitUntilMs: this.waitUntilMs, waitReason: this.waitReason, completedItem: this.completedItem
    };
    return { ...progress, ...calculateTiming(progress, this.now()) };
  }

  emit() {
    const snapshot = this.snapshot();
    this.emitStats(snapshot);
    return snapshot;
  }
}

module.exports = { JobProgress };
