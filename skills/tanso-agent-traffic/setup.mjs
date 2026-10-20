// Sets up Tanso agent traffic in the project in the current directory, in one command:
//
//   node setup.mjs --out src/tanso-traffic.mjs [--label my-api]
//
// 1. Signs up and appends TANSO_KEY, TANSO_PROJECT_ID and TANSO_ACCOUNT_SALT to .env, unless .env already has a
//    TANSO_KEY. The key is never printed.
// 2. Adds .env to .gitignore (creating it if there is none).
// 3. Writes the middleware to --out: as an ES module, or converted to CommonJS when package.json is not "type": "module"
//    or --out ends in .cjs.
// 4. Prints the lines to add to the app, with the right import or require.
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, relative, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

const ENDPOINT = process.env.TANSO_ENDPOINT ?? "https://traffic.katrinalaszlo.com";
const { values } = parseArgs({ options: { out: { type: "string" }, label: { type: "string" } } });
if (!values.out) {
  console.error("Usage: node setup.mjs --out <path for the middleware, next to the file that creates the Express app> [--label <name>]");
  process.exit(1);
}

const pkg = existsSync("package.json") ? JSON.parse(readFileSync("package.json", "utf8")) : {};
const label = values.label ?? pkg.name ?? basename(process.cwd());

// 1. Key, project and salt.
const env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
if (/^TANSO_KEY=/m.test(env)) {
  console.log("1. .env already has TANSO_KEY: kept it, no new signup.");
} else {
  const res = await fetch(`${ENDPOINT}/v1/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label, scopes: ["read", "write"] }),
  });
  const body = await res.json();
  if (res.status !== 201) {
    console.error(`Signup failed: ${res.status} ${body.error}: ${body.message}`);
    process.exit(1);
  }
  const lead = env === "" || env.endsWith("\n") ? "" : "\n";
  appendFileSync(".env", `${lead}TANSO_KEY=${body.key}\nTANSO_PROJECT_ID=${body.project_id}\nTANSO_ACCOUNT_SALT=${randomBytes(32).toString("hex")}\n`);
  console.log(`1. Signed up as "${label}": wrote TANSO_KEY, TANSO_PROJECT_ID and TANSO_ACCOUNT_SALT to .env. The key is shown nowhere else and cannot be recovered; copy .env's TANSO_ values into your production secrets.`);
}

// 2. .env out of git.
const ignore = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
if (/^\/?\.env$/m.test(ignore)) {
  console.log("2. .gitignore already ignores .env.");
} else {
  appendFileSync(".gitignore", `${ignore === "" || ignore.endsWith("\n") ? "" : "\n"}.env\n`);
  console.log(`2. Added .env to .gitignore${ignore === "" ? " (created it)" : ""}.`);
}

// 3. The middleware.
const res = await fetch(`${ENDPOINT}/skill/tanso-traffic.mjs`);
if (res.status !== 200) {
  console.error(`Could not download the middleware: ${res.status}`);
  process.exit(1);
}
let source = await res.text();
const commonjs = values.out.endsWith(".cjs") || (!values.out.endsWith(".mjs") && pkg.type !== "module");
if (commonjs) {
  source = source
    .replace('import { createHmac, randomUUID } from "node:crypto";', 'const { createHmac, randomUUID } = require("node:crypto");')
    .replaceAll("export function ", "function ")
    .concat("\nmodule.exports = { eventName, tansoTraffic };\n");
}
mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, source);
console.log(`3. Wrote the middleware to ${values.out}${commonjs ? " (CommonJS)" : ""}.`);

// 4. What to add.
const from = `./${relative(".", values.out).replace(/\\/g, "/")}`;
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const loadsEnv = Boolean(deps.dotenv) || /--env-file/.test(JSON.stringify(pkg.scripts ?? {}));
console.log(`4. Add this to the file that creates the Express app, right after const app = express(), before your auth
   middleware and routes (so requests your auth rejects are recorded too).
   Adjust the path "${from}" to be relative to that file, and make accountIdOf return your customer's id:

   ${commonjs ? `const { tansoTraffic } = require("${from}");` : `import { tansoTraffic } from "${from}";`}
   app.use(tansoTraffic({
     key: process.env.TANSO_KEY,
     projectId: process.env.TANSO_PROJECT_ID,
     salt: process.env.TANSO_ACCOUNT_SALT,
     accountIdOf: (req) => req.user?.id,
   }));
${loadsEnv ? "" : `
   This project does not seem to load .env. Start it with: node --env-file=.env <your entry file>  (Node 20.6+)
`}`);
