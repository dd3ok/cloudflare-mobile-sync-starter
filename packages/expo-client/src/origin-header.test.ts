import { describe, expect, it } from "vitest";
import { promoteExpoOriginHeader } from "./origin-header";

describe("promoteExpoOriginHeader", () => {
  it("promotes the Expo adapter origin to the standard Origin header", () => {
    const headers = new Headers({ "expo-origin": "com.example.nativeapp.dev://" });

    promoteExpoOriginHeader(headers);

    expect(headers.get("origin")).toBe("com.example.nativeapp.dev://");
    expect(headers.has("expo-origin")).toBe(false);
  });

  it("preserves an existing standard Origin header", () => {
    const headers = new Headers({
      origin: "com.example.nativeapp.dev://",
      "expo-origin": "com.example.attacker://",
    });

    promoteExpoOriginHeader(headers);

    expect(headers.get("origin")).toBe("com.example.nativeapp.dev://");
    expect(headers.has("expo-origin")).toBe(false);
  });

  it("leaves requests without an Expo origin unchanged", () => {
    const headers = new Headers({ accept: "application/json" });

    promoteExpoOriginHeader(headers);

    expect(Object.fromEntries(headers.entries())).toEqual({ accept: "application/json" });
  });
});
