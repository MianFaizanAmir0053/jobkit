import { NextResponse } from "next/server";

import { getContainer } from "@/server/container";
import { setScriptedAnswers } from "@/server/scriptedModels";
import { testRoutesAllowed } from "@/server/testOnly";

/**
 * Empties the test database between end-to-end tests. Like the test sign-in
 * route, it exists only in the dev server those tests start, and answers only
 * with the in-memory test database.
 */
export async function POST() {
  const container = await getContainer();
  if (!testRoutesAllowed(process.env, container.kind)) {
    return new NextResponse(null, { status: 404 });
  }
  // Deleting the sessions deletes their pairing tokens and approvals too.
  await container.db.exec(`
    delete from {{schema}}.sessions;
    delete from {{schema}}.owner;
    delete from {{schema}}.baseline_runs;
    delete from {{schema}}.profile_versions;
    delete from {{schema}}.draft_outcomes;
    delete from {{schema}}.kit_reviews;
    delete from {{schema}}.status_changes;
    delete from {{schema}}.applications;
    delete from {{schema}}.model_calls;
    delete from {{schema}}.job_stage_runs;
    delete from {{schema}}.job_leases;
    delete from {{schema}}.job_images;
    delete from {{schema}}.job_state_changes;
    delete from {{schema}}.jobs;
  `);
  // A pipeline left running from an earlier test must not take the next test's answers.
  setScriptedAnswers({});
  return new NextResponse(null, { status: 204 });
}
