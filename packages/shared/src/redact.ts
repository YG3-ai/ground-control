/**
 * Best-effort secret redaction before returning text to ChatGPT / OpenAI.
 * Anything returned via MCP is shared with OpenAI — do not rely on this alone.
 */

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: "aws_secret",
    re: /(?:aws_secret_access_key|secret_access_key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/gi,
  },
  {
    name: "generic_api_key",
    re: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer)\s*[:=]\s*["']?[A-Za-z0-9_\-.]{20,}["']?/gi,
  },
  {
    name: "openai_key",
    re: /\bsk-(?:proj-)?[A-Za-z0-9_\-]{20,}\b/g,
  },
  {
    name: "github_pat",
    re: /\bghp_[A-Za-z0-9]{36,}\b/g,
  },
  {
    name: "github_fine_grained",
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    name: "private_key_block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  {
    name: "cursor_api_key",
    re: /\bkey_[A-Za-z0-9]{20,}\b/g,
  },
];

export const REDACTION_DISCLAIMER =
  "Redaction is best-effort. Anything returned to ChatGPT is shared with OpenAI.";

export function redactSecrets(input: string): { text: string; redacted: boolean } {
  let text = input;
  let redacted = false;
  for (const { re } of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) {
      redacted = true;
      re.lastIndex = 0;
      text = text.replace(re, "[REDACTED]");
    }
  }
  return { text, redacted };
}

export function boundOutput(
  input: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(input, "utf8");
  if (buf.byteLength <= maxBytes) {
    return { text: input, truncated: false };
  }
  const sliced = buf.subarray(0, maxBytes).toString("utf8");
  return {
    text: sliced + "\n…[truncated]",
    truncated: true,
  };
}
