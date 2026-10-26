import { describe, expect, it } from "vitest";
import { boundOutput, redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("redacts openai-style keys", () => {
    const { text, redacted } = redactSecrets("token sk-abcdefghijklmnopqrstuvwxyz");
    expect(redacted).toBe(true);
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("redacts private key blocks", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----";
    const { text, redacted } = redactSecrets(pem);
    expect(redacted).toBe(true);
    expect(text).toBe("[REDACTED]");
  });
});

describe("boundOutput", () => {
  it("truncates oversized output", () => {
    const { text, truncated } = boundOutput("abcdefghij", 4);
    expect(truncated).toBe(true);
    expect(text.startsWith("abcd")).toBe(true);
    expect(text).toContain("truncated");
  });
});
