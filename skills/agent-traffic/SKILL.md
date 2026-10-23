---
name: agent-traffic
description: Install agent traffic into a Node/Express API, so the API owner can see which AI agents call their API, which sessions fail, and where. Use when asked to add agent traffic or agent analytics to an API.
---

# Install agent traffic

Three steps: a key, one package and two lines of code, and a check. Done means the check in step 3 says `RESULT: PASS`. Never print the key or salt: the commands below write them to `.env` without showing them. Covers Node 18+ with Express; for another stack, stop and point the user to https://alg.katrinalaszlo.com/docs.md.

## What this installs

Tell the user this before step 1. What it sends, per request, to `alg.katrinalaszlo.com` only: the route pattern (not the URL or query), method, status code, the `User-Agent`, `Signature-Agent` and `Accept-Language` headers, the time, and an HMAC-SHA256 of the customer id keyed with a salt that stays in `.env`. For a request an agent signed (Web Bot Auth, `Signature` and `Signature-Input` headers), also those two headers, the full URL and the other headers the signature covers, so the signature can be checked; never `Authorization` or `Cookie`. Otherwise no bodies, no other headers, no IPs, no raw ids. If you add `errorOf` (step 2), also the error text it returns for failed responses. It adds the `@katrinalaszlo/track` npm package (MIT, no dependencies, source https://github.com/katrinalaszlo/agent-traffic-skill) and creates a free workspace at alg.katrinalaszlo.com.

Event names exclude router mount prefixes because they can contain raw IDs. A route `/orders/:orderId` mounted at `/customers/:customerId` records `orders_orderid`; identical route patterns under different mounts share a name.

## 1. Get a key

From the repository root (in a monorepo, the workspace root is fine: the middleware finds `.env` in the directory the server starts from, its own folder, or any folder above). Skip the first command if `.env` already has `AGENT_TRAFFIC_KEY`.

```sh
curl -fsS -X POST "https://alg.katrinalaszlo.com/v1/signup?format=env" -H "Content-Type: application/json" -d '{"label":"<project name>","scopes":["read","write"]}' >> .env
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

Optional: if this API answers several different errors with the same status (two kinds of 402, say) with an error code in the body, set `res.locals.error = "<that code>"` next to each place it sends an error, and add `errorOf: (req, res) => res.locals.error`, so they show as separate rows in Fix next. Only failed responses (400 and above) are read, up to 200 characters. Use the codes the API already returns; do not invent new ones. The middleware reads its `AGENT_TRAFFIC_` values from the environment or `.env` by itself.

Optional, offer it once and do it only if the user says yes: keep the middleware in a variable (`const traffic = agentTraffic({...}); app.use(traffic);`) and, in the signup handler and the payment webhook handler, call `await traffic.recordOutcome({ accountId: <the same id accountIdOf returns>, name: "signup", idempotencyKey: <the new account's id> })` and `await traffic.recordOutcome({ accountId, name: "paid", value: <whole minor units, 1999 for $19.99>, currency: "USD", idempotencyKey: <the payment event id> })`. The dashboard then shows which class of agent led to signups and revenue.

## 3. Check

Start the server, then send at least 5 requests to at least 3 routes as an authenticated customer, including one that fails (4xx), some with agent headers:

```sh
curl -H "User-Agent: Claude-User (claude-code/2.1)" -H 'Signature-Agent: "https://claude.ai"' -H "<auth header>: <test credential>" http://localhost:<port>/<route>
```

Wait 2 seconds, then:

```sh
curl -fsS -X POST https://alg.katrinalaszlo.com/v1/install-check -H "Authorization: Bearer $(sed -n 's/^AGENT_TRAFFIC_KEY=//p' .env)"
```

On a `FAIL` line, fix what it says and repeat step 3. `WARN` lines are for the user.

## Hand off

Tell the user: the dashboard is at https://alg.katrinalaszlo.com/login (sign in with `AGENT_TRAFFIC_KEY` from `.env`); which field `accountIdOf` returns; that production needs the three `AGENT_TRAFFIC_` values from `.env`, with the same salt everywhere; and that on serverless hosts (Vercel functions, Lambda) events can be lost when the process freezes after the response.
