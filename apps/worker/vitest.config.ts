import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          TEST_REQUEST_MIGRATIONS: await readD1Migrations("./request-migrations"),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
