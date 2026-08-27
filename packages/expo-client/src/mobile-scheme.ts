export function validateMobileScheme(scheme: string): void {
  if (!/^[a-z][a-z0-9+.-]*$/u.test(scheme)) {
    throw new Error("Mobile scheme must follow the Expo scheme syntax");
  }
  if (!scheme.includes(".")) {
    throw new Error("Mobile scheme must use reverse-domain notation");
  }
}
