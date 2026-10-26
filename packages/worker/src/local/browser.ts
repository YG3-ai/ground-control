import { spawn } from "node:child_process";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export type OpenUrlResult = {
  ok: true;
  url: string;
  opened_with: "open";
};

/**
 * Open a URL in the owner's default browser (macOS `open`).
 * Only http/https — no file:, javascript:, etc.
 */
export async function openUrlInBrowser(urlRaw: string): Promise<OpenUrlResult> {
  let parsed: URL;
  try {
    parsed = new URL(urlRaw);
  } catch {
    throw new Error("invalid url");
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`protocol not allowed: ${parsed.protocol} (http/https only)`);
  }
  if (urlRaw.length > 2000) {
    throw new Error("url too long");
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/open", [parsed.toString()], {
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`open exited ${code}`));
    });
  });

  return { ok: true, url: parsed.toString(), opened_with: "open" };
}
