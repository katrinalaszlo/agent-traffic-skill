import { describe, test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { eventName, agentTraffic } from "../skills/agent-traffic/agent-traffic.cjs";

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
