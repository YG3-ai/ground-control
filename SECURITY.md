# Security

## Reporting

If you believe you have found a security issue, please report it responsibly. Do not open a public issue for exploit details.

Contact the maintainers through your usual YG3 / Ground Control channel, or open a GitHub Security Advisory once the repository is public.

## Sensitive data

Never commit:

- `.env`, live `config.yaml`, or OAuth tokens
- `data/relay/yg3/raw/` or workspace selection files from a real machine
- Absolute home paths, production URLs, or board keys in docs or tests

Use `.env.example` placeholders and temp directories in tests.

## Hybrid remote approval (Ground MCP)

The owner may enable **hybrid_remote**: ChatGPT-explicit consent can approve a mission plan without a Mac dialog, within a bounded routine scope (`read_code_test_terminal`). Destructive actions, external sends/deploys, credential changes, and material scope expansions still require Mac confirmation via `request_local_approval` or `approve_mission` with `require_dialog`. Agents must not downgrade sensitive work to chat-only approval or re-prompt for plan approval on already-approved missions.
