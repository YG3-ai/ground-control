import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatYg3AccountCreatedAt,
  mapYg3AccountRows,
  sortYg3AccountsByCreatedDesc,
} from "./board-yg3-accounts-present.js";

describe("yg3 accounts presentation", () => {
  it("sorts by createdAt descending with stable id tie-break", () => {
    const sorted = sortYg3AccountsByCreatedDesc([
      { id: "b", name: "Beta", email: "b@example.com", createdAt: "2026-03-01T12:00:00.000Z" },
      { id: "a", name: "Alpha", email: "a@example.com", createdAt: "2026-03-02T08:00:00.000Z" },
      { id: "c", name: "Gamma", email: "c@example.com", createdAt: "2026-03-02T08:00:00.000Z" },
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("maps and drops incomplete rows", () => {
    const rows = mapYg3AccountRows([
      { id: "1", name: "Acme", email: "ops@acme.test", createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "", name: "Bad", email: "x@test", createdAt: "2026-01-01T00:00:00.000Z" },
      { name: "No id", email: "y@test", createdAt: "2026-01-03T00:00:00.000Z" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Acme");
    expect(rows[0].email).toBe("ops@acme.test");
  });

  it("formats local wall time with timezone", () => {
    const label = formatYg3AccountCreatedAt(
      "2026-07-15T18:30:00.000Z",
      "en-US",
      "America/New_York",
    );
    expect(label).toMatch(/Jul/);
    expect(label).toMatch(/15/);
    expect(label).toMatch(/2026/);
  });
});

describe("board.html yg3 accounts feed", () => {
  const html = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

  it("ships owner feed markup and scrollable list styles", () => {
    expect(html).toContain('id="lm-yg3-accounts-feed"');
    expect(html).toContain("NEW ACCOUNTS");
    expect(html).toContain("/api/board/extensions/yg3-accounts");
    expect(html).toMatch(/\.lm-yg3-accounts-feed[\s\S]*overflow-y:\s*auto/);
    expect(html).toMatch(/\.lm-yg3-account-name[\s\S]*font-weight:\s*7/);
    expect(html).not.toMatch(/lm-yg3-account-email[^}]*white-space:\s*nowrap/);
  });
});
