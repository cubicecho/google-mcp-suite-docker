/**
 * Admin web UI for managing google-mcp-suite credentials.
 *
 * Writes the exact files the stdio servers read (see google-mcp-suite's
 * `dist/auth/config.js` / `oauth.js`):
 *
 *   <GOOGLE_MCP_DIR>/client_secret.json     shared OAuth app  (0600)
 *   <GOOGLE_MCP_DIR>/tokens/<account>.json  per-account token (0600, 0700 dir)
 *
 * Tokens are minted with the same library (`google-auth-library`), the same
 * `SCOPES`, the same offline/consent/PKCE flow, and persisted as the same
 * `JSON.stringify(tokens)` bytes, so an account authorized here is
 * indistinguishable from one authorized via `google-mcp-doctor auth`.
 *
 * The browser consent uses a loopback redirect (`http://localhost:<port>`,
 * always valid for a Desktop OAuth client). When the UI is reached locally the
 * callback auto-completes; when it is remote the user pastes the redirected
 * URL back in (the headless fallback).
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Express, Request, Response, NextFunction } from "express";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { SCOPES } from "google-mcp-suite/dist/auth/config.js";

// --- Credential layout (mirrors google-mcp-suite's loadConfig) ---------------

/** The config dir the stdio servers read; `GOOGLE_MCP_DIR` overrides `~/.google-mcp`. */
function googleMcpDir(): string {
  const dir = process.env.GOOGLE_MCP_DIR?.trim();
  return dir ? dir : path.join(os.homedir(), ".google-mcp");
}

function clientSecretPath(): string {
  const override = process.env.GOOGLE_MCP_CLIENT_SECRET?.trim();
  return override ? override : path.join(googleMcpDir(), "client_secret.json");
}

function tokensDir(): string {
  return path.join(googleMcpDir(), "tokens");
}

// Account labels become path segments (`tokens/<account>.json`): same rule the
// suite enforces, so a label that works here works there and cannot traverse.
const ACCOUNT_RE = /^[A-Za-z0-9._%+@-]+$/;
function validAccount(account: string): boolean {
  return ACCOUNT_RE.test(account) && !account.includes("..");
}

interface ClientKeys {
  client_id: string;
  client_secret: string;
}

/** Read the shared OAuth client (`installed` or `web` shape), or undefined if absent/invalid. */
function loadClientKeys(): ClientKeys | undefined {
  const p = clientSecretPath();
  if (!existsSync(p)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as {
      installed?: Partial<ClientKeys>;
      web?: Partial<ClientKeys>;
    };
    const keys = raw.installed ?? raw.web;
    if (keys?.client_id && keys.client_secret) {
      return { client_id: keys.client_id, client_secret: keys.client_secret };
    }
  } catch {
    /* fall through to undefined */
  }
  return undefined;
}

/** The loopback redirect URI; matched at both authorize and token-exchange time. */
function redirectUri(): string {
  const base =
    process.env.OAUTH_REDIRECT_BASE?.trim() ||
    `http://localhost:${process.env.PORT ?? 3000}`;
  return `${base.replace(/\/+$/, "")}/admin/oauth/callback`;
}

// --- Pending consent flows ---------------------------------------------------

interface Pending {
  codeVerifier: string;
  account: string;
  redirectUri: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, Pending>();

function sweepPending(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [state, p] of pending) {
    if (p.createdAt < cutoff) pending.delete(state);
  }
}

// --- OAuth -------------------------------------------------------------------

async function startAuth(account: string): Promise<{ authUrl: string; state: string }> {
  const keys = loadClientKeys();
  if (!keys) throw new Error("No client_secret.json yet — upload the OAuth client first.");

  const redirect = redirectUri();
  const client = new OAuth2Client(keys.client_id, keys.client_secret, redirect);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  if (!codeChallenge) throw new Error("PKCE challenge generation failed.");

  const state = randomBytes(16).toString("hex");
  const loginHint = account.includes("@") ? account : undefined;
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });

  sweepPending();
  pending.set(state, { codeVerifier, account, redirectUri: redirect, createdAt: Date.now() });
  return { authUrl, state };
}

/** Exchange an authorization code for tokens and persist them exactly as the suite does. */
async function completeAuth(state: string, code: string): Promise<string> {
  const p = pending.get(state);
  if (!p) throw new Error("Unknown or expired authorization (state mismatch). Start again.");

  const keys = loadClientKeys();
  if (!keys) throw new Error("client_secret.json is missing.");

  const client = new OAuth2Client(keys.client_id, keys.client_secret, p.redirectUri);
  const { tokens } = await client.getToken({ code, codeVerifier: p.codeVerifier });

  const dir = tokensDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mkdir's mode only applies on create; tighten a pre-existing dir.
  const file = path.join(dir, `${p.account}.json`);
  rmSync(file, { force: true }); // recreate so 0600 applies to fresh bytes, never a looser pre-existing mode.
  writeFileSync(file, JSON.stringify(tokens), { mode: 0o600 });

  pending.delete(state);
  return p.account;
}

// --- Account inventory -------------------------------------------------------

interface AccountInfo {
  account: string;
  scopes: number;
  expiry: number | null;
  hasRefresh: boolean;
}

function listAccounts(): AccountInfo[] {
  const dir = tokensDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const account = f.replace(/\.json$/, "");
      let scopes = 0;
      let expiry: number | null = null;
      let hasRefresh = false;
      try {
        const t = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as {
          scope?: string;
          expiry_date?: number;
          refresh_token?: string;
        };
        scopes = t.scope ? t.scope.split(/\s+/).filter(Boolean).length : 0;
        expiry = typeof t.expiry_date === "number" ? t.expiry_date : null;
        hasRefresh = Boolean(t.refresh_token);
      } catch {
        /* show the file even if it is unparseable */
      }
      return { account, scopes, expiry, hasRefresh };
    })
    .sort((a, b) => a.account.localeCompare(b.account));
}

function saveClientSecret(body: unknown): void {
  const parsed =
    typeof body === "string" ? (JSON.parse(body) as unknown) : (body as unknown);
  const raw = parsed as { installed?: Partial<ClientKeys>; web?: Partial<ClientKeys> };
  const keys = raw?.installed ?? raw?.web;
  if (!keys?.client_id || !keys.client_secret) {
    throw new Error('Invalid client secret: expected an "installed" or "web" object with client_id/client_secret.');
  }
  const dir = googleMcpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = clientSecretPath();
  rmSync(p, { force: true });
  writeFileSync(p, JSON.stringify(parsed), { mode: 0o600 });
}

// --- HTTP --------------------------------------------------------------------

/** HTTP Basic gate for the whole admin surface. Open (with a startup warning) if unset. */
function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const password = process.env.ADMIN_PASSWORD?.trim();
  if (!password) return next();
  const user = process.env.ADMIN_USER?.trim() || "admin";
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    const u = decoded.slice(0, sep);
    const p = decoded.slice(sep + 1);
    if (u === user && p === password) return next();
  }
  res
    .set("WWW-Authenticate", 'Basic realm="google-mcp admin"')
    .status(401)
    .send("Authentication required.");
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export function mountAdmin(app: Express): void {
  app.get("/admin", adminAuth, (_req, res) => {
    res.type("html").send(PAGE);
  });

  app.get("/admin/api/state", adminAuth, (_req, res) => {
    res.json({
      clientSecret: loadClientKeys() !== undefined,
      accounts: listAccounts(),
      scopes: SCOPES,
      dir: googleMcpDir(),
      redirectUri: redirectUri(),
    });
  });

  app.post("/admin/api/client-secret", adminAuth, (req, res) => {
    try {
      saveClientSecret(req.body?.content ?? req.body);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/admin/api/auth/start", adminAuth, async (req, res) => {
    const account = String(req.body?.account ?? "").trim();
    if (!validAccount(account)) {
      res.status(400).json({ error: "Invalid account label: use letters, digits, and . _ % + @ -" });
      return;
    }
    try {
      const { authUrl } = await startAuth(account);
      res.json({ authUrl });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Manual (headless) completion: the user pastes the full redirected URL.
  app.post("/admin/api/auth/complete", adminAuth, async (req, res) => {
    try {
      const input = String(req.body?.url ?? "").trim();
      let state = String(req.body?.state ?? "").trim();
      let code = String(req.body?.code ?? "").trim();
      if (input) {
        const u = new URL(input);
        state = u.searchParams.get("state") ?? state;
        code = u.searchParams.get("code") ?? code;
      }
      if (!state || !code) throw new Error("Could not find state/code in the pasted value.");
      const account = await completeAuth(state, code);
      res.json({ ok: true, account });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Browser redirect target: auto-completes when the callback reaches us.
  app.get("/admin/oauth/callback", adminAuth, async (req, res) => {
    const state = String(req.query.state ?? "");
    const code = String(req.query.code ?? "");
    const error = String(req.query.error ?? "");
    if (error) {
      res.status(400).type("html").send(resultPage(`Authorization denied: ${htmlEscape(error)}`, false));
      return;
    }
    try {
      const account = await completeAuth(state, code);
      res.type("html").send(resultPage(`Authorized ${htmlEscape(account)}. You can close this tab.`, true));
    } catch (err) {
      res.status(400).type("html").send(resultPage(htmlEscape((err as Error).message), false));
    }
  });

  app.delete("/admin/api/accounts/:account", adminAuth, (req, res) => {
    const account = req.params.account;
    if (!validAccount(account)) {
      res.status(400).json({ error: "Invalid account label." });
      return;
    }
    rmSync(path.join(tokensDir(), `${account}.json`), { force: true });
    res.json({ ok: true });
  });
}

function resultPage(message: string, ok: boolean): string {
  return `<!doctype html><meta charset="utf-8"><title>OAuth</title>
<body style="font-family:system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem">
<h1 style="color:${ok ? "#15803d" : "#b91c1c"}">${ok ? "✓" : "✗"} ${message}</h1>
<p><a href="/admin">Back to the admin UI</a></p></body>`;
}

// Single-file vanilla page; no build step, no client deps.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>google-mcp-suite — credentials</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
  h1{font-size:1.4rem} h2{font-size:1.1rem;margin-top:2rem}
  section{border:1px solid #8884;border-radius:.6rem;padding:1rem 1.2rem;margin:1rem 0}
  input,textarea,button{font:inherit;padding:.4rem .6rem;border-radius:.4rem;border:1px solid #8886}
  button{cursor:pointer;background:#2563eb;color:#fff;border:none}
  button.secondary{background:#6b7280} button.danger{background:#b91c1c;padding:.2rem .5rem}
  table{width:100%;border-collapse:collapse;margin-top:.5rem} td,th{text-align:left;padding:.35rem .4rem;border-bottom:1px solid #8883}
  .muted{color:#6b7280;font-size:.85rem} code{background:#8881;padding:.1rem .3rem;border-radius:.3rem}
  .ok{color:#15803d} .bad{color:#b91c1c} .row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
  textarea{width:100%;min-height:5rem;box-sizing:border-box}
  #msg{position:sticky;top:0;padding:.5rem;border-radius:.4rem}
</style></head>
<body>
<h1>google-mcp-suite — credentials</h1>
<p class="muted">Writes to <code id="dir">…</code>, exactly where the MCP servers read it.</p>
<div id="msg"></div>

<section>
  <h2>1 · Shared OAuth client</h2>
  <p class="muted">The Desktop-app <code>client_secret.json</code> from Google Cloud (<code>installed</code> or <code>web</code> shape). Shared by every account.</p>
  <p>Status: <span id="cs-status">…</span></p>
  <div class="row">
    <input type="file" id="cs-file" accept="application/json,.json">
    <button onclick="uploadSecret()">Save client secret</button>
  </div>
</section>

<section>
  <h2>2 · Authorized accounts</h2>
  <table id="accounts"><thead><tr><th>Account</th><th>Scopes</th><th>Refresh</th><th>Access expires</th><th></th></tr></thead><tbody></tbody></table>
  <p class="muted" id="no-accounts" hidden>No accounts authorized yet.</p>
</section>

<section>
  <h2>3 · Authorize an account</h2>
  <p class="muted">The label becomes the token filename and the value you set as <code>GOOGLE_MCP_ACCOUNT</code> (or <code>&lt;SERVICE&gt;_ACCOUNT</code>). Use the account's email to prefill Google's chooser.</p>
  <div class="row">
    <input id="acct" placeholder="you@example.com" size="28">
    <button onclick="startAuth()">Start authorization →</button>
  </div>
  <div id="step2" hidden style="margin-top:1rem">
    <p>1. <a id="auth-link" href="#" target="_blank" rel="noopener">Open the Google consent screen</a> and approve.</p>
    <p>2. If this page is running on another machine, the browser will land on a <em>localhost</em> page that won't load — copy that full URL from the address bar and paste it here:</p>
    <textarea id="redir" placeholder="http://localhost:3000/admin/oauth/callback?state=…&code=…"></textarea>
    <div class="row" style="margin-top:.5rem"><button onclick="complete()">Finish authorization</button>
      <span class="muted">(If you're on the same machine, it completes automatically — just refresh.)</span></div>
  </div>
</section>

<script>
const msg=document.getElementById('msg');
function flash(t,ok){msg.textContent=t;msg.style.background=ok?'#16a34a22':'#dc262622';msg.className='';setTimeout(()=>{msg.textContent='';msg.style.background='';},6000);}
function fmt(ts){if(!ts)return '—';const d=new Date(ts);return d<new Date()?'expired':d.toLocaleString();}
async function load(){
  const r=await fetch('/admin/api/state');const s=await r.json();
  document.getElementById('dir').textContent=s.dir;
  const cs=document.getElementById('cs-status');
  cs.innerHTML=s.clientSecret?'<span class="ok">✓ present</span>':'<span class="bad">✗ not uploaded</span>';
  const tb=document.querySelector('#accounts tbody');tb.innerHTML='';
  document.getElementById('no-accounts').hidden=s.accounts.length>0;
  for(const a of s.accounts){
    const tr=document.createElement('tr');
    tr.innerHTML='<td><code>'+a.account+'</code></td><td>'+a.scopes+'</td>'
      +'<td>'+(a.hasRefresh?'<span class="ok">yes</span>':'<span class="bad">no</span>')+'</td>'
      +'<td>'+fmt(a.expiry)+'</td><td></td>';
    const btn=document.createElement('button');btn.className='danger';btn.textContent='Delete';
    btn.onclick=()=>del(a.account);tr.lastElementChild.appendChild(btn);
    tb.appendChild(tr);
  }
}
async function uploadSecret(){
  const f=document.getElementById('cs-file').files[0];
  if(!f)return flash('Choose the client_secret.json file first.',false);
  const text=await f.text();
  const r=await fetch('/admin/api/client-secret',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:text})});
  const d=await r.json();flash(r.ok?'Client secret saved.':d.error,r.ok);load();
}
async function startAuth(){
  const account=document.getElementById('acct').value.trim();
  const r=await fetch('/admin/api/auth/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account})});
  const d=await r.json();
  if(!r.ok)return flash(d.error,false);
  const link=document.getElementById('auth-link');link.href=d.authUrl;
  document.getElementById('step2').hidden=false;window.open(d.authUrl,'_blank','noopener');
}
async function complete(){
  const url=document.getElementById('redir').value.trim();
  const r=await fetch('/admin/api/auth/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})});
  const d=await r.json();flash(r.ok?('Authorized '+d.account+'.'):d.error,r.ok);
  if(r.ok){document.getElementById('redir').value='';document.getElementById('step2').hidden=true;load();}
}
async function del(account){
  if(!confirm('Delete token for '+account+'?'))return;
  const r=await fetch('/admin/api/accounts/'+encodeURIComponent(account),{method:'DELETE'});
  const d=await r.json();flash(r.ok?'Deleted '+account+'.':d.error,r.ok);load();
}
load();
</script>
</body></html>`;
