export function createURL(_path: string, options?: { scheme?: string }): string {
  return `${options?.scheme ?? "app"}://`;
}
