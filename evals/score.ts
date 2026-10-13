import { normaliseWhatsAppNumber } from "@/core/extraction/contacts";
import { addressKey, companyKey, roleKey } from "@/core/ledger/normalise";

/**
 * The scorer (evals spec, "Metrics"): a proportion with its Wilson 95%
 * interval and count, precision and recall with theirs, the exact McNemar
 * test for two models on the same cases, and which extracted fields match
 * the owner's labels. Pass marks are read as point estimates and always
 * shown with their intervals; a difference the test does not support is
 * "no difference shown", never "equal".
 */

/** z for a two-sided 95% interval. */
const Z95 = 1.959963984540054;

/** The level below which McNemar's test shows a difference. */
const ALPHA = 0.05;

export interface Proportion {
  successes: number;
  n: number;
  /** Null without cases, as are the bounds. */
  point: number | null;
  low: number | null;
  high: number | null;
}

/** Wilson's score interval for `successes` out of `n`, at 95%. */
export function wilson(successes: number, n: number, z = Z95): Proportion {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || successes < 0 || successes > n) {
    throw new RangeError(`${successes} of ${n} is not a count`);
  }
  if (n === 0) return { successes, n, point: null, low: null, high: null };
  const point = successes / n;
  const z2 = z * z;
  const centre = point + z2 / (2 * n);
  const margin = z * Math.sqrt((point * (1 - point)) / n + z2 / (4 * n * n));
  const scale = 1 + z2 / n;
  return {
    successes,
    n,
    point,
    // At either end the bound is exactly 0 or 1; arithmetic would leave it a hair off.
    low: successes === 0 ? 0 : (centre - margin) / scale,
    high: successes === n ? 1 : (centre + margin) / scale,
  };
}

export interface PrecisionRecall {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  /** Of the cases called positive, the share that are. */
  precision: Proportion;
  /** Of the positive cases, the share called so. */
  recall: Proportion;
}

/** Precision and recall of a yes or no call against labels, as for "not supported" (the judge set). */
export function precisionRecall(
  rows: readonly { predicted: boolean; actual: boolean }[],
): PrecisionRecall {
  const count = (predicted: boolean, actual: boolean) =>
    rows.filter((row) => row.predicted === predicted && row.actual === actual).length;
  const truePositives = count(true, true);
  const falsePositives = count(true, false);
  const falseNegatives = count(false, true);
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives: count(false, false),
    precision: wilson(truePositives, truePositives + falsePositives),
    recall: wilson(truePositives, truePositives + falseNegatives),
  };
}

/**
 * McNemar's exact test: the two-sided binomial test, at one half, on the
 * cases where only one model was right. Computed on whole numbers, so it
 * stays exact for small counts and a probability for any.
 */
export function mcnemarExact(onlyFirst: number, onlySecond: number): number {
  const n = onlyFirst + onlySecond;
  if (n === 0) return 1;
  const fewer = Math.min(onlyFirst, onlySecond);
  // The binomial tail up to the smaller count: the sum of C(n, k) for k from 0.
  let tail = BigInt(0);
  let coefficient = BigInt(1);
  for (let k = 0; k <= fewer; k++) {
    tail += coefficient;
    coefficient = (coefficient * BigInt(n - k)) / BigInt(k + 1);
  }
  // p = 2 * tail / 2^n = tail / 2^(n - 1), from the tail's top 64 bits so no step overflows.
  const shift = Math.max(0, tail.toString(2).length - 64);
  let p = Number(tail >> BigInt(shift));
  let exponent = shift - (n - 1);
  for (; exponent < -1000; exponent += 1000) p *= 2 ** -1000;
  p *= 2 ** exponent;
  return Math.min(1, p);
}

export interface Comparison {
  onlyFirst: number;
  onlySecond: number;
  both: number;
  neither: number;
  p: number;
  verdict: "first" | "second" | "no difference shown";
}

/** Two models on the same cases, each right or wrong: McNemar's exact test, and what it shows. */
export function compareModels(rows: readonly { first: boolean; second: boolean }[]): Comparison {
  const count = (first: boolean, second: boolean) =>
    rows.filter((row) => row.first === first && row.second === second).length;
  const onlyFirst = count(true, false);
  const onlySecond = count(false, true);
  const p = mcnemarExact(onlyFirst, onlySecond);
  return {
    onlyFirst,
    onlySecond,
    both: count(true, true),
    neither: count(false, false),
    p,
    verdict:
      p >= ALPHA || onlyFirst === onlySecond
        ? "no difference shown"
        : onlyFirst > onlySecond
          ? "first"
          : "second",
  };
}

/** The fields extraction is scored on, as the labels hold them. */
export interface ScoredFields {
  company: string;
  role: string;
  route: string;
  contact: string;
  eligibility: string;
}

export const SCORED_FIELDS = [
  "company",
  "role",
  "route",
  "contact",
  "eligibility",
] as const satisfies readonly (keyof ScoredFields)[];

/** Each labelled field, right or wrong; a field without a label is not scored. */
export type FieldMatches = Partial<Record<keyof ScoredFields, boolean>>;

const MATCHERS: Readonly<
  Record<keyof ScoredFields, (extracted: string, labelled: string) => boolean>
> = {
  company: (extracted, labelled) => companyKey(extracted) === companyKey(labelled),
  role: (extracted, labelled) => roleKey(extracted) === roleKey(labelled),
  route: (extracted, labelled) => extracted === labelled,
  contact: (extracted, labelled) => sameContact(extracted, labelled),
  eligibility: (extracted, labelled) => extracted === labelled,
};

/**
 * Which extracted fields match the labels: company and role after the
 * ledger's normalisation (case, legal forms, places and labels set apart
 * from the title), route and eligibility exactly, and the contact as jobkit
 * would use it. Only the fields labelled are scored: an archive case labels
 * all of them, a synthetic post those it expects.
 */
export function fieldMatches(
  extracted: ScoredFields,
  labelled: Partial<ScoredFields>,
): FieldMatches {
  const matches: FieldMatches = {};
  for (const field of SCORED_FIELDS) {
    const label = labelled[field];
    if (label !== undefined) matches[field] = MATCHERS[field](extracted[field], label);
  }
  return matches;
}

/**
 * An address without surrounding space or case; a number as the number
 * jobkit would message, or by its digits when its country code cannot be
 * read, since jobkit never guesses one. An empty contact matches only an
 * empty label.
 */
export function sameContact(extracted: string, labelled: string): boolean {
  const [one, other] = [extracted.trim(), labelled.trim()];
  if (one === "" || other === "") return one === other;
  if (one.includes("@") || other.includes("@")) return one.toLowerCase() === other.toLowerCase();
  const [first, second] = [normaliseWhatsAppNumber(one), normaliseWhatsAppNumber(other)];
  if (first.ok && second.ok) return first.number === second.number;
  return !first.ok && !second.ok && addressKey(one) === addressKey(other);
}
