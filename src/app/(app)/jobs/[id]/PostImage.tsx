"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { afterFailure, firstShown, REDRAW_GAP_MS, withLatest } from "./imageUrls";

// When one of the page's images last had it drawn again, so a burst of failures draws it once.
let lastRedraw = Number.NEGATIVE_INFINITY;

/**
 * One of the post's images on the job page: the contact's crop or a
 * screenshot, loading the signed URL imageUrls.ts picks, and having the
 * page drawn again for a new one when it fails.
 */
export function PostImage({
  src,
  alt,
  className,
  width,
  height,
}: {
  src: string;
  alt: string;
  className: string;
  /** The image's size in pixels, so the page keeps its place before it loads. */
  width?: number;
  height?: number;
}) {
  const router = useRouter();
  const image = useRef<HTMLImageElement>(null);
  const [shown, setShown] = useState(() => firstShown(src));
  // Drawn again with a new URL: it replaces one that failed.
  const latest = withLatest(shown, src);
  if (latest !== shown) setShown(latest);

  const failed = () => {
    const next = afterFailure(latest, src);
    setShown(next.shown);
    if (next.redraw && Date.now() - lastRedraw >= REDRAW_GAP_MS) {
      lastRedraw = Date.now();
      router.refresh();
    }
  };

  // An image that failed before React hydrated fired its error unheard: loading it again, now
  // that the handler is attached, fires it again.
  useEffect(() => {
    const element = image.current;
    if (element?.complete && element.naturalWidth === 0) {
      element.setAttribute("src", element.getAttribute("src") ?? "");
    }
  }, []);

  return (
    // A signed URL that lasts 60 seconds, which Next's image loader would outlive.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={image}
      src={latest.src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      onError={failed}
    />
  );
}
