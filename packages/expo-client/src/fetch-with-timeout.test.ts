import { describe, expect, it } from "vitest";
import {
  fetchBoundedJsonWithTimeout,
  fetchWithTimeout,
  readBoundedJson,
} from "./fetch-with-timeout";

describe("fetchWithTimeout", () => {
  it("aborts a stalled request after the configured timeout", async () => {
    let receivedSignal: AbortSignal | undefined;
    const stalledFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        receivedSignal = init?.signal ?? undefined;
        receivedSignal?.addEventListener("abort", () => reject(receivedSignal?.reason), {
          once: true,
        });
      })) as typeof globalThis.fetch;

    await expect(
      fetchWithTimeout(stalledFetch, "https://sync.example.test", {}, 5),
    ).rejects.toThrow("Request timed out");
    expect(receivedSignal?.aborted).toBe(true);
  });
});

describe("readBoundedJson", () => {
  it("accepts JSON parameters but rejects lookalike media types", async () => {
    await expect(
      readBoundedJson(
        new Response('{"ok":true}', {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
        "invalid auth response",
      ),
    ).resolves.toEqual({ ok: true });

    await expect(
      readBoundedJson(
        new Response('{"ok":true}', {
          headers: { "Content-Type": "text/application/json-evil" },
        }),
        "invalid auth response",
      ),
    ).rejects.toThrow("invalid auth response");
  });

  it("rejects an oversized authentication response", async () => {
    const response = Response.json({ value: "x".repeat(65_536) });

    await expect(readBoundedJson(response, "invalid auth response")).rejects.toThrow(
      "invalid auth response",
    );
  });

  it("keeps the timeout active while a response body is streaming", async () => {
    const stalledBodyFetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
              once: true,
            });
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      )) as typeof globalThis.fetch;

    await expect(
      fetchBoundedJsonWithTimeout(
        stalledBodyFetch,
        "https://sync.example.test",
        {},
        5,
        "invalid auth response",
      ),
    ).rejects.toThrow("Request timed out");
  });
});
