import type { JobRecord, Role } from "@/core/extraction/record";

import { knownLineFits, NEEDS_YOUR_LINE, type ProfileParts } from "./build";
import { checkFit } from "./fit";
import { bodyWords, type EmailKit, type FitRow, type KitBlock } from "./kit";

/**
 * The code checks on an email kit (drafting spec, "validate(kit, context)"),
 * as far as the thin path needs them: citations, the fit check, gap lines,
 * the word limit, the accepted keyword, anything an AI-addressed line asked
 * for, internal IDs or markers in the text, a line only the owner can write,
 * sensitive topics in drafted sentences and the subject, a placeholder left
 * in the subject, and a body that says nothing about the owner. Pure: it
 * only flags, never rewrites, so the review page can run it in the browser
 * after each edit. Topic questions, short answers and form and message kits
 * come later.
 */

export type KitFlagKind =
  | "invalid_citation"
  | "fit_unverified"
  | "fit_missing"
  | "missing_gap_line"
  | "over_limit"
  | "keyword_missing"
  | "ai_instruction_followed"
  | "reference_leak"
  | "needs_your_line"
  | "sensitive_topic_drafted"
  | "subject_placeholder"
  | "no_claims";

export interface KitFlag {
  kind: KitFlagKind;
  /** A block's ID, a requirement's ID, or "body", "subject", "greeting" or "kit". */
  at: string;
  message: string;
}

export interface KitContext {
  record: JobRecord;
  role: Role;
  profile: ProfileParts;
  fit: readonly FitRow[];
  wordLimit: number;
  keyword: string | null;
  /** The marker strings the drafting call used. */
  markers: readonly string[];
}

const MESSAGES = {
  invalid_citation:
    "This sentence cites something that is not in your approved profile or the post. Check it, or cut it.",
  fit_facts:
    "Marked as met, but no cited fact shows every skill named at the depth and for the years asked.",
  fit_tick: "Only you can confirm you meet this requirement.",
  fit_missing: "The draft did not weigh this requirement.",
  missing_gap_line: "A must-have you do not fully meet has no honest line about it.",
  keyword_missing: "The post asks you to include a keyword, and the email does not.",
  reference_leak: "An internal ID or marker appears in the email. Take it out.",
  needs_your_line: "Write this line yourself: no gap line in your profile fits this requirement.",
  sensitive_topic_drafted:
    "This mentions money, visas, work permits or another personal topic only your profile may answer. Check it.",
  subject_placeholder:
    "The subject still holds a placeholder from the post. Fill it in before you send.",
  no_claims: "The email says nothing about you yet. Write at least one sentence from your profile.",
} as const;

// An amount of money (a currency before or after a number, or a word for one); visas,
// sponsorship and the right to work; and equal-opportunity topics worded about a person.
const SENSITIVE = [
  /(?:\b(?:usd|pkr|eur|gbp|aed|sar|qar|kwd|omr|bhd|sgd|cad|aud|inr|rs)\.?|[$£€₨₹])\s?\d/i,
  /\d[\d,.]*\s?(?:usd|pkr|eur|gbp|aed|sar|qar|kwd|omr|bhd|sgd|cad|aud|inr|dollars?|rupees?|pounds?|euros?|riyals?|dirhams?|lakhs?|crores?)\b/i,
  /\b(?:visas?|sponsor(?:ship|ed|s|ing)?|work (?:authori[sz]ation|permits?)|right to work|(?:authori[sz]ed|eligible|permitted) to work|citizen(?:s|ship)?|nationality|passports?|permanent residen(?:t|cy|ce))\b/i,
  /\b(?:gender|ethnicity|race(?!\s+conditions?)|veteran status|military service|(?:my|a|have a) disabilit(?:y|ies)|I am disabled)\b/i,
];

const PLACEHOLDER = /[[{<][^\]}>]{0,40}[\]}>]/;

const isSensitive = (text: string) => SENSITIVE.some((pattern) => pattern.test(text));

export function validateEmailKit(kit: EmailKit, context: KitContext): KitFlag[] {
  const flags: KitFlag[] = [];
  const flag = (kind: KitFlagKind, at: string, message: string) =>
    flags.push({ kind, at, message });
  const { role, profile } = context;
  const factIds = new Set(profile.facts.map((fact) => fact.id));

  if (PLACEHOLDER.test(kit.subject)) {
    flag("subject_placeholder", "subject", MESSAGES.subject_placeholder);
  }
  if (isSensitive(kit.subject))
    flag("sensitive_topic_drafted", "subject", MESSAGES.sensitive_topic_drafted);
  if (isSensitive(kit.greeting)) {
    flag("sensitive_topic_drafted", "greeting", MESSAGES.sensitive_topic_drafted);
  }
  for (const block of kit.blocks) {
    if (!citesTruly(block, context, factIds)) {
      flag("invalid_citation", block.id, MESSAGES.invalid_citation);
    }
    if (block.class === "gap" && block.text === NEEDS_YOUR_LINE) {
      flag("needs_your_line", block.id, MESSAGES.needs_your_line);
    }
    if (block.class !== "gap" && isSensitive(block.text)) {
      flag("sensitive_topic_drafted", block.id, MESSAGES.sensitive_topic_drafted);
    }
  }
  if (!kit.blocks.some((block) => block.class === "claim")) {
    flag("no_claims", "body", MESSAGES.no_claims);
  }

  const { flags: fitFlags, verdicts } = checkFit(role, context.fit, profile.facts);
  for (const fitFlag of fitFlags) {
    if (fitFlag.kind === "fit_missing") {
      flag("fit_missing", fitFlag.requirementId, MESSAGES.fit_missing);
    } else {
      const message = fitFlag.reason === "needs_tick" ? MESSAGES.fit_tick : MESSAGES.fit_facts;
      flag("fit_unverified", fitFlag.requirementId, message);
    }
  }
  for (const requirement of role.requirements) {
    if (requirement.priority !== "must" || verdicts.get(requirement.id) === "met") continue;
    const answered = kit.blocks.some(
      (block) => block.class === "gap" && block.gap?.requirementId === requirement.id,
    );
    if (!answered) flag("missing_gap_line", requirement.id, MESSAGES.missing_gap_line);
  }

  const words = bodyWords(kit);
  if (words > context.wordLimit) {
    flag(
      "over_limit",
      "body",
      `The email's body is ${words} words; the limit is ${context.wordLimit}.`,
    );
  }

  // The keyword counts only in the body, as a word of its own: "Go" is not in "good".
  const body = kit.blocks.map((block) => block.text).join("\n");
  if (context.keyword !== null && !hasWord(body, context.keyword)) {
    flag("keyword_missing", "body", MESSAGES.keyword_missing);
  }
  // From every role: a line aimed at AI that the model recorded under another role still counts.
  // Looked for in the body only: the subject, greeting and closing are the app's words.
  const followed = context.record.roles
    .flatMap((each) => each.instructions)
    .filter((instruction) => instruction.addressed_to_ai)
    .map((instruction) => instruction.value.trim())
    .find((value) => [...value].length >= 3 && hasWord(body, value));
  if (followed !== undefined) {
    const shown = [...followed].slice(0, 60).join("");
    flag(
      "ai_instruction_followed",
      "kit",
      `The email repeats “${shown}”, which a line aimed at AI tools asked for. Take it out.`,
    );
  }

  const references = [
    ...profile.facts.map((fact) => fact.id),
    ...profile.knownGaps.map((gap) => gap.id),
    ...profile.gapTemplates.map((template) => template.id),
    ...context.markers,
  ].filter((reference) => reference !== "");
  const texts = [kit.subject, kit.greeting, ...kit.blocks.map((block) => block.text), kit.closing];
  if (references.some((reference) => texts.some((text) => hasToken(text, reference)))) {
    flag("reference_leak", "kit", MESSAGES.reference_leak);
  }
  return flags;
}

/** Whether a block's references are real: facts of this profile, fields of this post, a gap line's sources. */
function citesTruly(block: KitBlock, context: KitContext, factIds: ReadonlySet<string>): boolean {
  const { role, record, profile } = context;
  if (block.class === "claim") {
    return block.factIds.length > 0 && block.factIds.every((id) => factIds.has(id));
  }
  if (block.class === "post") {
    if (block.fields.length === 0) return false;
    return block.fields.every((field) => {
      if (field === "company.name") {
        return record.company.name !== "" && block.text.includes(record.company.name);
      }
      if (field === "title") return role.title !== "" && block.text.includes(role.title);
      return role.requirements.some((requirement) => requirement.id === field);
    });
  }
  if (block.class === "gap") {
    const gap = block.gap;
    const requirement = role.requirements.find((entry) => entry.id === gap?.requirementId);
    if (!gap || !requirement) return false;
    // A known line answers a requirement only by naming one of its skills.
    const knownLine = profile.knownGaps.find((entry) => entry.id === gap.knownLineId);
    const known =
      gap.knownLineId === "" || (knownLine !== undefined && knownLineFits(knownLine, requirement));
    const template =
      gap.templateId === "" || profile.gapTemplates.some((entry) => entry.id === gap.templateId);
    const related = gap.relatedFactId === "" || factIds.has(gap.relatedFactId);
    return known && template && related && (gap.knownLineId !== "" || gap.templateId !== "");
  }
  return true;
}

/** Whether `token` stands alone in `text`, not inside a longer word: "S3" never matches "F-S3". */
function hasToken(text: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(token, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : text[at - 1]!;
    const after = text[at + token.length] ?? "";
    if (!/[A-Za-z0-9-]/.test(before) && !/[A-Za-z0-9-]/.test(after)) return true;
    from = at + 1;
  }
}

/** Whether `word` stands alone in `text`, in any case: "Java" is not in "JavaScript". */
function hasWord(text: string, word: string): boolean {
  return hasToken(text.toLowerCase(), word.toLowerCase());
}
