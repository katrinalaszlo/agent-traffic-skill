// Checks that a Tanso agent traffic install produces data the dashboard can use, not only that events were accepted.
// Source: https://traffic.katrinalaszlo.com/skill/verify.mjs. Node 20.6 or later:
//
//   node --env-file=.env verify.mjs
//
// Reads TANSO_KEY and TANSO_PROJECT_ID from the environment and never prints the key. It builds sessions now
// (POST /api/refresh), reads the last 24 hours (GET /v1/traffic/paths) and exits 1 if a check fails.
const ENDPOINT = process.env.TANSO_ENDPOINT ?? "https://traffic.katrinalaszlo.com";
const key = process.env.TANSO_KEY;
const projectId = process.env.TANSO_PROJECT_ID;
if (!key || !projectId) {
  console.error("FAIL  TANSO_KEY and TANSO_PROJECT_ID must be set (run with node --env-file=.env verify.mjs).");
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (res.status !== 200) {
    console.error(`FAIL  ${method} ${path.split("?")[0]} answered ${res.status} ${json.error}: ${json.message}`);
    process.exit(1);
  }
  return json;
}

await call("POST", "/api/refresh", { project_id: projectId });
const paths = await call("GET", `/v1/traffic/paths?project_id=${encodeURIComponent(projectId)}&days=1`);

const names = new Set([...paths.paths.flatMap((p) => p.steps), ...paths.intents.map((i) => i.intent).filter((i) => i !== "docs only")]);
const statused = paths.terminal_counts.success + paths.terminal_counts.failure;
const checks = [
  {
    ok: paths.events > 0,
    pass: `${paths.events} events in the last 24 hours`,
    fail: "No events in the last 24 hours. Is the middleware registered before your routes, and did the server stay up at least 2 seconds after the test requests?",
  },
  {
    ok: paths.sessions > 0,
    pass: `${paths.sessions} sessions`,
    fail: `${paths.events} events arrived but none is in a session. accountIdOf returned nothing for every request: make it return your customer's account id for authenticated requests, and send the test requests with credentials.`,
  },
  {
    ok: statused > 0,
    pass: `${statused} of ${paths.sessions} sessions ended with a status code`,
    fail: "No session ended with a status code. Send properties.status_code from res.statusCode after the response finished.",
  },
  {
    ok: names.size >= 2,
    pass: `${names.size} distinct event names: ${[...names].slice(0, 8).join(", ")}`,
    fail: `Every session event has the same name (${[...names].join(", ") || "none"}). Name events by route so paths show steps.`,
  },
];
const warnings = [];
if (paths.terminal_counts.unknown > 0) warnings.push(`${paths.terminal_counts.unknown} sessions ended on an event with no status code.`);
if (paths.events > 0 && paths.unattributed_events / paths.events > 0.5) warnings.push(`${paths.unattributed_events} of ${paths.events} events have no account, so they are in no session. Expected for unauthenticated routes (docs, signup); otherwise check accountIdOf.`);

for (const c of checks) console.log(c.ok ? `PASS  ${c.pass}` : `FAIL  ${c.fail}`);
for (const w of warnings) console.log(`WARN  ${w}`);
if (paths.agents.length > 0) console.log(`      Agents seen: ${paths.agents.map((a) => a.agent).join(", ")}`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
