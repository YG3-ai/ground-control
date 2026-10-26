import { describe, expect, it } from "vitest";
import { nextRelayReconnectBackoffMs } from "./relay-client.js";

describe("relay reconnect backoff", () => {
  it("doubles delay up to 30s", () => {
    expect(nextRelayReconnectBackoffMs(1000)).toBe(2000);
    expect(nextRelayReconnectBackoffMs(2000)).toBe(4000);
    expect(nextRelayReconnectBackoffMs(20_000)).toBe(30_000);
    expect(nextRelayReconnectBackoffMs(30_000)).toBe(30_000);
  });

  it("floors sub-minimum values to 1s step", () => {
    expect(nextRelayReconnectBackoffMs(0)).toBe(1000);
  });
});
