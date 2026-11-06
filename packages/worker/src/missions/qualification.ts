import { z } from "zod";
import type { MissionRecord } from "./store.js";

/** Schema version for the qualification intake packet (not mission contract version). */
export const QUALIFICATION_PACKET_SCHEMA_VERSION = 1;

export const QualificationAcceptanceTestSchema = z.object({
  id: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  command: z.string().max(2000).optional(),
});

export const QualificationOwnerCheckpointSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  when: z.enum([
    "before_implement",
    "after_implement",
    "before_verify",
    "before_release",
  ]),
  detail: z.string().max(2000).optional(),
});

export const QualificationDeploymentPolicySchema = z.object({
  mode: z.enum(["no_production", "staging_only", "owner_release_required"]),
  notes: z.string().max(2000).optional(),
});

export const QualificationPacketSchema = z.object({
  version: z.literal(QUALIFICATION_PACKET_SCHEMA_VERSION),
  objective: z.string().min(1).max(2000),
  context: z.string().min(1).max(8000),
  scope_in: z.array(z.string().min(1).max(500)).min(1).max(40),
  scope_out: z.array(z.string().max(500)).max(40).default([]),
  acceptance_tests: z.array(QualificationAcceptanceTestSchema).min(1).max(20),
  constraints: z.array(z.string().max(500)).max(40).default([]),
  risk: z.string().min(1).max(4000),
  workspace: z.string().min(1).max(200),
  /** Host agent selected for the qualified implementation work. */
  execution_agent: z.enum(["cursor", "codex"]).default("codex"),
  deployment_policy: QualificationDeploymentPolicySchema,
  owner_checkpoints: z.array(QualificationOwnerCheckpointSchema).max(15).default([]),
});

export type QualificationPacket = z.infer<typeof QualificationPacketSchema>;
export type QualificationOwnerCheckpoint = z.infer<
  typeof QualificationOwnerCheckpointSchema
>;

const QUALIFICATION_MARKER = "qualification_packet_json";
export const GROUND_DELIVERY_V2_MARKER = "ground_delivery_v2";

export function isGroundDeliveryV2Mission(m: MissionRecord): boolean {
  if (m.markers[GROUND_DELIVERY_V2_MARKER] === true) return true;
  return m.markers.ground_delivery_version === 2;
}

export function qualificationFromMission(m: MissionRecord): QualificationPacket | null {
  const raw = m.markers[QUALIFICATION_MARKER];
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return QualificationPacketSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function qualificationMarkerPayload(packet: QualificationPacket): {
  qualification_packet_json: string;
  qualification_packet_version: number;
  ground_delivery_v2: true;
} {
  return {
    qualification_packet_json: JSON.stringify(packet),
    qualification_packet_version: packet.version,
    ground_delivery_v2: true,
  };
}

export type QualificationValidationResult =
  | { ok: true; packet: QualificationPacket }
  | { ok: false; code: string; message: string };

export function validateQualificationForMission(
  m: MissionRecord,
  packet: QualificationPacket,
): QualificationValidationResult {
  if (m.workspace && m.workspace !== packet.workspace) {
    return {
      ok: false,
      code: "workspace_mismatch",
      message: `qualification workspace ${packet.workspace} does not match mission workspace ${m.workspace}`,
    };
  }
  const ids = new Set<string>();
  for (const cp of packet.owner_checkpoints) {
    if (ids.has(cp.id)) {
      return {
        ok: false,
        code: "duplicate_checkpoint_id",
        message: `duplicate owner checkpoint id ${cp.id}`,
      };
    }
    ids.add(cp.id);
  }
  const testIds = new Set<string>();
  for (const t of packet.acceptance_tests) {
    if (testIds.has(t.id)) {
      return {
        ok: false,
        code: "duplicate_acceptance_test_id",
        message: `duplicate acceptance test id ${t.id}`,
      };
    }
    testIds.add(t.id);
  }
  return { ok: true, packet };
}

export function assertQualificationForV2Approval(m: MissionRecord): QualificationPacket {
  if (!isGroundDeliveryV2Mission(m)) {
    throw new Error("internal: assertQualificationForV2Approval on non-v2 mission");
  }
  const packet = qualificationFromMission(m);
  if (!packet) {
    throw new Error("ground delivery v2: valid qualification_packet_json required before approve");
  }
  const gate = validateQualificationForMission(m, packet);
  if (!gate.ok) {
    throw new Error(`ground delivery v2: ${gate.message}`);
  }
  return gate.packet;
}
