# Changelog

## 0.7.3 (Unreleased)

- With `AGENT_TRAFFIC_ACCOUNT_SALT` set, each request's event carries `ip_hash`: HMAC-SHA256 of the client IP (`req.ip`; an IPv6 address as its /64 prefix) under a key derived from the salt and the UTC date, so it changes every UTC day. The IP and the salt never leave your server. Without the salt nothing changes, and the middleware prints one line at start saying no `ip_hash` is sent. New export `hashIp(ip, salt, occurredAt)`.
- Purpose: Track groups the requests of an agent that keeps no cookies and never signs in (crawlers, docs fetchers) into one visit instead of one per request, for analytics only, and only for requests whose class is not human. Track keeps `ip_hash` 48 hours, never shows it, never forwards it to PostHog or GA4, and never logs it. There is no identifier that lasts across days.
- It is a heuristic: clients behind one NAT or cloud egress IP can share a visit, and IPv6 address rotation across networks splits one.
- Behind a proxy, set Express's `trust proxy` so `req.ip` is the client's address; otherwise every request hashes the proxy's.

Behaviour you may notice: a Track host that does not accept `ip_hash` yet rejects every event with `unknown_field (ip_hash)` while the salt is set. Upgrade the host, or stay on 0.7.2.

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
