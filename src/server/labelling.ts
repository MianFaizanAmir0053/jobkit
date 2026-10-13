import { join } from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import {
  adoptScreenshot,
  archiveFile,
  dismissCase,
  labelsSchema,
  NoCase,
  saveLabels,
} from "../../evals/cases";
import type { Clock, Db } from "@/core/ports";
import { type AppConfig, appConfig } from "@/server/config";
import type { Container } from "@/server/container";
import { NO_STORE, readLimited, refusal, sessionForChange, sessionForRead } from "@/server/http";

/**
 * The labelling page's routes (evals spec, "Labelling"): saving a case's
 * labels, moving a screenshot from the pool into a case, setting a case
 * aside as not an application, and showing an image from the archive. They answer only on the laptop's dev server with
 * JOBKIT_LOCAL_EVALS=1, and only to the laptop's own session; their files
 * are local-only, so no build has them.
 */

/** The evaluation archive: one folder per case, never committed (private/). */
export const ARCHIVE = join(process.cwd(), "private", "archive");

/** The profile file, whose style examples leave a sent email out (amendment A10). */
export const PROFILE = join(process.cwd(), "private", "profile.yaml");

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
}

export function labellingDeps(container: Container): LabellingDeps {
  return {
    db: container.db,
    clock: container.clock,
    config: appConfig(),
    allowed: labellingAllowed(process.env, container.kind),
    archive: ARCHIVE,
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
  if (!deps.allowed) return notFound();
  const actor = await sessionForChange(request, deps, { kind: "google" });
  if (!actor.ok) return actor.response;
  const body = await jsonBody(request, 64 * 1024);
  if (body === "too-large") return refusal(413, "too-large");
  const labels = labelsSchema.safeParse(body);
  if (!labels.success) {
    const fields = [...new Set(labels.error.issues.map((issue) => String(issue.path[0] ?? "")))];
    return refusal(400, "bad-labels", { fields });
  }
  try {
    saveLabels(deps.archive, caseId, labels.data, deps.clock.now());
  } catch (error) {
    return failed(error);
  }
  return NextResponse.json({ saved: true }, { headers: NO_STORE });
}

export async function postAdopt(
  request: NextRequest,
  deps: LabellingDeps,
  caseId: string,
): Promise<NextResponse> {
  if (!deps.allowed) return notFound();
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
  if (!deps.allowed) return notFound();
  const actor = await sessionForChange(request, deps, { kind: "google" });
  if (!actor.ok) return actor.response;
  try {
    dismissCase(deps.archive, caseId);
    return NextResponse.json({ dismissed: true }, { headers: NO_STORE });
  } catch (error) {
    return failed(error);
  }
}

export async function getArchiveImage(
  request: NextRequest,
  deps: LabellingDeps,
  folder: string,
  file: string,
): Promise<NextResponse> {
  if (!deps.allowed) return notFound();
  const actor = await sessionForRead(request, deps, { kind: "google" });
  if (!actor.ok) return actor.response;
  const found = archiveFile(deps.archive, folder, file);
  if (!found) return notFound();
  return new NextResponse(Buffer.from(found.bytes), {
    headers: { "Content-Type": found.contentType, ...NO_STORE },
  });
}
