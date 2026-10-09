import type { Metadata } from "next";

import type { Fact } from "@/core/profile/schema";
import { placeName } from "@/core/shared/regions";
import { skillName } from "@/core/shared/skills";
import { profileForViewer, requireSession } from "@/server/dal";

export const metadata: Metadata = { title: "Profile · jobkit" };

const KIND_NAMES: Record<Fact["kind"], string> = {
  experience: "Experience",
  project: "Projects",
  skill: "Skills",
  metric: "Results",
  education: "Education",
  language: "Languages",
  other: "Other",
};

const HOW_TO_CHANGE =
  "To change anything, edit private/profile.yaml on the laptop and run npm run profile:seed.";

/**
 * The profile, read-only (profile spec, "Profile page"): the active
 * version, its approved items, and how many items still wait for approval.
 */
export default async function ProfilePage() {
  await requireSession({ kind: "google" });
  const loaded = await profileForViewer();

  if (!loaded) {
    return (
      <section aria-labelledby="profile-heading">
        <h1 id="profile-heading" className="text-2xl font-semibold tracking-tight">
          Profile
        </h1>
        <p className="mt-2 text-muted-foreground">There is no profile yet. {HOW_TO_CHANGE}</p>
      </section>
    );
  }

  const { profile, counts } = loaded;
  const seeded = profile.createdAt.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: profile.owner.location.timezone,
  });
  const byKind = Object.entries(KIND_NAMES)
    .map(([kind, name]) => ({ name, facts: profile.facts.filter((fact) => fact.kind === kind) }))
    .filter((group) => group.facts.length > 0);
  const answers = profile.fixedAnswers;

  return (
    <section aria-labelledby="profile-heading">
      <h1 id="profile-heading" className="text-2xl font-semibold tracking-tight">
        Profile
      </h1>
      <p className="mt-2 text-muted-foreground">
        The version seeded on {seeded} (
        <span className="font-mono">{counts.hash.slice(0, 12)}</span>). {HOW_TO_CHANGE}
      </p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Facts</dt>
        <dd>
          {counts.facts.approved} approved, {counts.facts.waiting} waiting
        </dd>
        <dt className="text-muted-foreground">Known gap lines</dt>
        <dd>
          {counts.knownGaps.approved} approved, {counts.knownGaps.waiting} waiting
        </dd>
      </dl>

      <h2 className="mt-8 font-medium">Facts</h2>
      {byKind.map((group) => (
        <div key={group.name} className="mt-3">
          <h3 className="text-sm text-muted-foreground">{group.name}</h3>
          <ul className="mt-1 space-y-2">
            {group.facts.map((fact) => (
              <li key={fact.id}>
                <p>{fact.statement}</p>
                <p className="text-sm text-muted-foreground">
                  {fact.skills.map(skillName).join(", ")} · {fact.depth}
                  {fact.years === undefined ? "" : ` · ${fact.years} years`} · {fact.source}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <h2 className="mt-8 font-medium">Gap templates</h2>
      <ul className="mt-2 space-y-1">
        {profile.gapTemplates.map((template) => (
          <li key={template.id}>{template.text}</li>
        ))}
      </ul>

      <h2 className="mt-8 font-medium">Known gap lines</h2>
      <ul className="mt-2 space-y-1">
        {profile.knownGaps.map((gap) => (
          <li key={gap.id}>
            {gap.line}{" "}
            <span className="text-sm text-muted-foreground">
              ({gap.skills.map(skillName).join(", ")})
            </span>
          </li>
        ))}
      </ul>

      <h2 className="mt-8 font-medium">Fixed answers</h2>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Salary expectation</dt>
        <dd>
          {Object.entries(answers.salary_expectation)
            .map(([currency, text]) => `${currency}: ${text}`)
            .join("; ")}
        </dd>
        <dt className="text-muted-foreground">Notice period</dt>
        <dd>{answers.notice_period}</dd>
        <dt className="text-muted-foreground">Availability</dt>
        <dd>{answers.availability}</dd>
        <dt className="text-muted-foreground">Working hours</dt>
        <dd>
          {answers.working_window.text} ({answers.working_window.start_utc} to{" "}
          {answers.working_window.end_utc} UTC)
        </dd>
        <dt className="text-muted-foreground">Relocation</dt>
        <dd>{answers.relocation.text}</dd>
        <dt className="text-muted-foreground">Work authorisation</dt>
        <dd>
          <ul>
            {answers.work_authorisation.map((entry) => (
              <li key={entry.place}>
                {placeName(entry.place)}: {entry.authorised ? "authorised" : "not authorised"}
                {entry.text ? `. ${entry.text}` : ""}
              </li>
            ))}
          </ul>
        </dd>
        <dt className="text-muted-foreground">Years per stack</dt>
        <dd>
          {Object.entries(answers.years_per_stack)
            .map(([tag, years]) => `${skillName(tag)} ${years}`)
            .join(", ")}
        </dd>
        <dt className="text-muted-foreground">Equal opportunity questions</dt>
        <dd>
          Gender: {answers.eeo.gender}; ethnicity: {answers.eeo.ethnicity}; veteran:{" "}
          {answers.eeo.veteran}; disability: {answers.eeo.disability}
        </dd>
      </dl>

      <h2 className="mt-8 font-medium">Signature</h2>
      <pre className="mt-2 font-sans text-sm whitespace-pre-wrap">{profile.signature}</pre>

      <h2 className="mt-8 font-medium">CV</h2>
      <p className="mt-2 text-sm">Version {profile.cv.label}</p>
    </section>
  );
}
