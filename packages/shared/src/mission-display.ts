/**
 * Truthful mission / queue presentation for Work UX and board snapshots.
 */

export type MissionDisplayState =
  | "intake"
  | "planning"
  | "queued"
  | "scheduled"
  | "implementing"
  | "waiting"
  | "verifying"
  | "ready_for_review"
  | "blocked"
  | "done"
  | "cancelled";

export type MissionDeliveryPresentation = {
  display_state: MissionDisplayState;
  display_state_label: string;
  current_step_id: string | null;
  supervision_state: string | null;
  has_active_supervisor_job: boolean;
  next_owner_action: string | null;
  blocker: string | null;
  needs_owner: boolean;
};

export type MissionDisplayInput = {
  id: string;
  status: string;
  markers?: Record<string, string | number | boolean | null>;
};

export type MissionQueueDisplayInput = {
  queue_state: string;
} | null;

const ACTIVE_SUPERVISOR_JOB = new Set([
  "queued",
  "preparing",
  "running",
  "cancelling",
  "awaiting_followup",
]);

const DISPLAY_LABEL: Record<MissionDisplayState, string> = {
  intake: "Intake",
  planning: "Plan ready",
  queued: "Queued",
  scheduled: "Scheduled",
  implementing: "Implementing",
  waiting: "Waiting",
  verifying: "Verifying",
  ready_for_review: "Ready for review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

export function isActiveSupervisorJobStatus(status: string | undefined): boolean {
  return ACTIVE_SUPERVISOR_JOB.has(String(status || ""));
}

export function missionLinkedJobIsActive(
  linkedJobIds: string[] | undefined,
  jobStatus: (id: string) => string | undefined,
): boolean {
  for (const id of linkedJobIds ?? []) {
    if (isActiveSupervisorJobStatus(jobStatus(id))) return true;
  }
  return false;
}

function markerString(
  markers: MissionDisplayInput["markers"],
  key: string,
): string | null {
  const raw = markers?.[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function baseFromMissionStatus(status: string): MissionDisplayState {
  switch (status) {
    case "intake":
    case "researching":
      return "intake";
    case "plan_ready":
      return "planning";
    case "approved":
    case "implementing":
      return "implementing";
    case "verifying":
      return "verifying";
    case "ready_for_review":
      return "ready_for_review";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    default:
      return "implementing";
  }
}

export type BlockReasonPresentation = {
  /** Short plain-language status (card primary line). */
  summary: string;
  /** Specific next step for the owner. */
  owner_step: string;
  /** Raw marker / gate text for expandable disclosure. */
  technical: string;
};

const GATE_OWNER_STEPS: Record<string, { summary: string; owner_step: string }> = {
  acceptance_evidence: {
    summary: "Verification evidence is missing or failed.",
    owner_step:
      "Review the verify-step output, fix the project, and re-run verification before staging review.",
  },
  not_reviewed: {
    summary: "Review is not finished yet.",
    owner_step:
      "Finish verification and submit for review, or cancel the project if you are stopping work.",
  },
  owner_release: {
    summary: "Waiting for your explicit release.",
    owner_step: "Review the implementation and authorize release when you are satisfied.",
  },
  steps_incomplete: {
    summary: "Not all planned steps are complete.",
    owner_step: "Resume implementation or adjust the contract before trying review again.",
  },
  no_succeeded_job: {
    summary: "No successful implementation job is linked yet.",
    owner_step: "Check the linked Cursor job finished successfully, or start a new implementation pass.",
  },
  stale_git_evidence: {
    summary: "Recorded git evidence no longer matches the workspace.",
    owner_step: "Re-run verification so evidence_git_head matches the current workspace HEAD.",
  },
  missing_git_evidence: {
    summary: "Git evidence was not recorded for this project.",
    owner_step: "Run verification from the supervisor workspace so git HEAD can be captured.",
  },
  usability_evidence: {
    summary: "Desktop/mobile QA evidence is missing or incomplete.",
    owner_step: "Run the required QA jobs and confirm both desktop and mobile markers succeeded.",
  },
  work_ui_evidence: {
    summary: "A checked Work UI result is required before review.",
    owner_step: "Capture the required desktop and mobile Work UI evidence, then submit for review.",
  },
  watchdog_connection_retry: {
    summary: "The executor kept retrying its connection without making progress.",
    owner_step: "Check executor availability, then resume with an available agent when ready.",
  },
  watchdog_stale_output: {
    summary: "The executor stopped producing progress updates.",
    owner_step: "Check the job output and executor, then resume or route the work to an available agent.",
  },
  missing_review_packet: {
    summary: "Review packet metadata is missing.",
    owner_step: "Submit for review with a review_packet_version after verification passes.",
  },
  contract_version_drift: {
    summary: "The plan changed after approval.",
    owner_step: "Return to plan review and re-approve the contract, or cancel this project.",
  },
  bad_status: {
    summary: "Project is in the wrong stage for that action.",
    owner_step: "Check mission status in chat and align the next step with verifying → review.",
  },
  no_contract: {
    summary: "This project has no execution contract.",
    owner_step: "Approve a mission contract before enqueueing or reviewing.",
  },
};

export function presentBlockReason(
  raw: string | null | undefined,
): BlockReasonPresentation | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const technical = raw.trim();

  // Acceptance runner identifiers are internal implementation details. They are
  // commonly emitted either as "acceptance <step> failed" or as the compact
  // `acceptance_<step> failed` form.
  const acceptanceFailed = /^(?:acceptance\s+\S+|acceptance_[\w-]+)\s+failed/i.exec(
    technical,
  );
  if (acceptanceFailed) {
    return {
      summary: "An automated verification step failed.",
      owner_step:
        "Open the job output, fix the failing check, then resume or retry the verify step.",
      technical,
    };
  }

  if (/waiting for an explicit resume/i.test(technical)) {
    return {
      summary: "Supervision paused after a cancel or handoff.",
      owner_step: "Tell Ground to resume the project, or cancel it if you want to stop.",
      technical,
    };
  }

  if (/^Owner checkpoint:/i.test(technical)) {
    const title = technical.replace(/^Owner checkpoint:\s*/i, "").trim();
    return {
      summary: title ? `Checkpoint: ${title}` : "Supervision paused for your decision.",
      owner_step: title
        ? `Approve or adjust the checkpoint (“${title}”) in chat, or cancel the project.`
        : "Respond to the checkpoint in chat, or cancel the project.",
      technical,
    };
  }

  const colon = technical.indexOf(":");
  const code = colon >= 0 ? technical.slice(0, colon).trim() : null;
  const message = colon >= 0 ? technical.slice(colon + 1).trim() : technical;
  const known = code ? GATE_OWNER_STEPS[code] : undefined;
  if (known) {
    return { ...known, technical };
  }

  if (/^step\s+\S+\s+exhausted/i.test(technical)) {
    return {
      summary: "A supervised step hit its retry limit.",
      owner_step:
        "Review the step output, fix the underlying issue, then resume or cancel the project.",
      technical,
    };
  }

  const summary =
    message.length > 140 ? `${message.slice(0, 137).trim()}…` : message || "This project is blocked.";
  return {
    summary,
    owner_step: "Resolve the blocker in chat or cancel the project if you want to stop.",
    technical,
  };
}

function nextOwnerAction(
  displayState: MissionDisplayState,
  blocker: string | null,
): string | null {
  if (displayState === "ready_for_review") {
    return "Review the implementation and authorize release when satisfied.";
  }
  if (displayState === "blocked") {
    return (
      presentBlockReason(blocker)?.owner_step ??
      "Resolve the blocker in chat or cancel the project if you want to stop."
    );
  }
  return null;
}

export function deriveMissionDeliveryPresentation(
  mission: MissionDisplayInput,
  queueEntry?: MissionQueueDisplayInput,
  hasActiveSupervisorJob?: boolean,
): MissionDeliveryPresentation {
  const markers = mission.markers ?? {};
  const supervisionState = markerString(markers, "supervision_state");
  const currentStepId = markerString(markers, "current_step_id");
  const blocker =
    markerString(markers, "block_reason") ??
    (queueEntry?.queue_state === "blocked"
      ? markerString(markers, "block_reason")
      : null);

  if (mission.status === "done" || mission.status === "cancelled") {
    const displayState = baseFromMissionStatus(mission.status);
    return {
      display_state: displayState,
      display_state_label: DISPLAY_LABEL[displayState],
      current_step_id: currentStepId,
      supervision_state: supervisionState,
      has_active_supervisor_job: hasActiveSupervisorJob === true,
      next_owner_action: null,
      blocker,
      needs_owner: false,
    };
  }

  let displayState = baseFromMissionStatus(mission.status);

  if (mission.status === "verifying") {
    displayState = "verifying";
  } else if (mission.status === "ready_for_review") {
    displayState = "ready_for_review";
  } else if (mission.status === "blocked") {
    displayState = "blocked";
  } else if (supervisionState === "waiting") {
    displayState = "waiting";
  } else if (hasActiveSupervisorJob) {
    displayState = "implementing";
  } else if (queueEntry) {
    const qs = queueEntry.queue_state;
    if (qs === "queued") displayState = "queued";
    else if (qs === "scheduled") displayState = "scheduled";
    else if (qs === "verifying") displayState = "verifying";
    else if (qs === "ready_for_review") displayState = "ready_for_review";
    else if (qs === "blocked") displayState = "blocked";
    else if (qs === "running" && mission.status !== "verifying") {
      displayState = "implementing";
    }
  }

  const needsOwner =
    displayState === "ready_for_review" || displayState === "blocked";

  return {
    display_state: displayState,
    display_state_label: DISPLAY_LABEL[displayState],
    current_step_id: currentStepId,
    supervision_state: supervisionState,
    has_active_supervisor_job: hasActiveSupervisorJob === true,
    next_owner_action: nextOwnerAction(displayState, blocker),
    blocker,
    needs_owner: needsOwner,
  };
}

export type NeedsYouRailEntry = {
  mission_id: string;
  title: string;
  display_state: MissionDisplayState;
  display_state_label: string;
  next_owner_action: string;
  blocker: string | null;
};

export function buildNeedsYouRail(
  missions: Array<
    MissionDisplayInput & {
      title: string;
      display_state?: MissionDisplayState;
      display_state_label?: string;
      next_owner_action?: string | null;
      blocker?: string | null;
      needs_owner?: boolean;
    }
  >,
): NeedsYouRailEntry[] {
  const out: NeedsYouRailEntry[] = [];
  for (const m of missions) {
    if (m.needs_owner !== true || !m.next_owner_action) continue;
    out.push({
      mission_id: m.id,
      title: String(m.title || "Project").trim(),
      display_state: m.display_state ?? baseFromMissionStatus(m.status),
      display_state_label:
        m.display_state_label ??
        DISPLAY_LABEL[m.display_state ?? baseFromMissionStatus(m.status)],
      next_owner_action: m.next_owner_action,
      blocker: m.blocker ?? null,
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}
