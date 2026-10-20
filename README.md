# Tanso agent traffic: install skill

[Tanso agent traffic](https://traffic.katrinalaszlo.com) shows which AI agents call your API, how their sessions go, and which errors end them. This repo is everything that runs on your side: an agent skill that installs it, the Express middleware it adds, and the script that checks the install.

## Install with a coding agent

Give your agent (Claude Code, Cursor, Codex) this prompt:

```
Add Tanso agent traffic to this API: read https://traffic.katrinalaszlo.com/SKILL.md and follow it.
```

Or add the skill to your agent first:

```sh
npx skills add katrinalaszlo/agent-traffic-skill
```

The skill is three steps: a `curl` that appends the key to `.env` without printing it, `npm install agent-traffic` plus two lines in your app, and a `curl` to the install check, which fails unless sessions, status codes and distinct event names arrive.

## Install by hand

```sh
npm install agent-traffic
```

```js
const { agentTraffic } = require("agent-traffic"); // or: import { agentTraffic } from "agent-traffic";
app.use(agentTraffic({ accountIdOf: (req, res) => req.user?.id }));
```

Register it right after creating the app, before auth and routes. `accountIdOf` returns your customer's id (hashed before it leaves your server), or undefined. Keys come from `TANSO_KEY`, `TANSO_PROJECT_ID` and `TANSO_ACCOUNT_SALT` in the environment or `.env`; get them with the signup in [SKILL.md](skills/tanso-agent-traffic/SKILL.md).

Per request it sends the route pattern, method, status code, the `User-Agent`, `Signature-Agent` and `Accept-Language` headers, the time, and the hashed customer id. No bodies, no other headers, no IPs. Events go out in batches once a second (at once on Vercel, Lambda and Netlify), and it never blocks or fails a request. No dependencies; TypeScript types included.

What each event contains, and the raw HTTP API for other stacks: [traffic.katrinalaszlo.com/docs](https://traffic.katrinalaszlo.com/docs).

## Tests

```sh
npm test
```

Node 18 or later. No dependencies.

## License

MIT
