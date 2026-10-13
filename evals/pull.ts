import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Db, Storage } from "@/core/ports";

/**
 * Live cases (evals spec, "Case sources"; intake spec, "Storage and
 * retention"): each job with images kept for evaluation becomes a case
 * folder on the laptop, `<archive>/live-<received date>-<job ID start>/`,
 * with each kept image as `<purpose>-<place>.<extension>` and the job's ID
 * and arrival in `source.json`. Each image is checked against its hash, and
 * only once all of a job's are copied is its keep flag cleared, so the
 * 30-day purge then deletes the cloud copy (amendment A7). A job whose
 * image cannot be copied keeps its flag for the next pull.
 */

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
  job_id: string;
  received_at: Date;
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
    `select i.job_id, j.received_at, i.purpose, i.position, i.storage_path, i.content_type, i.sha256
       from {{schema}}.job_images as i join {{schema}}.jobs as j on j.id = i.job_id
      where i.kept_for_eval
      order by j.received_at, i.job_id, i.purpose, i.position`,
  );
  const jobs = new Map<string, KeptImage[]>();
  for (const row of rows) jobs.set(row.job_id, [...(jobs.get(row.job_id) ?? []), row]);

  const report: PullReport = { cases: [], failed: [] };
  for (const [jobId, images] of jobs) {
    const receivedAt = images[0]!.received_at;
    const id = `live-${receivedAt.toISOString().slice(0, 10)}-${jobId.slice(0, 8)}`;
    const folder = join(archive, id);
    try {
      mkdirSync(folder, { recursive: true });
      for (const image of images) {
        const name = `${image.purpose} image ${image.position + 1}`;
        const file = join(
          folder,
          `${image.purpose}-${image.position + 1}.${EXTENSIONS[image.content_type] ?? "img"}`,
        );
        if (existsSync(file) && sha256(readFileSync(file)) === image.sha256) continue;
        const bytes = await deps.storage.get(image.storage_path);
        if (!bytes) throw new Error(`${name} is gone from storage`);
        if (sha256(bytes) !== image.sha256) throw new Error(`${name} does not match its hash`);
        writeFileSync(file, bytes);
      }
      writeFileSync(
        join(folder, "source.json"),
        `${JSON.stringify({ jobId, receivedAt: receivedAt.toISOString() }, null, 2)}\n`,
      );
    } catch (error) {
      report.failed.push({ jobId, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    await deps.db.query(
      "update {{schema}}.job_images set kept_for_eval = false where job_id = $1 and kept_for_eval",
      [jobId],
    );
    report.cases.push({ id, images: images.length });
  }
  return report;
}
