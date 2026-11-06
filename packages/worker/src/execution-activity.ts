/** Durable, token-free retry state, separate from quoted tool output. */
export function nextRetryStreak(previous: number, chunk: {stdout?: string; stderr?: string}): number {
 let streak = previous;
 const retry = /(?:connection (?:retry|lost|failed)|retrying (?:the )?connection|reconnect(?:ing)?)/i;
 for (const line of (chunk.stdout ?? "").split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
   const event = JSON.parse(line) as {type?: string; error?: unknown; message?: unknown; item?: {type?: string}};
   if (event.type === "error" || event.type === "turn.failed") {
    if (retry.test(JSON.stringify(event.error ?? event.message ?? ""))) streak++;
   } else if (event.type === "item.completed" || event.type === "turn.completed") streak = 0;
  } catch { if (!line.trim().startsWith("{")) streak = 0; }
 }
 for (const line of (chunk.stderr ?? "").split(/\r?\n|\\n/)) {
  if (!line.trim()) continue;
  if (retry.test(line)) streak++; else streak = 0;
 }
 return streak;
}
