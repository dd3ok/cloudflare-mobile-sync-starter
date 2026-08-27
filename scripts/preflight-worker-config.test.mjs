import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preflightScript = resolve(repositoryRoot, "scripts/preflight-worker-config.mjs");
const fakeWranglerScript = resolve(
  repositoryRoot,
  "scripts/fixtures/fake-wrangler-secret-list.mjs",
);
const primaryConfig = resolve(repositoryRoot, "apps/worker/wrangler.jsonc");

function runPreflight(environment, config = primaryConfig, requirements) {
  const arguments_ = [preflightScript, "--config", config, "--secrets-source", "environment"];
  if (requirements) arguments_.push("--requirements", requirements);
  return spawnSync(process.execPath, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

const availableSecrets = {
  BETTER_AUTH_SECRET: "unit-test-only-placeholder-primary-secret",
  BETTER_AUTH_SECRETS: "1:unit-test-only-placeholder-keyring-secret",
};

async function withConfigFixture(name, mutate, assertion) {
  const fixturePath = resolve(
    repositoryRoot,
    `apps/worker/.preflight-${name}-${process.pid}.jsonc`,
  );
  const config = JSON.parse(await readFile(primaryConfig, "utf8"));
  mutate(config, fixturePath);
  await writeFile(fixturePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  try {
    await assertion(fixturePath);
  } finally {
    await rm(fixturePath, { force: true });
  }
}

test("preflight requires only server session secrets without printing values", () => {
  const result = runPreflight(availableSecrets);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /2 required secret names are available/u);
  for (const value of Object.values(availableSecrets)) {
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(value, "u"));
  }
});

test("public config exposes native identity metadata but no provider secret", async () => {
  const config = JSON.parse(await readFile(primaryConfig, "utf8"));
  assert.match(
    config.vars.GOOGLE_WEB_CLIENT_ID,
    /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u,
  );
  assert.match(config.vars.NATIVE_APPLICATION_ID, /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u);
  assert.equal(Object.hasOwn(config.vars, "GOOGLE_CLIENT_SECRET"), false);
  assert.deepEqual(config.triggers?.crons, ["* * * * *"]);
  assert.equal(Object.hasOwn(config, "secrets"), false);
});

test("preflight reports only the missing secret names", () => {
  const result = runPreflight({ ...availableSecrets, BETTER_AUTH_SECRETS: "" });
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "Preflight failed: Missing required secret names: BETTER_AUTH_SECRETS\n",
  );
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /primary-secret-value/u);
});

test("environment preflight rejects example placeholders without printing values", () => {
  const placeholders = {
    BETTER_AUTH_SECRET: "replace-with-32-or-more-random-bytes",
    BETTER_AUTH_SECRETS: "1:replace-with-the-same-random-secret",
  };
  const result = runPreflight(placeholders);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /placeholder values: BETTER_AUTH_SECRET/u);
  for (const value of Object.values(placeholders)) {
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(value, "u"));
  }
});

test("preflight rejects an unresolved Wrangler schema path", async () => {
  await withConfigFixture(
    "invalid-schema",
    (config) => {
      config.$schema = "./node_modules/wrangler/schema-that-does-not-exist.json";
    },
    (fixturePath) => {
      const result = runPreflight(availableSecrets, fixturePath);
      assert.equal(result.status, 1);
      assert.equal(result.stderr, "Preflight failed: Wrangler $schema path does not exist\n");
    },
  );
});

test("preflight rejects a schema path outside the installed Wrangler package", async () => {
  let schemaPath;
  await withConfigFixture(
    "wrong-schema",
    (config, fixturePath) => {
      schemaPath = `${fixturePath}.schema.json`;
      config.$schema = `./${schemaPath.split(/[\\/]/u).at(-1)}`;
    },
    async (fixturePath) => {
      await writeFile(schemaPath, '{ "type": "object" }\n', "utf8");
      try {
        const result = runPreflight(availableSecrets, fixturePath);
        assert.equal(result.status, 1);
        assert.equal(
          result.stderr,
          "Preflight failed: Wrangler $schema must reference the installed Wrangler schema\n",
        );
      } finally {
        await rm(schemaPath, { force: true });
      }
    },
  );
});

test("preflight rejects an unsupported Wrangler field", async () => {
  await withConfigFixture(
    "invalid-config",
    (config) => {
      config.unsupported_preflight_test_field = true;
    },
    (fixturePath) => {
      const result = runPreflight(availableSecrets, fixturePath);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must NOT have additional properties/u);
    },
  );
});

test("preflight requires scheduled security-data cleanup", async () => {
  await withConfigFixture(
    "missing-maintenance",
    (config) => {
      delete config.triggers;
    },
    (fixturePath) => {
      const result = runPreflight(availableSecrets, fixturePath);
      assert.equal(result.status, 1);
      assert.equal(
        result.stderr,
        "Preflight failed: Wrangler config must schedule security-data maintenance once per minute\n",
      );
    },
  );
});

test("preflight rejects secrets declared inside Wrangler config", async () => {
  await withConfigFixture(
    "duplicate-secret-authority",
    (config) => {
      config.secrets = { required: ["BETTER_AUTH_SECRET"] };
    },
    (fixturePath) => {
      const result = runPreflight(availableSecrets, fixturePath);
      assert.equal(result.status, 1);
      assert.equal(
        result.stderr,
        "Preflight failed: Wrangler config must not declare secret requirements; use required-secrets.json\n",
      );
    },
  );
});

test("preflight rejects a requirements manifest with no deployment entry", async () => {
  const requirementsPath = resolve(
    repositoryRoot,
    `apps/worker/.preflight-missing-requirements-${process.pid}.json`,
  );
  await writeFile(requirementsPath, `${JSON.stringify({ deployments: {} }, null, 2)}\n`, "utf8");
  try {
    const result = runPreflight(availableSecrets, primaryConfig, requirementsPath);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "Preflight failed: No secret requirements found for wrangler.jsonc\n",
    );
  } finally {
    await rm(requirementsPath, { force: true });
  }
});

test("remote preflight compares secret names without forwarding values", () => {
  const unexpectedValue = "fixture-field-that-must-not-be-forwarded";
  const result = spawnSync(
    process.execPath,
    [
      preflightScript,
      "--config",
      primaryConfig,
      "--secrets-source",
      "remote",
      "--wrangler-script",
      fakeWranglerScript,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: process.env,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /2 required secret names are available/u);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(unexpectedValue, "u"));
});

test("remote preflight redacts Wrangler failures", () => {
  const unexpectedValue = "fixture-error-that-must-not-be-forwarded";
  const result = spawnSync(
    process.execPath,
    [
      preflightScript,
      "--config",
      primaryConfig,
      "--secrets-source",
      "remote",
      "--wrangler-script",
      fakeWranglerScript,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, FAKE_WRANGLER_FAIL: "1" },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "Preflight failed: Unable to list remote secret names with Wrangler\n",
  );
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(unexpectedValue, "u"));
});
