import { requireSession } from "@/server/dal";

/**
 * A page that shows the owner's data, for the end-to-end tests only
 * (next.config.ts): a phone waiting for approval must get none of it, from
 * the page or from its React Server Components payload (platform spec B2).
 * e2e/pairing.spec.ts looks for the marker below.
 */
export default async function TestDataPage() {
  await requireSession();
  return <p>jobkit-e2e-owner-data-marker</p>;
}
