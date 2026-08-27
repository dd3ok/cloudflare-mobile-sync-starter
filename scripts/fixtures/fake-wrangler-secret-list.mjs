const expectedArguments = ["secret", "list", "--config"];
if (process.env.FAKE_WRANGLER_FAIL === "1") {
  console.error("fixture-error-that-must-not-be-forwarded");
  process.exitCode = 1;
} else if (!expectedArguments.every((argument, index) => process.argv[index + 2] === argument)) {
  process.exitCode = 2;
} else if (process.argv.at(-2) !== "--format" || process.argv.at(-1) !== "json") {
  process.exitCode = 2;
} else {
  const names = ["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS"];
  console.log(
    JSON.stringify(
      names.map((name) => ({
        name,
        type: "secret_text",
        unexpectedValue: "fixture-field-that-must-not-be-forwarded",
      })),
    ),
  );
}
