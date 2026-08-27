import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { historySecretGrepPattern, matchingSecretPatterns } from "./secret-patterns.mjs";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split(/\r?\n/u)
  .filter(Boolean)
  .filter((file) => file !== "pnpm-lock.yaml");

const findings = [];
for (const file of files) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  const patterns = matchingSecretPatterns(file, content);
  if (patterns.length > 0) {
    findings.push(`${file} (${patterns.join(", ")})`);
  }
}

const historyFindings = new Set();
const commits = execFileSync("git", ["rev-list", "HEAD"], { encoding: "utf8" })
  .split(/\r?\n/u)
  .filter(Boolean);
for (const commit of commits) {
  const result = spawnSync(
    "git",
    [
      "grep",
      "-I",
      "-l",
      "-E",
      "-e",
      historySecretGrepPattern,
      commit,
      "--",
      ".",
      ":(exclude)pnpm-lock.yaml",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status === 0) {
    for (const match of result.stdout.split(/\r?\n/u).filter(Boolean)) {
      const prefix = `${commit}:`;
      const path = match.startsWith(prefix) ? match.slice(prefix.length) : match;
      const blob = spawnSync("git", ["show", `${commit}:${path}`], {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (blob.status !== 0) {
        console.error("Unable to inspect a candidate Git history blob.");
        process.exit(1);
      }
      const patterns = matchingSecretPatterns(path, blob.stdout);
      if (patterns.length > 0) {
        historyFindings.add(`${commit}:${path} (${patterns.join(", ")})`);
      }
    }
  } else if (result.status !== 1) {
    console.error("Unable to scan Git history for secret patterns.");
    process.exit(1);
  }
}

if (findings.length > 0 || historyFindings.size > 0) {
  console.error("Potential secret patterns found. Values are intentionally not printed:");
  for (const file of findings) console.error(`- current: ${file}`);
  for (const match of historyFindings) console.error(`- history: ${match}`);
  process.exitCode = 1;
} else {
  console.log(
    `Secret pattern check passed (${files.length} current files and ${commits.length} commits scanned).`,
  );
}
