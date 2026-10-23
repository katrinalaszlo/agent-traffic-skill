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

Per request it sends the route pattern, the path (see below), method, status code, the `User-Agent`, `Signature-Agent` and `Accept-Language` headers, the time, the hashed customer id, the journey key if the request carried one (see below), and the text `errorOf` returns if you set it. When an agent signed its request (Web Bot Auth, `Signature` and `Signature-Input` headers present) it also sends those two headers, the request's full URL, and the other headers the signature covers, so the signature can be checked; never `Authorization` or `Cookie`, whatever the signer covered. Otherwise no bodies, no other headers, no IPs. To see which agents lead to signups and payments, call `traffic.recordOutcome({ accountId, name: "paid", value: 1999, currency: "USD", idempotencyKey: paymentEvent.id })` from your payment webhook (and `name: "signup"` from your signup handler): the outcome joins the agent session of the same customer. Events go out in batches once a second (at once on Vercel, Lambda and Netlify), and it never fails a request. The one request it holds up is a person opening a handoff link (below), for at most 2 seconds. No dependencies; TypeScript types included.

### Journey keys

A journey key ties one visitor's requests together across sessions, for example an agent that reads your docs today and signs up tomorrow. The middleware reads it from each request in this order: the `Track-Journey` header, the `?track_j=` query parameter, then the `track_j` cookie. The first value of 8 to 128 letters, digits, `_` or `-` wins and is sent as `journey_id`, with `journey_source` set to `header`, `query` or `cookie`. A value that does not fit is ignored: not sent, and never an error for the request. With no key, neither field is sent (unless `issueJourneyKeys` is on, below). A journey key is never written to a log.

To hand out keys yourself, turn on `issueJourneyKeys`:

```js
app.use(agentTraffic({ accountIdOf: (req, res) => req.user?.id, issueJourneyKeys: true }));
```

Then every response carries the visitor's key: the one the request sent, or a new one (`j_` plus 32 hex characters) when it sent none. It goes out as the `Track-Journey` response header and as `Set-Cookie: track_j=<key>; Path=/; Max-Age=1209600; SameSite=Lax; Secure`, with `Cache-Control: private` so a shared cache never serves one visitor's key to another. It is off by default because it sets a cookie on your responses and changes their caching: that can need a line in your cookie policy or consent banner, and a CDN will stop caching those responses. Both are set before your routes run, so a route that sets its own `Cache-Control` replaces `private` (keep it private on any response that carries a key), and a raw `res.setHeader("Set-Cookie", ...)` replaces the `track_j` cookie (Express's `res.cookie` and express-session add to it instead). The request that receives a new key is sent with that key as `journey_id` and `journey_source: "issued"`, so it is the first step of the journey.

### Handoff links

When an agent cannot finish on its own (a person has to approve a payment or verify an email) and your server sends that person a link, add a handoff token to the link so the person's actions count toward the agent's journey. Their checkout is then credited to the agent that brought them.

```js
const traffic = agentTraffic({ accountIdOf: (req, res) => req.user?.id, issueJourneyKeys: true });
app.use(traffic);

app.post("/v1/checkout-links", async (req, res) => {
  const link = await traffic.handoffUrl("https://example.com/checkout?plan=pro", { req });
  res.json({ approve_at: link });   // https://example.com/checkout?plan=pro&track_h=h_...
});
```

`handoffUrl(link, { req })` asks Track for a one-time token for the journey of `req` (the agent's request, which must carry a journey key, or have one issued) and resolves with `link` plus `?track_h=<token>`. Pass `{ journeyId }` instead when you have the key without the request. It throws at once when `link` is not an absolute URL or there is no journey key. If Track cannot mint a token, it logs why and resolves with `link` unchanged, so the person still gets a working link that just does not count toward the journey.

When the person opens the link, the middleware sees `?track_h=` and, before your routes run, sends a `handoff_opened` event carrying the token and waits up to 2 seconds for Track's answer. If Track linked it, the request's own event goes on the agent's journey (`journey_source: "issued"`), and with `issueJourneyKeys` on the response sets the person's `track_j` cookie to the agent's journey, so their sign-in and checkout land on it too. With `issueJourneyKeys` off no cookie is set: read `traffic.journeyIdOf(req)` and set the `track_j` cookie (or send the `Track-Journey` header) yourself. A token links once and for 24 hours; a used, expired or unknown token, or Track not answering in time, leaves the person on their own journey and logs one line. A token is never written to a log, and `?track_h=` never reaches `path`. Needs a Track host that takes `handoff_token` (an older one logs that it does not).

Event names use the matched route's pattern and exclude router mount prefixes, which can contain raw IDs. A router mounted at `/customers/:customerId` with route `/orders/:orderId` records `orders_orderid` for every customer. Routes with the same pattern under different mounts share an event name.

### Path

Each event also carries `path`, which Track's Paths and Attribution reports use: the path the app received, router mount prefix included, cut at the first `?` or `#`. `GET https://api.example.com/v1/users?api_key=123` is sent as `/v1/users`: never the domain, and never the query or fragment, so an API key or a `track_j` value in the query is neither sent nor logged. Segments are sent as they are, not percent-decoded, so an id in the path is sent: `/v1/users/123` arrives as `/v1/users/123`. Event names stay route patterns (`users_id`), so reports grouped by event name do not split by id; there is no option yet to leave `path` out of the event. A path that does not start with `/` or is longer than 2048 characters is left out of the event.

For a signed request (Web Bot Auth), the signature material still carries the full URL with its query, because the signature covers it and cannot be checked without it. It goes to Track ingest only, never to a log.

What each event contains, and the raw HTTP API for other stacks: [alg.katrinalaszlo.com/docs](https://alg.katrinalaszlo.com/docs).

## Tests

```sh
npm test
```

Node 18 or later. No dependencies.

## License

MIT
