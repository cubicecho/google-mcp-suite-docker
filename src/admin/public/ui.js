// DOM rendering helpers: the transient status banner, date formatting, and the
// accounts table. `onDelete` is passed in so this module stays free of API calls.

const msg = document.getElementById("msg");

export function flash(text, ok) {
  msg.textContent = text;
  msg.style.background = ok ? "#16a34a22" : "#dc262622";
  setTimeout(() => {
    msg.textContent = "";
    msg.style.background = "";
  }, 6000);
}

function fmt(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d < new Date() ? "expired" : d.toLocaleString();
}

export function renderState(state, onDelete) {
  document.getElementById("dir").textContent = state.dir;

  const cs = document.getElementById("cs-status");
  cs.innerHTML = state.clientSecret
    ? '<span class="ok">✓ present</span>'
    : '<span class="bad">✗ not uploaded</span>';

  const tbody = document.querySelector("#accounts tbody");
  tbody.innerHTML = "";
  document.getElementById("no-accounts").hidden = state.accounts.length > 0;

  for (const a of state.accounts) {
    const tr = document.createElement("tr");
    const refresh = a.hasRefresh ? '<span class="ok">yes</span>' : '<span class="bad">no</span>';
    tr.innerHTML =
      "<td><code></code></td><td></td><td>" + refresh + "</td><td></td><td></td>";
    tr.children[0].firstChild.textContent = a.account;
    tr.children[1].textContent = a.scopes;
    tr.children[3].textContent = fmt(a.expiry);

    const btn = document.createElement("button");
    btn.className = "danger";
    btn.textContent = "Delete";
    btn.onclick = () => onDelete(a.account);
    tr.children[4].appendChild(btn);

    tbody.appendChild(tr);
  }
}
