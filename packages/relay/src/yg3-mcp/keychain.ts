/** macOS Keychain service name for YG3 OAuth secrets. */
export const YG3_KEYCHAIN_SERVICE = "ground-control-yg3-mcp";
export const YG3_KEYCHAIN_TOKEN_ACCOUNT = "oauth-tokens";

export function buildKeychainAddArgs(secret: string): string[] {
  return [
    "add-generic-password",
    "-U",
    "-s",
    YG3_KEYCHAIN_SERVICE,
    "-a",
    YG3_KEYCHAIN_TOKEN_ACCOUNT,
    "-w",
    secret,
  ];
}

export function buildKeychainFindArgs(): string[] {
  return [
    "find-generic-password",
    "-s",
    YG3_KEYCHAIN_SERVICE,
    "-a",
    YG3_KEYCHAIN_TOKEN_ACCOUNT,
  ];
}

export function buildKeychainDeleteArgs(): string[] {
  return [
    "delete-generic-password",
    "-s",
    YG3_KEYCHAIN_SERVICE,
    "-a",
    YG3_KEYCHAIN_TOKEN_ACCOUNT,
  ];
}
