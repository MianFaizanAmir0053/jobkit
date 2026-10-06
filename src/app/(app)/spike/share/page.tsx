import type { Metadata } from "next";

import { requireSession } from "@/server/dal";

export const metadata: Metadata = { title: "Share report · jobkit" };

/**
 * Where the service worker sends a share during the spike: counts and sizes
 * of what Chrome delivered, never the content.
 */
export default async function ShareReportPage({ searchParams }: PageProps<"/spike/share">) {
  await requireSession();
  const query = await searchParams;
  const read = (name: string) => (typeof query[name] === "string" ? query[name] : undefined);
  const count = (name: string) => Number.parseInt(read(name) ?? "0", 10) || 0;
  const error = read("error");
  const images = count("images");
  const works = !error && images > 0;

  return (
    <section aria-labelledby="share-report-heading">
      <h1 id="share-report-heading" className="text-2xl font-semibold tracking-tight">
        What the share delivered
      </h1>
      <p role="status" className="mt-4 text-lg">
        {works
          ? "The share target works: the images arrived."
          : "The share target did not deliver images."}
      </p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm tabular-nums">
        <dt className="text-muted-foreground">Parts</dt>
        <dd>{count("parts")}</dd>
        <dt className="text-muted-foreground">Images</dt>
        <dd>{images}</dd>
        <dt className="text-muted-foreground">Total size</dt>
        <dd>{Math.round(count("bytes") / 1024)} KB</dd>
        <dt className="text-muted-foreground">Types</dt>
        <dd>{read("types") || "none"}</dd>
        <dt className="text-muted-foreground">Text</dt>
        <dd>{count("text")} characters</dd>
        <dt className="text-muted-foreground">Link</dt>
        <dd>{read("url") === "1" ? "yes" : "no"}</dd>
        {error && (
          <>
            <dt className="text-muted-foreground">Error</dt>
            <dd>{error}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
