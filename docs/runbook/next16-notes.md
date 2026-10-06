# Next.js 16 notes

Read from the guides shipped in `node_modules/next/dist/docs/` (Next.js 16.3.8) on 2026-10-06, before any Next code was written (Task 1). Each note says what it changes in the specs.

## Session checks belong in a data access layer, not in layouts

The authentication guide warns that layouts do not re-render on client-side navigation (partial rendering), and that a layout does not control whether the rest of the route renders: child segments still run and can appear in the RSC payload. Checks must sit close to the data.

**Change to the specs:** platform B2 now puts `requireSession` in a data access layer (`src/server/dal.ts`). Every function that reads or writes the owner's data calls it first, memoised once per request with React's `cache`; pages call it too, for the redirect. Nothing relies on a layout to protect a page. Task 5's test loads `/jobs` and a test page as an unapproved phone and checks that no data reaches the response.

## `after()` runs within the route's maximum duration

`after` callbacks run for the platform's default or configured maximum duration of the route, set with the `maxDuration` route segment config.

**Change to the specs:** the routes that start the pipeline (`/api/jobs/<id>/uploaded` and `/api/jobs/<id>/advance`) export `maxDuration = 300`, matching Vercel Hobby's limit with Fluid compute. The day-2 spike confirms it on Vercel.

## Cookies are set only in Server Functions and Route Handlers

`cookies().set` and `.delete` work only in Server Functions and Route Handlers, because HTTP cannot set cookies after streaming starts. This matches platform B2, which already sets and rotates the session cookie only there.

## Proxy, not middleware

Middleware is called Proxy from Next 16 (`src/proxy.ts`, a named `proxy` export or a default export). The guide repeats that Proxy is for optimistic checks only and must not be the authorisation layer, as platform B2 already says.

## Caching

Cache Components (`cacheComponents: true`, the `use cache` directive) is opt-in. jobkit does not enable it: its pages hold one person's private data and are rendered per request. Calling `cookies()` already makes a route dynamic.

## Route types need `next typegen`

`create-next-app`'s layout uses the global `LayoutProps` type, which Next generates from the routes. `npm run typecheck` therefore runs `next typegen` before `tsc --noEmit`, so CI can typecheck without a full build.

## Environment files

Next loads `.env`, `.env.local` and the per-environment variants automatically. `.env.ops.local` is not a Next convention, so the app never loads it; only the operations scripts read it, and only with `--prod` (platform B8).

## Progressive web app

The guide uses `app/manifest.ts` for the manifest and a service worker served from `public/`, with headers that stop it being cached stale (`Cache-Control: no-cache, no-store, must-revalidate`) and set its content type. Intake's share-target handling follows that pattern; the headers go in `next.config.ts` when the service worker arrives (Task 8). The experimental `useOffline` hook is not used.

## Read the request before touching the database

`next build` tries to prerender every page it can. A page counts as request-time only once it calls `cookies()` or another request-time API, so the data access layer reads the session cookie first and opens the database after. The other way round, the first build failed while prerendering `/jobs`, because the container refuses to start without `JOBKIT_ENV`. (Found in Task 4.)

## A route that only test builds contain

`pageExtensions` decides which files count as pages and routes. `next.config.ts` adds the extension `testonly.ts` only when `JOBKIT_ENV=test`, so `src/app/api/test/signin/route.testonly.ts` is a route in test builds and an ordinary, unrouted file everywhere else. Checked both ways in Task 4: the default build's `.next/app-path-routes-manifest.json` lacks `/api/test/signin` and `next start` answers it with 404, while a `JOBKIT_ENV=test` build lists it. `npm run build` runs `scripts/checkBuild.ts` after `next build`, which fails any build outside `JOBKIT_ENV=test` whose manifest holds a route under `/api/test/`; Vercel runs the same script, so a misconfigured production build fails instead of shipping the route.

## Testing the proxy: the guide and the package disagree

The proxy guide names `unstable_doesProxyMatch` from `next/experimental/testing/server`, but 16.3.8 exports only `unstable_doesMiddlewareMatch` (checked in both the typings and the JavaScript). `src/proxy.test.ts` imports the latter under the former's name, so a later Next that renames it needs a one-line change.

## Agent files

`create-next-app` adds `AGENTS.md` and a `CLAUDE.md` that points to it, telling coding agents to read these guides first; `next dev` re-adds the block if it is removed. Both stay in the repository.
