import type { CancellationSignal } from "@cloudflare-mobile-sync/client-core";

const MAX_AUTH_RESPONSE_BYTES = 65_536;

export class BoundedJsonResponseError extends Error {
  constructor(
    readonly response: Response,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : "Invalid JSON response", { cause });
  }
}

export async function readBoundedJson(response: Response, message: string): Promise<unknown> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new Error(message);
  }
  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength === null ? null : Number(contentLength);
  if (declaredLength !== null && declaredLength > MAX_AUTH_RESPONSE_BYTES) {
    throw new Error(message);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(message);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_AUTH_RESPONSE_BYTES) {
        await reader.cancel(message);
        throw new Error(message);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error(message);
  }
}

async function withTimeout<T>(
  fetchImplementation: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMilliseconds: number,
  consume: (response: Response) => Promise<T>,
  externalSignal?: CancellationSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener?.("abort", abortFromCaller, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
    timeoutMilliseconds,
  );

  try {
    const response = await fetchImplementation(input, { ...init, signal: controller.signal });
    return await consume(response);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.("abort", abortFromCaller);
  }
}

export function fetchBoundedJsonWithTimeout(
  fetchImplementation: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMilliseconds: number,
  message: string,
  externalSignal?: CancellationSignal,
): Promise<{ payload: unknown; response: Response }> {
  return withTimeout(
    fetchImplementation,
    input,
    init,
    timeoutMilliseconds,
    async (response) => {
      try {
        return { payload: await readBoundedJson(response, message), response };
      } catch (error) {
        throw new BoundedJsonResponseError(response, error);
      }
    },
    externalSignal,
  );
}

export async function fetchWithTimeout(
  fetchImplementation: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMilliseconds: number,
  externalSignal?: CancellationSignal,
): Promise<Response> {
  return withTimeout(
    fetchImplementation,
    input,
    init,
    timeoutMilliseconds,
    async (response) => response,
    externalSignal,
  );
}
