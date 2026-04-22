// popup.js v1.1.0

let currentUrl = "";

// ── Load current tab URL ───────────────────────────────────────────────────
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  currentUrl = tabs[0]?.url || "";
  const el = document.getElementById("current-url");
  el.textContent = currentUrl || "Keine URL verfügbar";
});

// ── Load settings for labels ───────────────────────────────────────────────
chrome.storage.sync.get({ directHost: "localhost", directPort: "9666" }, (s) => {
  document.getElementById("direct-label").textContent = `${s.directHost}:${s.directPort}`;
});

// ── Button handlers ────────────────────────────────────────────────────────
document.getElementById("send-myjd").addEventListener("click", () => {
  sendUrl("myjd",
    document.getElementById("send-myjd"),
    document.getElementById("status-myjd")
  );
});

document.getElementById("send-direct").addEventListener("click", () => {
  sendUrl("direct",
    document.getElementById("send-direct"),
    document.getElementById("status-direct")
  );
});

document.getElementById("btn-settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// ── Send logic ─────────────────────────────────────────────────────────────
function sendUrl(method, btn, statusEl) {
  if (!currentUrl) {
    showStatus(statusEl, "err", "Keine URL gefunden.");
    return;
  }

  // Set loading state
  btn.disabled = true;
  btn.classList.add("loading");
  const origContent = btn.innerHTML;
  const label = method === "myjd" ? "Sende via MyJDownloader…" : "Sende direkt…";
  btn.innerHTML = `<span class="spinner"></span> <span class="label">${label}</span>`;
  clearStatus(statusEl);

  chrome.runtime.sendMessage({ action: "sendUrl", url: currentUrl, method }, (resp) => {
    btn.disabled = false;
    btn.classList.remove("loading");
    btn.innerHTML = origContent;

    if (resp?.ok) {
      btn.classList.add("ok");
      const detail = resp.device ? ` → ${resp.device}` : "";
      showStatus(statusEl, "ok", `✓ Gesendet${detail}`);
      setTimeout(() => { btn.classList.remove("ok"); clearStatus(statusEl); }, 3500);
    } else {
      btn.classList.add("fail");
      const errMsg = resp?.error || "Unbekannter Fehler";
      showStatus(statusEl, "err", `✗ ${errMsg}`);
      setTimeout(() => { btn.classList.remove("fail"); }, 4000);
    }
  });
}

function showStatus(el, type, text) {
  el.className = `btn-status show ${type}`;
  el.textContent = text;
}
function clearStatus(el) {
  el.className = "btn-status";
  el.textContent = "";
}
