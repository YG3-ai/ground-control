import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalManager } from "./approvals.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadWhiteboardHtml(): string {
  try {
    return readFileSync(join(HERE, "whiteboard.html"), "utf8");
  } catch {
    // When running from dist/, html is copied beside this file or sits in src/
    try {
      return readFileSync(
        join(HERE, "..", "..", "src", "local", "whiteboard.html"),
        "utf8",
      );
    } catch {
      return `<!doctype html><p>Whiteboard HTML missing. Rebuild worker.</p>`;
    }
  }
}

/**
 * Loopback-only HTTP for menu bar + full-screen whiteboard.
 * Not exposed through the public relay.
 */
export function startLocalControlServer(opts: {
  host?: string;
  port: number;
  approvals: ApprovalManager;
  ownerId: string;
  getBoard?: () => unknown;
  listEvents?: (q: {
    limit?: number;
    since?: string;
    source?: string;
    verb?: string;
    includePrivate?: boolean;
  }) => unknown;
  /** Phase 2 world model (read-only, loopback only, never on the relay). */
  listWorldEntities?: (q: {
    type?: string;
    state?: string;
    includePrivate?: boolean;
  }) => unknown;
  getWorldEntity?: (id: string, includePrivate: boolean) => unknown;
  worldSummary?: (includePrivate: boolean) => unknown;
  /** Phase 3 meaning engine (owner-gated, loopback only, never on the relay). */
  listMeaningCandidates?: (q: {
    kind?: string;
    status?: string;
    sensitivity?: string;
    includePrivate?: boolean;
  }) => unknown;
  getMeaningCandidate?: (id: string, includePrivate: boolean) => unknown;
  meaningSummary?: (includePrivate: boolean) => unknown;
  decideMeaningCandidate?: (
    id: string,
    action: "accept" | "dismiss" | "correct",
    body?: { label?: string; note?: string },
  ) => unknown;
  rebuildMeaning?: () => unknown;
}): Server {
  const host = opts.host ?? "127.0.0.1";
  const whiteboard = loadWhiteboardHtml();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/board")) {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(whiteboard);
      return;
    }

    res.setHeader("content-type", "application/json");

    if (req.method === "GET" && url.pathname === "/healthz") {
      res.end(JSON.stringify({ ok: true, service: "ground-local-control" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/board") {
      try {
        if (!opts.getBoard) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "board unavailable" }));
          return;
        }
        res.end(JSON.stringify(opts.getBoard()));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      if (!opts.listEvents) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "events unavailable" }));
        return;
      }
      try {
        const limitParam = url.searchParams.get("limit");
        res.end(
          JSON.stringify(
            opts.listEvents({
              limit: limitParam != null ? Number(limitParam) : undefined,
              since: url.searchParams.get("since") ?? undefined,
              source: url.searchParams.get("source") ?? undefined,
              verb: url.searchParams.get("verb") ?? undefined,
              includePrivate: url.searchParams.get("includePrivate") === "1",
            }),
          ),
        );
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/world") {
      if (!opts.listWorldEntities || !opts.worldSummary) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "world unavailable" }));
        return;
      }
      try {
        const includePrivate = url.searchParams.get("includePrivate") === "1";
        res.end(
          JSON.stringify({
            summary: opts.worldSummary(includePrivate),
            entities: opts.listWorldEntities({
              type: url.searchParams.get("type") ?? undefined,
              state: url.searchParams.get("state") ?? undefined,
              includePrivate,
            }),
          }),
        );
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/world/entity") {
      if (!opts.getWorldEntity) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "world unavailable" }));
        return;
      }
      try {
        const id = url.searchParams.get("id") ?? "";
        const entity = opts.getWorldEntity(
          id,
          url.searchParams.get("includePrivate") === "1",
        );
        if (!entity) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        res.end(JSON.stringify(entity));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/meaning/candidates") {
      if (!opts.listMeaningCandidates) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "meaning unavailable" }));
        return;
      }
      try {
        res.end(
          JSON.stringify(
            opts.listMeaningCandidates({
              kind: url.searchParams.get("kind") ?? undefined,
              status: url.searchParams.get("status") ?? undefined,
              sensitivity: url.searchParams.get("sensitivity") ?? undefined,
              includePrivate: url.searchParams.get("includePrivate") === "1",
            }),
          ),
        );
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/meaning/candidate") {
      if (!opts.getMeaningCandidate) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "meaning unavailable" }));
        return;
      }
      try {
        const got = opts.getMeaningCandidate(
          url.searchParams.get("id") ?? "",
          url.searchParams.get("includePrivate") === "1",
        );
        if (!got) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        res.end(JSON.stringify(got));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/meaning/summary") {
      if (!opts.meaningSummary) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "meaning unavailable" }));
        return;
      }
      try {
        res.end(
          JSON.stringify(
            opts.meaningSummary(url.searchParams.get("includePrivate") === "1"),
          ),
        );
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/meaning/rebuild") {
      if (!opts.rebuildMeaning) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "meaning unavailable" }));
        return;
      }
      try {
        res.end(JSON.stringify(opts.rebuildMeaning()));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname.startsWith("/api/meaning/candidates/")
    ) {
      if (!opts.decideMeaningCandidate) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "meaning unavailable" }));
        return;
      }
      const parts = url.pathname.split("/");
      const id = parts[4];
      const action = parts[5];
      if (!id || (action !== "accept" && action !== "dismiss" && action !== "correct")) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        try {
          const parsed =
            body.trim().length > 0
              ? (JSON.parse(body) as { label?: string; note?: string })
              : undefined;
          res.end(
            JSON.stringify(opts.decideMeaningCandidate!(id, action, parsed)),
          );
        } catch (err) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/approvals") {
      try {
        const list = opts.approvals.list(opts.ownerId, {
          includeResolved: url.searchParams.get("all") === "1",
          limit: Number(url.searchParams.get("limit") ?? 20),
        });
        res.end(JSON.stringify({ approvals: list }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/approvals/")) {
      const parts = url.pathname.split("/");
      const id = parts[2];
      const action = parts[3];
      if (!id || (action !== "approve" && action !== "deny")) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        try {
          const decision = action === "approve" ? "approved" : "denied";
          const note =
            body.trim().length > 0
              ? (JSON.parse(body) as { note?: string }).note
              : undefined;
          const rec = opts.approvals.resolve(opts.ownerId, id, decision, note);
          res.end(JSON.stringify(rec));
        } catch (err) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });

  server.listen(opts.port, host, () => {
    // bound
  });
  return server;
}
