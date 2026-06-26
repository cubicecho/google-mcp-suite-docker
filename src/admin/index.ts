/**
 * Admin web UI for managing google-mcp-suite credentials.
 *
 * Writes the exact files the stdio servers read (see google-mcp-suite's
 * `dist/auth/config.js` / `oauth.js`):
 *
 *   <GOOGLE_MCP_DIR>/client_secret.json     shared OAuth app  (0600)
 *   <GOOGLE_MCP_DIR>/tokens/<account>.json  per-account token (0600, 0700 dir)
 *
 * This barrel exposes the proxy-facing surface; see the sibling modules for the
 * implementation (paths, clientSecret, accounts, oauth, web, routes).
 */
export { mountAdmin } from "./routes.js";
export { validAccount } from "./paths.js";
export { accountAuthorized, authorizedAccounts } from "./accounts.js";
