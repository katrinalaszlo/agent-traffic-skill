# Agent traffic: install skill

[Agent traffic](https://alg.katrinalaszlo.com) shows which AI agents call your API, how their sessions go, and which errors end them. This repo is everything that runs on your side: an agent skill that installs it, the Express middleware it adds, and the script that checks the install.

## Install with a coding agent

Give your agent (Claude Code, Cursor, Codex) this prompt:

```
Add agent traffic to this API: read https://alg.katrinalaszlo.com/SKILL.md and follow it.
```

Or add the skill to your agent first:

```sh
npx skills add katrinalaszlo/track-skill
```

The skill is three steps: a `curl` that appends the key to `.env` without printing it, `npm install @katrinalaszlo/track` plus two lines in your app, and a `curl` to the install check, which fails unless sessions, status codes and distinct event names arrive.

## Install by hand

```sh
npm install @katrinalaszlo/track
```

```js
const { agentTraffic } = require("@katrinalaszlo/track"); // or: import { agentTraffic } from "@katrinalaszlo/track";
app.use(agentTraffic({ accountIdOf: (req, res) => req.user?.id }));
```

Register it right after creating the app, before auth and routes. `accountIdOf` returns your customer's id (hashed before it leaves your server), or undefined. Optional `errorOf(req, res)` returns error text for failed responses (400 and above, up to 200 characters), so two errors with the same status show separately. Keys come from `AGENT_TRAFFIC_KEY`, `AGENT_TRAFFIC_PROJECT_ID` and `AGENT_TRAFFIC_ACCOUNT_SALT` in the environment or `.env`; get them with the signup in [SKILL.md](skills/agent-traffic/SKILL.md).

Per request it sends the route pattern, method, status code, the `User-Agent`, `Signature-Agent` and `Accept-Language` headers, the time, the hashed customer id, and the text `errorOf` returns if you set it. When an agent signed its request (Web Bot Auth, `Signature` and `Signature-Input` headers present) it also sends those two headers, the request's full URL, and the other headers the signature covers, so the signature can be checked; never `Authorization` or `Cookie`, whatever the signer covered. Otherwise no bodies, no other headers, no IPs. To see which agents lead to signups and payments, call `traffic.recordOutcome({ accountId, name: "paid", value: 1999, currency: "USD", idempotencyKey: paymentEvent.id })` from your payment webhook (and `name: "signup"` from your signup handler): the outcome joins the agent session of the same customer. Events go out in batches once a second (at once on Vercel, Lambda and Netlify), and it never blocks or fails a request. No dependencies; TypeScript types included.

Event names use the matched route's pattern and exclude router mount prefixes, which can contain raw IDs. A router mounted at `/customers/:customerId` with route `/orders/:orderId` records `orders_orderid` for every customer. Routes with the same pattern under different mounts share an event name.

What each event contains, and the raw HTTP API for other stacks: [alg.katrinalaszlo.com/docs](https://alg.katrinalaszlo.com/docs).

## Tests

```sh
npm test
```

Node 18 or later. No dependencies.

## License

MIT
