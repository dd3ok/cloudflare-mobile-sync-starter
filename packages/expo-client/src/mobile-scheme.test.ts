import { describe, expect, it } from "vitest";
import { validateMobileScheme } from "./mobile-scheme";

describe("validateMobileScheme", () => {
  it("defaults to a reverse-domain private-use scheme", () => {
    expect(() => validateMobileScheme("com.example.myapp")).not.toThrow();
    expect(() => validateMobileScheme("my-app")).toThrow("reverse-domain");
  });
});
