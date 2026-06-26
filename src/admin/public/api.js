// Thin wrappers over the /admin JSON API. Each returns { ok, data } so callers
// can flash either a success message or the server's error string.

async function call(path, options) {
  const res = await fetch(path, options);
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* some endpoints may return no body */
  }
  return { ok: res.ok, data };
}

function postJson(path, body) {
  return call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getState() {
  return call("/admin/api/state");
}

export function saveClientSecret(content) {
  return postJson("/admin/api/client-secret", { content });
}

export function startAuth(account) {
  return postJson("/admin/api/auth/start", { account });
}

export function completeAuth(url) {
  return postJson("/admin/api/auth/complete", { url });
}

export function deleteAccount(account) {
  return call("/admin/api/accounts/" + encodeURIComponent(account), { method: "DELETE" });
}
