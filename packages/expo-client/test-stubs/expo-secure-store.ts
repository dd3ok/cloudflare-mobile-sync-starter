const values = new Map<string, string>();
let failingKey: string | null = null;

export function getItem(key: string): string | null {
  return values.get(key) ?? null;
}

export function setItem(key: string, value: string): void {
  if (key === failingKey) {
    failingKey = null;
    throw new Error(`Injected SecureStore failure for ${key}`);
  }
  values.set(key, value);
}

export async function getItemAsync(key: string): Promise<string | null> {
  return getItem(key);
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  setItem(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  values.delete(key);
}

export function failNextSetItem(key: string): void {
  failingKey = key;
}

export function resetTestStore(): void {
  values.clear();
  failingKey = null;
}
