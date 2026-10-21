(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.redactProgressMath = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function calculateTiming(progress, now, active = true) {
    const elapsedMs = active ? Math.max(0, now - progress.startedAt) : Math.max(0, progress.elapsedMs || 0);
    const processingElapsedMs = active ? Math.max(0, now - (progress.rateStartedAt ?? progress.startedAt)) : Math.max(0, progress.processingElapsedMs ?? elapsedMs);
    const processed = progress.processed || 0;
    const remaining = Number.isFinite(progress.total) ? Math.max(0, progress.total - processed) : null;
    const waitMs = active ? Math.max(0, (progress.waitUntilMs || 0) - now) : 0;
    const scanning = progress.phase === 'preview' || progress.phase === 'discover';
    const units = scanning ? progress.scanned || 0 : processed;
    return {
      elapsedMs, processingElapsedMs, remaining,
      ratePerMinute: processingElapsedMs > 0 ? units * 60000 / processingElapsedMs : 0,
      etaMs: remaining === 0 ? 0 : remaining !== null && processed >= 3 && processingElapsedMs > 0
        ? Math.max(1000, Math.ceil(remaining * processingElapsedMs / processed + waitMs)) : null
    };
  }
  return { calculateTiming };
});
