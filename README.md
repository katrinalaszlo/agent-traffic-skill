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

The skill signs up without printing the key, adds the middleware, asks the agent to pick the field that identifies your customer, sends test traffic, and runs `verify.mjs`, which fails unless sessions, status codes and distinct event names arrive.

## What's here

| File | What it does |
| --- | --- |
| [`skills/tanso-agent-traffic/SKILL.md`](skills/tanso-agent-traffic/SKILL.md) | The install steps an agent follows. |
| [`skills/tanso-agent-traffic/tanso-traffic.mjs`](skills/tanso-agent-traffic/tanso-traffic.mjs) | Express middleware, one file, no dependencies. Sends one event per request after the response: the route pattern as the name, the status code, the hashed account id, and the agent headers. Batches of up to 25 once a second; never blocks or fails a request. |
| [`skills/tanso-agent-traffic/verify.mjs`](skills/tanso-agent-traffic/verify.mjs) | Checks the data arriving is usable, not only accepted. Never prints the key. |

What each event contains, and the raw HTTP API for other stacks: [traffic.katrinalaszlo.com/docs](https://traffic.katrinalaszlo.com/docs).

## Tests

```sh
npm test
```

Node 20.6 or later. No dependencies.

## License

MIT
