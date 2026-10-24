import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { advertisesIpHash, checkLiveHost, LIVE_ORIGIN } from "../scripts/check-live-host.mjs";

// The shape Track's /openapi.json gives POST /v1/events (src/openapi.js and EVENT_SCHEMA in the track repo).
const event = (properties) => ({ type: "object", required: ["idempotency_key", "name", "occurred_at", "source"], properties });
const docWith = (properties) => ({
  openapi: "3.1.0",
  paths: { "/v1/events": { post: { requestBody: { content: { "application/json": { schema: { oneOf: [event(properties), { type: "array", items: event(properties) }] } } } } } } },
});
const NEW_HOST = docWith({ name: {}, user_agent: {}, ip_hash: { type: "string", pattern: "^[0-9a-f]{64}$" } });
const OLD_HOST = docWith({ name: {}, user_agent: {} });

function run({ env = {}, answer }) {
  const out = [];
  const err = [];
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    return answer();
  };
  return checkLiveHost({ env, fetch, log: (line) => out.push(line), warn: (line) => err.push(line) }).then((code) => ({ code, out, err, urls }));
}

describe("prepublish live host check", () => {
  test("passes when the live /openapi.json lists ip_hash in the events body", async () => {
    const result = await run({ answer: () => ({ status: 200, json: async () => NEW_HOST }) });
    assert.equal(result.code, 0);
    assert.deepEqual(result.urls, [`${LIVE_ORIGIN}/openapi.json`]);
    assert.match(result.out[0], /accepts ip_hash/);
  });

  test("refuses when the host does not list ip_hash, naming what to do", async () => {
    const result = await run({ answer: () => ({ status: 200, json: async () => OLD_HOST }) });
    assert.equal(result.code, 1);
    assert.match(result.err[0], /^Refusing to publish: .* does not list ip_hash/);
    assert.match(result.err[0], /TRACK_SKIP_LIVE_CHECK=1/);
  });

  test("refuses when the host cannot be read: a network error, a non-200, a body that is not JSON", async () => {
    for (const answer of [
      () => { throw new Error("getaddrinfo ENOTFOUND"); },
      () => ({ status: 503, json: async () => ({}) }),
      () => ({ status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
    ]) {
      const result = await run({ answer });
      assert.equal(result.code, 1);
      assert.match(result.err[0], /^Refusing to publish: could not read/);
    }
  });

  test("TRACK_SKIP_LIVE_CHECK=1 skips the call with a loud warning; any other value does not", async () => {
    const skipped = await run({ env: { TRACK_SKIP_LIVE_CHECK: "1" }, answer: () => assert.fail("no call when skipped") });
    assert.equal(skipped.code, 0);
    assert.deepEqual(skipped.urls, []);
    assert.ok(skipped.err.some((line) => line.startsWith("WARNING: TRACK_SKIP_LIVE_CHECK=1")));
    const notSkipped = await run({ env: { TRACK_SKIP_LIVE_CHECK: "true" }, answer: () => ({ status: 200, json: async () => OLD_HOST }) });
    assert.equal(notSkipped.code, 1);
  });

  test("advertisesIpHash reads the schema itself, oneOf and anyOf members, and array items", () => {
    assert.equal(advertisesIpHash(NEW_HOST), true);
    assert.equal(advertisesIpHash(OLD_HOST), false);
    assert.equal(advertisesIpHash({}), false);
    const direct = { paths: { "/v1/events": { post: { requestBody: { content: { "application/json": { schema: event({ ip_hash: {} }) } } } } } } };
    assert.equal(advertisesIpHash(direct), true);
  });
});
