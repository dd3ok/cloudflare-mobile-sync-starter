/** Returns the lowercase SHA-256 digest of an UTF-8 string. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Returns a lowercase keyed HMAC without retaining the source identifier. */
export async function hmacSha256Hex(key: string, value: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomBase64Url(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Compares equal-length lowercase hex digests without an early exit. */
export function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/u.test(left) || !/^[a-f0-9]+$/u.test(right)) return false;
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}
