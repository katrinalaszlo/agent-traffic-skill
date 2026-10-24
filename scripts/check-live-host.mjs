// prepublishOnly gate (issue #10): this package sends ip_hash, and a Track host that does not know the field rejects
// those events. The middleware falls back, but a release should never count on that, so publishing is refused until the
// live host advertises ip_hash in the POST /v1/events body of its /openapi.json.
// TRACK_SKIP_LIVE_CHECK=1 skips the check, with a warning, for the rare publish that must not wait for the host.
import { pathToFileURL } from "node:url";

export const LIVE_ORIGIN = "https://alg.katrinalaszlo.com";
const TIMEOUT_MS = 10_000;

// Whether an OpenAPI document's POST /v1/events body lists ip_hash: on the event schema itself, or on a oneOf/anyOf
// member, or on an array's items.
export function advertisesIpHash(doc) {
  const schema = doc?.paths?.["/v1/events"]?.post?.requestBody?.content?.["application/json"]?.schema;
  const has = (s) => Boolean(s && (s.properties?.ip_hash || has(s.items) || [...(s.oneOf ?? []), ...(s.anyOf ?? [])].some(has)));
  return has(schema);
}

// Returns the exit code. log and warn are where its lines go; fetch is injectable for tests.
export async function checkLiveHost({ env = process.env, fetch = globalThis.fetch, log = console.log, warn = console.error } = {}) {
  if (env.TRACK_SKIP_LIVE_CHECK === "1") {
    warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    warn("WARNING: TRACK_SKIP_LIVE_CHECK=1. Publishing WITHOUT checking that the live Track host accepts ip_hash.");
    warn("If it does not, every event from apps with AGENT_TRAFFIC_ACCOUNT_SALT set is refused once and resent without it.");
    warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    return 0;
  }
  const url = `${LIVE_ORIGIN}/openapi.json`;
  let doc;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    doc = await res.json();
  } catch (err) {
    warn(`Refusing to publish: could not read ${url} (${err.message}), so it is not known whether the live Track host accepts ip_hash. Try again, or see issue #10.`);
    return 1;
  }
  if (!advertisesIpHash(doc)) {
    warn(`Refusing to publish: ${url} does not list ip_hash in the POST /v1/events body, so the live Track host would reject the ip_hash this version sends. Deploy the Track host that accepts it first (branch anon-visits), then publish. Override only with TRACK_SKIP_LIVE_CHECK=1.`);
    return 1;
  }
  log(`Live Track host accepts ip_hash (${url}).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await checkLiveHost();
