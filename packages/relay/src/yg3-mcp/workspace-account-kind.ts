import type { ParsedClientRow } from "./workspace-resolve.js";
import {
  displayNameFromSnapshot,
  isAgencyWorkspaceSnapshot,
  isLikelyAgencyClientAccount,
  slugFromSnapshot,
} from "./workspace-owner-select.js";

export type WorkspaceAccountKind = "client" | "agency";

export function classifyWorkspaceAccountKind(
  row: ParsedClientRow,
  snapshotPayload?: unknown,
): WorkspaceAccountKind {
  if (snapshotPayload && isAgencyWorkspaceSnapshot(snapshotPayload)) {
    return "agency";
  }
  const name =
    (snapshotPayload ? displayNameFromSnapshot(snapshotPayload) : null) ??
    row.name;
  const slug =
    (snapshotPayload ? slugFromSnapshot(snapshotPayload) : null) ?? row.slug;
  if (isLikelyAgencyClientAccount(name, slug)) return "agency";
  return "client";
}
