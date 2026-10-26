import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ApprovalKind =
  | "browser_open"
  | "permission"
  | "general"
  | "destructive";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "timed_out"
  | "error";

export type ApprovalRecord = {
  id: string;
  owner_id: string;
  kind: ApprovalKind;
  title: string;
  detail: string;
  status: ApprovalStatus;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  /** Optional structured payload (e.g. url) echoed back after resolve */
  payload: Record<string, unknown>;
};

type Waiter = {
  resolve: (rec: ApprovalRecord) => void;
  timer: NodeJS.Timeout;
};

export type DialogRunner = (input: {
  title: string;
  detail: string;
  timeoutSec: number;
}) => Promise<"approved" | "denied" | "timed_out" | "error">;

export type Notifier = (input: {
  title: string;
  body: string;
}) => Promise<void>;

function nowIso(): string {
  return new Date().toISOString();
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Default: macOS notification banner (non-blocking). */
export const defaultNotifier: Notifier = async ({ title, body }) => {
  const script = `display notification "${escapeAppleScript(body.slice(0, 180))}" with title "${escapeAppleScript(title.slice(0, 60))}"`;
  await runOsascript(script, 10_000);
};

/**
 * Default: blocking dialog on the Mac login session.
 * Works when the worker runs as a gui LaunchAgent (Aqua).
 */
export const defaultDialogRunner: DialogRunner = async ({
  title,
  detail,
  timeoutSec,
}) => {
  const giveUp = Math.max(5, Math.min(timeoutSec, 600));
  const script = [
    `set frontResult to display dialog "${escapeAppleScript(detail.slice(0, 900))}" `,
    `buttons {"Deny", "Approve"} default button "Deny" `,
    `with title "${escapeAppleScript(title.slice(0, 80))}" `,
    `giving up after ${giveUp}`,
    `\n`,
    `if gave up of frontResult then\n`,
    `  return "timed_out"\n`,
    `else if button returned of frontResult is "Approve" then\n`,
    `  return "approved"\n`,
    `else\n`,
    `  return "denied"\n`,
    `end if`,
  ].join("");
  try {
    const out = await runOsascript(script, (giveUp + 15) * 1000);
    const normalized = out.trim().toLowerCase();
    if (normalized.includes("approved")) return "approved";
    if (normalized.includes("timed_out") || normalized.includes("gave up")) {
      return "timed_out";
    }
    if (normalized.includes("denied")) return "denied";
    return "denied";
  } catch {
    return "error";
  }
};

function runOsascript(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("osascript timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `osascript exit ${code}`));
    });
  });
}

/**
 * Local owner approvals for ChatGPT-requested actions.
 * Sync path: macOS dialog. Async path: pending until menu bar / resolveApproval.
 */
export class ApprovalManager {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly history: ApprovalRecord[] = [];
  /** Optional event sink (Ground Life Mirror). Kind + status only — never
   *  title/detail/note/payload. */
  onEvent?: import("../events/types.js").EventSink;

  constructor(
    private readonly opts: {
      ownerId: string;
      dataDir: string;
      defaultTimeoutSec?: number;
      dialog?: DialogRunner;
      notify?: Notifier;
      maxHistory?: number;
    },
  ) {
    mkdirSync(opts.dataDir, { recursive: true });
    this.load();
  }

  private get storePath(): string {
    return join(this.opts.dataDir, "approvals.json");
  }

  private load(): void {
    if (!existsSync(this.storePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.storePath, "utf8")) as {
        history?: ApprovalRecord[];
        pending?: ApprovalRecord[];
      };
      for (const r of raw.history ?? []) {
        this.history.push(r);
        this.records.set(r.id, r);
      }
      for (const r of raw.pending ?? []) {
        if (r.status === "pending") {
          this.records.set(r.id, r);
        }
      }
    } catch {
      // ignore corrupt store
    }
  }

  private persist(): void {
    const pending = [...this.records.values()].filter(
      (r) => r.status === "pending",
    );
    writeFileSync(
      this.storePath,
      JSON.stringify(
        {
          pending,
          history: this.history.slice(-(this.opts.maxHistory ?? 50)),
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  /** All known records (pending + history) for event materialization. */
  listAll(): ApprovalRecord[] {
    const out = new Map<string, ApprovalRecord>();
    for (const r of this.history) out.set(r.id, { ...r });
    for (const r of this.records.values()) out.set(r.id, { ...r });
    return [...out.values()];
  }

  assertOwner(ownerId: string): void {
    if (ownerId !== this.opts.ownerId) {
      throw new Error("unauthorized owner");
    }
  }

  list(ownerId: string, opts?: { includeResolved?: boolean; limit?: number }) {
    this.assertOwner(ownerId);
    const limit = opts?.limit ?? 20;
    const pending = [...this.records.values()]
      .filter((r) => r.status === "pending")
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (!opts?.includeResolved) return pending.slice(0, limit);
    const resolved = this.history
      .slice()
      .reverse()
      .filter((r) => r.status !== "pending");
    return [...pending, ...resolved].slice(0, limit);
  }

  get(ownerId: string, id: string): ApprovalRecord {
    this.assertOwner(ownerId);
    const rec = this.records.get(id) ?? this.history.find((h) => h.id === id);
    if (!rec) throw new Error(`approval not found: ${id}`);
    return { ...rec };
  }

  /**
   * Create an approval. If wait=true (default), show a Mac dialog and block
   * until the owner responds or timeout.
   */
  async request(
    input: {
      ownerId: string;
      kind: ApprovalKind;
      title: string;
      detail: string;
      payload?: Record<string, unknown>;
      timeoutSec?: number;
      wait?: boolean;
    },
  ): Promise<ApprovalRecord> {
    this.assertOwner(input.ownerId);
    const id = randomUUID();
    const timeoutSec =
      input.timeoutSec ?? this.opts.defaultTimeoutSec ?? 120;
    const rec: ApprovalRecord = {
      id,
      owner_id: input.ownerId,
      kind: input.kind,
      title: input.title.slice(0, 200),
      detail: input.detail.slice(0, 4000),
      status: "pending",
      created_at: nowIso(),
      resolved_at: null,
      resolution_note: null,
      payload: input.payload ?? {},
    };
    this.records.set(id, rec);
    this.persist();
    this.onEvent?.({
      source: "approvals",
      sourceRef: id,
      actor: "system",
      verb: "approval.requested",
      objectType: "approval",
      objectId: id,
      toState: rec.kind,
      occurredAt: rec.created_at,
      evidenceRefs: [`approval:${id}`],
      sensitivity: "private",
      dedupeKey: "requested",
    });

    const notify = this.opts.notify ?? defaultNotifier;
    void notify({
      title: `Ground Control · ${rec.kind}`,
      body: rec.title,
    }).catch(() => undefined);

    if (input.wait === false) {
      return { ...rec };
    }

    const dialog = this.opts.dialog ?? defaultDialogRunner;
    const result = await dialog({
      title: `Ground Control · ${rec.kind}`,
      detail: `${rec.title}\n\n${rec.detail}`,
      timeoutSec,
    });

    return this.finish(id, result, `dialog:${result}`);
  }

  resolve(
    ownerId: string,
    id: string,
    decision: "approved" | "denied",
    note?: string,
  ): ApprovalRecord {
    this.assertOwner(ownerId);
    return this.finish(id, decision, note ?? `manual:${decision}`);
  }

  private finish(
    id: string,
    status: ApprovalStatus,
    note: string,
  ): ApprovalRecord {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`approval not found: ${id}`);
    if (rec.status !== "pending") return { ...rec };
    rec.status = status;
    rec.resolved_at = nowIso();
    rec.resolution_note = note;
    this.history.push({ ...rec });
    this.persist();
    this.onEvent?.({
      source: "approvals",
      sourceRef: rec.id,
      actor: "owner",
      verb: "approval.resolved",
      objectType: "approval",
      objectId: rec.id,
      fromState: "pending",
      toState: rec.status,
      occurredAt: rec.resolved_at,
      evidenceRefs: [`approval:${rec.id}`],
      sensitivity: "private",
      dedupeKey: "resolved",
    });
    const waiter = this.waiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ...rec });
      this.waiters.delete(id);
    }
    return { ...rec };
  }

  /** Fire-and-forget banner for awareness (no decision). */
  async notifyOwner(
    ownerId: string,
    title: string,
    body: string,
  ): Promise<{ ok: true }> {
    this.assertOwner(ownerId);
    const notify = this.opts.notify ?? defaultNotifier;
    await notify({ title: title.slice(0, 80), body: body.slice(0, 240) });
    return { ok: true };
  }
}
