import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface AuthCodeRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string | null;
  scopes: string;
  expires_at: number;
}

export interface TokenRow {
  token_hash: string;
  kind: "access" | "refresh";
  client_id: string;
  owner_id: string;
  scopes: string;
  resource: string | null;
  expires_at: number;
  refresh_of: string | null;
}

export class OAuthStore {
  readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        resource TEXT,
        scopes TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        client_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        resource TEXT,
        expires_at INTEGER NOT NULL,
        refresh_of TEXT
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.db
      .prepare(
        `INSERT INTO clients(client_id, data) VALUES(?, ?)
         ON CONFLICT(client_id) DO UPDATE SET data=excluded.data`,
      )
      .run(client.client_id, JSON.stringify(client));
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db
      .prepare(`SELECT data FROM clients WHERE client_id = ?`)
      .get(clientId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as OAuthClientInformationFull) : undefined;
  }

  saveAuthCode(row: AuthCodeRow): void {
    this.db
      .prepare(
        `INSERT INTO auth_codes(code, client_id, redirect_uri, code_challenge, resource, scopes, expires_at)
         VALUES(@code, @client_id, @redirect_uri, @code_challenge, @resource, @scopes, @expires_at)`,
      )
      .run(row);
  }

  peekAuthCode(code: string): AuthCodeRow | undefined {
    return this.db.prepare(`SELECT * FROM auth_codes WHERE code = ?`).get(code) as
      | AuthCodeRow
      | undefined;
  }

  takeAuthCode(code: string): AuthCodeRow | undefined {
    const row = this.peekAuthCode(code);
    if (!row) return undefined;
    this.db.prepare(`DELETE FROM auth_codes WHERE code = ?`).run(code);
    return row;
  }

  saveToken(row: TokenRow): void {
    this.db
      .prepare(
        `INSERT INTO tokens(token_hash, kind, client_id, owner_id, scopes, resource, expires_at, refresh_of)
         VALUES(@token_hash, @kind, @client_id, @owner_id, @scopes, @resource, @expires_at, @refresh_of)`,
      )
      .run(row);
  }

  getToken(hash: string): TokenRow | undefined {
    return this.db.prepare(`SELECT * FROM tokens WHERE token_hash = ?`).get(hash) as
      | TokenRow
      | undefined;
  }

  deleteToken(hash: string): void {
    this.db.prepare(`DELETE FROM tokens WHERE token_hash = ?`).run(hash);
  }
}
