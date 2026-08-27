import assert from "node:assert/strict";
import test from "node:test";
import { historySecretGrepPattern, matchingSecretPatterns } from "./secret-patterns.mjs";

test("recognizes structured provider and platform credentials", () => {
  const samples = [
    ["Google API key", ["AIza", "A".repeat(32)].join("")],
    ["Google OAuth client secret", ["GOCSPX-", "a".repeat(24)].join("")],
    ["GitHub fine-grained token", ["github_pat_", "a".repeat(50)].join("")],
    ["AWS access key", ["AKIA", "A".repeat(16)].join("")],
    ["Slack token", ["xoxb-", "a".repeat(20)].join("")],
  ];

  for (const [expected, content] of samples) {
    assert.deepEqual(matchingSecretPatterns("src/example.ts", content), [expected]);
  }
});

test("checks named server-secret assignments in configuration and source files", () => {
  const serverSecretName = ["BETTER", "_AUTH_SECRET"].join("");
  const envAssignment = [`${serverSecretName}=`, "a".repeat(32)].join("");
  const sourceAssignment = [`const ${serverSecretName} = "`, "a".repeat(32), `";`].join("");
  const templateAssignment = [`const ${serverSecretName} = `, "`", "b".repeat(32), "`;"].join("");
  const yamlAssignment = [`${serverSecretName}: `, "c".repeat(32)].join("");
  assert.deepEqual(matchingSecretPatterns("apps/worker/.dev.vars", envAssignment), [
    "server secret assignment",
  ]);
  assert.deepEqual(matchingSecretPatterns("apps/worker/src/auth.ts", sourceAssignment), [
    "server secret assignment",
  ]);
  assert.deepEqual(matchingSecretPatterns("apps/worker/src/auth.ts", templateAssignment), [
    "server secret assignment",
  ]);
  assert.deepEqual(matchingSecretPatterns("deploy/config.yaml", yamlAssignment), [
    "server secret assignment",
  ]);
  assert.deepEqual(
    matchingSecretPatterns("apps/worker/.dev.vars", `REQUEST_SUBJECT_HMAC_KEY=${"d".repeat(32)}`),
    ["server secret assignment"],
  );
  assert.deepEqual(
    matchingSecretPatterns(
      "apps/worker/src/config.ts",
      "const env = { GOOGLE_CLIENT_SECRET: googleClientSecret };",
    ),
    [],
  );
  assert.deepEqual(
    matchingSecretPatterns(
      "apps/worker/.dev.vars.example",
      "BETTER_AUTH_SECRET=replace-with-32-or-more-random-bytes",
    ),
    [],
  );
  assert.deepEqual(
    matchingSecretPatterns(
      "apps/worker/.env.production.example",
      "BETTER_AUTH_SECRETS=1:replace-with-the-same-random-secret",
    ),
    [],
  );
  assert.deepEqual(
    matchingSecretPatterns(
      "apps/worker/test/auth.test.ts",
      "GOOGLE_CLIENT_SECRET: 'unit-test-only-placeholder-value'",
    ),
    [],
  );
});

test("checks Cloudflare token assignments without flagging placeholders", () => {
  assert.deepEqual(
    matchingSecretPatterns("scripts/deploy.mjs", `CLOUDFLARE_API_TOKEN = "${"a".repeat(40)}"`),
    ["Cloudflare API token assignment"],
  );
  assert.deepEqual(
    matchingSecretPatterns(".env.example", "CLOUDFLARE_API_TOKEN=replace-with-a-scoped-api-token"),
    [],
  );
});

test("selects named secret assignments for Git history blob inspection", () => {
  const candidate = new RegExp(historySecretGrepPattern, "iu");
  for (const name of [
    "CLOUDFLARE_API_TOKEN",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_SECRETS",
    "GOOGLE_CLIENT_SECRET",
    "REQUEST_PORTAL_TURNSTILE_SECRET_KEY",
    "REQUEST_SUBJECT_HMAC_KEY",
  ]) {
    assert.equal(candidate.test(name), true, name);
  }
});
