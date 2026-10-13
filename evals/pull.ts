import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { stageOutput } from "@/core/platform/runner";
import type { Db, Storage } from "@/core/ports";

/**
 * Live cases (evals spec, "Case sources"; intake spec, "Storage and
 * retention"): each job with images kept for evaluation becomes a case
 * folder on the laptop, `<archive>/live-<received date>-<job ID start>/`,
 * with each kept image as `<purpose>-<place>.<extension>`, the stored crop
 * of its contact as `crop.png` and its pasted text as `pasted.txt` when it
 * had them, and the job's ID and arrival in `source.json`. Each image is
 * checked against its hash, and the crop against the hash its name holds.
 * A new case is put together in `_pulling/` and moved into the archive
 * whole, so a pull that fails leaves no half-made case. Only the keep flags
 * of the images copied are cleared, so the 30-day purge then deletes the
 * cloud copy (amendment A7). A job whose image cannot be copied keeps its
 * flags for the next pull, or until `releaseKeptJob` leaves it to the purge.
 */

/** Where a new case is put together before it joins the archive. */
const STAGING = "_pulling";

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export interface PullReport {
  cases: { id: string; images: number }[];
  /** Jobs left kept because an image could not be copied, with why. */
  failed: { jobId: string; reason: string }[];
}

type KeptImage = {
  id: string;
  job_id: string;
  received_at: Date;
  pasted_text: string | null;
  purpose: string;
  position: number;
  storage_path: string;
  content_type: string;
  sha256: string;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function pullKeptJobs(
  deps: { db: Db; storage: Storage },
  archive: string,
): Promise<PullReport> {
  const { rows } = await deps.db.query<KeptImage>(
    `select i.id, i.job_id, j.received_at, j.pasted_text, i.purpose, i.position, i.storage_path,
            i.content_type, i.sha256
       from {{schema}}.job_images as i join {{schema}}.jobs as j on j.id = i.job_id
      where i.kept_for_eval
      order by j.received_at, i.job_id, i.purpose, i.position`,
  );
  const jobs = new Map<string, KeptImage[]>();
  for (const row of rows) jobs.set(row.job_id, [...(jobs.get(row.job_id) ?? []), row]);

  const report: PullReport = { cases: [], failed: [] };
  for (const [jobId, images] of jobs) {
    const { received_at: receivedAt, pasted_text: pastedText } = images[0]!;
    const id = `live-${receivedAt.toISOString().slice(0, 10)}-${jobId.slice(0, 8)}`;
    const folder = join(archive, id);
    // A case pulled before is completed where it is; a new one is put together aside.
    const work = existsSync(folder) ? folder : join(archive, STAGING, id);
    try {
      mkdirSync(work, { recursive: true });
      for (const image of images) {
        const name = `${image.purpose} image ${image.position + 1}`;
        const file = join(
          work,
          `${image.purpose}-${image.position + 1}.${EXTENSIONS[image.content_type] ?? "img"}`,
        );
        if (existsSync(file) && sha256(readFileSync(file)) === image.sha256) continue;
        const bytes = await deps.storage.get(image.storage_path);
        if (!bytes) throw new Error(`${name} is gone from storage`);
        if (sha256(bytes) !== image.sha256) throw new Error(`${name} does not match its hash`);
        writeFileSync(file, bytes);
      }
      await copyCrop(deps, jobId, work);
      if (pastedText && pastedText.trim() !== "") {
        writeFileSync(join(work, "pasted.txt"), pastedText);
      }
      writeFileSync(
        join(work, "source.json"),
        `${JSON.stringify({ jobId, receivedAt: receivedAt.toISOString() }, null, 2)}\n`,
      );
      if (work !== folder) renameSync(work, folder);
    } catch (error) {
      report.failed.push({ jobId, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    // Only the flags read above: an image kept while this ran waits for the next pull.
    await deps.db.query(
      "update {{schema}}.job_images set kept_for_eval = false where id = any($1::uuid[])",
      [images.map((image) => image.id)],
    );
    report.cases.push({ id, images: images.length });
  }
  return report;
}

/**
 * The crop the job's second read stored of its contact, for the crop
 * label, when it is still there and matches the hash its name holds.
 */
async function copyCrop(deps: { db: Db; storage: Storage }, jobId: string, folder: string) {
  const read = (await stageOutput(deps.db, jobId, "address_read"))?.output as
    { cropPath?: unknown } | undefined;
  if (typeof read?.cropPath !== "string") return;
  const bytes = await deps.storage.get(read.cropPath);
  if (bytes && `${sha256(bytes)}.png` === basename(read.cropPath)) {
    writeFileSync(join(folder, "crop.png"), bytes);
  }
}

/**
 * Clears a job's keep flags without copying it, for a job whose images
 * cannot be copied (`npm run eval:pull -- --release <job ID>`): the purge
 * then deletes them. Returns how many were kept.
 */
export async function releaseKeptJob(db: Db, jobId: string): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `update {{schema}}.job_images set kept_for_eval = false
      where job_id = $1 and kept_for_eval returning id`,
    [jobId],
  );
  return rows.length;
}
