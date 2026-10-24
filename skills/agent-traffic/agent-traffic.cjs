// Agent traffic: Express middleware that sends one event per request to alg.katrinalaszlo.com, after the
// response is sent. npm package @katrinalaszlo/track; source https://github.com/katrinalaszlo/track-skill. Node 18+.
//
//   const { agentTraffic } = require("@katrinalaszlo/track");   // or: import { agentTraffic } from "@katrinalaszlo/track";
//   const traffic = agentTraffic({ accountIdOf: (req, res) => req.user?.id });
//   app.use(traffic);
//   // From your signup handler and your payment webhook: the outcome an agent's session led to.
//   await traffic.recordOutcome({ accountId: user.id, name: "signup", idempotencyKey: user.id });
//   await traffic.recordOutcome({ accountId: customer.id, name: "paid", value: 1999, currency: "USD", idempotencyKey: paymentEvent.id });
//
// accountIdOf returns your customer's id for the request (called with req and res after the response, so values your
// auth set on either, such as req.user or res.locals.user, are there), or undefined. errorOf, optional, returns the
// error text for a failed response (status 400 and above), such as an error code your handler put in res.locals, so
// two errors with the same status show as different rows in Fix next. AGENT_TRAFFIC_KEY (required),
// AGENT_TRAFFIC_ACCOUNT_SALT and AGENT_TRAFFIC_PROJECT_ID (optional: without it the key's own project is used) come from
// the environment, or from a .env in the working directory or the app root (see appRoot), when the environment lacks
// them; only AGENT_TRAFFIC_ lines are read, nothing else in .env is touched. pathOf, optional, returns the path to send
// for a request instead of the default (the request path with secret-looking segments replaced by :token).
// issueJourneyKeys, optional and off by default, gives each visitor a journey key on the response (a header and an
// HttpOnly track_j cookie) so its later requests join one journey.
//
// Handoffs: when an agent sends a person a link to finish (approve a payment, verify an email), add a one-time token so
// the person's actions count toward the agent's journey:
//   const link = await traffic.handoffUrl("https://example.com/checkout?plan=pro", { req });   // adds ?track_h=<token>
// A request that arrives with ?track_h= waits up to 2 seconds for Track to link it to the agent's journey, records a
// handoff_opened event, and, with issueJourneyKeys on, sets the person's track_j cookie to the agent's journey.
//
// Register it right after creating the app, before auth and routes. It never fails a request, and blocks none but a
// request carrying ?track_h=: events are queued, sent in batches of up to 25 once a second, and a failed batch is logged
// and retried with the same keys.
const { createHmac, randomBytes, randomUUID } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const { isIP } = require("node:net");
const { dirname, join, sep } = require("node:path");

// The request and response header that carries a journey key.
const JOURNEY_HEADER = "Track-Journey";
// The cookie name and the query parameter name.
const JOURNEY_PARAM = "track_j";
const JOURNEY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
// 14 days. Secure so the key never travels over plain http; Lax so it comes along when a person follows a link in;
// HttpOnly because only the server reads it, so a script on the page cannot.
const JOURNEY_COOKIE_ATTRIBUTES = "Path=/; Max-Age=1209600; SameSite=Lax; Secure; HttpOnly";
// The query parameter a handoff link carries, and the token shape Track mints. A token is a secret in transit: it goes
// to Track only, never into a log or an error message.
const HANDOFF_PARAM = "track_h";
const HANDOFF_TOKEN = /^h_[A-Za-z0-9_-]{32,64}$/;
// How long a request with ?track_h= waits for Track before it carries on unlinked.
const HANDOFF_WAIT_MS = 2000;
// How long each call to Track may take before it is given up: a slow Track never holds a customer's request, payment
// webhook or serverless function for longer. A batch has the most to carry, so it gets the most time.
const SEND_TIMEOUT_MS = 5000;
const OUTCOME_TIMEOUT_MS = 3000;
const HANDOFF_URL_TIMEOUT_MS = 3000;

const BATCH_MAX = 25;
const OUTCOME_NAMES = ["signup", "key_created", "activation", "paid", "custom"];
const FLUSH_MS = 1000;
const RETRIES_MAX = 3;
const ERROR_MAX = 200;
const PATH_MAX = 2048;
// On serverless hosts the process can freeze as soon as the response is sent, so a queued batch might never go out.
// There each event is sent at once, and on Vercel the send is handed to waitUntil so the function stays up until it
// is done (the request context @vercel/functions reads, without depending on it).
const SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
const VERCEL_CONTEXT = Symbol.for("@vercel/request-context");

// The event name is the route pattern, not the URL, so /v1/users/42 and /v1/users/43 are one step. A leading version
// segment (v1) and "api" are dropped, and the method is appended for anything but GET:
//   GET /v1/docs/quickstart -> docs_quickstart   POST /api/v1/api-keys -> api_keys_post   GET /v1/users/:id -> users_id
// A request no route matched is "unmatched". Names fit the ingest rule: ^[a-z][a-z0-9_]{0,63}$.
function eventName(req) {
  if (!req.route) return "unmatched";
  // Express baseUrl contains matched values, not the mount pattern: /customers/:id can become /customers/customer_123.
  // Keep only the route pattern so mount parameters never enter event names.
  const pattern = typeof req.route.path === "string" ? req.route.path : "";
  const segments = pattern.toLowerCase().split("/").filter((seg) => seg !== "api" && !/^v\d+$/.test(seg));
  const words = segments.flatMap((seg) => seg.split(/[^a-z0-9]+/)).filter((w) => w !== "");
  if (req.method !== "GET" && req.method !== "HEAD") words.push(req.method.toLowerCase());
  const name = words.join("_").replace(/^[^a-z]+/, "");
  return (name === "" ? "root" : name).slice(0, 64).replace(/_+$/, "");
}

// The app root: the folder whose node_modules holds this package (the first node_modules in this file's path, so a
// pnpm store or a hoisted monorepo install gives the folder that holds that node_modules). For a copy of this file
// inside an app, the nearest folder at or above it with a package.json; with none, this file's folder.
function appRoot() {
  const at = __dirname.indexOf(`${sep}node_modules${sep}`);
  if (at !== -1) return __dirname.slice(0, at);
  for (let dir = __dirname; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dirname(dir) === dir) return __dirname;
  }
}

// The .env holding AGENT_TRAFFIC_KEY: in the working directory, else in the app root. No folder above those is read,
// so a stray .env higher up (a home folder, a parent project) is never picked up.
function envFile() {
  const candidates = [join(process.cwd(), ".env"), join(appRoot(), ".env")];
  return candidates.find((file) => existsSync(file) && /^AGENT_TRAFFIC_KEY=/m.test(readFileSync(file, "utf8")));
}

// AGENT_TRAFFIC_ variables from the environment, else from the .env envFile finds.
function agentTrafficEnv() {
  const values = {};
  const file = envFile();
  if (file) {
    for (const match of readFileSync(file, "utf8").matchAll(/^(AGENT_TRAFFIC_[A-Z_]+)=(.*)$/gm)) values[match[1]] = match[2].trim();
  }
  for (const name of Object.keys(process.env)) if (name.startsWith("AGENT_TRAFFIC_")) values[name] = process.env[name];
  return values;
}

// An endpoint on plain http sends the key and every event unencrypted. Said once per process; localhost is exempt.
let warnedPlainHttp = false;
function warnIfPlainHttp(endpoint) {
  const host = /^http:\/\/(\[[^\]]*\]|[^/:?#]*)/i.exec(endpoint)?.[1]?.toLowerCase();
  if (host === undefined || warnedPlainHttp) return;
  if (["localhost", "127.0.0.1", "[::1]"].includes(host) || host.endsWith(".localhost")) return;
  warnedPlainHttp = true;
  console.error(`agent-traffic: the endpoint http://${host} is plain http, not https: the key and every event travel unencrypted. Use https outside local development.`);
}

// The client IP, hashed on this server, so Track can group an anonymous agent's requests (no cookie, no account) into one
// visit. Only with AGENT_TRAFFIC_ACCOUNT_SALT set; the IP and the salt never leave the server. The key is
// HMAC-SHA256(salt, "agent-traffic ip_hash v1 " + the UTC date of the request), so it changes every UTC day and the same
// IP hashes differently from one day to the next: Track gets no identifier that lasts across days. ip_hash is
// HMAC-SHA256(that day key, the address) as hex. An IPv6 address is hashed as its /64 prefix, because devices rotate
// the rest of the address. The address is req.ip: with Express's "trust proxy" set, the client address from
// X-Forwarded-For, else the address of the connection (the proxy's, behind one).
const IP_HASH_CONTEXT = "agent-traffic ip_hash v1";

// The four leading 16-bit groups of an IPv6 address isIP accepted, as lowercase hex without leading zeros.
function ipv6Prefix64(address) {
  let text = address.toLowerCase();
  const ipv4Tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (ipv4Tail) {
    const [a, b, c, d] = ipv4Tail.slice(1).map(Number);
    text = `${text.slice(0, ipv4Tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length === 1 || halves[1] === "" ? [] : halves[1].split(":");
  const groups = halves.length === 1 ? head : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  return groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16));
}

// The text that is hashed: an IPv4 address as is (also when written as ::ffff:a.b.c.d), an IPv6 address as
// "<first four groups>::/64". undefined when it is not an IP address.
function ipForHash(ip) {
  if (typeof ip !== "string") return undefined;
  let address = ip.trim().split("%")[0];
  if (/^::ffff:/i.test(address) && isIP(address.slice(7)) === 4) address = address.slice(7);
  const version = isIP(address);
  if (version === 4) return address;
  if (version === 6) return `${ipv6Prefix64(address).join(":")}::/64`;
  return undefined;
}

// occurredAt is the event's ISO time; its UTC date picks the day key.
function hashIp(ip, salt, occurredAt) {
  const address = ipForHash(ip);
  if (address === undefined) return undefined;
  const dayKey = createHmac("sha256", salt).update(`${IP_HASH_CONTEXT} ${occurredAt.slice(0, 10)}`).digest();
  return createHmac("sha256", dayKey).update(address).digest("hex");
}

// Without the salt nothing is hashed and no ip_hash is sent. Said once per process.
let toldNoIpHash = false;
function tellNoIpHash() {
  if (toldNoIpHash) return;
  toldNoIpHash = true;
  console.log("agent-traffic: AGENT_TRAFFIC_ACCOUNT_SALT is not set, so no ip_hash is sent: requests from agents that keep no cookies and never sign in are counted one visit per request. https://alg.katrinalaszlo.com/docs#hashed-client-ip");
}

// A Track host older than ip_hash rejects every event that carries it (unknown_field). The first time that happens,
// the rejected events are sent again without it, with the same idempotency keys (a rejected event is not stored, so
// the key is unused), and this process stops sending ip_hash: no event is lost to an older host. Said once.
let ipHashUnsupported = false;
function stopSendingIpHash() {
  if (ipHashUnsupported) return;
  ipHashUnsupported = true;
  console.error("agent-traffic: the Track host does not accept ip_hash yet, so this process sends events without it from now on; the rejected events were sent again without it. Anonymous agent requests are counted one visit per request until the host is upgraded.");
}
function withoutIpHash(event) {
  const copy = { ...event };
  delete copy.ip_hash;
  return copy;
}

// Web Bot Auth: when an agent signed its request (Signature and Signature-Input headers), the event carries what ingest
// needs to check the signature: those two headers, the method and absolute URL, and only the other headers the
// signature covers. Never a credential header, whatever the signer covered. An unsigned request adds nothing.
// The URL keeps its query only when the signature covers it: without that, the query (which can hold an API key) stays home.
const SIGNATURE_HEADERS = ["signature", "signature-input", "signature-agent"];
const FORBIDDEN_COVERED = ["authorization", "proxy-authorization", "cookie", "set-cookie"];

// The header names a Signature-Input covers: the quoted strings inside its parentheses that are not @-derived components.
function coveredHeaderNames(signatureInput) {
  const names = [];
  for (const group of signatureInput.matchAll(/\(([^)]*)\)/g)) {
    for (const item of group[1].matchAll(/"([^"]+)"/g)) if (!item[1].startsWith("@")) names.push(item[1].toLowerCase());
  }
  return names;
}

// Derived components that include the query. With any of them signed, the signature cannot be checked without it.
const QUERY_COMPONENTS = ["@query", "@query-param", "@target-uri", "@request-target"];
function coversQuery(signatureInput) {
  for (const group of signatureInput.matchAll(/\(([^)]*)\)/g)) {
    for (const item of group[1].matchAll(/"([^"]+)"/g)) if (QUERY_COMPONENTS.includes(item[1].toLowerCase())) return true;
  }
  return false;
}

function signatureMaterial(req) {
  const signature = req.headers.signature;
  const signatureInput = req.headers["signature-input"];
  if (typeof signature !== "string" || typeof signatureInput !== "string") return {};
  const covered = {};
  for (const name of coveredHeaderNames(signatureInput)) {
    if (SIGNATURE_HEADERS.includes(name) || FORBIDDEN_COVERED.includes(name) || req.headers[name] === undefined) continue;
    covered[name] = Array.isArray(req.headers[name]) ? req.headers[name].join(", ") : String(req.headers[name]);
  }
  // req.protocol honours Express's trust proxy setting, so behind a proxy the URL is the one the agent signed.
  const host = req.headers.host;
  const target = String(req.originalUrl ?? req.url ?? "/").split("#")[0];
  const pathAndQuery = coversQuery(signatureInput) ? target : target.split("?")[0];
  const url = typeof host === "string" && host !== "" ? `${req.protocol ?? "https"}://${host}${pathAndQuery}` : undefined;
  return {
    signature,
    signature_input: signatureInput,
    method: String(req.method ?? "GET").toUpperCase(),
    ...(url ? { url } : {}),
    ...(Object.keys(covered).length > 0 ? { covered_headers: covered } : {}),
  };
}

// The path the app received, mount prefix included, cut at the first ? or #: never the domain or the query, which
// can hold an API key or a journey key. Not percent-decoded. Anything that does not start with / or is longer than
// ingest accepts is left out rather than cut.
function requestPath(req) {
  const url = req.originalUrl ?? req.url;
  if (typeof url !== "string") return undefined;
  const path = url.split(/[?#]/)[0];
  if (!path.startsWith("/") || path.length > PATH_MAX) return undefined;
  return path;
}

// Route words after which the next segment is a link token: /invite/<token>, /reset/<token>, /auth/magic/<token>.
const TOKEN_ROUTE = /^(auth|invite|invites|invitation|invitations|magic|magic-link|reset|reset-password|password-reset|token|tokens|verify|verify-email|verification|confirm|activate)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A segment that looks like a secret rather than a route name or an ordinary id: a JWT; 32 or more hex characters (a
// shorter hex string, such as a 24 character Mongo ObjectId, is an id); or 20 or more base64url characters with a
// letter and a digit that are mixed case or have no - or _ (so reset-password-confirmation and oauth2-callback stay).
// Right after a TOKEN_ROUTE word the bar is lower: a uuid, 16 or more hex, or 16 or more such characters. Base64
// padding (= or %3D) is ignored.
function looksLikeSecret(segment, afterTokenRoute) {
  if (afterTokenRoute && UUID.test(segment)) return true;
  const s = segment.replace(/(=|%3D)+$/i, "");
  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(s)) return true;
  if (/^[0-9a-f]+$/i.test(s)) return s.length >= (afterTokenRoute ? 16 : 32);
  if (s.length < (afterTokenRoute ? 16 : 20) || !/^[A-Za-z0-9_-]+$/.test(s) || !/[0-9]/.test(s) || !/[A-Za-z]/.test(s)) return false;
  return (/[A-Z]/.test(s) && /[a-z]/.test(s)) || !/[-_]/.test(s);
}

// The path with each secret-looking segment replaced by :token. Numbers, uuids outside a token route, short prefixed
// ids (cus_123) and route names are kept.
function redactPath(path) {
  const segments = path.split("/");
  return segments.map((segment, i) => (looksLikeSecret(segment, i > 0 && TOKEN_ROUTE.test(segments[i - 1])) ? ":token" : segment)).join("/");
}

// The default path: requestPath with secret-looking segments redacted.
function redactedPath(req) {
  const path = requestPath(req);
  return path === undefined ? undefined : redactPath(path);
}

// A journey key ties requests from one visitor together across sessions: the journey header, else ?track_j= in the URL,
// else the track_j cookie. The first value that fits the ingest rule wins; one that does not is ignored, never sent.
function journeyKeyOf(req) {
  const header = req.headers[JOURNEY_HEADER.toLowerCase()];
  if (typeof header === "string" && JOURNEY_KEY.test(header)) return { journey_id: header, journey_source: "header" };

  const rawUrl = req.originalUrl ?? req.url;
  const url = typeof rawUrl === "string" ? rawUrl : "";
  const queryStart = url.indexOf("?");
  if (queryStart !== -1) {
    const fromQuery = new URLSearchParams(url.slice(queryStart + 1)).getAll(JOURNEY_PARAM).find((value) => JOURNEY_KEY.test(value));
    if (fromQuery) return { journey_id: fromQuery, journey_source: "query" };
  }

  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader === "string") {
    for (const pair of cookieHeader.split(";")) {
      const eq = pair.indexOf("=");
      if (eq === -1 || pair.slice(0, eq).trim() !== JOURNEY_PARAM) continue;
      const value = pair.slice(eq + 1).trim();
      if (JOURNEY_KEY.test(value)) return { journey_id: value, journey_source: "cookie" };
    }
  }
  return undefined;
}

// The ?track_h= value when it has the token shape, else undefined.
function handoffTokenOf(req) {
  const rawUrl = req.originalUrl ?? req.url;
  const url = typeof rawUrl === "string" ? rawUrl : "";
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return undefined;
  return new URLSearchParams(url.slice(queryStart + 1)).getAll(HANDOFF_PARAM).find((value) => HANDOFF_TOKEN.test(value));
}

// Cache-Control: private so a shared cache never hands one visitor's key to another. A Set-Cookie an earlier
// middleware added is kept.
function setJourneyKey(res, journeyId) {
  res.setHeader(JOURNEY_HEADER, journeyId);
  const cookie = `${JOURNEY_PARAM}=${journeyId}; ${JOURNEY_COOKIE_ATTRIBUTES}`;
  const existing = res.getHeader("set-cookie");
  res.setHeader("set-cookie", existing === undefined ? cookie : [].concat(existing, cookie));
  res.setHeader("cache-control", "private");
}

function agentTraffic({ accountIdOf, errorOf, pathOf, key, projectId, salt, endpoint, issueJourneyKeys = false } = {}) {
  const env = agentTrafficEnv();
  key ??= env.AGENT_TRAFFIC_KEY;
  projectId ??= env.AGENT_TRAFFIC_PROJECT_ID;
  salt ??= env.AGENT_TRAFFIC_ACCOUNT_SALT;
  endpoint ??= env.AGENT_TRAFFIC_ENDPOINT ?? "https://alg.katrinalaszlo.com";
  if (!key) throw new Error("agentTraffic needs AGENT_TRAFFIC_KEY, in the environment or in .env. Run `npx agent-led-growth connect` to get one.");
  if (accountIdOf && !salt) throw new Error("agentTraffic needs AGENT_TRAFFIC_ACCOUNT_SALT, in the environment or in .env, to hash what accountIdOf returns.");
  warnIfPlainHttp(endpoint);
  if (!salt) tellNoIpHash();
  const projectQuery = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  const url = `${endpoint}/v1/events${projectQuery}`;
  const handoffsUrl = `${endpoint}/v1/handoffs${projectQuery}`;
  // The journey key each request was recorded with, after a handoff link changed it; read by journeyIdOf and handoffUrl.
  const journeys = new WeakMap();
  let queue = [];
  let timer = null;
  const warned = new Set();

  // A batch Track does not answer within timeoutMs counts as failed and is retried like a 5xx, with the same keys, so
  // a batch Track did store is counted once.
  async function send(batch, attempt, timeoutMs = SEND_TIMEOUT_MS) {
    let failure = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json();
      if (res.status === 202) {
        // A key inside its rotation grace window: said once per process, not once per batch.
        for (const warning of body.warnings ?? []) {
          if (!warned.has(warning)) {
            warned.add(warning);
            console.error(`agent-traffic: ${warning}`);
          }
        }
        // ip_hash refused by an older host: send those events again without it. A host too old to name the field
        // counts when the event carried ip_hash.
        const byKey = new Map(batch.map((event) => [event.idempotency_key, event]));
        const refusesIpHash = (entry) => entry.reason === "unknown_field" && byKey.get(entry.idempotency_key)?.ip_hash !== undefined && (entry.field === "ip_hash" || entry.field === undefined);
        const resend = body.rejected.filter(refusesIpHash).map((entry) => withoutIpHash(byKey.get(entry.idempotency_key)));
        if (resend.length > 0) {
          stopSendingIpHash();
          send(resend, 1, timeoutMs);
        }
        // One line per reason per batch, not one per event. An unknown field means this host is older than this
        // package: say which field and what to do, instead of a uuid per event.
        const byReason = new Map();
        for (const entry of body.rejected) {
          if (entry.reason === "duplicate" || refusesIpHash(entry)) continue;
          const label = entry.reason === "unknown_field" ? `unknown_field (${entry.field ?? "?"})` : entry.reason;
          byReason.set(label, (byReason.get(label) ?? 0) + 1);
        }
        for (const [label, n] of byReason) {
          const hint = label.startsWith("unknown_field") ? ". The agent traffic host does not know this field yet: it is older than this package. Upgrade the host, or pin @katrinalaszlo/track to the version before that field (0.7.2 for ip_hash, 0.5.x for journey_id, path and handoff_token). https://alg.katrinalaszlo.com/docs#event-fields" : "";
          console.error(`agent-traffic: ${n} of ${batch.length} events rejected: ${label}${hint}`);
        }
        return;
      }
      failure = `${res.status} ${body.error}: ${body.message}`;
      // A host that refuses the whole batch over ip_hash: the same, for every event.
      if (res.status === 400 && `${body.error} ${body.message}`.includes("ip_hash") && batch.some((event) => event.ip_hash !== undefined)) {
        stopSendingIpHash();
        send(batch.map(withoutIpHash), 1, timeoutMs);
        return;
      }
      // A 4xx other than 429 will fail the same way again, so it is not retried.
      if (res.status < 500 && res.status !== 429) {
        console.error(`agent-traffic: batch of ${batch.length} dropped: ${failure}`);
        return;
      }
    } catch (err) {
      failure = err.name === "TimeoutError" ? `no answer from Track within ${timeoutMs / 1000} seconds` : err.message;
    }
    if (attempt >= RETRIES_MAX) {
      console.error(`agent-traffic: batch of ${batch.length} dropped after ${attempt} attempts: ${failure}`);
      return;
    }
    console.error(`agent-traffic: batch of ${batch.length} failed (${failure}), retrying`);
    setTimeout(() => send(batch, attempt + 1, timeoutMs), FLUSH_MS * 2 ** attempt).unref();
  }

  function flush() {
    timer = null;
    while (queue.length > 0) send(queue.splice(0, BATCH_MAX), 1);
  }

  const hashAccountId = (accountId) => createHmac("sha256", salt).update(String(accountId)).digest("hex");

  // An outcome is sent at once, not batched: there are few of them and each one is money or a signup. Returns a
  // promise that settles when the send has finished (sent, or logged and dropped), within 3 seconds: when Track does
  // not answer in time it is logged and retried in the background with the same key. Nothing it does can throw into
  // your handler after validation. Bad input throws synchronously, at your call site, with the field named: that is
  // your bug to see now, not a rejection to find in a log later.
  function recordOutcome({ accountId, name, value, currency, idempotencyKey, occurredAt } = {}) {
    if (!salt) throw new TypeError("recordOutcome needs AGENT_TRAFFIC_ACCOUNT_SALT (or the salt option) to hash accountId, the same salt the middleware uses. docs: https://alg.katrinalaszlo.com/docs#outcomes");
    if (accountId === undefined || accountId === null || String(accountId) === "") throw new TypeError("recordOutcome: accountId is required: the same customer id accountIdOf returns, so the outcome joins the agent's session. docs: https://alg.katrinalaszlo.com/docs#outcomes");
    if (!OUTCOME_NAMES.includes(name)) throw new TypeError(`recordOutcome: name must be one of ${OUTCOME_NAMES.join(", ")}, got ${JSON.stringify(name)}. docs: https://alg.katrinalaszlo.com/docs#outcomes`);
    if (typeof idempotencyKey !== "string" || idempotencyKey === "" || idempotencyKey.length > 200) throw new TypeError("recordOutcome: idempotencyKey is required (1 to 200 characters): your payment event id or signup id, so a retried webhook never counts twice. docs: https://alg.katrinalaszlo.com/docs#outcomes");
    const hasValue = value !== undefined && value !== null;
    if (hasValue && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) throw new TypeError(`recordOutcome: value must be a whole number of minor units (1999 for $19.99), 0 or more, got ${typeof value === "string" ? `string ${JSON.stringify(value)}` : String(value)}. docs: https://alg.katrinalaszlo.com/docs#outcomes`);
    if (hasValue && !/^[A-Z]{3}$/.test(String(currency))) throw new TypeError(`recordOutcome: currency must be an ISO 4217 code such as USD when value is set, got ${JSON.stringify(currency)}. docs: https://alg.katrinalaszlo.com/docs#outcomes`);
    if (name === "paid" && !hasValue) throw new TypeError("recordOutcome: a paid outcome needs value (minor units) and currency. docs: https://alg.katrinalaszlo.com/docs#outcomes");
    const at = occurredAt === undefined ? new Date() : new Date(occurredAt);
    if (Number.isNaN(at.getTime())) throw new TypeError(`recordOutcome: occurredAt is not a date: ${JSON.stringify(occurredAt)}`);
    const event = {
      idempotency_key: idempotencyKey,
      name,
      occurred_at: at.toISOString(),
      source: "sdk",
      account_id: hashAccountId(accountId),
      outcome: { name, ...(hasValue ? { value, currency } : {}) },
      properties: {},
    };
    const vercel = globalThis[VERCEL_CONTEXT]?.get?.();
    const sending = send([event], 1, OUTCOME_TIMEOUT_MS);
    vercel?.waitUntil?.(sending);
    return sending;
  }

  // The journey key the middleware recorded req with (the agent's journey when a handoff link linked it), or undefined.
  function journeyIdOf(req) {
    return journeys.get(req)?.journey_id;
  }

  // Resolves with link plus ?track_h=<token> for the agent's journey: journeyId, else the journey of req. Bad input
  // throws synchronously. When Track cannot mint a token, or does not answer within 3 seconds, the failure is logged
  // and the promise resolves with link unchanged, so the person still gets a working link; it just will not count
  // toward the agent's journey.
  function handoffUrl(link, { req, journeyId } = {}) {
    let target;
    try {
      target = new URL(link);
    } catch {
      throw new TypeError("handoffUrl: link must be an absolute URL, such as https://example.com/checkout, because it is sent to a person.");
    }
    const journey = journeyId ?? (req ? journeyIdOf(req) ?? journeyKeyOf(req)?.journey_id : undefined);
    if (typeof journey !== "string" || !JOURNEY_KEY.test(journey)) throw new TypeError("handoffUrl: no journey to hand off. Pass { req } for a request that carried a journey key (Track-Journey header, ?track_j= or the track_j cookie, or issueJourneyKeys on), or { journeyId }. docs: https://alg.katrinalaszlo.com/docs#handing-off-to-a-person");
    return (async () => {
      try {
        const res = await fetch(handoffsUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ journey_id: journey }),
          signal: AbortSignal.timeout(HANDOFF_URL_TIMEOUT_MS),
        });
        const body = await res.json();
        if (res.status !== 201) {
          console.error(`agent-traffic: handoff link sent without a token: ${res.status} ${body.error}: ${body.message}`);
          return link;
        }
        target.searchParams.set(HANDOFF_PARAM, body.token);
        return target.toString();
      } catch (err) {
        const reason = err.name === "TimeoutError" ? `no answer from Track within ${HANDOFF_URL_TIMEOUT_MS / 1000} seconds` : err.message;
        console.error(`agent-traffic: handoff link sent without a token: ${reason}`);
        return link;
      }
    })();
  }

  // Sends the event of a request that arrived with a handoff token, at once, and resolves with the agent's journey key
  // when Track linked it, else null. Never rejects: a failure is logged (without the token) and the request carries on.
  async function linkHandoff(event) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify([event]),
        signal: AbortSignal.timeout(HANDOFF_WAIT_MS),
      });
      const body = await res.json();
      if (res.status !== 202) {
        console.error(`agent-traffic: handoff not linked: ${res.status} ${body.error}: ${body.message}`);
        return null;
      }
      for (const entry of body.rejected) {
        const hint = entry.reason === "unknown_field" ? ". The agent traffic host is older than this package (0.7.0) and does not take handoff tokens yet." : "";
        console.error(`agent-traffic: handoff not linked: event rejected: ${entry.reason}${hint}`);
      }
      for (const warning of body.event_warnings ?? []) console.error(`agent-traffic: handoff not linked: ${warning.message}`);
      return body.journeys?.[0]?.journey_id ?? null;
    } catch (err) {
      console.error(`agent-traffic: handoff not linked: ${err.message}`);
      return null;
    }
  }

  function agentTrafficMiddleware(req, res, next) {
    const occurredAt = new Date().toISOString();
    // Read while the request is current: the context is per request.
    const vercel = globalThis[VERCEL_CONTEXT]?.get?.();
    let journey = journeyKeyOf(req);
    if (issueJourneyKeys && !journey) journey = { journey_id: `j_${randomBytes(16).toString("hex")}`, journey_source: "issued" };
    const handoffToken = handoffTokenOf(req);
    if (!handoffToken) return record(journey);
    // A handoff link: Track has to answer before the response, so the person's cookie can carry the agent's journey.
    // The request's own event is still sent after the response, on the agent's journey with journey_source "issued":
    // the key was given on this request, not read from it. Ingest takes "handoff" from no caller.
    linkHandoff(handoffEventOf(req, occurredAt, journey, handoffToken)).then((agentJourney) => {
      if (agentJourney) journey = { journey_id: agentJourney, journey_source: "issued" };
      record(journey);
    }).catch(next);

    function record(journey) {
      journeys.set(req, journey);
      if (issueJourneyKeys) setJourneyKey(res, journey.journey_id);
      res.on("finish", () => {
        // An exception here would be thrown outside the request, so it is logged instead: the event is lost, the
        // server is not.
        let event;
        try {
          event = eventOf(req, res, occurredAt, journey);
        } catch (err) {
          // The redacted path only: the query string can hold an API key, a journey key or a handoff token, and a path
          // segment an invite or reset token, which never go in a log.
          console.error(`agent-traffic: event not recorded for ${req.method} ${redactedPath(req) ?? "(no path)"}: ${err.stack}`);
          return;
        }
        if (SERVERLESS || vercel?.waitUntil) {
          const sending = send([event], 1);
          vercel?.waitUntil?.(sending);
          return;
        }
        queue.push(event);
        if (queue.length >= BATCH_MAX) flush();
        else if (!timer) timer = setTimeout(flush, FLUSH_MS).unref();
      });
      next();
    }
  }
  agentTrafficMiddleware.recordOutcome = recordOutcome;
  agentTrafficMiddleware.handoffUrl = handoffUrl;
  agentTrafficMiddleware.journeyIdOf = journeyIdOf;
  return agentTrafficMiddleware;

  // The path to send: what pathOf returns, else the redacted request path. Either way cut at ? or #, and left out
  // when it does not start with / or is longer than 2048 characters.
  function pathFor(req) {
    if (!pathOf) return redactedPath(req);
    const custom = pathOf(req);
    if (typeof custom !== "string") return undefined;
    const path = custom.split(/[?#]/)[0];
    if (!path.startsWith("/") || path.length > PATH_MAX) return undefined;
    return path;
  }

  function eventOf(req, res, occurredAt, journey) {
    const accountId = accountIdOf ? accountIdOf(req, res) : undefined;
    // Only for failed responses: the text that tells one 402 from another in Fix next. Capped so a long message cannot
    // crowd a batch.
    const error = errorOf && res.statusCode >= 400 ? errorOf(req, res) : undefined;
    return {
      idempotency_key: randomUUID(),
      name: eventName(req),
      path: pathFor(req),
      occurred_at: occurredAt,
      source: "sdk",
      account_id: accountId ? hashAccountId(accountId) : undefined,
      ip_hash: salt && !ipHashUnsupported ? hashIp(req.ip ?? req.socket?.remoteAddress, salt, occurredAt) : undefined,
      user_agent: req.headers["user-agent"],
      accept_language: req.headers["accept-language"],
      signature_agent: req.headers["signature-agent"],
      ...signatureMaterial(req),
      ...journey,
      properties: { status_code: res.statusCode, method: req.method, ...(typeof error === "string" && error !== "" ? { error: error.slice(0, ERROR_MAX) } : {}) },
    };
  }

  // The event that carries a handoff token, sent before the response, so it has no status code and no account yet:
  // the person's sign-in comes on their later requests.
  // It runs before your routes, so a pathOf that throws must not fail the request: the event goes without a path.
  function handoffEventOf(req, occurredAt, journey, handoffToken) {
    let path;
    try {
      path = pathFor(req);
    } catch (err) {
      console.error(`agent-traffic: pathOf threw, handoff_opened sent without a path: ${err.message}`);
    }
    return {
      idempotency_key: randomUUID(),
      name: "handoff_opened",
      path,
      occurred_at: occurredAt,
      source: "sdk",
      user_agent: req.headers["user-agent"],
      accept_language: req.headers["accept-language"],
      signature_agent: req.headers["signature-agent"],
      ...journey,
      handoff_token: handoffToken,
      properties: { method: req.method },
    };
  }
}

module.exports = { eventName, agentTraffic, signatureMaterial, redactPath, hashIp, JOURNEY_HEADER, HANDOFF_PARAM };
