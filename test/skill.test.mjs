import { describe, test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHmac } from "node:crypto";
import { eventName, tansoTraffic } from "../skills/tanso-agent-traffic/tanso-traffic.mjs";

const run = promisify(execFile);

function fakeRequest({ method = "GET", baseUrl = "", route = null, headers = {} } = {}) {
  return { method, baseUrl, route: route === null ? undefined : { path: route }, headers, url: "/x" };
}

describe("eventName", () => {
  test("route pattern, version and api dropped, method added for anything but GET", () => {
    assert.equal(eventName(fakeRequest({ route: "/v1/docs/quickstart" })), "docs_quickstart");
    assert.equal(eventName(fakeRequest({ route: "/docs" })), "docs");
    assert.equal(eventName(fakeRequest({ method: "POST", baseUrl: "/api/v1", route: "/api-keys" })), "api_keys_post");
    assert.equal(eventName(fakeRequest({ route: "/v1/users/:id" })), "users_id");
    assert.equal(eventName(fakeRequest({ method: "POST", route: "/v1/charge" })), "charge_post");
    assert.equal(eventName(fakeRequest({ route: "/" })), "root");
    assert.equal(eventName(fakeRequest({ route: "/2fa/setup" })), "fa_setup");
    assert.equal(eventName(fakeRequest()), "unmatched");
  });

  test("always fits the ingest name rule", () => {
    const long = `/${"segment".repeat(20)}/x`;
    for (const route of ["/v1/docs", "/_internal/x", "/v1", long, "/a-b-c_/"]) {
      for (const method of ["GET", "DELETE"]) assert.match(eventName(fakeRequest({ method, route })), /^[a-z][a-z0-9_]{0,63}$/, `${method} ${route}`);
    }
  });
});

describe("tansoTraffic middleware", () => {
  const sent = [];
  let answer = { status: 202, body: { accepted: 1, rejected: [] } };

  before(() => {
    mock.method(globalThis, "fetch", async (url, init) => {
      sent.push({ url, init, batch: JSON.parse(init.body) });
      return { status: answer.status, json: async () => answer.body };
    });
    mock.timers.enable({ apis: ["setTimeout"] });
  });
  after(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  function request(middleware, req, statusCode) {
    const res = new EventEmitter();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled);
    res.statusCode = statusCode;
    res.emit("finish");
  }

  test("refuses to start without key, project, or a salt for accountIdOf", () => {
    assert.throws(() => tansoTraffic({ projectId: "p" }), /key and projectId/);
    assert.throws(() => tansoTraffic({ key: "k", projectId: "p", accountIdOf: () => "a" }), /salt/);
  });

  test("one event per finished response, sent after a second, with status code, hashed account and headers", async () => {
    sent.length = 0;
    const middleware = tansoTraffic({ key: "ark_test", projectId: "p-1", salt: "s", accountIdOf: (req) => req.user?.id });
    const req = fakeRequest({ method: "POST", route: "/v1/charge", headers: { "user-agent": "Claude-User (claude-code/2.1)", "signature-agent": '"https://claude.ai"' } });
    req.user = { id: "acct_1" };
    request(middleware, req, 402);
    request(middleware, fakeRequest({ route: "/v1/docs" }), 200);
    assert.equal(sent.length, 0);
    mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://traffic.katrinalaszlo.com/v1/events?project_id=p-1");
    assert.equal(sent[0].init.headers.authorization, "Bearer ark_test");
    const [charge, docs] = sent[0].batch;
    assert.equal(charge.name, "charge_post");
    assert.deepEqual(charge.properties, { status_code: 402, method: "POST" });
    assert.equal(charge.account_id, createHmac("sha256", "s").update("acct_1").digest("hex"));
    assert.equal(charge.signature_agent, '"https://claude.ai"');
    assert.equal(charge.source, "sdk");
    assert.equal(docs.name, "docs");
    assert.equal("account_id" in docs, false);
    assert.notEqual(charge.idempotency_key, docs.idempotency_key);
  });

  test("an accountIdOf that throws loses the event and logs it; the next request still records", async () => {
    sent.length = 0;
    const errors = mock.method(console, "error", () => {});
    const middleware = tansoTraffic({ key: "k", projectId: "p", salt: "s", accountIdOf: (req) => req.user.id });
    request(middleware, fakeRequest({ route: "/a" }), 200);
    assert.match(errors.mock.calls[0].arguments[0], /event not recorded for GET/);
    const ok = fakeRequest({ route: "/b" });
    ok.user = { id: "x" };
    request(middleware, ok, 200);
    mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map((s) => s.batch.map((e) => e.name)), [["b"]]);
    errors.mock.restore();
  });

  test("a 500 is retried with the same idempotency keys; a 401 is logged and dropped", async () => {
    sent.length = 0;
    const errors = mock.method(console, "error", () => {});
    const middleware = tansoTraffic({ key: "k", projectId: "p" });
    answer = { status: 500, body: { error: "internal_error", message: "x" } };
    request(middleware, fakeRequest({ route: "/a" }), 200);
    mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
    answer = { status: 202, body: { accepted: 1, rejected: [] } };
    mock.timers.tick(2000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].batch[0].idempotency_key, sent[0].batch[0].idempotency_key);

    sent.length = 0;
    answer = { status: 401, body: { error: "invalid_key", message: "bad" } };
    request(middleware, fakeRequest({ route: "/a" }), 200);
    mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(10_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.ok(errors.mock.calls.some((c) => /dropped: 401 invalid_key/.test(c.arguments[0])));
    answer = { status: 202, body: { accepted: 1, rejected: [] } };
    errors.mock.restore();
  });

  test("25 events go out at once without waiting for the timer", async () => {
    sent.length = 0;
    const middleware = tansoTraffic({ key: "k", projectId: "p" });
    for (let i = 0; i < 25; i += 1) request(middleware, fakeRequest({ route: "/a" }), 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].batch.length, 25);
  });
});

describe("verify.mjs", () => {
  let server;
  let base;
  let paths;
  const seen = [];

  before(async () => {
    server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/api/refresh" ? { success: true } : paths));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  const verify = async () => {
    const env = { ...process.env, TANSO_ENDPOINT: base, TANSO_KEY: "ark_ws_secretvalue", TANSO_PROJECT_ID: "4024c67a-7e8d-4011-a178-2600781419a8" };
    try {
      const { stdout } = await run(process.execPath, [new URL("../skills/tanso-agent-traffic/verify.mjs", import.meta.url).pathname], { env });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.code, stdout: err.stdout + err.stderr };
    }
  };

  const good = {
    events: 12, unattributed_events: 2, sessions: 3, terminal_counts: { success: 2, failure: 1, unknown: 0 },
    paths: [{ steps: ["docs", "api_keys_post", "charge_post"] }], intents: [{ intent: "api_keys_post" }], agents: [{ agent: "claude.ai" }],
  };

  test("passes a working install, refreshes first, and never prints the key", async () => {
    paths = good;
    seen.length = 0;
    const { code, stdout } = await verify();
    assert.equal(code, 0, stdout);
    assert.match(stdout, /PASS {2}12 events/);
    assert.match(stdout, /PASS {2}3 distinct event names/);
    assert.doesNotMatch(stdout, /FAIL|secretvalue/);
    assert.deepEqual(seen.map((s) => s.method), ["POST", "GET"]);
    assert.equal(seen[1].auth, "Bearer ark_ws_secretvalue");
  });

  test("fails events with no account, no status codes, and one name, each with its fix", async () => {
    paths = { ...good, unattributed_events: 12, sessions: 0, terminal_counts: { success: 0, failure: 0, unknown: 0 }, paths: [], intents: [], agents: [] };
    let result = await verify();
    assert.equal(result.code, 1);
    assert.match(result.stdout, /none is in a session\. accountIdOf returned nothing/);
    assert.match(result.stdout, /WARN {2}12 of 12 events have no account/);

    paths = { ...good, terminal_counts: { success: 0, failure: 0, unknown: 3 }, paths: [{ steps: ["api_call", "api_call"] }], intents: [{ intent: "api_call" }] };
    result = await verify();
    assert.equal(result.code, 1);
    assert.match(result.stdout, /No session ended with a status code/);
    assert.match(result.stdout, /same name \(api_call\)/);
  });

  test("fails without its environment", async () => {
    const err = await run(process.execPath, [new URL("../skills/tanso-agent-traffic/verify.mjs", import.meta.url).pathname], { env: { PATH: process.env.PATH } }).catch((e) => e);
    assert.equal(err.code, 1);
    assert.match(err.stderr, /TANSO_KEY and TANSO_PROJECT_ID must be set/);
  });
});
