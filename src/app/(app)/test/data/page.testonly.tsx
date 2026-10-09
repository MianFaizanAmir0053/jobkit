import { notFound } from "next/navigation";

import { getContainer } from "@/server/container";
import { requireSession } from "@/server/dal";
import { testRoutesAllowed } from "@/server/testOnly";

/**
 * A page that shows the owner's data, for the end-to-end tests only
 * (next.config.ts): a phone waiting for approval must get none of it, from
 * the page or from its React Server Components payload (platform spec B2).
 * e2e/pairing.spec.ts looks for the marker below.
 */
export default async function TestDataPage() {
  if (!testRoutesAllowed(process.env, (await getContainer()).kind)) notFound();
  await requireSession();
  return <p>jobkit-e2e-owner-data-marker</p>;
}
