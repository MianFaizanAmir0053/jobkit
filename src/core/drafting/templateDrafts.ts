import type { JobRecord, Role } from "@/core/extraction/record";
import type { Profile } from "@/core/profile/profile";
import type { EmailTemplate, Fact } from "@/core/profile/schema";
import { skillTag } from "@/core/shared/skills";

import {
  acceptedInstructions,
  buildEmailKit,
  canonicalSkill,
  knownLineFits,
  oneLine,
} from "./build";
import { type DraftOutput, withoutAiLines } from "./draftStage";
import { checkFit } from "./fit";
import { type DraftAnswer, type EmailKit, type FitRow } from "./kit";
import {
  hasToken,
  type KitFlag,
  type KitFlagKind,
  ONLY_YOU_CAN_CONFIRM,
  validateKit,
} from "./validate";
import type { BlockVerdict } from "./verdict";

/**
 * Drafts from the owner's approved email templates (decisions A21, with
 * amendment A22). No model writes them and no separate check weighs them,
 * so each holds only the owner's approved words, each word for word: a
 * template's sentences, with the post's company and role in its places for
 * them, approved facts and known gap lines. Code writes no words of its own.
 *
 * A template is weighed against the must-haves code can weigh: a skill, or
 * experience naming skills, every one in the shared vocabulary. It shows
 * one when its skills name every skill asked and a fact it cites has them
 * at the depth and years asked, as the fit check weighs any draft (fit.ts).
 * The two best that show at least 60% of them become drafts. For a
 * must-have the template does not show, code adds an approved fact that
 * shows it alone, at most two, or else a known gap line naming its skill;
 * with neither, the template is not used, and Gemini drafts the email. A
 * requirement code cannot weigh (a degree, a language, experience it cannot
 * measure, a skill outside the vocabulary) is not counted, and as a
 * must-have it is flagged for the owner to confirm. Requirements the post
 * repeats from lines aimed at AI are not weighed, as the drafting call never
 * sees them. A draft is offered only when it can go as it is: the post's
 * names plain, its keyword in the email, nothing past its limit, and no
 * flag that only new words resolve.
 */

/** The share of the must-haves code can weigh that a template must show to become a draft. */
export const TEMPLATE_COVERAGE = 0.6;
/** How many template drafts are offered at most. */
export const MAX_TEMPLATE_DRAFTS = 2;
/** How many approved facts code adds to a template draft at most. */
export const MAX_ADDED_FACTS = 2;
/** The longest company name or title code puts in a template's place for it. */
const MAX_NAME_CHARS = 80;
const MAX_NAME_WORDS = 10;

/**
 * Flags that stop a template draft: Gemini's draft serves the post better
 * than one the owner would have to change, or could not send at all.
 */
const STOPS: ReadonlySet<KitFlagKind> = new Set([
  "needs_your_line",
  "invalid_citation",
  "over_limit",
  "keyword_missing",
  "subject_placeholder",
  "reference_leak",
  "ai_instruction_followed",
]);

/** A draft built from a template, with what it covers, as the job page offers it. */
export interface TemplateDraft extends Omit<DraftOutput, "kit"> {
  /** A template is an email's body, so its draft is an email kit. */
  kit: EmailKit;
  templateId: string;
  templateName: string;
  /** The share of the role's weighable must-haves the finished draft meets. */
  coverage: number;
}

type Requirement = Role["requirements"][number];
type Names = { company: string; role: string };

/**
 * Whether code can weigh a requirement against facts: a skill, or
 * experience naming skills, every one in the shared vocabulary, which is
 * all the profile's facts are tagged with.
 */
export function isWeighable(requirement: Requirement): boolean {
  return (
    (requirement.kind === "skill" || requirement.kind === "experience") &&
    requirement.skills.length > 0 &&
    requirement.skills.every((skill) => skillTag(skill) !== null)
  );
}

const isWeighedMust = (requirement: Requirement) =>
  requirement.priority === "must" && isWeighable(requirement);

/**
 * The share of the role's weighable must-haves a draft's fit meets, as the
 * fit check finds it; 0 for a role with none. Gemini's drafts and the
 * templates' are ranked by it alike, the role as the drafting call sees it
 * (`visibleRole`): a requirement that repeats a line aimed at AI is no
 * must-have of the post's.
 */
export function mustHaveCoverage(
  role: Role,
  fit: readonly FitRow[],
  facts: readonly Fact[],
): number {
  const musts = role.requirements.filter(isWeighedMust);
  if (musts.length === 0) return 0;
  const { verdicts } = checkFit(role, fit, facts);
  return (
    musts.filter((requirement) => verdicts.get(requirement.id) === "met").length / musts.length
  );
}

const asked = (requirement: Requirement) => requirement.skills.map(canonicalSkill);

const row = (requirement: Requirement, verdict: FitRow["verdict"], factIds: string[]) => ({
  requirementId: requirement.id,
  verdict,
  factIds,
  note: "",
});

/** Whether facts, cited for a requirement, meet it, as the fit check weighs them. */
function shownBy(role: Role, requirement: Requirement, facts: readonly Fact[]): boolean {
  const cited = row(
    requirement,
    "met",
    facts.map((fact) => fact.id),
  );
  return (
    checkFit({ ...role, requirements: [requirement] }, [cited], facts).verdicts.get(
      requirement.id,
    ) === "met"
  );
}

/** The facts a template cites that have a skill the requirement asks. */
function relevant(cited: readonly Fact[], requirement: Requirement): Fact[] {
  const skills = asked(requirement);
  return cited.filter((fact) => fact.skills.some((skill) => skills.includes(skill)));
}

/** Whether a template shows a requirement: its skills name every skill asked, and its facts meet it. */
function templateShows(
  template: EmailTemplate,
  cited: readonly Fact[],
  role: Role,
  requirement: Requirement,
): boolean {
  return (
    asked(requirement).every((skill) => template.skills.includes(skill)) &&
    shownBy(role, requirement, relevant(cited, requirement))
  );
}

/**
 * A weighable requirement no draft fact meets, as honestly as code can put
 * it: partial when an approved fact has every skill asked, short of the
 * depth or years; a gap otherwise.
 */
function unmet(requirement: Requirement, facts: readonly Fact[]): FitRow {
  const skills = asked(requirement);
  const near = facts.filter((fact) => skills.every((skill) => fact.skills.includes(skill)));
  return near.length > 0
    ? row(
        requirement,
        "partial",
        near.map((fact) => fact.id),
      )
    : row(requirement, "gap", []);
}

/** The facts a template's sentences cite, as the profile holds them. */
const citedBy = (template: EmailTemplate, facts: readonly Fact[]) =>
  facts.filter((fact) => template.sentences.some((sentence) => sentence.facts.includes(fact.id)));

/** The template's own share of the weighable must-haves, before code adds anything. */
function ownCoverage(
  template: EmailTemplate,
  role: Role,
  visible: Role,
  facts: readonly Fact[],
): number {
  const cited = citedBy(template, facts);
  const rows = visible.requirements
    .filter((requirement) => isWeighable(requirement))
    .filter((requirement) => templateShows(template, cited, role, requirement))
    .map((requirement) =>
      row(
        requirement,
        "met",
        relevant(cited, requirement).map((f) => f.id),
      ),
    );
  return mustHaveCoverage(visible, rows, facts);
}

/**
 * The role as the drafting call sees it: without the requirements that
 * repeat a line aimed at AI. One an AI line took a skill tag from asks for
 * less than the post does, so code does not weigh it: it keeps no skills.
 */
export function visibleRole(record: JobRecord, role: Role): Role {
  const visible = withoutAiLines(record, role, acceptedInstructions(role).keyword).role;
  return {
    ...visible,
    requirements: visible.requirements.map((requirement) => {
      const asked = role.requirements.find((each) => each.id === requirement.id);
      return asked && asked.skills.length !== requirement.skills.length
        ? { ...requirement, skills: [] }
        : requirement;
    }),
  };
}

/**
 * A name code may put in a template's place for it: the post's company or
 * title, on one line as it stands, short, with no braces, so it reads as a
 * name and the email names it exactly.
 */
function plainName(value: string): boolean {
  return (
    value !== "" &&
    oneLine(value) === value &&
    !/[{}]/.test(value) &&
    [...value].length <= MAX_NAME_CHARS &&
    value.split(" ").length <= MAX_NAME_WORDS
  );
}

/** Whether the post gives a plain name for every place the template has one. */
function fillable(template: EmailTemplate, names: Names): boolean {
  const text = template.sentences.map((sentence) => sentence.text).join(" ");
  return (
    (!text.includes("{company}") || plainName(names.company)) &&
    (!text.includes("{role}") || plainName(names.role))
  );
}

/** A sentence with the post's names in their places, in one pass; a name ending a sentence ends it. */
const fill = (text: string, names: Names) =>
  text.replace(/\{(company|role)\}(\.?)/g, (_, place: keyof Names, stop: string) =>
    stop !== "" && /[.!?]$/.test(names[place]) ? names[place] : names[place] + stop,
  );

/** What a post sentence names, as a post block's fields say (kit.ts). */
const fieldsOf = (text: string) => [
  ...(text.includes("{company}") ? ["company.name"] : []),
  ...(text.includes("{role}") ? ["title"] : []),
];

const NO_GAP = { requirement_id: "", known_line_id: "", template_id: "", related_fact_id: "" };

/** Blocks as one paragraph: a new one starts after the last. */
const paragraph = (blocks: DraftAnswer["blocks"]) =>
  blocks.map((each, i) => (i === blocks.length - 1 ? { ...each, paragraph_break: true } : each));

/**
 * The owner's to confirm: a requirement code cannot weigh has no fit row,
 * so the checks find it not weighed. That says nothing the owner must act
 * on for a nice-to-have; a must-have asks the owner to confirm it. One the
 * post repeats from a line aimed at AI stays "not weighed", for the owner
 * to look at, with no gap line demanded: nothing says the owner lacks it.
 */
function ownersToConfirm(
  flags: readonly KitFlag[],
  unweighed: readonly Requirement[],
  hidden: ReadonlySet<string>,
): KitFlag[] {
  const ids = new Set(unweighed.map((requirement) => requirement.id));
  const fitKinds: ReadonlySet<KitFlagKind> = new Set([
    "fit_missing",
    "fit_unverified",
    "missing_gap_line",
  ]);
  return [
    ...flags.filter(
      (flag) =>
        !(fitKinds.has(flag.kind) && ids.has(flag.at)) &&
        !(flag.kind === "missing_gap_line" && hidden.has(flag.at)),
    ),
    ...unweighed
      .filter((requirement) => requirement.priority === "must")
      .map((requirement) => ({
        kind: "fit_unverified" as const,
        at: requirement.id,
        message: ONLY_YOU_CAN_CONFIRM,
      })),
  ];
}

/** A template's draft, or null when it cannot be offered as it is. */
function draftFrom(
  template: EmailTemplate,
  context: { record: JobRecord; role: Role; profile: Profile },
): TemplateDraft | null {
  const { record, role, profile } = context;
  const accepted = acceptedInstructions(role);
  const post = withoutAiLines(record, role, accepted.keyword);
  const names = { company: post.company, role: post.role.title };
  if (!fillable(template, names)) return null;
  const facts = profile.facts;
  const cited = citedBy(template, facts);
  const visible = visibleRole(record, role);
  const weighable = visible.requirements.filter(isWeighable);

  // Must-haves first, so a nice-to-have an added fact shows counts as met.
  const rows = new Map<string, FitRow>();
  const added: Fact[] = [];
  const gaps: DraftAnswer["blocks"][number]["gap"][] = [];
  for (const requirement of weighable.filter((each) => each.priority === "must")) {
    if (templateShows(template, cited, role, requirement)) {
      rows.set(requirement.id, row(requirement, "met", ids(relevant(cited, requirement))));
      continue;
    }
    // One approved fact that meets it alone, already added for an earlier must-have or new.
    const fact =
      added.find((each) => shownBy(role, requirement, [each])) ??
      (added.length < MAX_ADDED_FACTS
        ? facts.find(
            (each) =>
              !cited.includes(each) && !added.includes(each) && shownBy(role, requirement, [each]),
          )
        : undefined);
    if (fact) {
      if (!added.includes(fact)) added.push(fact);
      rows.set(requirement.id, row(requirement, "met", [fact.id]));
      continue;
    }
    // Else a known gap line naming its skill, once: two must-haves answered alike leave it to Gemini.
    const known = profile.knownGaps.find((line) => knownLineFits(line, requirement));
    if (!known || gaps.some((gap) => gap.known_line_id === known.id)) return null;
    rows.set(requirement.id, unmet(requirement, facts));
    gaps.push({ ...NO_GAP, requirement_id: requirement.id, known_line_id: known.id });
  }
  for (const requirement of weighable.filter((each) => each.priority !== "must")) {
    const fact = added.find((each) => shownBy(role, requirement, [each]));
    rows.set(
      requirement.id,
      templateShows(template, cited, role, requirement)
        ? row(requirement, "met", ids(relevant(cited, requirement)))
        : fact
          ? row(requirement, "met", [fact.id])
          : unmet(requirement, facts),
    );
  }

  // The added facts and gap lines go in paragraphs of their own, before the closing courtesy.
  const sentences = template.sentences;
  let closingFrom = sentences.length;
  while (closingFrom > 0 && sentences[closingFrom - 1]!.kind === "courtesy") closingFrom--;
  const block = (sentence: (typeof sentences)[number]): DraftAnswer["blocks"][number] => ({
    id: "",
    text: fill(sentence.text, names),
    paragraph_break: sentence.paragraph_break,
    class: sentence.kind,
    fact_ids: [...sentence.facts],
    fields: sentence.kind === "post" ? fieldsOf(sentence.text) : [],
    gap: NO_GAP,
  });
  const body = sentences.slice(0, closingFrom).map(block);
  const closing = sentences.slice(closingFrom).map(block);
  const inserted = [
    ...paragraph(
      added.map((fact) => ({
        id: "",
        text: fact.statement,
        paragraph_break: false,
        class: "claim" as const,
        fact_ids: [fact.id],
        fields: [],
        gap: NO_GAP,
      })),
    ),
    ...paragraph(
      gaps.map((gap) => ({
        id: "",
        text: "",
        paragraph_break: false,
        class: "gap" as const,
        fact_ids: [],
        fields: [],
        gap,
      })),
    ),
  ];
  const blocks = (
    inserted.length > 0 ? [...paragraph(body), ...inserted, ...closing] : [...body, ...closing]
  ).map((each, i) => ({ ...each, id: `S${i + 1}` }));

  const answer: DraftAnswer = {
    fit: [...rows.values()].map((each) => ({
      requirement_id: each.requirementId,
      verdict: each.verdict,
      fact_ids: each.factIds,
      note: each.note,
    })),
    blocks,
  };
  const parts = { facts, knownGaps: profile.knownGaps, gapTemplates: profile.gapTemplates };
  const built = buildEmailKit(answer, {
    record,
    role,
    ownerName: profile.owner.name,
    accepted,
    profile: parts,
  });
  const found = validateKit(built.kit, {
    record,
    role,
    profile: parts,
    fit: built.fit,
    wordLimit: accepted.wordLimit,
    keyword: post.keyword,
    subjectFormat: accepted.subjectFormat,
    markers: [],
  });
  const flags = templateFlags(found, record, role);
  // A template's ID is no word of the owner's: one in the email is a leak, as a fact's would be.
  const texts = [
    built.kit.subject,
    built.kit.greeting,
    ...built.kit.blocks.map((each) => each.text),
    built.kit.closing,
  ];
  const leaks = profile.emailTemplates.some((each) =>
    texts.some((text) => hasToken(text, each.id)),
  );
  if (leaks || flags.some((flag) => STOPS.has(flag.kind))) return null;
  return {
    kit: built.kit,
    fit: built.fit,
    flags,
    wordLimit: accepted.wordLimit,
    keyword: post.keyword,
    subjectFormat: accepted.subjectFormat,
    markers: [],
    profileVersion: profile.versionId,
    roleId: role.id,
    templateId: template.id,
    templateName: template.name,
    coverage: mustHaveCoverage(visible, built.fit, facts),
  };
}

/**
 * validate's flags on a template's draft, with what only the owner can
 * confirm in place of what code cannot weigh: as the templates first drew
 * them, and as the review page draws them again on the owner's edits.
 */
export function templateFlags(found: readonly KitFlag[], record: JobRecord, role: Role): KitFlag[] {
  const visible = visibleRole(record, role);
  return ownersToConfirm(
    found,
    visible.requirements.filter((requirement) => !isWeighable(requirement)),
    new Set(
      role.requirements
        .filter((requirement) => !visible.requirements.some((each) => each.id === requirement.id))
        .map((requirement) => requirement.id),
    ),
  );
}

const ids = (facts: readonly Fact[]) => facts.map((fact) => fact.id);

/**
 * The verdict on each sentence of a template draft, which no separate check
 * weighs (decisions A22): its claims are the owner's approved template
 * sentences or approved facts, and its gap lines known gap lines, word for
 * word; its other sentences are the template's own post and courtesy
 * sentences, which name only the company and the role, or are courtesy, as
 * the owner approved them (profile spec). It reads the stored draft, never
 * an edited one.
 */
export function templateVerdicts(kit: EmailKit): BlockVerdict[] {
  return kit.blocks.map((block) => ({
    blockId: block.id,
    verdict: block.class === "claim" || block.class === "gap" ? "supported" : "not_a_claim",
    companyClaim: false,
    note: "",
  }));
}

/**
 * The drafts the profile's approved templates make for a role: the two
 * best that show at least 60% of its weighable must-haves themselves, best
 * first; none for a role with no such must-have, or whose requirements
 * share an ID, which leaves its fit unreadable row by row.
 */
export function templateDrafts(context: {
  record: JobRecord;
  role: Role;
  profile: Profile;
}): TemplateDraft[] {
  const { record, role, profile } = context;
  const requirementIds = role.requirements.map((requirement) => requirement.id);
  if (new Set(requirementIds).size !== requirementIds.length) return [];
  const visible = visibleRole(record, role);
  if (!visible.requirements.some(isWeighedMust)) return [];
  return profile.emailTemplates
    .map((template) => ({ template, own: ownCoverage(template, role, visible, profile.facts) }))
    .filter(({ own }) => own >= TEMPLATE_COVERAGE)
    .sort((a, b) => b.own - a.own)
    .flatMap(({ template }) => {
      const draft = draftFrom(template, context);
      return draft ? [draft] : [];
    })
    .slice(0, MAX_TEMPLATE_DRAFTS);
}
