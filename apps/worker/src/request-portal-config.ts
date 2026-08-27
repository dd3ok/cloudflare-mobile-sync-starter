import { commaSeparated, type Env } from "./env";

const placeholderPattern =
  /(replace[-_ ]?with|placeholder|change[-_ ]?me|unreleased|\bexample\b)/iu;
const scopePattern = /^[a-z][a-z0-9._-]{0,63}$/u;

export interface RequestPortalConfig {
  origin: string;
  organizationName: string;
  productName: string;
  publicScope: string;
  accountScope: string;
  noticeVersion: string;
  evidencePolicyVersion: string;
  pendingMaxAgeMilliseconds: number;
  identityIssueEnabled: boolean;
  accountDeletionEnabled: boolean;
  requestDbGeneration: string;
  turnstileSiteKey: string;
  turnstileSecretKey: string;
  accessTeamDomain: string;
  accessAudience: string;
  adminEmails: ReadonlySet<string>;
  subjectHmacKey: string;
}

function required(env: Env, name: keyof Env): string {
  const value = env[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${String(name)} is required when the request portal is enabled`);
  }
  return value.trim();
}

function exactHttpsOrigin(value: string, name: string): string {
  if (placeholderPattern.test(value)) throw new Error(`${name} must not use an example value`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS origin`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an absolute HTTPS origin without a path`);
  }
  return url.origin;
}

function boundedLabel(value: string, name: string): string {
  if (value.length > 80 || placeholderPattern.test(value)) {
    throw new Error(`${name} must be a non-placeholder value of at most 80 characters`);
  }
  return value;
}

function version(value: string, name: string): string {
  if (value.length > 32 || placeholderPattern.test(value)) {
    throw new Error(`${name} must be a released version of at most 32 characters`);
  }
  return value;
}

function wholeDays(value: string, name: string): number {
  if (!/^\d{1,3}$/u.test(value)) throw new Error(`${name} must be a whole number of days`);
  const days = Number(value);
  if (days < 1 || days > 365) throw new Error(`${name} must be between 1 and 365 days`);
  return days;
}

function releasedIdentifier(value: string, name: string, maximum: number): string {
  if (value.length > maximum || placeholderPattern.test(value)) {
    throw new Error(`${name} must be a released identifier of at most ${maximum} characters`);
  }
  return value;
}

function secret(value: string, name: string): string {
  if (placeholderPattern.test(value) || new TextEncoder().encode(value).byteLength < 32) {
    throw new Error(`${name} must contain 32+ non-placeholder bytes`);
  }
  return value;
}

export function requestPortalEnabled(env: Pick<Env, "REQUEST_PORTAL_ENABLED">): boolean {
  return env.REQUEST_PORTAL_ENABLED === "true";
}

export function requestPortalConfig(env: Env): RequestPortalConfig {
  if (!requestPortalEnabled(env)) throw new Error("Request portal is not enabled");
  const origin = exactHttpsOrigin(required(env, "REQUEST_PORTAL_ORIGIN"), "REQUEST_PORTAL_ORIGIN");
  if (new URL(origin).hostname.endsWith(".workers.dev")) {
    throw new Error("REQUEST_PORTAL_ORIGIN must use a custom hostname");
  }
  const accessTeamDomain = exactHttpsOrigin(
    required(env, "REQUEST_PORTAL_ACCESS_TEAM_DOMAIN"),
    "REQUEST_PORTAL_ACCESS_TEAM_DOMAIN",
  );
  if (!new URL(accessTeamDomain).hostname.endsWith(".cloudflareaccess.com")) {
    throw new Error("REQUEST_PORTAL_ACCESS_TEAM_DOMAIN must be a Cloudflare Access team domain");
  }
  const publicScope = required(env, "REQUEST_PORTAL_PUBLIC_SCOPE");
  const accountScope = required(env, "REQUEST_PORTAL_ACCOUNT_SCOPE");
  if (
    !scopePattern.test(publicScope) ||
    !scopePattern.test(accountScope) ||
    placeholderPattern.test(publicScope) ||
    placeholderPattern.test(accountScope)
  ) {
    throw new Error("Request portal scopes must use lowercase deployment identifiers");
  }
  const adminEmails = new Set(
    commaSeparated(required(env, "REQUEST_PORTAL_ADMIN_EMAILS")).map((email) =>
      email.toLowerCase(),
    ),
  );
  if (
    adminEmails.size === 0 ||
    [...adminEmails].some(
      (email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || placeholderPattern.test(email),
    )
  ) {
    throw new Error("REQUEST_PORTAL_ADMIN_EMAILS must contain exact email addresses");
  }

  return {
    origin,
    organizationName: boundedLabel(
      required(env, "REQUEST_PORTAL_ORGANIZATION_NAME"),
      "REQUEST_PORTAL_ORGANIZATION_NAME",
    ),
    productName: boundedLabel(
      required(env, "REQUEST_PORTAL_PRODUCT_NAME"),
      "REQUEST_PORTAL_PRODUCT_NAME",
    ),
    publicScope,
    accountScope,
    noticeVersion: version(
      required(env, "REQUEST_PORTAL_NOTICE_VERSION"),
      "REQUEST_PORTAL_NOTICE_VERSION",
    ),
    evidencePolicyVersion: version(
      required(env, "REQUEST_EVIDENCE_POLICY_VERSION"),
      "REQUEST_EVIDENCE_POLICY_VERSION",
    ),
    pendingMaxAgeMilliseconds:
      wholeDays(
        required(env, "REQUEST_PORTAL_PENDING_MAX_AGE_DAYS"),
        "REQUEST_PORTAL_PENDING_MAX_AGE_DAYS",
      ) *
      24 *
      60 *
      60 *
      1_000,
    identityIssueEnabled: env.REQUEST_PORTAL_IDENTITY_ISSUE_ENABLED === "true",
    accountDeletionEnabled: env.REQUEST_PORTAL_ACCOUNT_DELETION_ENABLED === "true",
    requestDbGeneration: releasedIdentifier(
      required(env, "REQUEST_DB_GENERATION"),
      "REQUEST_DB_GENERATION",
      128,
    ),
    turnstileSiteKey: releasedIdentifier(
      required(env, "REQUEST_PORTAL_TURNSTILE_SITE_KEY"),
      "REQUEST_PORTAL_TURNSTILE_SITE_KEY",
      128,
    ),
    turnstileSecretKey: secret(
      required(env, "REQUEST_PORTAL_TURNSTILE_SECRET_KEY"),
      "REQUEST_PORTAL_TURNSTILE_SECRET_KEY",
    ),
    accessTeamDomain,
    accessAudience: releasedIdentifier(
      required(env, "REQUEST_PORTAL_ACCESS_AUDIENCE"),
      "REQUEST_PORTAL_ACCESS_AUDIENCE",
      256,
    ),
    adminEmails,
    subjectHmacKey: secret(required(env, "REQUEST_SUBJECT_HMAC_KEY"), "REQUEST_SUBJECT_HMAC_KEY"),
  };
}

export function isRequestPortalOrigin(request: Request, config: RequestPortalConfig): boolean {
  return new URL(request.url).origin === config.origin;
}

export function requestPortalDatabase(env: Env): D1Database {
  if (!env.REQUEST_DB) {
    throw new Error("REQUEST_DB binding is required when the request portal is enabled");
  }
  return env.REQUEST_DB;
}
