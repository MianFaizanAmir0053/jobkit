import type { Metadata } from "next";

import { PairPhone } from "./PairPhone";

export const metadata: Metadata = { title: "Pair this phone · jobkit" };

/**
 * The phone's side of QR pairing (platform spec B3). The page shell needs no
 * session: the token arrives in the URL fragment, which never reaches the
 * server, and the client posts it in a request body.
 */
export default function PairPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Pair this phone</h1>
      <PairPhone />
    </main>
  );
}
