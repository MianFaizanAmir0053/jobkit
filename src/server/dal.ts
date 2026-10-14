import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { baselineSummary, type BaselineSummary } from "@/core/ledger/baseline";
import { listDevices, type Device } from "@/core/platform/devices";
import { waitingPhones, type WaitingPhone } from "@/core/platform/pairing";
import {
  getActiveProfile,
  getProfileVersion,
  type Profile,
  profileCounts,
  type ProfileCounts,
} from "@/core/profile/profile";
import {
  checkRequirements,
  findSession,
  type Session,
  type SessionRequirements,
} from "@/core/platform/sessions";
import { type JobListItem, listJobViews, jobView, type JobView } from "@/core/review/jobView";
import { cvFileName } from "@/core/review/send";
import { isUuid } from "@/lib/uuid";

import { getContainer } from "./container";
import { gmailConnection, type GmailConnection } from "./gmail/connection";
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

/** The jobs list, newest first. */
export const listJobs = cache(async (): Promise<JobListItem[]> => {
  await requireSession();
  return listJobViews(await getContainer());
});

/** One job as its page shows it, its upload timeout applied; null for an unknown ID. */
export const jobForViewer = cache(async (id: string): Promise<JobView | null> => {
  await requireSession();
  if (!isUuid(id)) return null;
  return jobView(await getContainer(), id);
});

/**
 * The time zone the owner reads times in: the active profile's, or UTC
 * before there is one. Paired phones see times too, but no other profile data.
 */
export const viewerTimeZone = cache(async (): Promise<string> => {
  await requireSession();
  const profile = await getActiveProfile((await getContainer()).db);
  return profile?.owner.location.timezone ?? "UTC";
});

/** The Devices page's list: google sessions only (platform spec B3). */
export const devicesForViewer = cache(async (): Promise<Device[]> => {
  const session = await requireSession({ kind: "google" });
  return listDevices(await getContainer(), session);
});

/** Phones waiting for this session to type their code, so a reload resumes approval. */
export const waitingPhonesForViewer = cache(async (): Promise<WaitingPhone[]> => {
  const session = await requireSession({ kind: "google" });
  return waitingPhones(await getContainer(), session);
});

/** The request's time from the container's clock, for pages that show ages. */
export const requestTime = cache(async (): Promise<Date> => (await getContainer()).clock.now());

/** The owner's Gmail connection for one-click send, without its token; null when not connected. */
export const gmailForViewer = cache(async (): Promise<GmailConnection | null> => {
  await requireSession();
  return gmailConnection((await getContainer()).db);
});

/** The Baseline page: the stopwatch and the manual runs' timings (ledger spec). */
export const baselineForViewer = cache(async (): Promise<BaselineSummary> => {
  await requireSession();
  return baselineSummary(await getContainer());
});

/**
 * The Profile page (profile spec): the active version's approved items and
 * how many wait. Google sessions only: it holds the owner's fixed answers.
 */
export const profileForViewer = cache(
  async (): Promise<{ profile: Profile; counts: ProfileCounts } | null> => {
    await requireSession({ kind: "google" });
    const { db } = await getContainer();
    const profile = await getActiveProfile(db);
    const counts = profile && (await profileCounts(db, profile.versionId));
    return profile && counts ? { profile, counts } : null;
  },
);

/**
 * The CV "Approve & send" attaches, as the recruiter sees its name: the one
 * of the profile version the email was written with; null when that version,
 * or its CV in storage, is gone.
 */
export const kitCvForViewer = cache(async (versionId: string): Promise<string | null> => {
  await requireSession();
  const { db, storage } = await getContainer();
  const profile = await getProfileVersion(db, versionId);
  if (!profile || !(await storage.stat(profile.cv.path))) return null;
  return cvFileName(profile.owner.name);
});
