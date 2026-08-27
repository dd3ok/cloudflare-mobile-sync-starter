import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";

// Schema-only configuration for the Better Auth CLI. Runtime configuration lives
// in src/auth.ts. Keep schema-affecting options synchronized between the two.
export const auth = betterAuth({
  baseURL: "http://localhost:8787",
  database: new DatabaseSync(":memory:"),
  secret: "schema-generation-only-not-used-at-runtime",
  rateLimit: {
    enabled: true,
    storage: "memory",
  },
});
