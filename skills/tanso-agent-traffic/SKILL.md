---
name: tanso-agent-traffic
description: Install Tanso agent traffic into a Node/Express API, so the API owner can see which AI agents call their API, which sessions fail, and where. Use when asked to add Tanso, agent traffic, or agent analytics to an API.
---

# Install Tanso agent traffic

Three steps: run setup, add the middleware, verify. You are done only when verify prints all `PASS`. Never print, log or commit the key or salt (setup writes them to `.env` without printing them).

This covers Node 18+ with Express. For another stack, stop and tell the user: the raw API is at https://traffic.katrinalaszlo.com/docs.md.

## 1. Run setup

From the project root, with `--out` next to the file that creates the Express app:

```sh
curl -sS https://traffic.katrinalaszlo.com/skill/setup.mjs -o .tanso-setup.mjs && node .tanso-setup.mjs --out src/tanso-traffic.mjs; rm -f .tanso-setup.mjs
```

It signs up (or keeps an existing `TANSO_KEY` in `.env`), writes `.env`, adds `.env` to `.gitignore`, writes the middleware (as CommonJS if the project is), and prints the exact lines to add.

## 2. Add the middleware

Paste the lines setup printed right after `const app = express()`, before auth and routes. Then set `accountIdOf`, the one decision that matters: return the id of the customer behind the request, as this API's auth resolves it (user id, org id or API key id; read after the response, so values your auth sets are there). Return `undefined` when there is none. Never a constant, a random value, or the raw API key. If you can't tell which field identifies the customer, ask the user.

If setup said the project does not load `.env`, start the server with `node --env-file=.env <entry file>`.

## 3. Verify

Start the server. Send at least 5 requests to at least 3 routes as an authenticated customer, including one that fails (4xx), some with agent headers:

```sh
curl -H "User-Agent: Claude-User (claude-code/2.1)" -H 'Signature-Agent: "https://claude.ai"' -H "Authorization: <test credential>" http://localhost:<port>/<route>
```

Wait 2 seconds, then:

```sh
curl -sS https://traffic.katrinalaszlo.com/skill/verify.mjs -o .tanso-verify.mjs && node --env-file=.env .tanso-verify.mjs; rm -f .tanso-verify.mjs
```

On `FAIL`, fix what the line says and repeat step 3. `WARN` lines are for the user.

## Hand off

Tell the user: the dashboard is at https://traffic.katrinalaszlo.com/login (sign in with `TANSO_KEY` from `.env`); which field `accountIdOf` returns; that production needs the three `TANSO_` values from `.env` with the same salt everywhere; and that on serverless hosts (Vercel functions, Lambda) events can be lost when the process freezes after the response.
