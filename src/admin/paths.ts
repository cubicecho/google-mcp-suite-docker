/**
 * Credential layout, mirroring google-mcp-suite's `loadConfig`. These resolve the
 * same paths the stdio servers read, so anything written here is picked up there.
 */
import os from "node:os";
import path from "node:path";

/** The config dir the stdio servers read; `GOOGLE_MCP_DIR` overrides `~/.google-mcp`. */
export function googleMcpDir(): string {
  const dir = process.env.GOOGLE_MCP_DIR?.trim();
  return dir ? dir : path.join(os.homedir(), ".google-mcp");
}

export function clientSecretPath(): string {
  const override = process.env.GOOGLE_MCP_CLIENT_SECRET?.trim();
  return override ? override : path.join(googleMcpDir(), "client_secret.json");
}

export function tokensDir(): string {
  return path.join(googleMcpDir(), "tokens");
}

export function tokenPath(account: string): string {
  return path.join(tokensDir(), `${account}.json`);
}

// Account labels become path segments (`tokens/<account>.json`) and the account
// segment of `/<account>/<service>`: same rule the suite enforces, so a label that
// works here works there and cannot traverse.
const ACCOUNT_RE = /^[A-Za-z0-9._%+@-]+$/;
export function validAccount(account: string): boolean {
  return ACCOUNT_RE.test(account) && !account.includes("..");
}
