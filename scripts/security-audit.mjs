import { spawnSync } from "node:child_process";

// No ignored advisories: the previously exempted Metro image parser is patched.
const exceptions = [];

const today = new Date().toISOString().slice(0, 10);
const expired = exceptions.filter(({ expiresOn }) => today >= expiresOn);

if (expired.length > 0) {
  console.error("Dependency-audit exception review is overdue:");
  for (const exception of expired) {
    console.error(`- ${exception.id} (expired ${exception.expiresOn} UTC)`);
  }
  process.exit(1);
}

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) {
  console.error("Run this check through `pnpm security:audit`.");
  process.exit(1);
}

const configuredIgnores = spawnSync(
  process.execPath,
  [pnpmCli, "config", "get", "auditConfig.ignoreGhsas", "--json"],
  {
    encoding: "utf8",
    windowsHide: true,
  },
);

if (configuredIgnores.error || configuredIgnores.status !== 0) {
  console.error("Unable to read pnpm dependency-audit exceptions.");
  process.exit(1);
}

let ignoredAdvisories;
try {
  ignoredAdvisories = JSON.parse(configuredIgnores.stdout);
} catch {
  console.error("pnpm returned invalid dependency-audit exception configuration.");
  process.exit(1);
}

const expectedAdvisories = exceptions.map(({ id }) => id).sort();
if (
  !Array.isArray(ignoredAdvisories) ||
  JSON.stringify([...ignoredAdvisories].sort()) !== JSON.stringify(expectedAdvisories)
) {
  console.error("pnpm must ignore exactly the reviewed dependency advisories:");
  for (const id of expectedAdvisories) console.error(`- ${id}`);
  process.exit(1);
}

for (const exception of exceptions) {
  console.warn(
    `Temporary audit exception: ${exception.id} (${exception.scope}; expires ${exception.expiresOn} UTC)`,
  );
}

const auditArguments = [pnpmCli, "audit", "--audit-level", "high"];
const audit = spawnSync(process.execPath, auditArguments, {
  stdio: "inherit",
  windowsHide: true,
});

if (audit.error) {
  console.error(`Unable to run pnpm audit: ${audit.error.message}`);
  process.exit(1);
}

process.exit(audit.status ?? 1);
