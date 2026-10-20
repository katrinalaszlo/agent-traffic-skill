import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const SETUP = new URL("../skills/tanso-agent-traffic/setup.mjs", import.meta.url).pathname;
const MIDDLEWARE = readFileSync(new URL("../skills/tanso-agent-traffic/tanso-traffic.mjs", import.meta.url), "utf8");
const KEY = "ark_ws0123456789abcdef01234567_secretsecret";

describe("setup.mjs", () => {
  let server;
  let base;
  const signups = [];
  const dirs = [];

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/skill/tanso-traffic.mjs") {
        res.writeHead(200, { "content-type": "text/javascript" });
        return res.end(MIDDLEWARE);
      }
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        signups.push(JSON.parse(body));
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ workspace: "ws0123456789abcdef01234567", key: KEY, project_id: "p-1", scopes: ["read", "write"] }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  });

  const project = (files) => {
    const dir = mkdtempSync(join(tmpdir(), "tanso-setup-"));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  };
  const setup = async (dir, args) => {
    const { stdout } = await run(process.execPath, [SETUP, ...args], { cwd: dir, env: { ...process.env, TANSO_ENDPOINT: base } });
    return stdout;
  };

  test("ES module project: signs up with the package name, writes .env and .gitignore, prints the import, never the key", async () => {
    signups.length = 0;
    const dir = project({ "package.json": JSON.stringify({ name: "acme-api", type: "module" }) });
    const out = await setup(dir, ["--out", "src/tanso-traffic.mjs"]);
    assert.deepEqual(signups, [{ label: "acme-api", scopes: ["read", "write"] }]);
    const env = readFileSync(join(dir, ".env"), "utf8");
    assert.match(env, new RegExp(`^TANSO_KEY=${KEY}\nTANSO_PROJECT_ID=p-1\nTANSO_ACCOUNT_SALT=[0-9a-f]{64}\n$`));
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ".env\n");
    assert.equal(readFileSync(join(dir, "src/tanso-traffic.mjs"), "utf8"), MIDDLEWARE);
    assert.match(out, /import \{ tansoTraffic \} from "\.\/src\/tanso-traffic\.mjs";/);
    assert.match(out, /does not seem to load \.env/);
    assert.doesNotMatch(out, /secretsecret/);
  });

  test("CommonJS project with dotenv: writes a working CommonJS file and prints require", async () => {
    const dir = project({ "package.json": JSON.stringify({ name: "legacy", dependencies: { dotenv: "^16" } }), ".gitignore": "node_modules" });
    const out = await setup(dir, ["--out", "lib/tanso-traffic.js"]);
    assert.match(out, /const \{ tansoTraffic \} = require\("\.\/lib\/tanso-traffic\.js"\);/);
    assert.doesNotMatch(out, /does not seem to load/);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "node_modules\n.env\n");
    const mod = createRequire(join(dir, "index.js"))("./lib/tanso-traffic.js");
    assert.equal(mod.eventName({ method: "POST", baseUrl: "", route: { path: "/v1/charge" } }), "charge_post");
    assert.equal(typeof mod.tansoTraffic({ key: "k", projectId: "p" }), "function");
  });

  test("an existing TANSO_KEY is kept: no second signup, .env unchanged", async () => {
    signups.length = 0;
    const env = "DATABASE_URL=x\nTANSO_KEY=ark_existing\nTANSO_PROJECT_ID=p-0\n";
    const dir = project({ "package.json": "{}", ".env": env, ".gitignore": ".env\n" });
    const out = await setup(dir, ["--out", "tanso-traffic.cjs"]);
    assert.equal(signups.length, 0);
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), env);
    assert.match(out, /kept it, no new signup/);
    assert.match(out, /already ignores \.env/);
    assert.ok(existsSync(join(dir, "tanso-traffic.cjs")));
  });

  test("refuses to run without --out", async () => {
    const dir = project({});
    const err = await setup(dir, []).catch((e) => e);
    assert.equal(err.code, 1);
    assert.match(err.stderr, /Usage: node setup\.mjs --out/);
    assert.equal(existsSync(join(dir, ".env")), false);
  });
});
