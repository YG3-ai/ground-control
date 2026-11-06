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

The owner may enable **hybrid_remote** and **permanent Owner Control** (`owner_control_mode: permanent`): authenticated ChatGPT owner instructions authorize routine local work (repo edits, shell, tests, builds, safe restarts, owner-instance deploy, self-repair) without duplicate Mac dialogs, within logging. Destructive deletion, financial actions, external representational communication, credential/access changes, ambiguous irreversible operations, and `open_url` (by default) still require Mac confirmation. Unauthenticated MCP callers fail closed. Agents must not downgrade sensitive work to chat-only approval or re-prompt for plan approval on already-approved missions.
