/**
 * Percentiles for the Baseline and Stats pages (ledger spec): linear
 * interpolation between the closest ranks, the common default, so a median
 * of an even count is the mean of the middle two.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (p < 0 || p > 100) throw new Error(`A percentile runs from 0 to 100, not ${p}`);
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const below = Math.floor(rank);
  const above = Math.ceil(rank);
  return sorted[below]! + (sorted[above]! - sorted[below]!) * (rank - below);
}

export function median(values: readonly number[]): number | null {
  return percentile(values, 50);
}

/**
 * The 95% Wilson score interval for a proportion, `successes` of `trials`
 * (ledger spec: the factual-edit rate); null with no trials.
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  z = 1.96,
): { low: number; high: number } | null {
  if (trials === 0) return null;
  const p = successes / trials;
  const z2 = z * z;
  const centre = (p + z2 / (2 * trials)) / (1 + z2 / trials);
  const half =
    (z / (1 + z2 / trials)) * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}
