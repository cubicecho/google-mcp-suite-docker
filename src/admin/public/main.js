// Entry point: wires the page controls to the API and re-renders on every change.
import * as api from "./api.js";
import { flash, renderState } from "./ui.js";

async function load() {
  const { ok, data } = await api.getState();
  if (!ok) return flash("Could not load state.", false);
  renderState(data, del);
}

async function uploadSecret() {
  const file = document.getElementById("cs-file").files[0];
  if (!file) return flash("Choose the client_secret.json file first.", false);
  const { ok, data } = await api.saveClientSecret(await file.text());
  flash(ok ? "Client secret saved." : data.error, ok);
  load();
}

async function startAuth() {
  const account = document.getElementById("acct").value.trim();
  const { ok, data } = await api.startAuth(account);
  if (!ok) return flash(data.error, false);
  document.getElementById("auth-link").href = data.authUrl;
  document.getElementById("step2").hidden = false;
  window.open(data.authUrl, "_blank", "noopener");
}

async function complete() {
  const url = document.getElementById("redir").value.trim();
  const { ok, data } = await api.completeAuth(url);
  flash(ok ? "Authorized " + data.account + "." : data.error, ok);
  if (ok) {
    document.getElementById("redir").value = "";
    document.getElementById("step2").hidden = true;
    load();
  }
}

async function del(account) {
  if (!confirm("Delete token for " + account + "?")) return;
  const { ok, data } = await api.deleteAccount(account);
  flash(ok ? "Deleted " + account + "." : data.error, ok);
  load();
}

document.getElementById("cs-save").addEventListener("click", uploadSecret);
document.getElementById("auth-start").addEventListener("click", startAuth);
document.getElementById("auth-finish").addEventListener("click", complete);

load();
