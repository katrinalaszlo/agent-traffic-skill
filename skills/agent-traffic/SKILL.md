---
name: agent-traffic
description: Install Track (agent traffic analytics) into a Node/Express API, so the API owner can see which AI agents call their API, which sessions fail, and where. Use when asked to add Track, agent traffic or agent analytics to an API.
---

# Install Track

Three steps: a key, one package and two lines of code, and a check. Done means the check in step 3 says `RESULT: PASS`. Never print the key or salt: the commands below write them to `.env` without showing them. Covers Node 18+ with Express; for another stack, stop and point the user to https://alg.katrinalaszlo.com/docs.md.

## What this installs

Tell the user this before step 1. What it sends, per request, to `alg.katrinalaszlo.com` only: the route pattern, the path without domain, query or fragment (`/v1/users/123`: ordinary ids in path segments are sent as they are, segments that look like secrets, such as the token in `/invite/<token>` or `/reset/<token>`, are sent as `:token`), method, status code, the `User-Agent`, `Signature-Agent` and `Accept-Language` headers, the time, an HMAC-SHA256 of the customer id keyed with a salt that stays in `.env`, and the journey key if the request carried one (the `Track-Journey` header, `?track_j=` in the URL, or the `track_j` cookie, in that order). For a request an agent signed (Web Bot Auth, `Signature` and `Signature-Input` headers), also those two headers, the URL (with its query only when the signature covers it) and the other headers the signature covers, so the signature can be checked; never `Authorization` or `Cookie`. Also, because step 1 sets a salt, `ip_hash`: an HMAC-SHA256 of the client IP (an IPv6 address as its /64) under a key derived from the salt and the UTC date, so it changes every day; the IP and the salt never leave the server. Track uses it only to group an anonymous agent's requests (no cookie, no account) into one visit, for analytics, keeps it 48 hours and never shows or forwards it. It is a heuristic: clients behind one NAT can share a visit, and IPv6 rotation can split one. Otherwise no bodies, no other headers, no raw IPs, no raw ids. If you add `errorOf` (step 2), also the error text it returns for failed responses. It adds the `@katrinalaszlo/track` npm package (MIT, no dependencies, source https://github.com/katrinalaszlo/track-skill) and creates a free workspace at alg.katrinalaszlo.com.

Event names exclude router mount prefixes because they can contain raw IDs (the path field does include them). A route `/orders/:orderId` mounted at `/customers/:customerId` records `orders_orderid`; identical route patterns under different mounts share a name.

## 1. Get a key

From the directory the server starts in, or the app root (the folder whose `node_modules` will hold the package): the middleware reads `.env` from those two places only, never from a folder above them. In a monorepo where the package is installed in the API's workspace and the server starts there, run this in the API's folder. Skip the `curl` if `.env` already has `AGENT_TRAFFIC_KEY`. If a `curl` in this skill prints a JSON error, do what its `next_step` says. The first command adds a final newline to a `.env` that lacks one, so each value below lands on its own line.

```sh
if [ -s .env ] && [ -n "$(tail -c 1 .env)" ]; then echo >> .env; fi
curl -sS --fail-with-body -X POST "https://alg.katrinalaszlo.com/v1/signup?format=env" -H "Content-Type: application/json" -d '{"label":"<project name>","scopes":["read","write"]}' -o .track-signup && cat .track-signup >> .env || cat .track-signup; rm -f .track-signup
grep -q "^AGENT_TRAFFIC_ACCOUNT_SALT=" .env || echo "AGENT_TRAFFIC_ACCOUNT_SALT=$(openssl rand -hex 32)" >> .env
grep -qx ".env" .gitignore 2>/dev/null || echo ".env" >> .gitignore
```

## 2. Add the middleware

Install the `@katrinalaszlo/track` package in the API's package, with the project's package manager (`npm install @katrinalaszlo/track`, `pnpm add @katrinalaszlo/track`, `yarn add @katrinalaszlo/track`; in a monorepo, in the API's workspace). It ships TypeScript types.

Add two lines right after `const app = express()`, before auth and routes:

```js
const { agentTraffic } = require("@katrinalaszlo/track"); // or: import { agentTraffic } from "@katrinalaszlo/track";
app.use(agentTraffic({ accountIdOf: (req, res) => req.user?.id }));
```

`accountIdOf(req, res)` is the one decision: return the id of the customer behind the request as this API's auth resolves it (user id, org id or API key id), or `undefined` when there is none. It runs after the response, so whatever auth set is there: `req.user`, `res.locals.user`, or wherever this app puts it. Read the auth code to find it. Never a constant or a random value. Prefer an id over a secret; if the only stable customer id the app has is derived from their API key, use it (it is HMAC-hashed with the salt before it leaves the server). If you can't tell which field identifies the customer, ask the user.

If the API runs behind a proxy or load balancer (Heroku, Render, Fly, Vercel, nginx), check that the app sets Express's `trust proxy` (`app.set("trust proxy", 1)` for one proxy hop) so `req.ip` is the client's address and not the proxy's; without it every request hashes the proxy's IP and anonymous agents' visits merge. Do not add it if the app is reached directly: then `X-Forwarded-For` can be forged. If unsure, tell the user instead of changing it.

Optional: if this API answers several different errors with the same status (two kinds of 402, say) with an error code in the body, set `res.locals.error = "<that code>"` next to each place it sends an error, and add `errorOf: (req, res) => res.locals.error`, so they show as separate rows in Fix next. Only failed responses (400 and above) are read, up to 200 characters. Use the codes the API already returns; do not invent new ones. The middleware reads its `AGENT_TRAFFIC_` values from the environment or `.env` by itself.

Optional: if a route puts a secret in the path in a shape the default redaction may miss (a short code, a token with no digit), add `pathOf: (req) => req.route?.path` so the route pattern is sent instead of the raw path (not `req.baseUrl`, which holds matched values), or `pathOf: () => undefined` to send no path. Check the routes for invite, reset, magic-link and verify links before deciding.

Optional, offer it once and do it only if the user says yes: keep the middleware in a variable (`const traffic = agentTraffic({...}); app.use(traffic);`) and, in the signup handler and the payment webhook handler, call `await traffic.recordOutcome({ accountId: <the same id accountIdOf returns>, name: "signup", idempotencyKey: <the new account's id> })` and `await traffic.recordOutcome({ accountId, name: "paid", value: <whole minor units, 1999 for $19.99>, currency: "USD", idempotencyKey: <the payment event id> })`. The dashboard then shows which class of agent led to signups and revenue.

Optional, off by default, and only if the user asks for it: `issueJourneyKeys: true` gives each visitor a journey key so its requests across sessions show as one journey. It sets a `track_j` cookie (14 days, `Secure`, `SameSite=Lax`, `HttpOnly`), a `Track-Journey` response header and `Cache-Control: private` on every response, so a shared cache never serves one visitor's key to another. Tell the user that is a new cookie (their cookie policy may need to mention it) and that a CDN stops caching those responses; that is why it is opt-in.

## 3. Check

Start the server, then send at least 5 requests to at least 3 routes as an authenticated customer, including one that fails (4xx), some with agent headers:

```sh
curl -H "User-Agent: Claude-User (claude-code/2.1)" -H 'Signature-Agent: "https://claude.ai"' -H "<auth header>: <test credential>" http://localhost:<port>/<route>
```

Wait 2 seconds, then:

```sh
curl -sS --fail-with-body -X POST https://alg.katrinalaszlo.com/v1/install-check -H "Authorization: Bearer $(sed -n 's/^AGENT_TRAFFIC_KEY=//p' .env)"
```

On a `FAIL` line, fix what it says and repeat step 3. `WARN` lines are for the user.

## Hand off

End by showing the user the claim link: the last line of the install check (`Claim this workspace: <url> (link valid until <date> <time> UTC)`), or `grep '^# Claim this workspace' .env`. Tell them: open it, sign in or create an account, and choose "Add to my account" to keep this workspace, its projects and everything you did in their Track account; the key in `.env` keeps working after the claim and nothing changes for the server; the link works 7 days, and unclaimed nothing is deleted (they can also sign in at https://alg.katrinalaszlo.com/login with `AGENT_TRAFFIC_KEY`). If they say they claimed it, run `curl -sS --fail-with-body https://alg.katrinalaszlo.com/v1/claim -H "Authorization: Bearer $(sed -n 's/^AGENT_TRAFFIC_KEY=//p' .env)"` and confirm `"claimed": true`; if the link expired, `curl -sS --fail-with-body -X POST https://alg.katrinalaszlo.com/v1/claim-link -H "Authorization: Bearer $(sed -n 's/^AGENT_TRAFFIC_KEY=//p' .env)"` returns a new `claim_url`. Also tell them which field `accountIdOf` returns; that production needs `AGENT_TRAFFIC_KEY` and `AGENT_TRAFFIC_ACCOUNT_SALT` from `.env`, with the same salt everywhere (`AGENT_TRAFFIC_PROJECT_ID` is optional: the key already names its project); and that on serverless hosts (Vercel functions, Lambda) events can be lost when the process freezes after the response.
