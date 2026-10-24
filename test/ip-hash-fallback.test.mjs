// An older Track host rejects ip_hash. The middleware must lose no event to it: the refused events go again without
// ip_hash, with the same idempotency keys, and the process stops sending ip_hash. Each test loads a fresh copy of the
// module, because stopping is per process.
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MODULE = require.resolve("../skills/agent-traffic/agent-traffic.cjs");
const fresh = () => {
  delete require.cache[MODULE];
  return require(MODULE);
};

describe("ip_hash fallback for an older Track host", () => {
  let calls;
  let answers;
  let errors;

  beforeEach(() => {
    calls = [];
    answers = [];
    mock.method(globalThis, "fetch", async (url, init) => {
      const batch = JSON.parse(init.body);
      calls.push(batch);
      const answer = answers.shift()?.(batch) ?? { status: 202, body: { accepted: batch.length, rejected: [] } };
      return { status: answer.status, json: async () => answer.body };
    });
    errors = mock.method(console, "error", () => {});
    mock.method(console, "log", () => {});
    mock.timers.enable({ apis: ["setTimeout"] });
  });
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  const request = (middleware, ip, route = "/docs") => {
    const res = new EventEmitter();
    const req = { method: "GET", baseUrl: "", route: { path: route }, headers: { "user-agent": "curl/8.7.1" }, url: route, ip };
    middleware(req, res, () => {});
    res.statusCode = 200;
    res.emit("finish");
  };
  const flush = async () => {
    mock.timers.tick(1000);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const loggedLines = () => errors.mock.calls.map((call) => call.arguments[0]);

  test("unknown_field on ip_hash: the refused events go again without it, same keys; later events carry none; said once", async () => {
    const { agentTraffic } = fresh();
    const middleware = agentTraffic({ key: "k", salt: "s" });
    // An older host: every event with ip_hash is refused and named, one event also fails for another reason.
    answers.push((batch) => ({
      status: 202,
      body: {
        accepted: 0,
        rejected: [
          ...batch.slice(0, 2).map((event) => ({ idempotency_key: event.idempotency_key, reason: "unknown_field", field: "ip_hash" })),
          { idempotency_key: batch[2].idempotency_key, reason: "invalid_name" },
        ],
      },
    }));
    for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) request(middleware, ip);
    await flush();
    assert.equal(calls.length, 2);
    const [first, resent] = calls;
    assert.ok(first.every((event) => /^[0-9a-f]{64}$/.test(event.ip_hash)));
    assert.deepEqual(resent.map((event) => event.idempotency_key), first.slice(0, 2).map((event) => event.idempotency_key));
    assert.deepEqual(resent, first.slice(0, 2).map(({ ip_hash, ...event }) => event));
    const lines = loggedLines();
    assert.equal(lines.filter((line) => line.includes("does not accept ip_hash")).length, 1);
    assert.ok(lines.some((line) => line.includes("1 of 3 events rejected: invalid_name")), "other rejections are still logged");
    assert.equal(lines.some((line) => line.includes("unknown_field (ip_hash)")), false, "the handled refusal is not logged as a rejection");

    request(middleware, "198.51.100.4");
    await flush();
    assert.equal(calls.length, 3);
    assert.equal("ip_hash" in calls[2][0], false);
    assert.equal(loggedLines().filter((line) => line.includes("does not accept ip_hash")).length, 1);
  });

  test("a host too old to name the field: unknown_field on an event that carried ip_hash counts", async () => {
    const { agentTraffic } = fresh();
    const middleware = agentTraffic({ key: "k", salt: "s" });
    answers.push((batch) => ({ status: 202, body: { accepted: 0, rejected: batch.map((event) => ({ idempotency_key: event.idempotency_key, reason: "unknown_field" })) } }));
    request(middleware, "203.0.113.9");
    await flush();
    assert.equal(calls.length, 2);
    assert.equal("ip_hash" in calls[1][0], false);
    assert.equal(calls[1][0].idempotency_key, calls[0][0].idempotency_key);
  });

  test("a 400 that names ip_hash: the whole batch goes again without it", async () => {
    const { agentTraffic } = fresh();
    const middleware = agentTraffic({ key: "k", salt: "s" });
    answers.push(() => ({ status: 400, body: { error: "invalid_body", message: "Unknown field ip_hash." } }));
    request(middleware, "203.0.113.9");
    request(middleware, "203.0.113.10");
    await flush();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0].map(({ ip_hash, ...event }) => event));
    assert.equal(loggedLines().some((line) => line.includes("dropped")), false, "nothing is dropped");
  });

  test("a 400 about something else is dropped as before, and ip_hash keeps being sent", async () => {
    const { agentTraffic } = fresh();
    const middleware = agentTraffic({ key: "k", salt: "s" });
    answers.push(() => ({ status: 400, body: { error: "invalid_body", message: "Body is not JSON." } }));
    request(middleware, "203.0.113.9");
    await flush();
    request(middleware, "203.0.113.9");
    await flush();
    assert.equal(calls.length, 2);
    assert.match(calls[1][0].ip_hash, /^[0-9a-f]{64}$/);
  });
});
