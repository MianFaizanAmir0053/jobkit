/**
 * Platform spec B2: route handlers that change state accept only requests
 * whose Origin is the app's own. Browsers send Origin with every POST, so a
 * missing one means a client this app did not write, and is refused too.
 */
export function isSameOrigin(request: Request, appOrigin: string): boolean {
  return request.headers.get("origin") === appOrigin;
}
