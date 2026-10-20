// Tanso agent traffic: Express middleware that sends one event per request to Tanso, after the response is sent.
// Source: https://github.com/katrinalaszlo/agent-traffic-skill. Node 18 or later, no dependencies.
//
//   const { tansoTraffic } = require("./tanso-traffic.cjs");   // or: import { tansoTraffic } from "./tanso-traffic.cjs";
//   app.use(tansoTraffic({ accountIdOf: (req, res) => req.user?.id }));
//
// accountIdOf returns your customer's id for the request (called with req and res after the response, so values your
// auth set on either, such as req.user or res.locals.user, are there), or undefined. TANSO_KEY, TANSO_PROJECT_ID and TANSO_ACCOUNT_SALT come from the environment, or from a .env in
// the working directory, this file's folder or any folder above it, when the environment lacks them; only TANSO_ lines are read, nothing else in .env is touched.
//
// Register it right after creating the app, before auth and routes. It never blocks or fails a request: events are
// queued, sent in batches of up to 25 once a second, and a failed batch is logged and retried with the same keys.
const { createHmac, randomUUID } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const BATCH_MAX = 25;
const FLUSH_MS = 1000;
const RETRIES_MAX = 3;
// On serverless hosts the process can freeze as soon as the response is sent, so a queued batch might never go out.
// There each event is sent at once, and on Vercel the send is handed to waitUntil so the function stays up until it
// is done (the request context @vercel/functions reads, without depending on it).
const SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
const VERCEL_CONTEXT = Symbol.for("@vercel/request-context");

// The event name is the route pattern, not the URL, so /v1/users/42 and /v1/users/43 are one step. A leading version
// segment (v1) and "api" are dropped, and the method is appended for anything but GET:
//   GET /v1/docs/quickstart -> docs_quickstart   POST /api/v1/api-keys -> api_keys_post   GET /v1/users/:id -> users_id
// A request no route matched is "unmatched". Names fit Tanso's rule: ^[a-z][a-z0-9_]{0,63}$.
function eventName(req) {
  if (!req.route) return "unmatched";
  const pattern = `${req.baseUrl ?? ""}${typeof req.route.path === "string" ? req.route.path : ""}`;
  const segments = pattern.toLowerCase().split("/").filter((seg) => seg !== "api" && !/^v\d+$/.test(seg));
  const words = segments.flatMap((seg) => seg.split(/[^a-z0-9]+/)).filter((w) => w !== "");
  if (req.method !== "GET" && req.method !== "HEAD") words.push(req.method.toLowerCase());
  const name = words.join("_").replace(/^[^a-z]+/, "");
  return (name === "" ? "root" : name).slice(0, 64).replace(/_+$/, "");
}

// The .env holding TANSO_KEY: in the working directory, else in this file's folder or the nearest one above it, so
// it can sit at an app's root or a monorepo's root whichever directory the server starts from.
function envFile() {
  const candidates = [join(process.cwd(), ".env")];
  for (let dir = __dirname; ; dir = dirname(dir)) {
    candidates.push(join(dir, ".env"));
    if (dirname(dir) === dir) break;
  }
  return candidates.find((file) => existsSync(file) && /^TANSO_KEY=/m.test(readFileSync(file, "utf8")));
}

// TANSO_ variables from the environment, else from the .env envFile finds.
function tansoEnv() {
  const values = {};
  const file = envFile();
  if (file) {
    for (const match of readFileSync(file, "utf8").matchAll(/^(TANSO_[A-Z_]+)=(.*)$/gm)) values[match[1]] = match[2].trim();
  }
  for (const name of Object.keys(process.env)) if (name.startsWith("TANSO_")) values[name] = process.env[name];
  return values;
}

function tansoTraffic({ accountIdOf, key, projectId, salt, endpoint } = {}) {
  const env = tansoEnv();
  key ??= env.TANSO_KEY;
  projectId ??= env.TANSO_PROJECT_ID;
  salt ??= env.TANSO_ACCOUNT_SALT;
  endpoint ??= env.TANSO_ENDPOINT ?? "https://traffic.katrinalaszlo.com";
  if (!key || !projectId) throw new Error("tansoTraffic needs TANSO_KEY and TANSO_PROJECT_ID, in the environment or in .env.");
  if (accountIdOf && !salt) throw new Error("tansoTraffic needs TANSO_ACCOUNT_SALT, in the environment or in .env, to hash what accountIdOf returns.");
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
          if (entry.reason !== "duplicate") console.error(`tanso: rejected ${entry.idempotency_key}: ${entry.reason}`);
        }
        return;
      }
      failure = `${res.status} ${body.error}: ${body.message}`;
      // A 4xx other than 429 will fail the same way again, so it is not retried.
      if (res.status < 500 && res.status !== 429) {
        console.error(`tanso: batch of ${batch.length} dropped: ${failure}`);
        return;
      }
    } catch (err) {
      failure = err.message;
    }
    if (attempt >= RETRIES_MAX) {
      console.error(`tanso: batch of ${batch.length} dropped after ${attempt} attempts: ${failure}`);
      return;
    }
    console.error(`tanso: batch of ${batch.length} failed (${failure}), retrying`);
    setTimeout(() => send(batch, attempt + 1), FLUSH_MS * 2 ** attempt).unref();
  }

  function flush() {
    timer = null;
    while (queue.length > 0) send(queue.splice(0, BATCH_MAX), 1);
  }

  return function tansoTrafficMiddleware(req, res, next) {
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
        console.error(`tanso: event not recorded for ${req.method} ${req.originalUrl ?? req.url}: ${err.stack}`);
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
  };

  function eventOf(req, res, occurredAt) {
    const accountId = accountIdOf ? accountIdOf(req, res) : undefined;
    return {
      idempotency_key: randomUUID(),
      name: eventName(req),
      occurred_at: occurredAt,
      source: "sdk",
      account_id: accountId ? createHmac("sha256", salt).update(String(accountId)).digest("hex") : undefined,
      user_agent: req.headers["user-agent"],
      accept_language: req.headers["accept-language"],
      signature_agent: req.headers["signature-agent"],
      properties: { status_code: res.statusCode, method: req.method },
    };
  }
}

module.exports = { eventName, tansoTraffic };
