import { median } from "./stats";

/**
 * Bootstrap 95% intervals for the timing comparison (ledger spec, "Timing
 * and stats"): the percentile method over resamples drawn with a seeded
 * generator, so the Stats page shows the same interval each time it is
 * drawn from the same runs. The runs are put in order first, since a
 * resample picks them by place and the database returns them in any order.
 */

export interface Interval {
  low: number;
  high: number;
}

export interface BootstrapOptions {
  resamples?: number;
  seed?: number;
}

const RESAMPLES = 2000;

/** mulberry32: a small seeded generator, uniform on [0, 1). */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The values from smallest to largest, a copy, so a resample does not follow their order. */
function inOrder(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function resample(values: readonly number[], next: () => number): number[] {
  return values.map(() => values[Math.floor(next() * values.length)]!);
}

/** The 2.5th and 97.5th percentiles of the statistics, sorted. */
function percentileInterval(statistics: number[]): Interval {
  statistics.sort((a, b) => a - b);
  const at = (p: number) =>
    statistics[Math.min(statistics.length - 1, Math.floor(p * statistics.length))]!;
  return { low: at(0.025), high: at(0.975) };
}

/** A 95% interval for the median of the values; null for none. */
export function medianInterval(
  values: readonly number[],
  options: BootstrapOptions = {},
): Interval | null {
  if (values.length === 0) return null;
  const runs = inOrder(values);
  const next = generator(options.seed ?? 1);
  const statistics: number[] = [];
  for (let i = 0; i < (options.resamples ?? RESAMPLES); i++) {
    statistics.push(median(resample(runs, next))!);
  }
  return percentileInterval(statistics);
}

/**
 * A 95% interval for the ratio of two medians, `top` over `bottom`, each
 * resampled on its own; null when either has no values or a resample's
 * bottom median is zero.
 */
export function ratioInterval(
  top: readonly number[],
  bottom: readonly number[],
  options: BootstrapOptions = {},
): Interval | null {
  if (top.length === 0 || bottom.length === 0) return null;
  const [above, under] = [inOrder(top), inOrder(bottom)];
  const next = generator(options.seed ?? 1);
  const statistics: number[] = [];
  for (let i = 0; i < (options.resamples ?? RESAMPLES); i++) {
    const below = median(resample(under, next))!;
    if (below === 0) return null;
    statistics.push(median(resample(above, next))! / below);
  }
  return percentileInterval(statistics);
}
