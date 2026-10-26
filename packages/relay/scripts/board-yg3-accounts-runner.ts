/**
 * Read-only recent YG3 client accounts for Ground board (owner feed).
 * Uses the same Supabase `clients` + `client_users` sources as funnels growth.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type ClientRow = {
  id: string;
  name: string;
  created_at: string;
};

type ClientUserRow = {
  client_id: string;
  email: string;
  role: string | null;
};

async function main(): Promise<void> {
  const root = (
    process.env.GROUND_CONTROL_WORK_ROOT ||
    process.env.PARTHA_WORK_ROOT ||
    process.cwd()
  ).replace(/\/$/, "");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="))?.slice(8);
  const limit = Math.min(80, Math.max(1, Number(limitArg) || 40));

  const { sbSelect } = await import(pathToFileURL(join(root, "lib/supa.ts")).href);

  const clients = await sbSelect<ClientRow>("clients", {
    select: "id,name,created_at",
    filter: { is_test: "not.is.true", is_demo: "not.is.true" },
    order: "created_at.desc",
    limit,
  });

  const ids = clients.map((c) => c.id).filter(Boolean);
  const emailByClient = new Map<string, string>();
  if (ids.length) {
    const users = await sbSelect<ClientUserRow>("client_users", {
      select: "client_id,email,role",
      filter: { client_id: `in.(${ids.join(",")})` },
      order: "role.asc",
      limit: Math.min(2000, ids.length * 4),
    });
    for (const u of users) {
      const cid = u.client_id;
      const email = u.email ? String(u.email).trim() : "";
      if (!cid || !email || emailByClient.has(cid)) continue;
      emailByClient.set(cid, email);
    }
  }

  const items = clients.map((c) => ({
    id: c.id,
    name: c.name,
    email: emailByClient.get(c.id) ?? "",
    createdAt: c.created_at,
  }));

  process.stdout.write(JSON.stringify({ items }));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(message);
  process.exit(1);
});
