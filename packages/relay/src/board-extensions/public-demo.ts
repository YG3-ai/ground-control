import type { GrowthFeedPayload } from "./growth.js";
import type { LifecycleFeedPayload } from "./lifecycle.js";
import type { Yg3SyncStatusPayload } from "./yg3-sync.js";
import {
  FICTION_BUSINESS_NAME,
  publicBoardFictionSnapshot,
  publicNoteFictionRead,
  publicNotesFictionFeed,
  publicYg3AccountsFiction,
} from "./public-fiction.js";
import type { WorldListPayload } from "./public-redact.js";

/** Fixed clock for anonymous demo feeds (never reflects live measurement). */
export const PUBLIC_DEMO_MEASURED_AT = "2020-01-01T00:00:00.000Z";

const BOARD_KEYS = [
  "at",
  "public_preview",
  "health",
  "owner",
  "missions",
  "columns",
  "approvals",
  "tasks",
  "active_tasks",
  "recent_tasks",
  "terminal_sessions",
  "kpis",
  "usage",
  "system_state",
  "user_led_project",
] as const;

function pickAllowlisted(board: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of BOARD_KEYS) {
    if (board[key] !== undefined) out[key] = board[key];
  }
  return out;
}

export function publicBoardSnapshotDemo(): Record<string, unknown> {
  return pickAllowlisted(publicBoardFictionSnapshot());
}

export function publicGrowthFeedDemo(window: string): GrowthFeedPayload {
  return {
    ok: true,
    health: "ok",
    source: "demo",
    measuredAt: PUBLIC_DEMO_MEASURED_AT,
    window,
    from: null,
    to: null,
    generatedAt: PUBLIC_DEMO_MEASURED_AT,
    summary: {
      visits: 1840,
      signups: 96,
      trials: 28,
      activation: 19,
      demandSignups: 12,
    },
    outbound: { sent: 420, replies: 37, note: "Demo outbound cadence" },
    funnelRows: [
      { key: "visit", label: "Site visits", n: 1840 },
      { key: "signup", label: "Signups", n: 96 },
      { key: "trial", label: "Trials", n: 28 },
    ],
    insights: [
      {
        id: "demo-growth-1",
        kicker: "Harbor Lantern",
        body: "Trial starts rose after the catalog hero refresh (fictional demo).",
        tone: "positive",
      },
    ],
    funnelsUrl: "",
  };
}

export function publicYg3SyncStatusDemo(): Yg3SyncStatusPayload {
  return {
    ok: true,
    enabled: false,
    status: {
      state: "idle",
      running: false,
      lastSyncedAt: PUBLIC_DEMO_MEASURED_AT,
      lastAttemptAt: PUBLIC_DEMO_MEASURED_AT,
      lastTrigger: null,
      lastErrorCode: null,
    },
  };
}

export function publicLifecycleFeedDemo(): LifecycleFeedPayload {
  return {
    ok: true,
    health: "ok",
    source: "demo",
    measuredAt: PUBLIC_DEMO_MEASURED_AT,
    asOf: PUBLIC_DEMO_MEASURED_AT,
    recommendations: [
      {
        id: "demo-rec-1",
        kind: "build",
        title: "Finish spring catalog refresh",
        metric: "mission · implementing",
        detail: { workspace: "harbor-lantern-demo" },
      },
      {
        id: "demo-rec-2",
        kind: "decision",
        title: "Approve pricing page copy",
        metric: "approval pending",
        detail: {},
      },
    ],
  };
}

/** Anonymous board snapshot when the worker hub is disconnected (relay-only demo). */
export function publicBoardFeedDemo(): Record<string, unknown> {
  return publicBoardSnapshotDemo();
}

export function publicWorldFeedDemo(): WorldListPayload {
  return {
    ok: true,
    summary: {
      entities: 3,
      missions: 3,
      people: 2,
      services: 2,
    },
    entities: [
      {
        entity_id: "demo-entity-1",
        entity_type: "mission",
        label: "Spring catalog refresh",
        state: "active",
        sensitivity: "public",
      },
    ],
  };
}

export {
  publicNotesFictionFeed,
  publicNoteFictionRead,
  publicYg3AccountsFiction,
  FICTION_BUSINESS_NAME,
};
