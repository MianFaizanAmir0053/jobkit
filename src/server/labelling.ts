import { join } from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import {
  adoptScreenshot,
  AlreadySetAside,
  archiveFile,
  CaseChanged,
  dismissCase,
  LabelsRefused,
  labelsSchema,
  NoCase,
  saveLabels,
  shownSchema,
} from "../../evals/cases";
import { styleExamplesOf } from "../../evals/import";
import { JUDGE_LABELS, type JudgeLabel, labelJudgeItem } from "../../evals/judgeSet";
import { labelClaim } from "../../evals/liveClaims";
import type { Clock, Db } from "@/core/ports";
import { type AppConfig, appConfig } from "@/server/config";
import type { Container } from "@/server/container";
import { NO_STORE, readLimited, refusal, sessionForChange, sessionForRead } from "@/server/http";

/**
 * The labelling page's routes (evals spec, "Labelling"): saving a case's
 * labels, moving a screenshot from the pool into a case, setting a case
 * aside as not an application, and showing an image from the archive. They
 * answer only on the laptop's dev server with JOBKIT_LOCAL_EVALS=1, only to
 * a request to the laptop's own address that came through no proxy, as a
 * tunnel to the dev server is, and only to the laptop's own session; their
 * files are local-only, so no build has them.
 */

/** The frozen judge set, never committed (private/). */
export const JUDGE_SET = join(process.cwd(), "private", "evals", "judge-set.json");

/** The evaluation archive: one folder per case, never committed (private/). */
export const ARCHIVE = join(process.cwd(), "private", "archive");

/** The profile file, whose style examples leave a sent email out (amendment A10). */
export const PROFILE = join(process.cwd(), "private", "profile.yaml");

/** What a request says of where it came from: its host and any forwarding headers. */
export interface RequestFrom {
  host: string | null;
  forwardedFor: string | null;
  forwarded: string | null;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An address of this machine: 127.0.0.0/8 or ::1, as IPv4 or mapped into IPv6. */
function isLoopback(address: string): boolean {
  const bare = address.trim().replace(/^::ffff:/i, "");
  return bare === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/**
 * Whether a request is the laptop's own: to a loopback host, with every
 * forwarded address a loopback one and no proxy's Forwarded header. The dev
 * server fills X-Forwarded-For with the socket's address only when a proxy
 * has not, so a tunnel's request carries the phone's address or its own
 * host.
 */
export function fromLaptop(from: RequestFrom): boolean {
  const host = (from.host ?? "").toLowerCase().replace(/:\d+$/, "");
  if (!LOOPBACK_HOSTS.has(host)) return false;
  if (from.forwarded) return false;
  const forwarded = (from.forwardedFor ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");
  return forwarded.every(isLoopback);
}

/** Where a route's request came from, by its URL's host as Next built it and its headers. */
function requestFrom(request: NextRequest): RequestFrom {
  return {
    host: request.headers.get("host") ?? request.nextUrl.host,
    forwardedFor: request.headers.get("x-forwarded-for"),
    forwarded: request.headers.get("forwarded"),
  };
}

export function labellingAllowed(
  env: Readonly<Record<string, string | undefined>>,
  kind: Container["kind"],
): boolean {
  return kind === "development" && env.JOBKIT_LOCAL_EVALS === "1";
}

export interface LabellingDeps {
  db: Db;
  clock: Clock;
  config: AppConfig;
  /** Whether this server may answer at all: labellingAllowed. */
  allowed: boolean;
  archive: string;
  /** The profile file whose style examples leave a case out. */
  profile: string;
}

export function labellingDeps(container: Container): LabellingDeps {
  return {
    db: container.db,
    clock: container.clock,
    config: appConfig(),
    allowed: labellingAllowed(process.env, container.kind),
    archive: ARCHIVE,
    profile: PROFILE,
  };
}

const notFound = () => new NextResponse(null, { status: 404 });

/** A case or file that is not there is 404; anything else, a write that failed, is the server's. */
function failed(error: unknown): NextResponse {
  return error instanceof NoCase ? refusal(404, "not-found") : refusal(500, "server");
}

/** The request's JSON body, read with a cap; "too-large" or "bad" when it is not usable. */
async function jsonBody(request: NextRequest, max: number): Promise<unknown> {
  const body = await readLimited(request, max);
  if (body === "too-large") return "too-large";
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return "bad";
  }
}

export async function postLabels(
  request: NextRequest,
  deps: LabellingDeps,
  caseId: string,
): Promise<NextResponse> {
  if (!deps.allowed || !fromLaptop(requestFrom(request))) return notFound();
  const actor = await sessionForChange(request, deps, { kind: "google" });
  if (!actor.ok) return actor.response;
  const body = await jsonBody(request, 64 * 1024);
  if (body === "too-large") return refusal(413, "too-large");
  // The labels, and what the page showed of the case, which they must record.
  const sent = (body ?? {}) as { labels?: unknown; shown?: unknown };
  const labels = labelsSchema.safeParse(sent.labels);
  if (!labels.success) {
    const fields = [...new Set(labels.error.issues.map((issue) => String(issue.path[0] ?? "")))];
    return refusal(400, "bad-labels", { fields });
  }
  const shown = shownSchema.safeParse(sent.shown);
  if (!shown.success) return refusal(400, "bad-request");
  try {
    await saveLabels(
      deps.archive,
      caseId,
      { labels: labels.data, shown: shown.data, at: deps.clock.now() },
      { styleExamples: styleExamplesOf(deps.profile).examples },
    );
  } catch (error) {
    if (error instanceof LabelsRefused) {
      return refusal(400, "bad-labels", { fields: error.fields });
    }
    if (error instanceof CaseChanged) return refusal(409, "changed");
    return failed(error);
  }
  return NextResponse.json({ saved: true }, { headers: NO_STORE });
}

export async function postAdopt(
  request: NextRequest,
  deps: LabellingDeps,
  caseId: string,
): Promise<NextResponse> {
  if (!deps.allowed || !fromLaptop(requestFrom(request))) return notFound();
  const actor = await sessionForChange(request, deps, { kind: "google" });
  if (!actor.ok) return actor.response;
  const body = await jsonBody(request, 4 * 1024);
  if (body === "too-large") return refusal(413, "too-large");
  const file = (body as { file?: unknown } | null)?.file;
  if (typeof file !== "string") return refusal(400, "bad-request");
  try {
    const name = adoptScreenshot(deps.archive, caseId, file);
    return NextResponse.json({ name }, { headers: NO_STORE });
  } catch (error) {
    return failed(error);
  }
}

/** "Not an application": moves the case's folder aside, where no import brings it back. */
export async function postDismiss(
  request: NextRequest,
  deps: LabellingDeps,
  caseId: string,
): Promise<NextResponse> {
  if (!deps.allowed || !fromLaptop(requestFrom(request))) return notFound();
  const actor = await sessionForChange(request, deps, { kind: "google" });
  if (!actor.ok) return actor.response;
  try {
    dismissCase(deps.archive, caseId);
    return NextResponse.json({ dismissed: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof AlreadySetAside) return refusal(409, "already-set-aside");
    return failed(error);
  }
}

export async function getArchiveImage(
  request: NextRequest,
  deps: LabellingDeps,
  folder: string,
  file: string,
): Promise<NextResponse> {
  if (!deps.allowed || !fromLaptop(requestFrom(request))) return notFound();
  const actor = await sessionForRead(request, deps, { kind: "google" });
  if (!actor.ok) return actor.response;
  const found = archiveFile(deps.archive, folder, file);
  if (!found) return notFound();
  return new NextResponse(Buffer.from(found.bytes), {
    headers: { "Content-Type": found.contentType, ...NO_STORE },
  });
}

/**
 * One judge-set sentence's label from its page (evals spec, "Labelling"):
 * supported or not, once; the page never shows a verdict or what the
 * sentence was meant to be.
 */
export async function postJudgeLabel(
  request: NextRequest,
  deps: LabellingDeps,
  itemId: string,
  file: string = JUDGE_SET,
): Promise<NextResponse> {
  if (!deps.allowed || !fromLaptop(requestFrom(request))) return notFound();
  const actor = await sessionForChange(request, deps, { kind: "google" });
  if (!actor.ok) return actor.response;
  const body = await jsonBody(request, 1024);
  if (body === "too-large") return refusal(413, "too-large");
  const label = (body as { label?: unknown } | null)?.label;
  if (typeof label !== "string" || !(JUDGE_LABELS as readonly string[]).includes(label)) {
    return refusal(400, "bad-label");
  }
  try {
    const saved = labelJudgeItem(
      file,
      itemId,
      label as (typeof JUDGE_LABELS)[number],
      deps.clock.now(),
    );
    if (!saved.ok) return refusal(saved.reason === "labelled" ? 409 : 404, saved.reason);
  } catch (error) {
    return failed(error);
  }
  return NextResponse.json({ saved: true }, { headers: NO_STORE });
}

/**
 * POST /api/dev/label/claims/<case>/<block>: one claim from a live draft,
 * labelled once, blind, as the judge set's sentences are.
 */
export async function postClaimLabel(
  request: NextRequest,
  deps: LabellingDeps,
  caseId: string,
  blockId: string,
  archive: string = ARCHIVE,
): Promise<NextResponse> {
  if (!deps.allowed || !fromLaptop(requestFrom(request))) return notFound();
  const actor = await sessionForChange(request, deps, { kind: "google" });
  if (!actor.ok) return actor.response;
  const body = await jsonBody(request, 1024);
  if (body === "too-large") return refusal(413, "too-large");
  const label = (body as { label?: unknown } | null)?.label;
  if (typeof label !== "string" || !(JUDGE_LABELS as readonly string[]).includes(label)) {
    return refusal(400, "bad-label");
  }
  try {
    const saved = labelClaim(archive, caseId, blockId, label as JudgeLabel, deps.clock.now());
    if (!saved.ok) return refusal(saved.reason === "labelled" ? 409 : 404, saved.reason);
  } catch (error) {
    return failed(error);
  }
  return NextResponse.json({ saved: true }, { headers: NO_STORE });
}
