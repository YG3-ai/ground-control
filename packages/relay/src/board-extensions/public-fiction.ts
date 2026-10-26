/**
 * Deterministic fictional business for anonymous Ground Control demo.
 * No owner/client data — stable for screenshots and tests.
 */
const DEMO_AT = "2020-01-01T00:00:00.000Z";

export const FICTION_BUSINESS_NAME = "Harbor Lantern Co.";
export const FICTION_WORKSPACE = "harbor-lantern-demo";

const M1 = "00000000-0000-4000-8000-000000000101";
const M2 = "00000000-0000-4000-8000-000000000102";
const M3 = "00000000-0000-4000-8000-000000000103";
const J1 = "00000000-0000-4000-8000-000000000201";
const T1 = "00000000-0000-4000-8000-000000000301";
const A1 = "00000000-0000-4000-8000-000000000401";

export function publicBoardFictionSnapshot(): Record<string, unknown> {
  return {
    at: DEMO_AT,
    public_preview: true,
    health: { worker: false },
    owner: { id: "public", display_name: FICTION_BUSINESS_NAME },
    missions: [
      {
        id: M1,
        title: "Spring catalog refresh",
        goal: "Update product pages and email capture for the spring line.",
        status: "implementing",
        workspace: FICTION_WORKSPACE,
        markers: { lane: "commerce", priority: "high" },
      },
      {
        id: M2,
        title: "Outbound sequence tune-up",
        goal: "Tighten follow-ups for trial accounts without hurting deliverability.",
        status: "plan_ready",
        workspace: FICTION_WORKSPACE,
        markers: { lane: "growth" },
      },
      {
        id: M3,
        title: "Warehouse label audit",
        goal: "Verify SKU labels match the new packing spec.",
        status: "done",
        workspace: FICTION_WORKSPACE,
        markers: { lane: "ops" },
      },
    ],
    columns: {
      implementing: [{ id: M1, title: "Spring catalog refresh", status: "implementing" }],
      plan_ready: [{ id: M2, title: "Outbound sequence tune-up", status: "plan_ready" }],
      done: [{ id: M3, title: "Warehouse label audit", status: "done" }],
    },
    approvals: [
      {
        id: A1,
        title: "Ship pricing page copy",
        status: "pending",
        kind: "permission",
      },
    ],
    tasks: [{ id: J1, title: "Cursor: refresh hero section", status: "running" }],
    active_tasks: [{ id: J1, status: "running" }],
    recent_tasks: [
      { id: "00000000-0000-4000-8000-000000000202", status: "succeeded", title: "Research competitors" },
    ],
    terminal_sessions: [
      {
        id: T1,
        kind: "cursor",
        state: "running",
        label: "catalog-refresh",
        output_tail:
          "Running vitest… 42 passed\nUpdating product copy in components/Hero.tsx\n",
      },
    ],
    kpis: [{ key: "trial_starts", value: "12", label: "7d trials" }],
    usage: {
      cursor: { starts_remaining: 8 },
      kimi: { starts_remaining: 5 },
    },
    system_state: { state: "on_a_project", label: "ON A PROJECT" },
    user_led_project: {
      active: true,
      mission_id: M1,
      title: "Spring catalog refresh",
    },
  };
}

export function publicNotesFictionFeed() {
  return {
    ok: true,
    health: "ok",
    measuredAt: DEMO_AT,
    items: [
      {
        slug: "notes/demo/welcome-brief",
        title: "Welcome brief — Harbor Lantern",
        updated: DEMO_AT,
      },
      {
        slug: "notes/demo/spring-launch-checklist",
        title: "Spring launch checklist",
        updated: DEMO_AT,
      },
      {
        slug: "notes/demo/customer-voice-snippets",
        title: "Customer voice snippets",
        updated: DEMO_AT,
      },
    ],
  };
}

export function publicNoteFictionRead(slug: string) {
  const body =
    slug.includes("checklist")
      ? "# Spring launch checklist\n\n- Hero refresh\n- Email capture QA\n- Trial onboarding copy\n"
      : "# Harbor Lantern demo note\n\nFictional memory for the public tour. Replace with your Second Brain after install.\n";
  return {
    ok: true,
    slug,
    title: slug.includes("checklist") ? "Spring launch checklist" : "Harbor Lantern demo note",
    body,
  };
}

export function publicYg3AccountsFiction() {
  return {
    ok: true,
    health: "ok",
    measuredAt: DEMO_AT,
    items: [
      {
        id: "demo-acct-01",
        name: "North Pier Outfitters",
        createdAt: DEMO_AT,
        plan: "trial",
      },
      {
        id: "demo-acct-02",
        name: "Lumen Pantry",
        createdAt: DEMO_AT,
        plan: "starter",
      },
    ],
  };
}
