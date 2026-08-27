/**
 * Keeps Expo's adapter header at the Expo boundary while presenting the
 * standard Origin contract to the platform-neutral Worker.
 */
export function promoteExpoOriginHeader(headers: Headers): void {
  const expoOrigin = headers.get("expo-origin");
  if (expoOrigin !== null && !headers.has("origin")) {
    headers.set("origin", expoOrigin);
  }
  headers.delete("expo-origin");
}
