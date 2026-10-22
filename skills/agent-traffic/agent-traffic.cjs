// Agent traffic: Express middleware that sends one event per request to traffic.katrinalaszlo.com, after the
// response is sent. npm package @katrinalaszlo/agent-traffic; source https://github.com/katrinalaszlo/agent-traffic-skill. Node 18+.
//
//   const { agentTraffic } = require("@katrinalaszlo/agent-traffic");   // or: import { agentTraffic } from "@katrinalaszlo/agent-traffic";
//   const traffic = agentTraffic({ accountIdOf: (req, res) => req.user?.id });
//   app.use(traffic);
//   // From your signup handler and your payment webhook: the outcome an agent's session led to.
//   await traffic.recordOutcome({ accountId: user.id, name: "signup", idempotencyKey: user.id });
//   await traffic.recordOutcome({ accountId: customer.id, name: "paid", value: 1999, currency: "USD", idempotencyKey: paymentEvent.id });
//
// accountIdOf returns your customer's id for the request (called with req and res after the response, so values your
// auth set on either, such as req.user or res.locals.user, are there), or undefined. errorOf, optional, returns the
// error text for a failed response (status 400 and above), such as an error code your handler put in res.locals, so
// two errors with the same status show as different rows in Fix next. AGENT_TRAFFIC_KEY,
// AGENT_TRAFFIC_PROJECT_ID and AGENT_TRAFFIC_ACCOUNT_SALT come from the environment, or from a .env in the working
// directory, this file's folder or any folder above it, when the environment lacks them; only AGENT_TRAFFIC_ lines are
// read, nothing else in .env is touched.
//
// Register it right after creating the app, before auth and routes. It never blocks or fails a request: events are
// queued, sent in batches of up to 25 once a second, and a failed batch is logged and retried with the same keys.
const { createHmac, randomUUID } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const BATCH_MAX = 25;
const OUTCOME_NAMES = ["signup", "key_created", "activation", "paid", "custom"];
const FLUSH_MS = 1000;
const RETRIES_MAX = 3;
const ERROR_MAX = 200;
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

// The .env holding AGENT_TRAFFIC_KEY: in the working directory, else in this file's folder or the nearest one above it, so
// it can sit at an app's root or a monorepo's root whichever directory the server starts from.
function envFile() {
  const candidates = [join(process.cwd(), ".env")];
  for (let dir = __dirname; ; dir = dirname(dir)) {
    candidates.push(join(dir, ".env"));
    if (dirname(dir) === dir) break;
  }
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

// Web Bot Auth: when an agent signed its request (Signature and Signature-Input headers), the event carries what ingest
// needs to check the signature: those two headers, the method and absolute URL, and only the other headers the
// signature covers. Never a credential header, whatever the signer covered. An unsigned request adds nothing.
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
  const url = typeof host === "string" && host !== "" ? `${req.protocol ?? "https"}://${host}${req.originalUrl ?? req.url ?? "/"}` : undefined;
  return {
    signature,
    signature_input: signatureInput,
    method: String(req.method ?? "GET").toUpperCase(),
    ...(url ? { url } : {}),
    ...(Object.keys(covered).length > 0 ? { covered_headers: covered } : {}),
  };
}

function agentTraffic({ accountIdOf, errorOf, key, projectId, salt, endpoint } = {}) {
  const env = agentTrafficEnv();
  key ??= env.AGENT_TRAFFIC_KEY;
  projectId ??= env.AGENT_TRAFFIC_PROJECT_ID;
  salt ??= env.AGENT_TRAFFIC_ACCOUNT_SALT;
  endpoint ??= env.AGENT_TRAFFIC_ENDPOINT ?? "https://traffic.katrinalaszlo.com";
  if (!key || !projectId) throw new Error("agentTraffic needs AGENT_TRAFFIC_KEY and AGENT_TRAFFIC_PROJECT_ID, in the environment or in .env.");
  if (accountIdOf && !salt) throw new Error("agentTraffic needs AGENT_TRAFFIC_ACCOUNT_SALT, in the environment or in .env, to hash what accountIdOf returns.");
  const url = `${endpoint}/v1/events?project_id=${encodeURIComponent(projectId)}`;
  let queue = [];
  let timer = null;

  async function send(batch, attempt) {
    let failure = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(batch),
      });
      const body = await res.json();
      if (res.status === 202) {
        for (const entry of body.rejected) {
          if (entry.reason !== "duplicate") console.error(`agent-traffic: rejected ${entry.idempotency_key}: ${entry.reason}`);
        }
        return;
      }
      failure = `${res.status} ${body.error}: ${body.message}`;
      // A 4xx other than 429 will fail the same way again, so it is not retried.
      if (res.status < 500 && res.status !== 429) {
        console.error(`agent-traffic: batch of ${batch.length} dropped: ${failure}`);
        return;
      }
    } catch (err) {
      failure = err.message;
    }
    if (attempt >= RETRIES_MAX) {
      console.error(`agent-traffic: batch of ${batch.length} dropped after ${attempt} attempts: ${failure}`);
      return;
    }
    console.error(`agent-traffic: batch of ${batch.length} failed (${failure}), retrying`);
    setTimeout(() => send(batch, attempt + 1), FLUSH_MS * 2 ** attempt).unref();
  }

  function flush() {
    timer = null;
    while (queue.length > 0) send(queue.splice(0, BATCH_MAX), 1);
  }

  const hashAccountId = (accountId) => createHmac("sha256", salt).update(String(accountId)).digest("hex");

  // An outcome is sent at once, not batched: there are few of them and each one is money or a signup. Returns a
  // promise that settles when the send has finished (sent, or logged and dropped); nothing it does can throw into
  // your handler after validation. Bad input throws synchronously, at your call site, with the field named: that is
  // your bug to see now, not a rejection to find in a log later.
  function recordOutcome({ accountId, name, value, currency, idempotencyKey, occurredAt } = {}) {
    if (!salt) throw new TypeError("recordOutcome needs AGENT_TRAFFIC_ACCOUNT_SALT (or the salt option) to hash accountId, the same salt the middleware uses. docs: https://traffic.katrinalaszlo.com/docs#outcomes");
    if (accountId === undefined || accountId === null || String(accountId) === "") throw new TypeError("recordOutcome: accountId is required: the same customer id accountIdOf returns, so the outcome joins the agent's session. docs: https://traffic.katrinalaszlo.com/docs#outcomes");
    if (!OUTCOME_NAMES.includes(name)) throw new TypeError(`recordOutcome: name must be one of ${OUTCOME_NAMES.join(", ")}, got ${JSON.stringify(name)}. docs: https://traffic.katrinalaszlo.com/docs#outcomes`);
    if (typeof idempotencyKey !== "string" || idempotencyKey === "" || idempotencyKey.length > 200) throw new TypeError("recordOutcome: idempotencyKey is required (1 to 200 characters): your payment event id or signup id, so a retried webhook never counts twice. docs: https://traffic.katrinalaszlo.com/docs#outcomes");
    const hasValue = value !== undefined && value !== null;
    if (hasValue && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) throw new TypeError(`recordOutcome: value must be a whole number of minor units (1999 for $19.99), 0 or more, got ${typeof value === "string" ? `string ${JSON.stringify(value)}` : String(value)}. docs: https://traffic.katrinalaszlo.com/docs#outcomes`);
    if (hasValue && !/^[A-Z]{3}$/.test(String(currency))) throw new TypeError(`recordOutcome: currency must be an ISO 4217 code such as USD when value is set, got ${JSON.stringify(currency)}. docs: https://traffic.katrinalaszlo.com/docs#outcomes`);
    if (name === "paid" && !hasValue) throw new TypeError("recordOutcome: a paid outcome needs value (minor units) and currency. docs: https://traffic.katrinalaszlo.com/docs#outcomes");
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
    const sending = send([event], 1);
    vercel?.waitUntil?.(sending);
    return sending;
  }

  function agentTrafficMiddleware(req, res, next) {
    const occurredAt = new Date().toISOString();
    // Read while the request is current: the context is per request.
    const vercel = globalThis[VERCEL_CONTEXT]?.get?.();
    res.on("finish", () => {
      // An exception here would be thrown outside the request, so it is logged instead: the event is lost, the
      // server is not.
      let event;
      try {
        event = eventOf(req, res, occurredAt);
      } catch (err) {
        console.error(`agent-traffic: event not recorded for ${req.method} ${req.originalUrl ?? req.url}: ${err.stack}`);
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
  agentTrafficMiddleware.recordOutcome = recordOutcome;
  return agentTrafficMiddleware;

  function eventOf(req, res, occurredAt) {
    const accountId = accountIdOf ? accountIdOf(req, res) : undefined;
    // Only for failed responses: the text that tells one 402 from another in Fix next. Capped so a long message cannot
    // crowd a batch.
    const error = errorOf && res.statusCode >= 400 ? errorOf(req, res) : undefined;
    return {
      idempotency_key: randomUUID(),
      name: eventName(req),
      occurred_at: occurredAt,
      source: "sdk",
      account_id: accountId ? hashAccountId(accountId) : undefined,
      user_agent: req.headers["user-agent"],
      accept_language: req.headers["accept-language"],
      signature_agent: req.headers["signature-agent"],
      ...signatureMaterial(req),
      properties: { status_code: res.statusCode, method: req.method, ...(typeof error === "string" && error !== "" ? { error: error.slice(0, ERROR_MAX) } : {}) },
    };
  }
}

module.exports = { eventName, agentTraffic, signatureMaterial };
