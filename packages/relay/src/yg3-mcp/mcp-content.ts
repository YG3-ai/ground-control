export type McpTextBlock = { type?: string; text?: string };

export function mcpTextBlocks(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  const out: string[] = [];
  for (const block of payload) {
    if (!block || typeof block !== "object") continue;
    const b = block as McpTextBlock;
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
  }
  return out;
}

export function joinMcpText(payload: unknown): string {
  return mcpTextBlocks(payload).join("\n").trim();
}

export function parseEmbeddedJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1));
    return o && typeof o === "object" && !Array.isArray(o)
      ? (o as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseEmbeddedJsonArray(text: string): unknown[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const a = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(a) ? a : null;
  } catch {
    return null;
  }
}

/** Pretty-printed JSON objects separated by `},` newlines (YG3 list_projects shape). */
export function parsePrettyJsonObjectSequence(text: string): Record<string, unknown>[] {
  const objs: Record<string, unknown>[] = [];
  const parts = text.split(/\n\s*},\s*\n/);
  for (const part of parts) {
    let chunk = part.trim();
    if (!chunk.startsWith("{")) continue;
    if (!chunk.endsWith("}")) chunk += "\n}";
    try {
      const o = JSON.parse(chunk);
      if (o && typeof o === "object" && !Array.isArray(o)) {
        objs.push(o as Record<string, unknown>);
      }
    } catch {
      /* skip chunk */
    }
  }
  return objs;
}
