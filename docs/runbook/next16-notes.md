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

## Agent files

`create-next-app` adds `AGENTS.md` and a `CLAUDE.md` that points to it, telling coding agents to read these guides first; `next dev` re-adds the block if it is removed. Both stay in the repository.
