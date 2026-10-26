/** Map explicit control tokens to PTY bytes. Raw text is passed through. */
const CONTROL_MAP: Record<string, string> = {
  enter: "\r",
  return: "\r",
  newline: "\n",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
  "ctrl-z": "\x1a",
  "ctrl-l": "\x0c",
  "ctrl-u": "\x15",
  "ctrl-a": "\x01",
  "ctrl-e": "\x05",
  "ctrl-w": "\x17",
  tab: "\t",
  escape: "\x1b",
  esc: "\x1b",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
};

export const SUPPORTED_CONTROL_KEYS = Object.keys(CONTROL_MAP).sort();

export function encodeSessionInput(opts: {
  data?: string;
  keys?: string[];
  submit?: boolean;
}): string {
  let out = "";
  if (opts.data != null) out += opts.data;
  if (opts.keys) {
    for (const key of opts.keys) {
      const normalized = key.trim().toLowerCase();
      const mapped = CONTROL_MAP[normalized];
      if (!mapped) {
        throw new Error(
          `unsupported control key "${key}". Supported: ${SUPPORTED_CONTROL_KEYS.join(", ")}`,
        );
      }
      out += mapped;
    }
  }
  if (opts.submit) out += "\r";
  return out;
}
