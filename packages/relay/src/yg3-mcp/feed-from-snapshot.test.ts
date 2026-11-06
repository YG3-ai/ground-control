import { describe, expect, it } from "vitest";
import { projectYg3SnapshotV1 } from "./projector.js";
import {
  growthFeedFromYg3Snapshot,
  snapshotHasRealAccountsFeed,
  yg3AccountsFeedFromSnapshot,
} from "./feed-from-snapshot.js";
import type { Yg3SnapshotLoadResult } from "./snapshot-service.js";

const FABRICATED = {
  whoami: [{ type: "text", text: "tenant: t\nuser: u\nrole: owner" }],
  client_connections: [
    {
      type: "text",
      text: "Clients in scope: 3\nAll clear: 2\nNeeds attention: 1",
    },
  ],
  list_clients: [{ type: "text", text: "id: a\nname: Client A" }],
  projects: [{ type: "text", text: "id: p1\nstatus: active" }],
  tasks: [{ type: "text", text: "open: 1" }],
  daily_checkin: [{ type: "text", text: "Insight: steady week" }],
};

function ownerLoad(snapshot: ReturnType<typeof projectYg3SnapshotV1>): Yg3SnapshotLoadResult {
  return {
    enabled: true,
    snapshot,
    health: "ok",
    source: "yg3-mcp",
  };
}

describe("feed-from-snapshot owner honesty", () => {
  it("does not treat v1 snapshot as a real NEW ACCOUNTS feed", () => {
    const snap = projectYg3SnapshotV1(
      { tenantKey: "t", userKey: "u" },
      "2026-03-15T12:00:00.000Z",
      FABRICATED,
    );
    expect(snapshotHasRealAccountsFeed(snap)).toBe(false);
    expect(yg3AccountsFeedFromSnapshot(ownerLoad(snap))).toBeNull();
  });

  it("never maps syncedAt onto synthetic Workspace rows", () => {
    const snap = projectYg3SnapshotV1(
      { tenantKey: "t", userKey: "u" },
      "2026-03-15T12:00:00.000Z",
      FABRICATED,
    );
    const feed = yg3AccountsFeedFromSnapshot(ownerLoad(snap));
    expect(feed).toBeNull();
    const blob = JSON.stringify(feed);
    expect(blob).not.toMatch(/Workspace \d+/);
    expect(blob).not.toContain("2026-03-15T12:00:00.000Z");
  });

  it("uses persisted recentAccounts when present", () => {
    const snap = projectYg3SnapshotV1(
      { tenantKey: "t", userKey: "u" },
      "2026-03-15T12:00:00.000Z",
      FABRICATED,
    );
    const withRows = {
      ...snap,
      recentAccounts: [
        {
          id: "37e9ffa1-f76f-4b89-8cd0-68e21b5ea2e4",
          name: "YG3 Media",
          email: "",
          createdAt: "2024-06-01T10:00:00.000Z",
        },
      ],
    };
    expect(snapshotHasRealAccountsFeed(withRows)).toBe(true);
    const feed = yg3AccountsFeedFromSnapshot(ownerLoad(withRows));
    expect(feed?.items).toHaveLength(1);
    expect(feed?.items[0].name).toBe("YG3 Media");
    expect(feed?.items[0].createdAt).toBe("2024-06-01T10:00:00.000Z");
    expect(feed?.items[0].createdAt).not.toBe(snap.syncedAt);
  });

  it("does not map MCP leads or opportunities into platform signups or demand", () => {
    const snap = projectYg3SnapshotV1(
      { tenantKey: "t", userKey: "u" },
      "2026-01-01T00:00:00.000Z",
      {
        ...FABRICATED,
        leads: [{ type: "text", text: "count: 5" }],
        search_opportunities: [{ type: "text", text: "total: 9" }],
      },
    );
    const growth = growthFeedFromYg3Snapshot(ownerLoad(snap), "7d");
    expect(growth?.summary.signups).toBeNull();
    expect(growth?.summary.demandSignups).toBeNull();
    expect(growth?.outbound.replies).toBeNull();
  });

  it("does not use agency connection counts for activation in growth summary", () => {
    const snap = projectYg3SnapshotV1(
      { tenantKey: "t", userKey: "u" },
      "2026-01-01T00:00:00.000Z",
      FABRICATED,
    );
    const growth = growthFeedFromYg3Snapshot(ownerLoad(snap), "7d");
    expect(growth?.summary.activation).toBeNull();
    if (snap.workspace.connectedCount > 0) {
      expect(growth?.summary.activation).not.toBe(snap.workspace.connectedCount);
    }
  });
});
