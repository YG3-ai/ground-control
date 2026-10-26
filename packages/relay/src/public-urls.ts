/** Validate public install/donation URLs for anonymous board CTAs. */
export function normalizePublicHttpUrl(raw: string | undefined | null): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const DEFAULT_PUBLIC_REPO_URL = "https://github.com/YG3-ai/ground-control";
