/**
 * The hostnames the dev server lets request its dev-only assets besides
 * localhost (next.config.ts, `allowedDevOrigins`): the tunnel's, when
 * APP_ORIGIN names a tunnel to the dev server so the phone can reach it
 * (docs/runbook/local.md). Next blocks any other hostname by default
 * (node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/allowedDevOrigins.md),
 * and only the tunnel's own hostname is allowed, never every subdomain of
 * the tunnel service.
 */
export function devOriginsFor(appOrigin: string | undefined): string[] {
  let hostname: string;
  try {
    hostname = new URL(appOrigin ?? "").hostname;
  } catch {
    return [];
  }
  return hostname === "localhost" || hostname === "127.0.0.1" ? [] : [hostname];
}
