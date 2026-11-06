# Advisor reconciliation evidence

Jacqueline's Advisor architecture in PR #1 (921c38d) is authoritative. Delivery v2, recovery and watchdog behavior extend that coordination model.

The combined version enforces revision-bound, explicit plan approval; mission-linked jobs; FIFO workspace serialization; durable context and handoffs; launch-time usage checks; persisted execution settings; acceptance and review gates. Research can precede plan approval. Late callbacks preserve stopped missions. Consecutive retry state persists and resets on progress; queued waiting is not an output stall. MCP tools and worker RPC expose mission_id and submit_mission_plan.

Verified locally on 2026-11-05:

- Worker: 167 passed, 16 skipped (including Docker-gated and platform fixtures).
- Shared: 18 passed.
- Scoped relay privacy, YG3 and Advisor MCP wiring: 66 passed.
- Typecheck, build, setup tests, release tests and dependency-license checks passed.
- A managed fixture progresses through dispatch, handoff, acceptance and review, recording exactly one usage start.
- Cancellation, revision invalidation, preapproval research, unavailable-executor fallback, waiting queues and historical retry resets have regression coverage.
- CI builds shared dependencies before running shared and worker suites, and includes the MCP wiring test.

The broader npm test run was bounded to 120 seconds. Its worker/shared suites passed; the unchanged World UI video-request case timed out, and the relay runner did not finish within that bound. This is not represented as a fully green broad UI suite.

Private machine configuration, environment files, data and historical internal repository objects must not be published. Runtime rollout and GitHub publication are verified separately from this candidate evidence.

Fresh-clone CI exposed a missing shared-package emit before downstream typechecking. Restored the shared typecheck emit used by the public baseline and declared the relay icon builder Python/Pillow dependency explicitly in CI and setup documentation.
