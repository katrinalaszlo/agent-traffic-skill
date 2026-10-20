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

The skill is three steps of plain shell and one code edit, with nothing downloaded and run: a `curl` that appends the key to `.env`, the middleware file plus two lines in your app, and a `curl` to Tanso's install check, which fails unless sessions, status codes and distinct event names arrive.

## What's here

| File | What it does |
| --- | --- |
| [`skills/tanso-agent-traffic/SKILL.md`](skills/tanso-agent-traffic/SKILL.md) | The install steps an agent follows. |
| [`skills/tanso-agent-traffic/tanso-traffic.cjs`](skills/tanso-agent-traffic/tanso-traffic.cjs) | Express middleware, one file, no dependencies, works with `require` and `import`. Sends one event per request after the response: the route pattern as the name, the status code, the hashed account id, and the agent headers. Reads `TANSO_` values from the environment or `.env`. Batches of up to 25 once a second; never blocks or fails a request. |

```js
const { tansoTraffic } = require("./tanso-traffic.cjs");
app.use(tansoTraffic({ accountIdOf: (req) => req.user?.id }));
```

What each event contains, and the raw HTTP API for other stacks: [traffic.katrinalaszlo.com/docs](https://traffic.katrinalaszlo.com/docs).

## Tests

```sh
npm test
```

Node 18 or later. No dependencies.

## License

MIT
