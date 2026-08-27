const envLikePath = /(?:^|\/)(?:[^/]*\.)?(?:env|vars)(?:\.[^/]*)?$|\.(?:jsonc?|ya?ml|toml)$/iu;
const placeholder = String.raw`(?:\d+:)?(?:(?:placeholder|replace-with|example|unit-test-only)\b|(?:[a-z0-9-]*must-stay-private|available-[a-z0-9-]+|0123456789abcdefghijklmnopqrstuvwxyz)\b|<generated-value>)|\$\{`;

function namedAssignmentMatcher(names) {
  const templateQuote = "\u0060";
  const quoted = new RegExp(
    String.raw`\b(?:${names})\b["']?\s*[:=]\s*(?:"(?!${placeholder})[^"\r\n]{16,}"|'(?!${placeholder})[^'\r\n]{16,}'|${templateQuote}(?!${placeholder})[^${templateQuote}\r\n]{16,}${templateQuote})`,
    "iu",
  );
  const unquoted = new RegExp(
    String.raw`\b(?:${names})\b\s*[:=]\s*(?!${placeholder}|$)[^\s"',#}]{16,}`,
    "iu",
  );

  return (path, content) =>
    quoted.test(content) ||
    (envLikePath.test(path.replaceAll("\\", "/")) && unquoted.test(content));
}

export const secretPatterns = [
  {
    name: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
  },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/u },
  { name: "Google OAuth client secret", pattern: /\bGOCSPX-[0-9A-Za-z_-]{20,}\b/u },
  { name: "GitHub token", pattern: /\bgh[opusr]_[0-9A-Za-z]{30,}\b/u },
  { name: "GitHub fine-grained token", pattern: /\bgithub_pat_[0-9A-Za-z_]{40,}\b/u },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: "Slack token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/u },
  { name: "Stripe live key", pattern: /\b(?:sk_live|rk_live)_[0-9A-Za-z]{16,}\b/u },
  {
    name: "Cloudflare API token assignment",
    matches: namedAssignmentMatcher("CLOUDFLARE_API_TOKEN"),
  },
  {
    name: "server secret assignment",
    matches: namedAssignmentMatcher(
      "BETTER_AUTH_SECRETS?|GOOGLE_CLIENT_SECRET|REQUEST_PORTAL_TURNSTILE_SECRET_KEY|REQUEST_SUBJECT_HMAC_KEY",
    ),
  },
];

export const historySecretGrepPattern = [
  "-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
  "AIza[0-9A-Za-z_-]{30,}",
  "GOCSPX-[0-9A-Za-z_-]{20,}",
  "gh[opusr]_[0-9A-Za-z]{30,}",
  "github_pat_[0-9A-Za-z_]{40,}",
  "AKIA[0-9A-Z]{16}",
  "xox[baprs]-[0-9A-Za-z-]{10,}",
  "(sk_live|rk_live)_[0-9A-Za-z]{16,}",
  "CLOUDFLARE_API_TOKEN",
  "BETTER_AUTH_SECRETS?",
  "GOOGLE_CLIENT_SECRET",
  "REQUEST_PORTAL_TURNSTILE_SECRET_KEY",
  "REQUEST_SUBJECT_HMAC_KEY",
].join("|");

export function matchingSecretPatterns(path, content) {
  return [
    ...new Set(
      secretPatterns
        .filter(
          ({ matches, pattern }) => matches?.(path, content) || (!matches && pattern.test(content)),
        )
        .map(({ name }) => name),
    ),
  ];
}
