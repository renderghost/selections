# SoundSelections

A fast, responsive browser for Barry Prendergast's curated playlists on [TIDAL](https://tidal.com): weekly selections for every genre and mood, plus deep dives into artists' back catalogues.

- Browse every public playlist, artwork first, on any screen size.
- Search titles, artist/genre tags and descriptions as you type (accents ignored: "bjork" finds "Björk").
- Filter by artist or genre, taken from the playlist title — "Night drive (rock)" is tagged *rock*. Every trailing bracket is its own tag, so "Night drive (rock) (jazz)" is tagged both.
- Sort by when a playlist was created, when it was last updated, or by title, in either direction.
- Open a playlist to play it in TIDAL's embedded player, open it in TIDAL, or copy its link.
- Every view has its own URL (`?q=`, `?tag=`, `?sort=created|updated|title`, `?order=asc|desc`, `?p=<playlist>`), so it can be shared, bookmarked, and the Back button closes an open playlist.

## Quick start

Requires Node.js 22.12 or newer.

```bash
npm install
npm run dev:mock     # demo playlists, no TIDAL account needed
```

Open <http://localhost:3000>.

## Connecting your TIDAL account

1. In your app at [developer.tidal.com](https://developer.tidal.com/dashboard), copy the **Client ID** and **Client Secret**.
2. Copy `.env.example` to `.env` and fill in:

   ```
   TIDAL_CLIENT_ID=…
   TIDAL_CLIENT_SECRET=…
   TIDAL_USER_ID=…          # whose playlists to show (see below)
   TIDAL_PROFILE_URL=…      # optional: link for the "View on TIDAL" button
   ```

3. `npm run dev`, and check the terminal: it logs `Fetched playlists from TIDAL` with a count when everything works.

### If TIDAL refuses: sign in once

TIDAL has said its playlist endpoints may require a signed-in user, even for public playlists. If the log shows *"TIDAL denied access … Run `npm run tidal:login`"*:

1. In the TIDAL dashboard, add `http://localhost:3000/callback` as a **Redirect URI** for your app, and enable the `user.read` and `playlists.read` scopes.
2. Stop the app, then run `npm run tidal:login -- --save` and sign in with the link it prints.
3. It saves `TIDAL_REFRESH_TOKEN` (and your `TIDAL_USER_ID`) to `.env`. Add the same values to your Vercel project's environment variables.

The refresh token grants read access to your account: keep it secret. Only **public** playlists are ever shown, whichever way the app signs in.

**Finding your user ID:** `npm run tidal:login` prints it.

## Deploying (Vercel)

1. In Vercel, **Add New → Project** and import this GitHub repository. Vercel detects an Express app (`app.js`). There is no build step, and the settings in `vercel.json` need no changes.
2. Under **Settings → Environment Variables**, add for Production (and Preview, if you want working preview deployments):
   - `TIDAL_CLIENT_ID`, `TIDAL_CLIENT_SECRET`, `TIDAL_USER_ID`, `TIDAL_REFRESH_TOKEN`
   - `TIDAL_PROFILE_URL` (optional) and `SENTRY_DSN` (optional)
   - `SITE_URL` only if you use a custom domain; otherwise the project's production URL is used.
3. Deploy. Every pull request gets its own preview deployment.
4. Check `https://<your-site>/healthz`: it should report `"status":"ok"` and a playlist count.

How the app runs on Vercel:

- **One function, CDN-served files:** `app.js` is a single Vercel Function. Everything in `public/` is served directly by Vercel's CDN; `vercel.json` maps the versioned `/static/<hash>/…` URLs onto those files and marks them cacheable for a year.
- **Playlist data is cached on the CDN:** API responses carry a `Vercel-CDN-Cache-Control` header, so the CDN answers repeat requests and refreshes in the background. Visitors only wait for TIDAL (about 10 seconds for ~340 playlists) on the first request after a deploy, or when the CDN has no copy at all. Change `CDN_CACHE_SECONDS` (default 600) to tune this.
- **Disk:** each function instance keeps its saved copy in the temp directory, the only writable place on Vercel.
- **Background work:** refreshes and Sentry reports run through `waitUntil`, so they finish after the response is sent.
- **Preview toolbar:** on preview deployments, Vercel's toolbar may be blocked by the site's Content Security Policy and show up as CSP reports in the logs. This is harmless; the toolbar can be turned off in the project settings.

`npm start` still runs a normal long-lived server for any other host.

## How it stays fast

**On the server.** All playlists and their artwork come from TIDAL in a handful of paginated requests. The old app made one extra request for every playlist. The result is kept in memory for `CACHE_DURATION` (10 minutes by default) and saved to disk, so a restart serves instantly. After that, the next visit triggers a background refresh, and visitors never wait for it. On Vercel, the CDN also caches the playlist data (see *Deploying*). If TIDAL is down, the last good copy keeps being served while the server retries with back-off.

**In the browser.**
- **First visit:** one request for everything, roughly 10–20 KB compressed for 150 playlists. A tiny script in `<head>` starts it before the app's code has even downloaded, and the newest playlist's artwork is preloaded.
- **Return visits:** the grid renders instantly from the browser's saved copy (localStorage). The app then asks the server whether anything has changed, using an ETag. Usually the answer is an empty `304 Not Modified`.
- **When something has changed:** the server sends a manifest of every playlist's id and revision. The browser then downloads only the playlists that are new or edited, drops deleted ones, and says *"A new playlist has been added since your last visit."*

**Images and assets.**
- **Artwork:** each image is sized to fit its card (`srcset`/`sizes`), lazy-loaded as you scroll, and fades in over its own palette colour. Only the first row loads eagerly.
- **TIDAL player:** loads only when a playlist is opened, and is removed when it closes.
- **CSS, JS and fonts:** served from URLs that include a hash of their contents, so browsers cache them for a year and a deploy updates them all at once. No build step is needed. The DM Sans font is self-hosted, and icons are inlined Lucide SVGs, so no font or icon service is contacted.

## Errors: handling and reporting

- **For visitors:** nothing fails silently or shows a broken page.
  - Clear messages, with a *Try again* button.
  - Offline detection, with an automatic retry on reconnect.
  - Automatic retries while TIDAL is unavailable.
  - The saved copy stays on screen when a refresh fails.
  - A placeholder for any artwork that fails to load, and a fallback when the clipboard is blocked.
- **Server logs:** structured JSON, one line per request, each with a request ID. Visitors see that ID ("Reference: …") on error messages, so a report can be matched to its log line. Secrets are redacted.
- **Browser errors:** sent to `POST /api/reports`, which de-duplicates and rate-limits them before logging. Content-Security-Policy violations are reported there too.
- **Sentry (optional):** set `SENTRY_DSN` to receive server and browser errors with alerting. The SDK loads only when configured.
- **TIDAL failures:** carry TIDAL's own error code and request ID. Credential problems explain how to fix them.
- **Health:** `GET /healthz` reports `ok`, `degraded` (serving the last good copy) or `unavailable`, with the data's age.
- **Crashes:** an unexpected crash is reported before the process exits, and the host restarts it. Shutdown on deploy is graceful.

## Development

```bash
npm run dev          # with your TIDAL account; restarts on server changes
npm run dev:mock     # with generated demo data
npm test             # unit and integration tests (Node's built-in runner)
npm run check        # syntax-check every JS file, including browser code
```

CI runs `check` and `test` on every pull request (`.github/workflows/ci.yml`).

```
app.js                 entry point: exported as the Vercel Function, or listens locally
vercel.json            Vercel rewrites, cache headers and function settings
src/
  site.js              builds the app; serve() runs it as a normal server
  config.js            settings from the environment, validated at start-up
  catalogue.js         server copy of the playlists: refresh, back-off, disk snapshot
  reporting.js         one place for errors: logs + optional Sentry
  tidal/               TIDAL auth, API client (retries, pagination), normalisation, mock
  http/                Express app, security headers, report intake, asset versioning
views/                 page templates
public/
  css/app.css          all styles
  js/                  browser modules: sync, store, grid, dialog, filter, report…
scripts/tidal-login.js one-time TIDAL sign-in helper
test/                  tests
```

## Licence

MIT. The DM Sans font is licensed under the SIL Open Font License (`public/fonts/OFL.txt`). Icons are from [Lucide](https://lucide.dev) (ISC licence).
