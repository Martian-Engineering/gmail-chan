import { describe, expect, it } from "vitest";
import entry from "../index.js";

describe("Gmail plugin entry", () => {
  it("declares the modern channel entry contract", () => {
    expect(entry.id).toBe("gmail");
    expect(entry.name).toBe("Gmail");
    expect(entry.channelPlugin.id).toBe("gmail");
    expect(entry.channelPlugin.meta.id).toBe("gmail");
  });
});
