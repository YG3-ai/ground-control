import { DEFAULT_PUBLIC_REPO_URL, normalizePublicHttpUrl } from "./public-urls.js";

export interface RelayConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  jwtSecret: string;
  workerToken: string;
  ownerId: string;
  ownerApprovalSecret: string;
  /**
   * Read-only secret for the phone board at / or /board?k=…
   * Defaults to OWNER_APPROVAL_SECRET if unset.
   */
  boardViewSecret: string;
  /**
   * When true, GET / (and /board) and board read APIs work without the owner key.
   * Mutations always require the board key. Default false.
   */
  boardPublicReadOnly: boolean;
  /** scrypt$salt$hex — unlock password for public board (BOARD_UNLOCK_PASSWORD_HASH). */
  boardUnlockPasswordHash: string | null;
  allowDevToken: boolean;
  dataDir: string;
  /** Public install CTA (GitHub or docs). */
  publicRepoUrl: string;
  /** Optional Stripe/support URL; hidden when unset. */
  publicDonationUrl: string | null;
}

export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const publicBaseUrl = env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8787";
  const jwtSecret = env.RELAY_JWT_SECRET;
  const workerToken = env.WORKER_TOKEN;
  const ownerApprovalSecret = env.OWNER_APPROVAL_SECRET;

  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error("RELAY_JWT_SECRET must be set (min 32 chars)");
  }
  if (!workerToken || workerToken.length < 24) {
    throw new Error("WORKER_TOKEN must be set (min 24 chars)");
  }
  if (!ownerApprovalSecret || ownerApprovalSecret.length < 4) {
    throw new Error("OWNER_APPROVAL_SECRET must be set (min 4 chars)");
  }

  const boardViewSecret = (
    env.BOARD_VIEW_SECRET?.trim() || ownerApprovalSecret.trim()
  );

  const unlockHash = env.BOARD_UNLOCK_PASSWORD_HASH?.trim() || null;

  return {
    host: env.RELAY_HOST ?? "127.0.0.1",
    port: Number(env.RELAY_PORT ?? "8787"),
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ""),
    jwtSecret: jwtSecret.trim(),
    workerToken: workerToken.trim(),
    ownerId: env.OWNER_ID ?? "owner-local",
    ownerApprovalSecret: ownerApprovalSecret.trim(),
    boardViewSecret,
    boardPublicReadOnly: env.BOARD_PUBLIC_READ_ONLY === "1",
    boardUnlockPasswordHash: unlockHash,
    allowDevToken: env.ALLOW_DEV_TOKEN === "1",
    dataDir: env.RELAY_DATA_DIR ?? "./data/relay",
    publicRepoUrl:
      normalizePublicHttpUrl(env.PUBLIC_REPO_URL) ?? DEFAULT_PUBLIC_REPO_URL,
    publicDonationUrl: normalizePublicHttpUrl(env.PUBLIC_DONATION_URL),
  };
}
