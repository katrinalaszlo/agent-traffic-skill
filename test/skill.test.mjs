import { describe, test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { eventName, agentTraffic, signatureMaterial, JOURNEY_HEADER } from "../skills/agent-traffic/agent-traffic.cjs";

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

  test("dynamic router mounts never put matched customer ids into event names", () => {
    for (const baseUrl of ["/customers/customer_123", "/customers/customer_456", "/teams/team_789/customers/alice%40example.com"]) {
      const req = fakeRequest({ baseUrl, route: "/orders/:orderId" });
      // Parent router params need not be present on req.params unless mergeParams was enabled.
      req.params = { orderId: "42" };
      assert.equal(eventName(req), "orders_orderid");
      assert.equal(eventName(fakeRequest({ method: "POST", baseUrl, route: "/" })), "post");
    }
  });
});

describe("signatureMaterial (Web Bot Auth forwarding)", () => {
  const INPUT = 'sig1=("@method" "@authority" "content-digest" "signature-agent";key="sig1" "authorization");created=1;expires=2;keyid="k";tag="web-bot-auth"';
  const signed = (extra = {}) => ({
    method: "post", protocol: "https", originalUrl: "/v1/charge?x=1", url: "/v1/charge?x=1",
    headers: { host: "shop.example", signature: "sig1=:AAAA:", "signature-input": INPUT, "signature-agent": 'sig1="https://claude.ai"', "content-digest": "sha-256=:abc:", authorization: "Bearer secret", cookie: "s=1", "user-agent": "x", ...extra },
  });

  test("an unsigned request adds nothing", () => {
    assert.deepEqual(signatureMaterial({ method: "GET", headers: { "user-agent": "x", "signature-agent": '"https://claude.ai"' } }), {});
    assert.deepEqual(signatureMaterial({ method: "GET", headers: { signature: "sig1=:AAAA:" } }), {});
  });

  test("a signed request forwards the two headers, uppercase method, absolute URL, and only the covered non-credential headers", () => {
    const out = signatureMaterial(signed());
    assert.deepEqual(out, {
      signature: "sig1=:AAAA:",
      signature_input: INPUT,
      method: "POST",
      url: "https://shop.example/v1/charge?x=1",
      covered_headers: { "content-digest": "sha-256=:abc:" },
    });
    assert.equal(JSON.stringify(out).includes("secret"), false);
    assert.equal(JSON.stringify(out).includes("s=1"), false);
  });

  test("a covered header the request lacks is skipped; repeated header values join; no host means no url", () => {
    const out = signatureMaterial(signed({ "content-digest": ["a", "b"] }));
    assert.deepEqual(out.covered_headers, { "content-digest": "a, b" });
    const noHost = signed(); delete noHost.headers.host;
    assert.equal("url" in signatureMaterial(noHost), false);
    const missing = signed(); delete missing.headers["content-digest"];
    assert.equal("covered_headers" in signatureMaterial(missing), false);
  });

  test("the middleware puts the material on the event beside signature_agent", async () => {
    const seen = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => { seen.push(JSON.parse(init.body)); return { status: 202, json: async () => ({ accepted: 1, rejected: [] }) }; };
    try {
      const middleware = agentTraffic({ key: "ark_test", projectId: "p-1" });
      const req = { ...signed(), baseUrl: "", route: { path: "/v1/charge" } };
      const res = new EventEmitter();
      middleware(req, res, () => {});
      res.statusCode = 200;
      res.emit("finish");
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal(seen[0][0].signature_input, INPUT);
      assert.equal(seen[0][0].url, "https://shop.example/v1/charge?x=1");
      assert.equal(seen[0][0].signature_agent, 'sig1="https://claude.ai"');
      assert.equal("authorization" in (seen[0][0].covered_headers ?? {}), false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("agentTraffic middleware", () => {
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
    assert.throws(() => agentTraffic({ projectId: "p" }), /needs AGENT_TRAFFIC_KEY and AGENT_TRAFFIC_PROJECT_ID/);
    assert.throws(() => agentTraffic({ key: "k", projectId: "p", accountIdOf: () => "a" }), /needs AGENT_TRAFFIC_ACCOUNT_SALT/);
  });

  test("one event per finished response, sent after a second, with status code, hashed account and headers", async () => {
    sent.length = 0;
    const middleware = agentTraffic({ key: "ark_test", projectId: "p-1", salt: "s", accountIdOf: (req) => req.user?.id });
    const req = fakeRequest({ method: "POST", route: "/v1/charge", headers: { "user-agent": "Claude-User (claude-code/2.1)", "signature-agent": '"https://claude.ai"' } });
    req.user = { id: "acct_1" };
    request(middleware, req, 402);
    request(middleware, fakeRequest({ route: "/v1/docs" }), 200);
    assert.equal(sent.length, 0);
    mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://alg.katrinalaszlo.com/v1/events?project_id=p-1");
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

  test("sent events group dynamic mounts by route; raw ids appear only in path, the query nowhere", async () => {
    sent.length = 0;
    const middleware = agentTraffic({ key: "k", projectId: "p", salt: "s", accountIdOf: (req) => req.user.id });
    for (const customerId of ["customer_123", "customer_456"]) {
      const req = fakeRequest({ baseUrl: `/customers/${customerId}`, route: "/orders/:orderId" });
      req.user = { id: customerId };
      req.params = { orderId: "42" };
      req.originalUrl = `/customers/${customerId}/orders/42?private=value`;
      request(middleware, req, 200);
    }
    mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent[0].batch.map((event) => event.name), ["orders_orderid", "orders_orderid"]);
    assert.deepEqual(sent[0].batch.map((event) => event.account_id), ["customer_123", "customer_456"].map((id) => createHmac("sha256", "s").update(id).digest("hex")));
    assert.deepEqual(sent[0].batch.map((event) => event.path), ["/customers/customer_123/orders/42", "/customers/customer_456/orders/42"]);
    assert.doesNotMatch(JSON.stringify(sent[0].batch.map(({ path, ...rest }) => rest)), /customer_123|customer_456/);
    assert.doesNotMatch(sent[0].init.body, /private=value|private/);
  });

  test("an accountIdOf that throws loses the event and logs it; the next request still records", async () => {
    sent.length = 0;
    const errors = mock.method(console, "error", () => {});
    const middleware = agentTraffic({ key: "k", projectId: "p", salt: "s", accountIdOf: (req) => req.user.id });
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
    const middleware = agentTraffic({ key: "k", projectId: "p" });
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

  test("accountIdOf gets res too, for auth that sets res.locals", async () => {
    sent.length = 0;
    const middleware = agentTraffic({ key: "k", projectId: "p", salt: "s", accountIdOf: (req, res) => res.locals?.user?.id });
    const req = fakeRequest({ route: "/a" });
    const res = new EventEmitter();
    middleware(req, res, () => {});
    res.locals = { user: { id: "u_1" } };
    res.statusCode = 200;
    res.emit("finish");
    mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent[0].batch[0].account_id, createHmac("sha256", "s").update("u_1").digest("hex"));
  });

  test("errorOf adds the error text to failed responses only, capped at 200 characters", async () => {
    sent.length = 0;
    const middleware = agentTraffic({ key: "k", projectId: "p", errorOf: (req, res) => res.locals?.error });
    const fail = (status, error) => {
      const res = new EventEmitter();
      middleware(fakeRequest({ method: "POST", route: "/v1/charge" }), res, () => {});
      res.locals = { error };
      res.statusCode = status;
      res.emit("finish");
    };
    fail(402, "quota_exceeded");
    fail(402, "payment_required");
    fail(200, "ignored on success");
    fail(500, "x".repeat(500));
    fail(404, undefined);
    mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent[0].batch.map((e) => e.properties.error), ["quota_exceeded", "payment_required", undefined, "x".repeat(200), undefined]);
  });

  test("on Vercel each event is sent at once and handed to waitUntil", async () => {
    sent.length = 0;
    const waited = [];
    const symbol = Symbol.for("@vercel/request-context");
    globalThis[symbol] = { get: () => ({ waitUntil: (p) => waited.push(p) }) };
    try {
      const middleware = agentTraffic({ key: "k", projectId: "p" });
      request(middleware, fakeRequest({ route: "/a" }), 200);
      assert.equal(waited.length, 1);
      await waited[0];
      assert.equal(sent.length, 1);
      assert.equal(sent[0].batch.length, 1);
    } finally {
      delete globalThis[symbol];
    }
  });

  test("25 events go out at once without waiting for the timer", async () => {
    sent.length = 0;
    const middleware = agentTraffic({ key: "k", projectId: "p" });
    for (let i = 0; i < 25; i += 1) request(middleware, fakeRequest({ route: "/a" }), 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].batch.length, 25);
  });
});

describe("agent-traffic.cjs as a file in a project", () => {
  const SOURCE = new URL("../skills/agent-traffic/agent-traffic.cjs", import.meta.url).pathname;
  const dirs = [];
  after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const project = (files) => {
    const dir = mkdtempSync(join(tmpdir(), "agent-traffic-mw-"));
    dirs.push(dir);
    copyFileSync(SOURCE, join(dir, "agent-traffic.cjs"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  };
  const node = (dir, file, env = {}) => run(process.execPath, [file], { cwd: dir, env: { PATH: process.env.PATH, ...env } });

  test("reads AGENT_TRAFFIC_ lines from .env, leaves the rest of .env alone, and works with require and import", async () => {
    const env = "DATABASE_URL=postgres://x\nAGENT_TRAFFIC_KEY=ark_k\nAGENT_TRAFFIC_PROJECT_ID=p-9\nAGENT_TRAFFIC_ACCOUNT_SALT=s\n";
    const probe = (load) => `${load}\nconst mw = agentTraffic({ accountIdOf: () => "a" });\nconsole.log(typeof mw, process.env.DATABASE_URL === undefined, process.env.AGENT_TRAFFIC_KEY === undefined);`;
    const dir = project({
      ".env": env,
      "cjs.cjs": probe('const { agentTraffic } = require("./agent-traffic.cjs");'),
      "esm.mjs": probe('import { agentTraffic } from "./agent-traffic.cjs";'),
    });
    assert.equal((await node(dir, "cjs.cjs")).stdout, "function true true\n");
    assert.equal((await node(dir, "esm.mjs")).stdout, "function true true\n");
  });

  test("finds .env above its own folder when the server starts elsewhere (monorepo root vs app folder)", async () => {
    const dir = project({});
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "apps/api/src"), { recursive: true });
    copyFileSync(join(dir, "agent-traffic.cjs"), join(dir, "apps/api/src/agent-traffic.cjs"));
    writeFileSync(join(dir, ".env"), "AGENT_TRAFFIC_KEY=ark_root\nAGENT_TRAFFIC_PROJECT_ID=p\n");
    writeFileSync(join(dir, "apps/api/src/probe.cjs"), 'const { agentTraffic } = require("./agent-traffic.cjs"); console.log(typeof agentTraffic());');
    const other = project({});
    assert.equal((await node(other, join(dir, "apps/api/src/probe.cjs"))).stdout, "function\n");
  });

  test("the environment wins over .env; with neither, it says what is missing", async () => {
    const dir = project({ ".env": "AGENT_TRAFFIC_KEY=from_file\n", "probe.cjs": 'const { agentTraffic } = require("./agent-traffic.cjs"); agentTraffic();' });
    await node(dir, "probe.cjs", { AGENT_TRAFFIC_KEY: "from_env", AGENT_TRAFFIC_PROJECT_ID: "p" });
    const err = await node(dir, "probe.cjs").catch((e) => e);
    assert.match(err.stderr, /needs AGENT_TRAFFIC_KEY and AGENT_TRAFFIC_PROJECT_ID, in the environment or in \.env/);
  });
});

describe("rejection logging", () => {
  test("rejections are coalesced per reason per batch; unknown_field names the field and the fix", async () => {
    const errors = [];
    const originalError = console.error;
    const originalFetch = globalThis.fetch;
    console.error = (line) => errors.push(line);
    globalThis.fetch = async () => ({ status: 202, json: async () => ({ accepted: 0, rejected: [
      { idempotency_key: "a", reason: "unknown_field", field: "outcome" }, { idempotency_key: "b", reason: "unknown_field", field: "outcome" },
      { idempotency_key: "c", reason: "duplicate" }, { idempotency_key: "d", reason: "invalid_name" },
    ] }) });
    try {
      const traffic = agentTraffic({ key: "ark_test", projectId: "p-1", salt: "s" });
      await traffic.recordOutcome({ accountId: "a", name: "signup", idempotencyKey: "k1" });
      assert.equal(errors.length, 2);
      assert.match(errors[0], /^agent-traffic: 2 of 1 events rejected: unknown_field \(outcome\)\. The agent traffic host does not know this field yet/);
      assert.match(errors[1], /^agent-traffic: 1 of 1 events rejected: invalid_name$/);
    } finally {
      console.error = originalError;
      globalThis.fetch = originalFetch;
    }
  });
});

describe("rotation warnings", () => {
  test("a 202 with warnings is logged once per process, not once per batch", async () => {
    const errors = [];
    const originalError = console.error;
    const originalFetch = globalThis.fetch;
    console.error = (line) => errors.push(line);
    globalThis.fetch = async () => ({ status: 202, json: async () => ({ accepted: 1, rejected: [], warnings: ["This key was rotated on X and stops working on Y. Set AGENT_TRAFFIC_KEY to the key that rotation returned and restart your server."] }) });
    try {
      const traffic = agentTraffic({ key: "ark_test", projectId: "p-1", salt: "s" });
      await traffic.recordOutcome({ accountId: "a", name: "signup", idempotencyKey: "k1" });
      await traffic.recordOutcome({ accountId: "a", name: "signup", idempotencyKey: "k2" });
      assert.equal(errors.filter((line) => /was rotated on X/.test(line)).length, 1);
    } finally {
      console.error = originalError;
      globalThis.fetch = originalFetch;
    }
  });
});

describe("recordOutcome", () => {
  const sent = [];
  const withFetch = async (fn) => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => { sent.push({ url, batch: JSON.parse(init.body) }); return { status: 202, json: async () => ({ accepted: 1, rejected: [] }) }; };
    try { return await fn(); } finally { globalThis.fetch = original; }
  };

  test("hangs off the middleware, hashes accountId with the middleware's salt, and sends one event with an outcome block at once", async () => {
    sent.length = 0;
    const traffic = agentTraffic({ key: "ark_test", projectId: "p-1", salt: "s", accountIdOf: (req) => req.user?.id });
    assert.equal(typeof traffic, "function");
    await withFetch(() => traffic.recordOutcome({ accountId: "acct_1", name: "paid", value: 1999, currency: "USD", idempotencyKey: "evt_1", occurredAt: "2026-10-18T05:00:00Z" }));
    assert.equal(sent.length, 1);
    const [event] = sent[0].batch;
    assert.deepEqual(event, {
      idempotency_key: "evt_1", name: "paid", occurred_at: "2026-10-18T05:00:00.000Z", source: "sdk",
      account_id: createHmac("sha256", "s").update("acct_1").digest("hex"),
      outcome: { name: "paid", value: 1999, currency: "USD" }, properties: {},
    });
    await withFetch(() => traffic.recordOutcome({ accountId: 42, name: "signup", idempotencyKey: "acct_42" }));
    assert.deepEqual(sent[1].batch[0].outcome, { name: "signup" });
    assert.equal("value" in sent[1].batch[0].outcome, false);
  });

  test("bad input throws synchronously with the field named, before anything is sent", () => {
    const traffic = agentTraffic({ key: "ark_test", projectId: "p-1", salt: "s" });
    const cases = [
      [{ name: "paid", value: 1, currency: "USD", idempotencyKey: "k" }, /accountId is required/],
      [{ accountId: "a", name: "purchase", idempotencyKey: "k" }, /name must be one of signup, key_created/],
      [{ accountId: "a", name: "signup" }, /idempotencyKey is required/],
      [{ accountId: "a", name: "paid", value: "19.99", currency: "USD", idempotencyKey: "k" }, /value must be a whole number of minor units \(1999 for \$19\.99\), 0 or more, got string "19\.99"/],
      [{ accountId: "a", name: "paid", value: 19.99, currency: "USD", idempotencyKey: "k" }, /value must be a whole number/],
      [{ accountId: "a", name: "paid", value: 1999, currency: "usd", idempotencyKey: "k" }, /currency must be an ISO 4217 code/],
      [{ accountId: "a", name: "paid", idempotencyKey: "k" }, /paid outcome needs value/],
      [{ accountId: "a", name: "custom", value: 5, idempotencyKey: "k" }, /currency must be an ISO 4217 code/],
      [{ accountId: "a", name: "signup", idempotencyKey: "k", occurredAt: "yesterday" }, /occurredAt is not a date/],
    ];
    for (const [input, message] of cases) assert.throws(() => traffic.recordOutcome(input), message, JSON.stringify(input));
    assert.throws(() => agentTraffic({ key: "ark_test", projectId: "p-1" }).recordOutcome({ accountId: "a", name: "signup", idempotencyKey: "k" }), /needs AGENT_TRAFFIC_ACCOUNT_SALT/);
  });
});

describe("journey keys", () => {
  const KEY_A = "journey_header_aaaa";
  const KEY_B = "journey_query_bbbb";
  const KEY_C = "journey_cookie_cccc";
  const sent = [];
  let original;
  before(() => {
    original = globalThis.fetch;
    globalThis.fetch = async (url, init) => { sent.push(...JSON.parse(init.body)); return { status: 202, json: async () => ({ accepted: 1, rejected: [] }) }; };
  });
  after(() => { globalThis.fetch = original; });

  function fakeResponse() {
    const headers = {};
    const res = new EventEmitter();
    res.setHeader = (name, value) => { headers[name.toLowerCase()] = value; };
    res.getHeader = (name) => headers[name.toLowerCase()];
    res.headers = headers;
    return res;
  }

  // One request through the middleware; resolves with the event it sent and the response headers it set.
  async function send(options, { headers = {}, url = "/v1/docs", res = fakeResponse() } = {}) {
    sent.length = 0;
    const symbol = Symbol.for("@vercel/request-context");
    const waited = [];
    globalThis[symbol] = { get: () => ({ waitUntil: (p) => waited.push(p) }) };
    try {
      const middleware = agentTraffic({ key: "k", projectId: "p", ...options });
      middleware({ method: "GET", baseUrl: "", route: { path: "/v1/docs" }, headers, url, originalUrl: url }, res, () => {});
      res.statusCode = 200;
      res.emit("finish");
      await Promise.all(waited);
    } finally {
      delete globalThis[symbol];
    }
    return { event: sent[0], headers: res.headers };
  }

  const headerName = JOURNEY_HEADER.toLowerCase();

  test("the journey header is the one exported constant", () => {
    assert.equal(JOURNEY_HEADER, "Track-Journey");
  });

  test("header, query and cookie are each picked up with their journey_source", async () => {
    assert.deepEqual(pick((await send({}, { headers: { [headerName]: KEY_A } })).event), { journey_id: KEY_A, journey_source: "header" });
    assert.deepEqual(pick((await send({}, { url: `/v1/docs?x=1&track_j=${KEY_B}` })).event), { journey_id: KEY_B, journey_source: "query" });
    assert.deepEqual(pick((await send({}, { headers: { cookie: `theme=dark; track_j=${KEY_C}; other=1` } })).event), { journey_id: KEY_C, journey_source: "cookie" });
  });

  test("header beats query beats cookie", async () => {
    const all = { headers: { [headerName]: KEY_A, cookie: `track_j=${KEY_C}` }, url: `/v1/docs?track_j=${KEY_B}` };
    assert.deepEqual(pick((await send({}, all)).event), { journey_id: KEY_A, journey_source: "header" });
    assert.deepEqual(pick((await send({}, { ...all, headers: { cookie: `track_j=${KEY_C}` } })).event), { journey_id: KEY_B, journey_source: "query" });
  });

  test("an invalid value is ignored and never sent; the next valid source wins", async () => {
    for (const bad of ["short", "has space here", "x".repeat(129), "semi;colon_value", "quote\"d_value"]) {
      const { event } = await send({}, { headers: { [headerName]: bad, cookie: `track_j=${encodeURIComponent(bad)}` }, url: `/v1/docs?track_j=${encodeURIComponent(bad)}` });
      assert.equal("journey_id" in event, false, bad);
      assert.equal("journey_source" in event, false, bad);
    }
    const { event } = await send({}, { headers: { [headerName]: "bad key!", cookie: `track_j=${KEY_C}` }, url: "/v1/docs?track_j=no" });
    assert.deepEqual(pick(event), { journey_id: KEY_C, journey_source: "cookie" });
  });

  test("nothing is sent when no key is present, and session_hint is never set", async () => {
    const { event } = await send({});
    assert.equal("journey_id" in event, false);
    assert.equal("journey_source" in event, false);
    assert.equal("session_hint" in event, false);
    assert.equal("session_hint" in (await send({}, { headers: { [headerName]: KEY_A } })).event, false);
  });

  test("issueJourneyKeys is off by default: no header, no cookie, no Cache-Control", async () => {
    const { headers } = await send({}, { headers: { [headerName]: KEY_A } });
    assert.deepEqual(headers, {});
    assert.deepEqual((await send({})).headers, {});
  });

  test("issueJourneyKeys mints a valid key when none was sent, on the header, the cookie and with Cache-Control: private", async () => {
    const { headers, event } = await send({ issueJourneyKeys: true });
    const minted = headers[headerName];
    assert.match(minted, /^j_[0-9a-f]{32}$/);
    assert.match(minted, /^[A-Za-z0-9_-]{8,128}$/);
    assert.equal(headers["set-cookie"], `track_j=${minted}; Path=/; Max-Age=1209600; SameSite=Lax; Secure`);
    assert.equal(headers["cache-control"], "private");
    assert.deepEqual(pick(event), { journey_id: minted, journey_source: "issued" });
    assert.notEqual((await send({ issueJourneyKeys: true })).headers[headerName], minted);
  });

  test("issueJourneyKeys echoes a key the request carried and never mints one then", async () => {
    for (const [request, key] of [[{ headers: { [headerName]: KEY_A } }, KEY_A], [{ url: `/v1/docs?track_j=${KEY_B}` }, KEY_B], [{ headers: { cookie: `track_j=${KEY_C}` } }, KEY_C]]) {
      const { headers, event } = await send({ issueJourneyKeys: true }, request);
      assert.equal(headers[headerName], key);
      assert.equal(headers["set-cookie"], `track_j=${key}; Path=/; Max-Age=1209600; SameSite=Lax; Secure`);
      assert.equal(headers["cache-control"], "private");
      assert.equal(event.journey_id, key);
      assert.notEqual(event.journey_source, "issued");
    }
  });

  test("a Set-Cookie set before the middleware is kept", async () => {
    const res = fakeResponse();
    res.setHeader("Set-Cookie", "sid=1");
    const { headers } = await send({ issueJourneyKeys: true }, { headers: { cookie: `track_j=${KEY_C}` }, res });
    assert.deepEqual(headers["set-cookie"], ["sid=1", `track_j=${KEY_C}; Path=/; Max-Age=1209600; SameSite=Lax; Secure`]);
  });

  test("a journey key in the query never reaches a log", async () => {
    const errors = mock.method(console, "error", () => {});
    try {
      const middleware = agentTraffic({ key: "k", projectId: "p", salt: "s", accountIdOf: (req) => req.user.id });
      const res = fakeResponse();
      const url = `/v1/docs?track_j=${KEY_B}`;
      middleware({ method: "GET", baseUrl: "", route: { path: "/v1/docs" }, headers: { [headerName]: KEY_A }, url, originalUrl: url }, res, () => {});
      res.statusCode = 200;
      res.emit("finish");
      assert.equal(errors.mock.calls.length, 1);
      assert.match(errors.mock.calls[0].arguments[0], /event not recorded for GET \/v1\/docs:/);
      assert.doesNotMatch(errors.mock.calls[0].arguments[0], new RegExp(`${KEY_A}|${KEY_B}`));
    } finally {
      errors.mock.restore();
    }
  });

  function pick(event) {
    return { journey_id: event.journey_id, journey_source: event.journey_source };
  }
});

describe("path", () => {
  const SIGNATURE_INPUT = 'sig1=("@method" "@target-uri");created=1;keyid="k";tag="web-bot-auth"';
  const sent = [];
  let original;
  before(() => {
    original = globalThis.fetch;
    globalThis.fetch = async (url, init) => { sent.push(init.body); return { status: 202, json: async () => ({ accepted: 1, rejected: [] }) }; };
  });
  after(() => { globalThis.fetch = original; });

  // One request through the middleware; resolves with the raw JSON body it sent and the parsed event.
  async function send(req, options = {}) {
    sent.length = 0;
    const symbol = Symbol.for("@vercel/request-context");
    const waited = [];
    globalThis[symbol] = { get: () => ({ waitUntil: (p) => waited.push(p) }) };
    try {
      const middleware = agentTraffic({ key: "k", projectId: "p", ...options });
      const res = new EventEmitter();
      middleware({ method: "GET", baseUrl: "", route: { path: "/v1/users" }, headers: {}, ...req }, res, () => {});
      res.statusCode = 200;
      res.emit("finish");
      await Promise.all(waited);
    } finally {
      delete globalThis[symbol];
    }
    return { body: sent[0], event: JSON.parse(sent[0])[0] };
  }

  test("a plain request sends its path, never the domain", async () => {
    const { event } = await send({ originalUrl: "/v1/users", url: "/v1/users", headers: { host: "api.example" } });
    assert.equal(event.path, "/v1/users");
    assert.doesNotMatch(JSON.stringify(event), /api\.example/);
  });

  test("query and fragment are stripped: an api_key or track_j value is not in the event", async () => {
    const url = "/v1/users?api_key=SECRET123&track_j=journeyvalue99#frag";
    const { event, body } = await send({ originalUrl: url, url });
    assert.equal(event.path, "/v1/users");
    assert.doesNotMatch(body, /SECRET123|api_key|journeyvalue99|track_j|frag/);
    assert.equal((await send({ originalUrl: "/docs#section?x=1", url: "/docs" })).event.path, "/docs");
  });

  test("a journey key read from the query reaches journey_id, never path", async () => {
    const url = "/v1/users?track_j=journeyvalue99";
    const { event } = await send({ originalUrl: url, url });
    assert.equal(event.path, "/v1/users");
    assert.equal(event.journey_id, "journeyvalue99");
  });

  test("a signed request keeps the full URL in the signature material only", async () => {
    const url = "/v1/users?api_key=SECRET123";
    const { event } = await send({ originalUrl: url, url, protocol: "https", headers: { host: "api.example", signature: "sig1=:AAAA:", "signature-input": SIGNATURE_INPUT } });
    assert.equal(event.path, "/v1/users");
    assert.equal(event.url, "https://api.example/v1/users?api_key=SECRET123");
    const { url: signedUrl, ...rest } = event;
    assert.doesNotMatch(JSON.stringify(rest), /SECRET123/);
  });

  test("the router mount prefix is included and the path is not percent-decoded", async () => {
    const url = "/customers/cus_1/orders/a%20b?x=1";
    const { event } = await send({ baseUrl: "/customers/cus_1", route: { path: "/orders/:id" }, originalUrl: url, url: "/orders/a%20b?x=1" });
    assert.equal(event.path, "/customers/cus_1/orders/a%20b");
    assert.equal(event.name, "orders_id");
  });

  test("a missing or odd path is left out", async () => {
    for (const req of [{ originalUrl: undefined, url: undefined }, { originalUrl: "", url: "" }, { originalUrl: "?x=1", url: "?x=1" }, { originalUrl: "http://api.example/v1/users", url: "http://api.example/v1/users" }, { originalUrl: 42, url: 42 }]) {
      const { event } = await send(req);
      assert.equal("path" in event, false, JSON.stringify(req));
    }
  });

  test("a path longer than 2048 characters is left out, not cut; 2048 exactly is sent", async () => {
    const exact = `/${"a".repeat(2047)}`;
    assert.equal((await send({ originalUrl: exact, url: exact })).event.path, exact);
    const long = `/${"a".repeat(2048)}`;
    assert.equal("path" in (await send({ originalUrl: `${long}?q=1`, url: long })).event, false);
  });

  test("the log line for a lost event has the path, never the query", async () => {
    const errors = mock.method(console, "error", () => {});
    try {
      const url = "/v1/users?api_key=SECRET123#frag";
      const middleware = agentTraffic({ key: "k", projectId: "p", salt: "s", accountIdOf: (req) => req.user.id });
      const res = new EventEmitter();
      middleware({ method: "GET", baseUrl: "", route: { path: "/v1/users" }, headers: {}, originalUrl: url, url }, res, () => {});
      res.statusCode = 200;
      res.emit("finish");
      assert.match(errors.mock.calls[0].arguments[0], /event not recorded for GET \/v1\/users:/);
      assert.doesNotMatch(errors.mock.calls[0].arguments[0], /SECRET123|api_key|frag/);
    } finally {
      errors.mock.restore();
    }
  });
});
