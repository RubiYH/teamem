/**
 * Minimal in-memory counter+histogram registry. Process-local, zero-dep,
 * intentionally tiny — wired by the TOCTOU gate (`claim_scope.gate.*`)
 * for AC-NEW-9 assertions. Tests reset state via `metricsResetAll()`.
 *
 * NOT a stand-in for a real metrics backend (Prometheus, OTLP). When v2.5
 * adds telemetry, swap this module's exports for a real client; callers
 * keep the same `metrics.increment` / `metrics.histogram` surface.
 */

const counters = new Map<string, number>();
const histograms = new Map<string, number[]>();

function increment(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

function histogram(name: string, value: number): void {
  const arr = histograms.get(name);
  if (arr) {
    arr.push(value);
  } else {
    histograms.set(name, [value]);
  }
}

function getCounter(name: string): number {
  return counters.get(name) ?? 0;
}

function getHistogram(name: string): readonly number[] {
  return histograms.get(name) ?? [];
}

function resetAll(): void {
  counters.clear();
  histograms.clear();
}

export const metrics = {
  increment,
  histogram,
  getCounter,
  getHistogram
};

export const metricsResetAll = resetAll;
