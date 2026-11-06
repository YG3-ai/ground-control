# Ground execution watchdog

Ground supervision persists a mission/job association before a job is considered running. On each supervisor scan it checks linked active jobs for fresh streamed output and repeated connection-retry messages. By default, five minutes without output or three connection retries cancels the job and blocks the mission with durable timeline evidence.

`supervisor.job_stale_sec` and `supervisor.connection_retry_limit` tune those bounds. A disabled or previously marked-unavailable requested executor is skipped in favor of an enabled Codex/Cursor fallback; if none is available, the mission is blocked instead of repeatedly dispatching.

Contracts may set `evidence.require_work_ui_evidence: true`. Such missions cannot enter review until `work_ui_evidence=pass` and `work_ui_evidence_at` are recorded after a real Work UI check. The watchdog can stop local managed jobs; it cannot detect progress from an executor that emits no output until the stale interval expires.
