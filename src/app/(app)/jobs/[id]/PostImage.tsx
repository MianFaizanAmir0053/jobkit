"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import {
  afterFailure,
  afterLoad,
  asked,
  type FreshImages,
  firstShown,
  urlFor,
  withAnswer,
  withLatest,
} from "./imageUrls";

/** How long a started image may take before the page offers "Load again" beside it, still loading. */
const SLOW_MS = 20_000;

/** How long the images route may take to answer. */
const ASK_MS = 15_000;

// The asks for fresh URLs in flight, by job: images that fail at once share one.
const asking = new Map<string, Promise<void>>();
// The images on each job's page, each told every answer, whichever image asked.
const listening = new Map<string, Set<(fresh: FreshImages) => void>>();

/** Asks the images route for the job's images signed afresh, and tells each of its images. */
function askFresh(jobId: string): void {
  if (asking.has(jobId)) return;
  const asked = fetch(`/api/jobs/${jobId}/images`, {
    cache: "no-store",
    signal: AbortSignal.timeout(ASK_MS),
  })
    .then(async (response) => (response.ok ? ((await response.json()) as FreshImages) : null))
    .catch(() => null)
    .then((fresh) => {
      if (fresh) for (const tell of listening.get(jobId) ?? []) tell(fresh);
    })
    .finally(() => asking.delete(jobId));
  asking.set(jobId, asked);
}

/**
 * One of the post's images on the job page, the contact's crop or a
 * screenshot, loading the URL imageUrls.ts picks. One that fails asks the
 * images route for fresh URLs once of its own, once the phone is online if
 * it is not; after that, or while it is slow, "Load again" asks. A lazy
 * one starts once it comes into view, as when its list is opened.
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
  failedWords = "This image did not load.",
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
  /** What the page says when it did not load. */
  failedWords?: string;
}) {
  const image = useRef<HTMLImageElement>(null);
  const [shown, setShown] = useState(() => firstShown(src));
  const [started, setStarted] = useState(loading !== "lazy");
  // The URL that was still loading after SLOW_MS; a new URL, or a load, ends it.
  const [slow, setSlow] = useState<string | null>(null);
  // An ask that waits for the phone to be online.
  const [waiting, setWaiting] = useState(false);
  // Drawn again with a newer URL: it replaces one that failed, or one not yet started.
  const latest = withLatest(shown, src, !started);
  if (latest !== shown) setShown(latest);

  const ask = () => {
    setShown((now) => asked(now));
    if (navigator.onLine) askFresh(jobId);
    else setWaiting(true);
  };

  const failed = () => {
    const next = afterFailure(latest, src);
    setShown(next.shown);
    if (next.fetch) ask();
  };

  // Every answer to the page's asks, whichever image asked.
  useEffect(() => {
    const images = listening.get(jobId) ?? new Set<(fresh: FreshImages) => void>();
    listening.set(jobId, images);
    const tell = (fresh: FreshImages) =>
      setShown((now) => withAnswer(now, urlFor(fresh, imageKey), !started));
    images.add(tell);
    return () => {
      images.delete(tell);
      if (images.size === 0) listening.delete(jobId);
    };
  }, [jobId, imageKey, started]);

  // An ask made offline goes once the phone is online, unless the image has left the page.
  useEffect(() => {
    if (!waiting) return;
    const online = () => {
      setWaiting(false);
      askFresh(jobId);
    };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [waiting, jobId]);

  // A lazy image starts once it comes into view.
  useEffect(() => {
    const element = image.current;
    if (started || !element || typeof IntersectionObserver === "undefined") return;
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        seen.disconnect();
        setStarted(true);
      }
    });
    seen.observe(element);
    return () => seen.disconnect();
  }, [started]);

  // An image that failed before React hydrated fired its error unheard: loading it again, now
  // that the handler is attached, fires it again.
  useEffect(() => {
    const element = image.current;
    if (element?.complete && element.naturalWidth === 0) {
      element.setAttribute("src", element.getAttribute("src") ?? "");
    }
  }, []);

  // A started load that neither ends nor fails, as on a stalled connection, is offered "Load again".
  useEffect(() => {
    if (!started) return;
    const loadingSrc = latest.src;
    const timer = setTimeout(() => {
      if (image.current && !image.current.complete) setSlow(loadingSrc);
    }, SLOW_MS);
    return () => clearTimeout(timer);
  }, [latest.src, started]);

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
        onLoad={() => {
          setSlow(null);
          setShown((now) => afterLoad(now));
        }}
        onError={failed}
      />
      {stuck && (
        <span className="mt-1 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {waiting
              ? "Waiting for the connection to load it again."
              : latest.failed
                ? failedWords
                : "This image is slow to load."}
          </span>
          <Button type="button" variant="outline" className="min-h-11" onClick={ask}>
            Load again
          </Button>
        </span>
      )}
    </>
  );
}
