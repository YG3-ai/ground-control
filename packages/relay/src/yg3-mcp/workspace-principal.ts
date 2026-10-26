import type { ParsedWhoami } from "./envelope-parsers.js";

export type Yg3PrincipalTier =
  | "client_scoped"
  | "agency"
  | "super_admin"
  | "unknown";

export function principalTierFromWhoami(
  whoami: ParsedWhoami | null,
): Yg3PrincipalTier {
  if (!whoami) return "unknown";
  const role = (whoami.role || "").toLowerCase();
  const principal = (whoami.principalType || "").toLowerCase();
  if (
    role.includes("super") ||
    principal.includes("super") ||
    role === "superadmin" ||
    principal === "superadmin"
  ) {
    return "super_admin";
  }
  if (whoami.scopeClientId) return "client_scoped";
  if (role.includes("agency") || principal.includes("agency")) {
    return "agency";
  }
  if (role.includes("admin") || principal.includes("admin")) {
    return "super_admin";
  }
  return "agency";
}
