import type { Env } from "./env";

/** Rejects without reading message metadata, headers, or body content. */
export function rejectRequestEmail(
  message: Pick<ForwardableEmailMessage, "setReject">,
  env: Pick<Env, "REQUEST_PORTAL_ORIGIN">,
): void {
  let portal: string | null = null;
  try {
    const url = new URL(env.REQUEST_PORTAL_ORIGIN ?? "");
    if (url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash) {
      portal = url.origin;
    }
  } catch {
    portal = null;
  }
  message.setReject(
    portal
      ? `Email is not accepted. Use the request portal at ${portal}.`
      : "Email is not accepted. Use the published request portal.",
  );
}
