"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import {
  afterFailure,
  afterLoad,
  type FreshImages,
  firstShown,
  urlFor,
  withFresh,
  withLatest,
} from "./imageUrls";

/** How long an image may take before the page offers "Load again" beside it, still loading. */
const SLOW_MS = 20_000;

/** How long the images route may take to answer. */
const ASK_MS = 15_000;

// The page's asks for fresh URLs in flight, by job: images that fail at once share one.
const asking = new Map<string, Promise<FreshImages | null>>();

/** The job's images signed afresh by the images route; null when it cannot be asked. */
function freshImages(jobId: string): Promise<FreshImages | null> {
  const pending = asking.get(jobId);
  if (pending) return pending;
  const asked = fetch(`/api/jobs/${jobId}/images`, {
    cache: "no-store",
    signal: AbortSignal.timeout(ASK_MS),
  })
    .then(async (response) => (response.ok ? ((await response.json()) as FreshImages) : null))
    .catch(() => null)
    .finally(() => asking.delete(jobId));
  asking.set(jobId, asked);
  return asked;
}

/**
 * One of the post's images on the job page, the contact's crop or a
 * screenshot, loading the URL imageUrls.ts picks. One that fails asks the
 * images route for fresh URLs once of its own, when the phone is online
 * again if it is not; after that, or while it is slow, "Load again" asks.
 */
export function PostImage({
  jobId,
  imageKey,
  src,
  alt,
  className,
  width,
  height,
  loading,
}: {
  jobId: string;
  /** CROP_KEY for the crop, a screenshot's row ID for a screenshot. */
  imageKey: string;
  src: string;
  alt: string;
  className: string;
  /** The image's size in pixels, so the page keeps its place before it loads. */
  width?: number;
  height?: number;
  loading?: "lazy";
}) {
  const image = useRef<HTMLImageElement>(null);
  const [shown, setShown] = useState(() => firstShown(src));
  // The URL that was still loading after SLOW_MS; a new URL starts again.
  const [slow, setSlow] = useState<string | null>(null);
  // Drawn again with a newer URL: it replaces one that failed.
  const latest = withLatest(shown, src);
  if (latest !== shown) setShown(latest);

  const ask = () => {
    void freshImages(jobId).then((fresh) =>
      setShown((now) => withFresh(now, fresh ? urlFor(fresh, imageKey) : null)),
    );
  };

  const failed = () => {
    const next = afterFailure(latest, src);
    setShown(next.shown);
    if (!next.fetch) return;
    if (navigator.onLine) ask();
    else window.addEventListener("online", ask, { once: true });
  };

  // An image that failed before React hydrated fired its error unheard: loading it again, now
  // that the handler is attached, fires it again.
  useEffect(() => {
    const element = image.current;
    if (element?.complete && element.naturalWidth === 0) {
      element.setAttribute("src", element.getAttribute("src") ?? "");
    }
  }, []);

  // A load that neither ends nor fails, as on a stalled connection, is offered "Load again".
  useEffect(() => {
    const loadingSrc = latest.src;
    const timer = setTimeout(() => {
      if (image.current && !image.current.complete) setSlow(loadingSrc);
    }, SLOW_MS);
    return () => clearTimeout(timer);
  }, [latest.src]);

  const stuck = latest.failed || slow === latest.src;
  return (
    <>
      {/* A signed URL that lasts 60 seconds, which Next's image loader would outlive. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={image}
        src={latest.src}
        alt={alt}
        width={width}
        height={height}
        loading={loading}
        className={className}
        onLoad={() => setShown((now) => afterLoad(now))}
        onError={failed}
      />
      {stuck && (
        <span className="mt-1 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {latest.failed ? "This image did not load." : "This image is slow to load."}
          </span>
          <Button type="button" variant="outline" className="min-h-11" onClick={ask}>
            Load again
          </Button>
        </span>
      )}
    </>
  );
}
