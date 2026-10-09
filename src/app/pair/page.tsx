import type { Metadata } from "next";

import { PairPhone } from "./PairPhone";

export const metadata: Metadata = { title: "Pair this phone · jobkit" };

// Runs while the HTML is still being parsed, before the page's scripts load:
// takes the token out of the address bar at once (platform spec B3) and keeps
// it in memory only, where PairPhone reads it.
const TAKE_TOKEN = `(function(){var m=/(?:^#|&)t=([A-Za-z0-9_-]+)/.exec(location.hash);if(m){window.__jobkitPairToken=m[1];history.replaceState(null,"","/pair")}})()`;

/**
 * The phone's side of QR pairing (platform spec B3). The page shell needs no
 * session: the token arrives in the URL fragment, which never reaches the
 * server, and the client posts it in a request body.
 */
export default function PairPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-12">
      <script dangerouslySetInnerHTML={{ __html: TAKE_TOKEN }} />
      <h1 className="text-2xl font-semibold tracking-tight">Pair this phone</h1>
      <PairPhone />
    </main>
  );
}
