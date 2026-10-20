---
name: agent-traffic
description: Install agent traffic into a Node/Express API, so the API owner can see which AI agents call their API, which sessions fail, and where. Use when asked to add agent traffic or agent analytics to an API.
---

# Install agent traffic

Three steps: a key, one package and two lines of code, and a check. Done means the check in step 3 says `RESULT: PASS`. Never print the key or salt: the commands below write them to `.env` without showing them. Covers Node 18+ with Express; for another stack, stop and point the user to https://traffic.katrinalaszlo.com/docs.md.

## 1. Get a key

From the repository root (in a monorepo, the workspace root is fine: the middleware finds `.env` in the directory the server starts from, its own folder, or any folder above). Skip the first command if `.env` already has `AGENT_TRAFFIC_KEY`.

```sh
curl -fsS -X POST "https://traffic.katrinalaszlo.com/v1/signup?format=env" -H "Content-Type: application/json" -d '{"label":"<project name>","scopes":["read","write"]}' >> .env
grep -q "^AGENT_TRAFFIC_ACCOUNT_SALT=" .env || echo "AGENT_TRAFFIC_ACCOUNT_SALT=$(openssl rand -hex 32)" >> .env
grep -qx ".env" .gitignore 2>/dev/null || echo ".env" >> .gitignore
```

## 2. Add the middleware

Install the `@katrinalaszlo/agent-traffic` package in the API's package, with the project's package manager (`npm install @katrinalaszlo/agent-traffic`, `pnpm add @katrinalaszlo/agent-traffic`, `yarn add @katrinalaszlo/agent-traffic`; in a monorepo, in the API's workspace). It is MIT, has no dependencies, ships TypeScript types, and its source is https://github.com/katrinalaszlo/agent-traffic-skill.

What it sends, per request, to `traffic.katrinalaszlo.com` only: the route pattern (not the URL or query), method, status code, the `User-Agent`, `Signature-Agent` and `Accept-Language` headers, the time, and an HMAC-SHA256 of the customer id keyed with a salt that stays in `.env`. No bodies, no other headers, no IPs, no raw ids.

Add two lines right after `const app = express()`, before auth and routes:

```js
const { agentTraffic } = require("@katrinalaszlo/agent-traffic"); // or: import { agentTraffic } from "@katrinalaszlo/agent-traffic";
app.use(agentTraffic({ accountIdOf: (req, res) => req.user?.id }));
```

`accountIdOf(req, res)` is the one decision: return the id of the customer behind the request as this API's auth resolves it (user id, org id or API key id), or `undefined` when there is none. It runs after the response, so whatever auth set is there: `req.user`, `res.locals.user`, or wherever this app puts it. Read the auth code to find it. Never a constant or a random value. Prefer an id over a secret; if the only stable customer id the app has is derived from their API key, use it (it is HMAC-hashed with the salt before it leaves the server). If you can't tell which field identifies the customer, ask the user. The middleware reads its `AGENT_TRAFFIC_` values from the environment or `.env` by itself.

## 3. Check

Start the server, then send at least 5 requests to at least 3 routes as an authenticated customer, including one that fails (4xx), some with agent headers:

```sh
curl -H "User-Agent: Claude-User (claude-code/2.1)" -H 'Signature-Agent: "https://claude.ai"' -H "<auth header>: <test credential>" http://localhost:<port>/<route>
```

Wait 2 seconds, then:

```sh
curl -fsS -X POST https://traffic.katrinalaszlo.com/v1/install-check -H "Authorization: Bearer $(sed -n 's/^AGENT_TRAFFIC_KEY=//p' .env)"
```

On a `FAIL` line, fix what it says and repeat step 3. `WARN` lines are for the user.

## Hand off

Tell the user: the dashboard is at https://traffic.katrinalaszlo.com/login (sign in with `AGENT_TRAFFIC_KEY` from `.env`); which field `accountIdOf` returns; that production needs the three `AGENT_TRAFFIC_` values from `.env`, with the same salt everywhere; and that on serverless hosts (Vercel functions, Lambda) events can be lost when the process freezes after the response.
