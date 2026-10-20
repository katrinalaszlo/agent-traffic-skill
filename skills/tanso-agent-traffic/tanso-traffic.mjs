// Tanso agent traffic: Express middleware that sends one event per request to Tanso, after the response is sent.
// Source: https://traffic.katrinalaszlo.com/skill/tanso-traffic.mjs. Node 18 or later (fetch is built in).
//
//   import { tansoTraffic } from "./tanso-traffic.mjs";
//   app.use(tansoTraffic({
//     key: process.env.TANSO_KEY,
//     projectId: process.env.TANSO_PROJECT_ID,
//     salt: process.env.TANSO_ACCOUNT_SALT,
//     accountIdOf: (req) => req.user?.id,   // your customer's account id, read after your auth ran; undefined if none
//   }));
//
// Register it before your routes. It never blocks or fails a request: events are queued, sent in batches of up to
// 25 once a second, and a failed batch is logged and retried with the same idempotency keys.
import { createHmac, randomUUID } from "node:crypto";

const BATCH_MAX = 25;
const FLUSH_MS = 1000;
const RETRIES_MAX = 3;

// The event name is the route pattern, not the URL, so /v1/users/42 and /v1/users/43 are one step. A leading version
// segment (v1) and "api" are dropped, and the method is appended for anything but GET:
//   GET /v1/docs/quickstart -> docs_quickstart   POST /api/v1/api-keys -> api_keys_post   GET /v1/users/:id -> users_id
// A request no route matched is "unmatched". Names fit Tanso's rule: ^[a-z][a-z0-9_]{0,63}$.
export function eventName(req) {
  if (!req.route) return "unmatched";
  const pattern = `${req.baseUrl ?? ""}${typeof req.route.path === "string" ? req.route.path : ""}`;
  const segments = pattern.toLowerCase().split("/").filter((seg) => seg !== "api" && !/^v\d+$/.test(seg));
  const words = segments.flatMap((seg) => seg.split(/[^a-z0-9]+/)).filter((w) => w !== "");
  if (req.method !== "GET" && req.method !== "HEAD") words.push(req.method.toLowerCase());
  const name = words.join("_").replace(/^[^a-z]+/, "");
  return (name === "" ? "root" : name).slice(0, 64).replace(/_+$/, "");
}

export function tansoTraffic({ key, projectId, salt, accountIdOf, endpoint = "https://traffic.katrinalaszlo.com" }) {
  if (!key || !projectId) throw new Error("tansoTraffic needs key and projectId (TANSO_KEY, TANSO_PROJECT_ID).");
  if (accountIdOf && !salt) throw new Error("tansoTraffic needs salt (TANSO_ACCOUNT_SALT) to hash what accountIdOf returns.");
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
    res.on("finish", () => {
      // An exception here would be thrown outside the request, so it is logged instead: the event is lost, the
      // server is not.
      try {
        queue.push(eventOf(req, res, occurredAt));
      } catch (err) {
        console.error(`tanso: event not recorded for ${req.method} ${req.originalUrl ?? req.url}: ${err.stack}`);
        return;
      }
      if (queue.length >= BATCH_MAX) flush();
      else if (!timer) timer = setTimeout(flush, FLUSH_MS).unref();
    });
    next();
  };

  function eventOf(req, res, occurredAt) {
    const accountId = accountIdOf ? accountIdOf(req) : undefined;
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
