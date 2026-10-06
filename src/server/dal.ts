import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import {
  checkRequirements,
  findSession,
  type Session,
  type SessionRequirements,
} from "@/core/platform/sessions";

import { getContainer } from "./container";
import { SESSION_COOKIE } from "./sessionCookie";

/**
 * The data access layer (platform spec B2). Every function here that reads
 * or writes the owner's data calls `requireSession` first, and so does every
 * page and server action. Nothing relies on a layout: Next 16's guide says
 * layouts do not re-render on navigation and do not stop child segments from
 * rendering (docs/runbook/next16-notes.md).
 */

/**
 * The session the request's cookie names, looked up once per request. The
 * cookie is read before anything else, so `next build` sees a request-time
 * page and never prerenders it, which would need a database.
 */
const currentSession = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const container = await getContainer();
  return { check: await findSession(container, token), now: container.clock.now() };
});

/**
 * The live, approved session, or a redirect: to /login without one, to /pair
 * while a paired phone waits for approval, to Google sign-in when a page
 * needs a recent one, and to the jobs list when it needs a google session.
 */
export async function requireSession(require: SessionRequirements = {}): Promise<Session> {
  const { check, now } = await currentSession();
  if (!check.ok) redirect(check.reason === "unapproved" ? "/pair" : "/login");
  const met = checkRequirements(check.session, now, require);
  if (met.ok) return met.session;
  redirect(met.reason === "stale-google-auth" ? "/api/auth/google/start" : "/jobs");
}

export interface JobSummary {
  id: string;
  title: string;
}

/** The jobs list: empty until the runner's jobs table exists. */
export const listJobs = cache(async (): Promise<JobSummary[]> => {
  await requireSession();
  return [];
});
