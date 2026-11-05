# Advisor: deterministic mission coordination

Advisor is Ground Control's rule-based coordination layer for Cursor, Kimi,
and Codex. It is not another AI agent and does not make model calls.

The conversational coordinator is separate. ChatGPT is the default documented
client; Grok or another bot can take that role when it can connect to the same
MCP tools. Switching coordinators does not transfer private chat memory. It
works because each coordinator reads the durable mission packet from Ground
Control before acting.

For an attention-friendly workflow, the board should present one current
focus, one next queued item, and only decisions that need the owner. Background
health checks and unchanged queues remain quiet.

## Responsibilities

Advisor owns operational decisions that can be made from recorded state:

- keep one approved mission plan as the source of truth;
- serialize writers in the same workspace;
- route queued work in a stable order;
- observe process, relay, output, and test signals;
- classify known failures and apply bounded recovery rules;
- notify the owner when a decision or new authority is required.

Advisor does not judge whether prose or code is semantically correct. That
requires an agent or a human review. It only evaluates concrete signals and
rules.

## Shared mission packet

Every managed agent run receives the same bounded packet:

- mission id, goal, workspace, and approved scope;
- plan revision and approval revision;
- current step and definition of done;
- findings and decisions that remain relevant;
- linked jobs, changed files, test evidence, and known blockers;
- the previous agent's structured handoff, when agents switch.

Changing the plan creates a new revision and invalidates the old approval.
Chat history is supporting context, not mission state.

## Coordination rules

1. One agent may write to a workspace at a time.
2. Read-only research may run separately when it uses an isolated worktree or
   cannot race with the active writer.
3. Resume the current agent session when it is healthy.
4. Prefer the agent selected by the owner or mission configuration.
5. Wait through a configured rate-limit cooldown before considering a
   fallback.
6. Switch agents only to an allowed fallback and only from a recorded
   checkpoint. Never silently broaden scope.
7. Queue eligible work FIFO within a workspace. Priority may break ties, but
   queued work never preempts an active writer.
8. Start the next eligible item after the active item reaches a terminal state
   and releases its workspace lock.

## Token boundary

Advisor checks are token-free:

- relay socket connected and heartbeats acknowledged;
- agent process running or exited;
- last structured event or output timestamp;
- workspace lock ownership;
- file, diff, and test-result evidence already produced by a run;
- retry counts, cooldowns, and queue position.

Starting, resuming, or sending a follow-up to Cursor, Kimi, or Codex invokes a
model and can consume tokens. Those actions are execution, not health checks.
Advisor must label them as such and never use them as routine pings. An
optional agent check-in may be enabled explicitly, with a budget and retry
limit.

## Failure rules

| Signal | Default action | Model tokens |
| --- | --- | --- |
| Relay disconnected | Reconnect with capped exponential backoff | No |
| Agent process still running with recent output | Continue observing | No |
| No output or state change past the stale threshold | Notify owner; keep process state intact | No |
| Recognized rate limit | Hold queue until cooldown expires | No |
| Authentication failure | Pause and notify owner | No |
| Approval or scope missing | Pause for owner decision | No |
| Known transient network exit | Requeue only when retry policy permits | The later resumed run does |
| Repeated or unknown failure | Mark blocked and notify owner | No |

Retries use the original mission id and idempotency key. Advisor never creates
an unbounded loop. The default recovery budget is three transport reconnects;
agent-run retries and fallback agents remain disabled until configured.

## Notifications

Notify only when the owner can act or the state materially changes:

- plan ready for approval;
- mission blocked or approval missing;
- retry budget exhausted;
- fallback agent requested;
- next queued mission started;
- mission completed.

Healthy heartbeats and unchanged queues stay quiet.
