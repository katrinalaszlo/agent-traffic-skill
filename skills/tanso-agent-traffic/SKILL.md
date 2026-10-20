---
name: tanso-agent-traffic
description: Install Tanso agent traffic into a Node/Express API, so the API owner can see which AI agents call their API, which sessions fail, and where. Use when asked to add Tanso, agent traffic, or agent analytics to an API.
---

# Install Tanso agent traffic

You are adding a middleware to the user's API server. It sends one event per request to Tanso after the response is sent. You are done only when `verify.mjs` passes. A `202` from Tanso alone does not mean the install works: events can be accepted and still be useless (no sessions, no status codes, every event the same name).

Full reference: https://traffic.katrinalaszlo.com/docs.md

## Rules

- Never print, log or commit the API key or the salt. Write them to the env file the project already uses (create `.env` only if there is none), and make sure that file is gitignored (create `.gitignore` if there is none).
- Do not read existing env files' values. Append to them.
- The middleware must never block or fail a request. Use the provided file as is; do not rewrite its sending logic.

## Steps

1. **Check the stack.** This skill covers Node 18+ with Express (or an Express-compatible router that sets `req.route`). For anything else, stop and tell the user: the reference above has the raw HTTP API, and Tanso can help.

2. **Get a key.** If the user already has `TANSO_KEY` and `TANSO_PROJECT_ID`, use them. Otherwise sign up, writing the answer straight to a file instead of printing it. Run these as two separate commands, from the project root:

   ```sh
   curl -sS -X POST https://traffic.katrinalaszlo.com/v1/signup \
     -H "Content-Type: application/json" \
     -d '{ "label": "<the project name>", "scopes": ["read", "write"] }' -o .tanso-signup.json
   ```

   ```sh
   node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(".tanso-signup.json","utf8")); fs.appendFileSync(".env", `\nTANSO_KEY=${s.key}\nTANSO_PROJECT_ID=${s.project_id}\nTANSO_ACCOUNT_SALT=${require("crypto").randomBytes(32).toString("hex")}\n`); fs.rmSync(".tanso-signup.json"); console.log("wrote TANSO_KEY, TANSO_PROJECT_ID, TANSO_ACCOUNT_SALT to .env")'
   ```

   The other fields in the signup answer (`workspace`, `claimCode`, `message`) are not needed. Tell the user the key is in `.env`, is shown only once, and should go into their secret store for production. The salt must stay the same forever and be the same on every server.

3. **Add the middleware.** Download it next to the file that creates the Express app (adjust the path below, and the import path after it, to match):

   ```sh
   curl -sS https://traffic.katrinalaszlo.com/skill/tanso-traffic.mjs -o src/tanso-traffic.mjs
   ```

   It is an ES module. If the project uses CommonJS, convert its `import` line to `require`, its two `export`s to `module.exports`, and save it as `tanso-traffic.cjs`. Register it before the routes, and after nothing that ends requests early. The process must have the three variables in its environment: if the project does not already load `.env` (dotenv, `--env-file`, a framework), start it with `node --env-file=.env` (Node 20.6+) or tell the user how their setup loads env. The middleware throws at startup without them.

   ```js
   import { tansoTraffic } from "./tanso-traffic.mjs";
   app.use(tansoTraffic({
     key: process.env.TANSO_KEY,
     projectId: process.env.TANSO_PROJECT_ID,
     salt: process.env.TANSO_ACCOUNT_SALT,
     accountIdOf: (req) => req.user?.id,
   }));
   ```

4. **Wire `accountIdOf`. This is the decision that matters.** Tanso groups requests into sessions by account: one account's requests, split after 30 minutes of silence. Read how this API authenticates and return the id of the customer behind the request: the user id, org id, or API key id your auth middleware already resolved. It is read after the response, so values set by auth middleware are there. Return `undefined` for unauthenticated requests. Do not return a constant, a random value, or the raw API key. If you cannot tell which field identifies the customer, ask the user.

   Event names come from the route pattern (`POST /v1/api-keys` becomes `api_keys_post`, `GET /v1/docs/...` becomes `docs_...`), and the status code from `res.statusCode`. Leave both as they are.

5. **Send test traffic.** Start the server and make at least 5 requests to at least 3 different routes, as an authenticated customer, including one that fails (a 4xx). Use agent-like headers on some:

   ```sh
   curl -H "User-Agent: Claude-User (claude-code/2.1)" -H 'Signature-Agent: "https://claude.ai"' -H "Authorization: <a test credential>" http://localhost:<port>/<route>
   ```

   Keep the server running for at least 2 seconds after the last request, so the batch is sent.

   `verify.mjs` counts every event, including unauthenticated ones (docs, health checks), but only events with an account are in sessions and in the event names it lists.

6. **Verify.** Download and run the check. It reads the key from `.env` and never prints it:

   ```sh
   curl -sS https://traffic.katrinalaszlo.com/skill/verify.mjs -o /tmp/tanso-verify.mjs
   node --env-file=.env /tmp/tanso-verify.mjs
   ```

   Every line must say `PASS`. On `FAIL`, fix what the line says and repeat steps 5 and 6. `WARN` lines are for the user to read, not blockers.

7. **Hand off.** Tell the user:
   - The dashboard is at https://traffic.katrinalaszlo.com/login (sign in with `TANSO_KEY`).
   - Which field `accountIdOf` returns, and that unauthenticated requests (docs, signup) are counted but are in no session.
   - That production needs `TANSO_KEY`, `TANSO_PROJECT_ID` and `TANSO_ACCOUNT_SALT` in its environment, with the same salt everywhere.
   - On serverless hosts (Vercel functions, Lambda) the process can freeze before the 1-second batch is sent; tell the user so, and point them to the reference.
