---
name: tanso-agent-traffic
description: Install Tanso agent traffic into a Node/Express API, so the API owner can see which AI agents call their API, which sessions fail, and where. Use when asked to add Tanso, agent traffic, or agent analytics to an API.
---

# Install Tanso agent traffic

Three steps, all plain shell and one code edit; nothing is downloaded and run. Done means the check in step 3 says `RESULT: PASS`. Never print the key or salt: the commands below write them to `.env` without showing them. Covers Node 18+ with Express; for another stack, stop and point the user to https://traffic.katrinalaszlo.com/docs.md.

## 1. Get a key

From the project root. Skip the first command if `.env` already has `TANSO_KEY`.

```sh
curl -fsS -X POST "https://traffic.katrinalaszlo.com/v1/signup?format=env" -H "Content-Type: application/json" -d '{"label":"<project name>","scopes":["read","write"]}' >> .env
echo "TANSO_ACCOUNT_SALT=$(openssl rand -hex 32)" >> .env
grep -qx ".env" .gitignore 2>/dev/null || echo ".env" >> .gitignore
```

## 2. Add the middleware

Save it next to the file that creates the Express app:

```sh
curl -fsSL https://traffic.katrinalaszlo.com/skill/tanso-traffic.cjs -o <dir of that file>/tanso-traffic.cjs
```

Add two lines right after `const app = express()`, before auth and routes (use `import { tansoTraffic } from "./tanso-traffic.cjs"` in an ES module project):

```js
const { tansoTraffic } = require("./tanso-traffic.cjs");
app.use(tansoTraffic({ accountIdOf: (req) => req.user?.id }));
```

`accountIdOf` is the one decision: return the id of the customer behind the request as this API's auth resolves it (user id, org id or API key id; it runs after the response, so values auth set are there), or `undefined` when there is none. Never a constant, a random value or the raw API key. If you can't tell which field identifies the customer, ask the user. The middleware reads its `TANSO_` values from the environment or `.env` by itself.

## 3. Check

Start the server, then send at least 5 requests to at least 3 routes as an authenticated customer, including one that fails (4xx), some with agent headers:

```sh
curl -H "User-Agent: Claude-User (claude-code/2.1)" -H 'Signature-Agent: "https://claude.ai"' -H "<auth header>: <test credential>" http://localhost:<port>/<route>
```

Wait 2 seconds, then:

```sh
curl -fsS -X POST https://traffic.katrinalaszlo.com/v1/install-check -H "Authorization: Bearer $(sed -n 's/^TANSO_KEY=//p' .env)"
```

On a `FAIL` line, fix what it says and repeat step 3. `WARN` lines are for the user.

## Hand off

Tell the user: the dashboard is at https://traffic.katrinalaszlo.com/login (sign in with `TANSO_KEY` from `.env`); which field `accountIdOf` returns; that production needs the three `TANSO_` values from `.env`, with the same salt everywhere; and that on serverless hosts (Vercel functions, Lambda) events can be lost when the process freezes after the response.
