import { betterAuth } from "better-auth";
import { commaSeparated, type Env } from "./env";

interface VersionedSecret {
  version: number;
  value: string;
}

const placeholderSecretPattern = /(replace[-_ ]?with|placeholder|change[-_ ]?me)/iu;

function validateSecret(name: string, value: string): void {
  if (placeholderSecretPattern.test(value)) {
    throw new Error(`${name} must not use an example placeholder`);
  }
  if (new TextEncoder().encode(value).byteLength < 32) {
    throw new Error(`${name} must contain 32+ bytes`);
  }
}

export function parseVersionedSecrets(value: string | undefined): VersionedSecret[] {
  if (!value?.trim()) return [];
  const secrets = value.split(",").map((entry) => {
    const normalized = entry.trim();
    const separator = normalized.indexOf(":");
    const versionText = normalized.slice(0, separator);
    const version = Number(versionText);
    const secret = normalized.slice(separator + 1).trim();
    if (
      separator < 1 ||
      !/^(0|[1-9][0-9]*)$/u.test(versionText) ||
      !Number.isSafeInteger(version) ||
      !secret
    ) {
      throw new Error("BETTER_AUTH_SECRETS must use version:secret entries with 32+ byte secrets");
    }
    validateSecret("BETTER_AUTH_SECRETS", secret);
    return { version, value: secret };
  });
  if (new Set(secrets.map((secret) => secret.version)).size !== secrets.length) {
    throw new Error("BETTER_AUTH_SECRETS versions must be unique");
  }
  return secrets;
}

export function validateAuthSecrets(
  env: Pick<Env, "BETTER_AUTH_SECRET" | "BETTER_AUTH_SECRETS">,
): VersionedSecret[] {
  validateSecret("BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET);
  return parseVersionedSecrets(env.BETTER_AUTH_SECRETS);
}

export function validateTrustedOrigins(env: Pick<Env, "TRUSTED_ORIGINS">): string[] {
  const origins = commaSeparated(env.TRUSTED_ORIGINS);
  if (origins.length === 0) throw new Error("TRUSTED_ORIGINS must not be empty");

  for (const origin of origins) {
    if (origin.includes("*")) throw new Error("TRUSTED_ORIGINS must use exact origins");
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`Invalid trusted origin: ${origin}`);
    }
    const scheme = url.protocol.slice(0, -1);
    if (url.protocol === "https:" || url.protocol === "http:") {
      if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error(
          `Trusted web origin must not include credentials, a path, or a query: ${origin}`,
        );
      }
      continue;
    }
    if (
      !/^[a-z][a-z0-9+.-]*$/u.test(scheme) ||
      url.host ||
      url.pathname ||
      url.search ||
      url.hash
    ) {
      throw new Error(`Invalid mobile trusted origin: ${origin}`);
    }
    if (!scheme.includes(".")) {
      throw new Error("Mobile trusted origins must use a reverse-domain scheme");
    }
  }
  return origins;
}

export function createAuth(env: Env) {
  const secrets = validateAuthSecrets(env);

  return betterAuth({
    appName: "Cloudflare Mobile Sync",
    basePath: "/v1/auth",
    baseURL: env.BETTER_AUTH_URL,
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    ...(secrets.length > 0 ? { secrets } : {}),
    trustedOrigins: validateTrustedOrigins(env),
    socialProviders: {
      google: {
        clientId: env.GOOGLE_WEB_CLIENT_ID,
      },
    },
    account: {
      encryptOAuthTokens: true,
      storeAccountCookie: false,
      updateAccountOnSignIn: false,
      accountLinking: {
        enabled: false,
      },
    },
    session: {
      cookieCache: { enabled: false },
      expiresIn: 60 * 60 * 24 * 7,
      freshAge: 60 * 60 * 24,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
    user: {
      deleteUser: { enabled: false },
    },
    verification: {
      storeIdentifier: "hashed",
    },
    rateLimit: {
      enabled: true,
      max: 60,
      storage: "memory",
      window: 60,
      customRules: {
        "/sign-in/*": { max: 10, window: 60 },
        "/callback/*": { max: 20, window: 60 },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
