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

// ── Blob-URL scan ───────────────────────────────────────────────────────────
//
// A `blob:` URL is always of the form  blob:<origin>/<uuid>  — the origin
// is embedded in the URL text itself, so it's always extractable directly.
// The *real* source URL (the .m3u8/.mp4/etc. the blob was built from) is
// NOT embedded in the blob URL — the browser doesn't retain that
// provenance. To recover it we consult blob-tracker.js (injected into the
// page's MAIN world at document_start), which correlates blob creation
// with recently-seen network requests. This function runs in the popup's
// on-demand ISOLATED-world script (via chrome.scripting.executeScript),
// finds blob: URLs in the DOM (all frames, incl. shadow roots), then
// bridges to the MAIN-world tracker via a CustomEvent to fetch candidate
// source URLs for each one.
async function extractBlobInfoInPage() {
  const BLOB_RE = /blob:[^\s"'<>\)\]]+/g;
  const found = new Set();
  const attrs = ["src", "href", "poster", "data-src", "data-url", "currentSrc"];

  function scanElement(el) {
    attrs.forEach((a) => {
      try {
        const attrVal = el.getAttribute && el.getAttribute(a);
        if (attrVal && attrVal.startsWith("blob:")) found.add(attrVal);
      } catch (e) {}
      try {
        const propVal = el[a];
        if (typeof propVal === "string" && propVal.startsWith("blob:")) found.add(propVal);
      } catch (e) {}
    });
  }

  function walk(root) {
    let all;
    try { all = root.querySelectorAll("*"); } catch (e) { return; }
    all.forEach((el) => {
      scanElement(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  }
  walk(document);

  try {
    const html = document.documentElement.outerHTML;
    const matches = html.match(BLOB_RE);
    if (matches) matches.forEach((u) => found.add(u));
  } catch (e) {}

  // Ask blob-tracker.js (MAIN world) for its registry of blob creations +
  // candidate source URLs. Bridge via window CustomEvents since MAIN and
  // ISOLATED worlds share the DOM but not JS objects.
  function queryTracker() {
    return new Promise((resolve) => {
      let done = false;
      function handler(e) {
        if (done) return;
        done = true;
        window.removeEventListener("__jd_blob_tracker_response__", handler);
        try { resolve(JSON.parse(e.detail)); } catch (err) { resolve([]); }
      }
      window.addEventListener("__jd_blob_tracker_response__", handler);
      window.dispatchEvent(new CustomEvent("__jd_blob_tracker_query__"));
      setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener("__jd_blob_tracker_response__", handler);
        resolve([]);
      }, 300);
    });
  }

  const registry = await queryTracker();
  const registryByUrl = {};
  registry.forEach((r) => { if (r && r.blobUrl) registryByUrl[r.blobUrl] = r; });

  const MANIFEST_RE = /\.(m3u8|mpd)(\?|#|$)/i;
  const DIRECT_RE = /\.(mp4|webm|mov|mkv|m4v)(\?|#|$)/i;

  function bestCandidate(candidates) {
    if (!candidates || !candidates.length) return null;
    return (
      candidates.find((c) => MANIFEST_RE.test(c)) ||
      candidates.find((c) => DIRECT_RE.test(c)) ||
      candidates[0]
    );
  }

  const items = [];
  found.forEach((u) => {
    let origin = null;
    try { origin = new URL(u.replace(/^blob:/, "")).origin; } catch (e) {}
    const reg = registryByUrl[u];
    const source = reg ? bestCandidate(reg.candidates) : null;
    items.push({ blobUrl: u, origin, source, mimeType: reg ? reg.type : null });
  });

  return { items, blobCount: found.size };
}

document.getElementById("scan-blobs").addEventListener("click", scanForBlobOrigins);

async function scanForBlobOrigins() {
  const btn = document.getElementById("scan-blobs");
  const statusEl = document.getElementById("status-scan");
  const resultsEl = document.getElementById("blob-results");

  btn.disabled = true;
  btn.classList.add("loading");
  const origContent = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span> <span class="label">Durchsuche Seite…</span>`;
  clearStatus(statusEl);
  resultsEl.style.display = "none";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Kein aktiver Tab gefunden.");

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: extractBlobInfoInPage
    });

    // Merge items across frames, dedupe by whatever we'll actually send
    // (real source URL when we found one, else the origin).
    const seen = new Set();
    const merged = [];
    let blobCount = 0;
    let sourceCount = 0;
    for (const r of results) {
      if (!r?.result) continue;
      blobCount += r.result.blobCount || 0;
      (r.result.items || []).forEach((item) => {
        const key = item.source || item.origin;
        if (!key || seen.has(key)) return;
        seen.add(key);
        if (item.source) sourceCount++;
        merged.push(item);
      });
    }

    renderOriginList(merged, blobCount);

    if (merged.length === 0) {
      showStatus(statusEl, "err",
        blobCount
          ? `${blobCount} blob:-URL(s) gefunden, aber nichts extrahierbar.`
          : "Keine blob:-URLs auf dieser Seite gefunden."
      );
    } else if (sourceCount > 0) {
      showStatus(statusEl, "ok",
        `✓ ${sourceCount} echte Quell-URL(s) + ${merged.length - sourceCount} Origin(s) gefunden.`
      );
    } else {
      showStatus(statusEl, "ok",
        `✓ ${merged.length} Origin(s) gefunden (keine echte Quell-URL erkannt — evtl. Seite neu laden und erneut versuchen, da der Tracker erst ab Seitenaufruf mitschneidet).`
      );
    }
  } catch (err) {
    console.error("Blob scan error:", err);
    showStatus(statusEl, "err", `✗ ${err.message || "Fehler beim Durchsuchen der Seite."}`);
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
    btn.innerHTML = origContent;
  }
}

function renderOriginList(items, blobCount) {
  const resultsEl = document.getElementById("blob-results");
  const listEl = document.getElementById("blob-origin-list");
  listEl.innerHTML = "";

  if (!items.length) {
    resultsEl.style.display = blobCount ? "block" : "none";
    listEl.innerHTML = `<div class="hint">Nichts gefunden.</div>`;
    return;
  }

  // Real source URLs first, origin-only fallbacks after.
  const sorted = [...items].sort((a, b) => (b.source ? 1 : 0) - (a.source ? 1 : 0));

  sorted.forEach((item) => {
    const value = item.source || item.origin;
    if (!value) return;
    const row = document.createElement("label");
    row.className = "origin-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.value = value;
    const span = document.createElement("span");
    if (item.source) {
      span.innerHTML = `<span style="color:var(--success);font-weight:600;">Quelle</span> ${escapeHtml(item.source)}`;
    } else {
      span.innerHTML = `<span style="color:var(--muted);font-weight:600;">Origin</span> ${escapeHtml(item.origin)}`;
    }
    row.appendChild(cb);
    row.appendChild(span);
    listEl.appendChild(row);
  });

  resultsEl.style.display = "block";
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

document.getElementById("select-all-origins").addEventListener("click", () => {
  document.querySelectorAll("#blob-origin-list input[type=checkbox]").forEach((cb) => (cb.checked = true));
});
document.getElementById("select-none-origins").addEventListener("click", () => {
  document.querySelectorAll("#blob-origin-list input[type=checkbox]").forEach((cb) => (cb.checked = false));
});

document.getElementById("send-blobs-myjd").addEventListener("click", () => sendSelectedOrigins("myjd"));
document.getElementById("send-blobs-direct").addEventListener("click", () => sendSelectedOrigins("direct"));

function sendSelectedOrigins(method) {
  const statusEl = document.getElementById("status-blobs");
  const selected = Array.from(
    document.querySelectorAll("#blob-origin-list input[type=checkbox]:checked")
  ).map((cb) => cb.dataset.value);

  if (!selected.length) {
    showStatus(statusEl, "err", "Nichts ausgewählt.");
    return;
  }

  const btn = document.getElementById(method === "myjd" ? "send-blobs-myjd" : "send-blobs-direct");
  btn.disabled = true;
  btn.classList.add("loading");
  const origContent = btn.innerHTML;
  const label = method === "myjd" ? "Sende via MyJDownloader…" : "Sende direkt…";
  btn.innerHTML = `<span class="spinner"></span> <span class="label">${label}</span>`;
  clearStatus(statusEl);

  chrome.runtime.sendMessage(
    { action: "sendUrl", url: selected.join("\n"), method },
    (resp) => {
      btn.disabled = false;
      btn.classList.remove("loading");
      btn.innerHTML = origContent;

      if (resp?.ok) {
        btn.classList.add("ok");
        const detail = resp.device ? ` → ${resp.device}` : "";
        showStatus(statusEl, "ok", `✓ ${selected.length} URL(s) gesendet${detail}`);
        setTimeout(() => { btn.classList.remove("ok"); clearStatus(statusEl); }, 3500);
      } else {
        btn.classList.add("fail");
        const errMsg = resp?.error || "Unbekannter Fehler";
        showStatus(statusEl, "err", `✗ ${errMsg}`);
        setTimeout(() => btn.classList.remove("fail"), 4000);
      }
    }
  );
}
