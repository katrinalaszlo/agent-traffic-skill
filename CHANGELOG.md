# Changelog

## 0.7.2 (2026-10-24)

Security hardening from the 2026-10-24 review. No API changes; existing code keeps working.

- Every call to Track has a time limit. Batch sends give up after 5 seconds and retry with the same idempotency keys. `handoffUrl` gives up after 3 seconds and returns the link unchanged. `recordOutcome` resolves after at most 3 seconds and keeps retrying in the background. A slow Track can no longer hold your request or payment webhook open.
- Secret-looking path segments are replaced with `:token` before an event leaves your server: JWTs, long hex or base64url strings, and shorter tokens after words like `reset`, `invite`, `magic`, `verify`, `auth`, `token`. Numeric ids, uuids elsewhere and short prefixed ids are kept. New option `pathOf(req)` replaces the default; `redactPath` is exported.
- Signed requests (Web Bot Auth) no longer send the URL's query string unless the signature covers it (`@query`, `@query-param`, `@target-uri` or `@request-target`).
- One warning per process when the endpoint is plain `http://` and not localhost.
- `.env` is read only from the working directory and the app root, no longer from every folder up to the disk root. A monorepo with the key only at the repository root must set the variables in the environment or put `.env` where the server starts.
- The `track_j` journey cookie is now `HttpOnly`. Browser code can still read the `Track-Journey` response header.

Behaviour you may notice: some paths show as `:token` in reports, including long random ids such as Stripe-style ids and ULIDs.

## Rolling back

0.7.1 stays published. To go back:

- Your app: `npm install @katrinalaszlo/track@0.7.1`.
- Everyone: `npm dist-tag add @katrinalaszlo/track@0.7.1 latest` makes new installs get 0.7.1, then `npm deprecate @katrinalaszlo/track@0.7.2 "<reason>"`.
- The install instructions Track serves at /SKILL.md are pinned to a tag; pin them back to v0.7.1 in the track repo.

## Earlier

0.7.1 docs and package links. 0.7.0 handoff links and key-only setup. 0.6.0 sends the request path. See the git tags for details.
