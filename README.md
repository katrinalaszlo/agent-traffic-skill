# Track: install skill

[Track](https://alg.katrinalaszlo.com) shows which AI agents call your API, how their sessions go, and which errors end them. This repo is everything that runs on your side: an agent skill that installs it, the Express middleware it adds, and the script that checks the install.

## Install with a coding agent

Give your agent (Claude Code, Cursor, Codex) this prompt:

```
Add Track to this API: read https://alg.katrinalaszlo.com/SKILL.md and follow it.
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

Register it right after creating the app, before auth and routes. `accountIdOf` returns your customer's id (hashed before it leaves your server), or undefined. Optional `errorOf(req, res)` returns error text for failed responses (400 and above, up to 200 characters), so two errors with the same status show separately. It needs one variable, `AGENT_TRAFFIC_KEY`, in the environment or `.env`: the key belongs to one project, and events go there. The `.env` is read from the directory the server starts in, else from the app root: the folder whose `node_modules` holds the package (for a copy of the file inside your app, the nearest folder with a `package.json`). Since 0.7.2 no folder above those is read, so a `.env` at a monorepo root is found only when the server starts there or the package is installed in the root `node_modules`; otherwise set the variables in the environment. No account yet? This creates a free workspace and appends its key to `.env` without printing it (the first line adds a final newline to a `.env` that lacks one):

```sh
if [ -s .env ] && [ -n "$(tail -c 1 .env)" ]; then echo >> .env; fi
curl -fsS -X POST "https://alg.katrinalaszlo.com/v1/signup?format=env" -H "Content-Type: application/json" -d '{"label":"my api","scopes":["read","write"]}' >> .env
```

Already have an account? Create a key on the Install page of your dashboard, or run `npx agent-led-growth connect`, which opens your browser to sign in and writes the key to `.env` for you. The full install steps are in [SKILL.md](https://github.com/katrinalaszlo/track-skill/blob/main/skills/agent-traffic/SKILL.md).

`AGENT_TRAFFIC_ACCOUNT_SALT` is needed when you set `accountIdOf` or call `recordOutcome`. `AGENT_TRAFFIC_PROJECT_ID` is optional: set, it is sent with each batch as before.

Per request it sends the route pattern, the path with secret-looking segments redacted (see below), method, status code, the `User-Agent`, `Signature-Agent` and `Accept-Language` headers, the time, the hashed customer id, the journey key if the request carried one (see below), the hashed client IP when `AGENT_TRAFFIC_ACCOUNT_SALT` is set (see below), and the text `errorOf` returns if you set it. When an agent signed its request (Web Bot Auth, `Signature` and `Signature-Input` headers present) it also sends those two headers, the request's URL (with its query only when the signature covers it), and the other headers the signature covers, so the signature can be checked; never `Authorization` or `Cookie`, whatever the signer covered. Otherwise no bodies, no other headers, no raw IPs. To see which agents lead to signups and payments, call `traffic.recordOutcome({ accountId, name: "paid", value: 1999, currency: "USD", idempotencyKey: paymentEvent.id })` from your payment webhook (and `name: "signup"` from your signup handler): the outcome joins the agent session of the same customer. Events go out in batches once a second (at once on Vercel, Lambda and Netlify), and it never fails a request. The one request it holds up is a person opening a handoff link (below), for at most 2 seconds. Every call to Track has a time limit: 5 seconds for a batch of events (retried like a 5xx when Track does not answer), 3 seconds for `recordOutcome` and `handoffUrl`. `recordOutcome` resolves when Track answers or the 3 seconds run out; on a timeout it logs one line and retries in the background with the same idempotency key, so an outcome Track did store is counted once (on a serverless host that retry can be lost when the function freezes). If `AGENT_TRAFFIC_ENDPOINT` is plain `http://` and not localhost, it logs one warning per process: the key and the events would travel unencrypted. No dependencies; TypeScript types included.

### Journey keys

A journey key ties one visitor's requests together across sessions, for example an agent that reads your docs today and signs up tomorrow. The middleware reads it from each request in this order: the `Track-Journey` header, the `?track_j=` query parameter, then the `track_j` cookie. The first value of 8 to 128 letters, digits, `_` or `-` wins and is sent as `journey_id`, with `journey_source` set to `header`, `query` or `cookie`. A value that does not fit is ignored: not sent, and never an error for the request. With no key, neither field is sent (unless `issueJourneyKeys` is on, below). A journey key is never written to a log.

To hand out keys yourself, turn on `issueJourneyKeys`:

```js
app.use(agentTraffic({ accountIdOf: (req, res) => req.user?.id, issueJourneyKeys: true }));
```

Then every response carries the visitor's key: the one the request sent, or a new one (`j_` plus 32 hex characters) when it sent none. It goes out as the `Track-Journey` response header and as `Set-Cookie: track_j=<key>; Path=/; Max-Age=1209600; SameSite=Lax; Secure; HttpOnly`, with `Cache-Control: private` so a shared cache never serves one visitor's key to another. It is off by default because it sets a cookie on your responses and changes their caching: that can need a line in your cookie policy or consent banner, and a CDN will stop caching those responses. Both are set before your routes run, so a route that sets its own `Cache-Control` replaces `private` (keep it private on any response that carries a key), and a raw `res.setHeader("Set-Cookie", ...)` replaces the `track_j` cookie (Express's `res.cookie` and express-session add to it instead). The request that receives a new key is sent with that key as `journey_id` and `journey_source: "issued"`, so it is the first step of the journey. The cookie is `HttpOnly` (since 0.7.2): only your server reads it, so scripts on your pages cannot. Browser code that needs the key can read the `Track-Journey` response header.

### Hashed client IP

Since 0.7.3, when `AGENT_TRAFFIC_ACCOUNT_SALT` is set, each request's event carries `ip_hash`: HMAC-SHA256, as 64 hex characters, of the client IP under a key derived from your salt and the UTC date (`HMAC-SHA256(salt, "agent-traffic ip_hash v1 YYYY-MM-DD")`). The key changes every UTC day, so the same IP hashes differently from one day to the next and Track gets no identifier that lasts across days. An IPv6 address is hashed as its /64 prefix, because devices rotate the rest of it; an IPv4-mapped address (`::ffff:a.b.c.d`) as its IPv4 address. The IP and the salt never leave your server. Without the salt no `ip_hash` is sent, and the middleware prints one line saying so when it starts. `hashIp(ip, salt, occurredAt)` is exported if you want to check a value.

Purpose: Track uses it only to group the requests of an agent that keeps no cookies and never signs in (crawlers, docs fetchers) into one visit, for analytics, and only requests whose class is not human. It keeps `ip_hash` for 48 hours, never shows it in the dashboard or an API, never forwards it to PostHog or GA4, and never logs it.

The address is `req.ip`, as Express gives it. Behind a proxy or load balancer, set Express's `trust proxy` (`app.set("trust proxy", 1)` for one hop) so `req.ip` is the client from `X-Forwarded-For` and not the proxy; without it every request hashes the proxy's address and different agents' visits merge. Do not trust `X-Forwarded-For` when the app is reached directly, because a client can forge it.

It is a heuristic: many clients behind one NAT or one cloud egress IP can look like one visitor, and an IPv6 client that moves to another network looks like a new one.

Needs a Track host that accepts `ip_hash` (an older one rejects the events with `unknown_field (ip_hash)`; alg.katrinalaszlo.com does).

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

`handoffUrl` waits at most 3 seconds for Track. When the person opens the link, the middleware sees `?track_h=` and, before your routes run, sends a `handoff_opened` event carrying the token and waits up to 2 seconds for Track's answer. If Track linked it, the request's own event goes on the agent's journey (`journey_source: "issued"`), and with `issueJourneyKeys` on the response sets the person's `track_j` cookie to the agent's journey, so their sign-in and checkout land on it too. With `issueJourneyKeys` off no cookie is set: read `traffic.journeyIdOf(req)` and set the `track_j` cookie (or send the `Track-Journey` header) yourself. A token links once and for 24 hours; a used, expired or unknown token, or Track not answering in time, leaves the person on their own journey and logs one line. A token is never written to a log, and `?track_h=` never reaches `path`. Needs a Track host that takes `handoff_token` (an older one logs that it does not).

Event names use the matched route's pattern and exclude router mount prefixes, which can contain raw IDs. A router mounted at `/customers/:customerId` with route `/orders/:orderId` records `orders_orderid` for every customer. Routes with the same pattern under different mounts share an event name.

### Path

Each event also carries `path`, which Track's Paths and Attribution reports use: the path the app received, router mount prefix included, cut at the first `?` or `#`. `GET https://api.example.com/v1/users?api_key=123` is sent as `/v1/users`: never the domain, and never the query or fragment, so an API key or a `track_j` value in the query is neither sent nor logged. Segments are not percent-decoded. A path that does not start with `/` or is longer than 2048 characters is left out of the event.

Since 0.7.2, path segments that look like secrets are replaced with `:token` before the event is built, so `/invite/<token>`, `/reset/<token>` and `/auth/magic/<token>` arrive as `/invite/:token`, `/reset/:token` and `/auth/magic/:token`. The same redacted path is the one written to a log. A segment counts as secret-looking when it is:

- a JWT (three dot-separated base64url parts), anywhere;
- 32 or more hex characters, anywhere;
- 20 or more base64url characters (`A-Z`, `a-z`, `0-9`, `-`, `_`) with at least one letter and one digit, that are mixed case or have no `-` or `_`, anywhere;
- right after one of `auth`, `invite(s)`, `invitation(s)`, `magic`, `magic-link`, `reset`, `reset-password`, `password-reset`, `token(s)`, `verify`, `verify-email`, `verification`, `confirm` or `activate`: also a uuid, 16 or more hex characters, or 16 or more characters of the kind above.

Ordinary ids stay as they are: `/v1/users/123` arrives as `/v1/users/123`, and so do uuids outside those routes, 24 character Mongo ObjectIds, long numeric ids and short prefixed ids such as `cus_NffrFeUfNV2Hib`. Route names stay too (`reset-password-confirmation`, `oauth2-callback`). Long random-looking ids, such as a 28 character Stripe id or a ULID, are redacted: when in doubt the rule drops a segment rather than send a secret. A token with no digit, or one shorter than the limits above, is not caught. Event names stay route patterns (`invite_token`, `users_id`), so nothing changes there.

To decide yourself, pass `pathOf(req)`. What it returns replaces the default (still cut at `?` or `#`, and left out unless it starts with `/` and fits 2048 characters); return `undefined` to leave `path` out of every event:

```js
app.use(agentTraffic({
  accountIdOf: (req, res) => req.user?.id,
  pathOf: (req) => req.route?.path,   // the route pattern, /invite/:token, never the value
}));
```

That example drops the router mount prefix, because `req.baseUrl` holds the matched values of a mount such as `/teams/:teamId`, not its pattern. A request no route matched gets no path, and neither does `handoff_opened`, which is recorded before routing.

`pathOf` runs after the response, except for a request that opens a handoff link, where it runs before your routes. If it throws, that event is lost and logged (on a handoff link, `handoff_opened` goes without a path and the request carries on).

For a signed request (Web Bot Auth), the signature material carries the URL Track needs to check the signature: the raw path, and the query only when `Signature-Input` covers `@query`, `@query-param`, `@target-uri` or `@request-target`. Before 0.7.2 the query was always sent. It goes to Track ingest only, never to a log.

What each event contains, and the raw HTTP API for other stacks: [alg.katrinalaszlo.com/docs](https://alg.katrinalaszlo.com/docs).

## Tests

From a clone of [katrinalaszlo/track-skill](https://github.com/katrinalaszlo/track-skill) (the npm package ships only the middleware and its types):

```sh
npm test
```

Node 18 or later. No dependencies.

## License

MIT
