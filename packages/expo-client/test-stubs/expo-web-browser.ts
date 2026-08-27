export function dismissAuthSession(): void {}

export async function openAuthSessionAsync(): Promise<{ type: "cancel" }> {
  return { type: "cancel" };
}
