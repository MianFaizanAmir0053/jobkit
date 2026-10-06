"use client";

import { useEffect } from "react";

/** Registers /sw.js, which installing the app and the share target need (platform spec B5). */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // updateViaCache "none" fetches a changed worker at once, as Next's PWA guide does.
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  }, []);
  return null;
}
