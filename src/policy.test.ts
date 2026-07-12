import { describe, expect, it } from "vitest";
import { isAddressAllowed } from "./policy.js";

describe("isAddressAllowed", () => {
  it("denies every address when policy is empty", () => {
    expect(isAddressAllowed("person@example.com", [])).toBe(false);
  });

  it("matches exact addresses without case sensitivity", () => {
    expect(isAddressAllowed("Person@Example.com", ["person@example.com"])).toBe(
      true,
    );
  });

  it("matches a domain and its subdomains on a label boundary", () => {
    expect(isAddressAllowed("person@ops.example.com", ["@example.com"])).toBe(
      true,
    );
    expect(isAddressAllowed("person@notexample.com", ["@example.com"])).toBe(
      false,
    );
  });

  it("accepts any valid address for wildcard policy", () => {
    expect(isAddressAllowed("person@example.com", ["*"])).toBe(true);
    expect(isAddressAllowed("not-an-address", ["*"])).toBe(false);
  });
});
