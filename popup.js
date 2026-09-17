// popup.js v1.3.0

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

// ── Page media scan ─────────────────────────────────────────────────────────
//
// Runs inside the target page (ISOLATED world) via chrome.scripting. It
// collects, in one pass:
//
//   1. blob: URLs from the DOM (all frames, incl. shadow roots) — plus,
//      via the MAIN-world tracker, the real source URL each blob was most
//      likely built from.
//   2. Every media URL the page *references*: <video>/<audio>/<source>
//      src + srcset, <a href>, data-* attributes, <link>, and the raw HTML
//      source itself (inline scripts, JSON players configs, escaped
//      "\/" and \u002F forms are all normalised first).
//   3. Every media URL the page actually *loaded*: PerformanceResourceTiming
//      entries plus the fetch/XHR log from blob-tracker.js.
//
// Everything is absolutised, deduped and classified so the popup can list
// manifests and full files first and keep HLS/DASH segment spam collapsed.
async function extractPageMediaInPage() {
  const MEDIA_EXT =
    "m3u8|m3u|mpd|ism|mp4|m4v|m4a|m4s|webm|mov|mkv|avi|flv|wmv|3gp|ogv|ts|mp3|aac|flac|wav|ogg|opus";
  const EXT_RE = new RegExp("\\.(" + MEDIA_EXT + ")(\\?|#|$)", "i");
  const MEDIA_HINT_RE =
    /(\/manifest|\/master\.|\/playlist|\/chunklist|\/hls\/|\/dash\/|format=m3u8|mime=video|videoplayback)/i;
  const MANIFEST_RE = /\.(m3u8|m3u|mpd|ism)(\?|#|$)/i;
  const VIDEO_RE = /\.(mp4|m4v|webm|mov|mkv|avi|flv|wmv|3gp|ogv)(\?|#|$)/i;
  const AUDIO_RE = /\.(mp3|m4a|aac|flac|wav|ogg|opus)(\?|#|$)/i;
  const SEGMENT_RE = /\.(ts|m4s)(\?|#|$)/i;
  const BLOB_RE = /blob:[^\s"'<>\)\]]+/g;

  const blobsFound = new Set();
  const mediaFound = new Map(); // absUrl -> { url, kind, origin: "dom"|"net"|"code" }

  function absolutize(u) {
    try { return new URL(String(u).trim(), document.baseURI || location.href).href; }
    catch (e) { return null; }
  }

  function classify(u) {
    if (MANIFEST_RE.test(u)) return "manifest";
    if (VIDEO_RE.test(u)) return "video";
    if (AUDIO_RE.test(u)) return "audio";
    if (SEGMENT_RE.test(u)) return "segment";
    return "other";
  }

  function addMedia(raw, origin) {
    if (!raw) return;
    let s = String(raw).trim();
    if (!s || /^(data:|javascript:|about:)/i.test(s)) return;
    if (s.startsWith("blob:")) { blobsFound.add(s); return; }
    if (!EXT_RE.test(s) && !MEDIA_HINT_RE.test(s)) return;
    const abs = absolutize(s);
    if (!abs || !/^https?:/i.test(abs)) return;
    if (mediaFound.has(abs)) return;
    mediaFound.set(abs, { url: abs, kind: classify(abs), origin });
  }

  // ── 1. DOM attributes ────────────────────────────────────────────────────
  const ATTRS = [
    "src", "href", "poster", "data-src", "data-url", "data-file", "data-video",
    "data-video-src", "data-mp4", "data-hls", "data-stream", "data-source",
    "data-setup", "content", "value"
  ];

  function scanElement(el) {
    ATTRS.forEach((a) => {
      try {
        const v = el.getAttribute && el.getAttribute(a);
        if (v) addMedia(v, "dom");
      } catch (e) {}
    });
    // live properties (currentSrc is often set even when the attribute isn't)
    ["src", "currentSrc"].forEach((p) => {
      try {
        const v = el[p];
        if (typeof v === "string" && v) {
          if (v.startsWith("blob:")) blobsFound.add(v);
          else addMedia(v, "dom");
        }
      } catch (e) {}
    });
    try {
      const ss = el.getAttribute && el.getAttribute("srcset");
      if (ss) ss.split(",").forEach((part) => addMedia(part.trim().split(/\s+/)[0], "dom"));
    } catch (e) {}
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

  // ── 2. Raw page source (inline scripts, JSON player configs, …) ──────────
  try {
    let html = document.documentElement.outerHTML || "";
    if (html.length > 4000000) html = html.slice(0, 4000000);

    (html.match(BLOB_RE) || []).forEach((u) => blobsFound.add(u));

    // Normalise the escapes players commonly use inside JSON/JS strings.
    const text = html
      .replace(/\\{1,2}\//g, "/")
      .replace(/\\u002[fF]/g, "/")
      .replace(/\\u0026/g, "&")
      .replace(/&amp;/g, "&")
      .replace(/&#x2F;/gi, "/")
      .replace(/&quot;/g, '"');

    const ABS_URL_RE = /https?:\/\/[^\s"'`<>()\[\]{},\\]+/gi;
    (text.match(ABS_URL_RE) || []).forEach((u) => addMedia(u.replace(/[.,;)]+$/, ""), "code"));

    const REL_URL_RE = new RegExp(
      "[\"'`(=]\\s*((?:\\.{0,2}/)[^\\s\"'`<>()]+?\\.(?:" + MEDIA_EXT + ")(?:\\?[^\\s\"'`<>()]*)?)",
      "gi"
    );
    let m;
    while ((m = REL_URL_RE.exec(text)) !== null) addMedia(m[1], "code");
  } catch (e) {}

  // ── 3. Actually loaded resources (Resource Timing) ───────────────────────
  try {
    performance.getEntriesByType("resource").forEach((e) => {
      if (!e || !e.name) return;
      if (e.initiatorType === "video" || e.initiatorType === "audio" ||
          e.initiatorType === "xmlhttprequest" || e.initiatorType === "fetch" ||
          e.initiatorType === "other" || e.initiatorType === "link") {
        addMedia(e.name, "net");
      } else {
        addMedia(e.name, "net");
      }
    });
  } catch (e) {}

  // ── 4. Tracker registry (MAIN world) ─────────────────────────────────────
  function queryTracker() {
    return new Promise((resolve) => {
      let done = false;
      function handler(e) {
        if (done) return;
        done = true;
        window.removeEventListener("__jd_blob_tracker_response__", handler);
        try {
          const parsed = JSON.parse(e.detail);
          // v1.2 payload was a bare array of blob entries.
          if (Array.isArray(parsed)) resolve({ blobs: parsed, media: [] });
          else resolve({ blobs: parsed.blobs || [], media: parsed.media || [] });
        } catch (err) { resolve({ blobs: [], media: [] }); }
      }
      window.addEventListener("__jd_blob_tracker_response__", handler);
      window.dispatchEvent(new CustomEvent("__jd_blob_tracker_query__"));
      setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener("__jd_blob_tracker_response__", handler);
        resolve({ blobs: [], media: [] });
      }, 400);
    });
  }

  const tracker = await queryTracker();
  (tracker.media || []).forEach((r) => { if (r && r.url) addMedia(r.url, "net"); });

  // ── 5. Blob items + their recovered source URLs ──────────────────────────
  const registryByUrl = {};
  (tracker.blobs || []).forEach((r) => { if (r && r.blobUrl) registryByUrl[r.blobUrl] = r; });

  function bestCandidate(candidates) {
    if (!candidates || !candidates.length) return null;
    return (
      candidates.find((c) => MANIFEST_RE.test(c)) ||
      candidates.find((c) => VIDEO_RE.test(c)) ||
      candidates.find((c) => !SEGMENT_RE.test(c)) ||
      candidates[0]
    );
  }

  const blobItems = [];
  blobsFound.forEach((u) => {
    let origin = null;
    try { origin = new URL(u.replace(/^blob:/, "")).origin; } catch (e) {}
    const reg = registryByUrl[u];
    const source = reg ? bestCandidate(reg.candidates) : null;
    if (source) addMedia(source, "blob");
    blobItems.push({ blobUrl: u, origin, source, mimeType: reg ? reg.type : null });
  });

  return {
    blobItems,
    blobCount: blobsFound.size,
    media: Array.from(mediaFound.values()),
    pageUrl: location.href
  };
}

document.getElementById("scan-blobs").addEventListener("click", scanPage);

let lastScan = { items: [], blobCount: 0 };

async function scanPage() {
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
      func: extractPageMediaInPage
    });

    const seen = new Set();
    const items = [];
    let blobCount = 0;

    for (const r of results) {
      if (!r?.result) continue;
      blobCount += r.result.blobCount || 0;

      // Media URLs (from DOM, page code, network, blob provenance)
      (r.result.media || []).forEach((m) => {
        if (!m?.url || seen.has(m.url)) return;
        seen.add(m.url);
        items.push({ value: m.url, kind: m.kind, origin: m.origin });
      });

      // Blobs without a recovered source → offer the origin as fallback
      (r.result.blobItems || []).forEach((b) => {
        if (b.source) return; // already added as media
        const key = b.origin || b.blobUrl;
        if (!key || seen.has(key)) return;
        seen.add(key);
        items.push({ value: key, kind: "origin", origin: "blob" });
      });
    }

    lastScan = { items, blobCount };
    renderMediaList();

    const counts = countKinds(items);
    if (!items.length) {
      showStatus(statusEl, "err",
        blobCount
          ? `${blobCount} blob:-URL(s) gefunden, aber keine Medien-URL extrahierbar.`
          : "Keine Medien- oder blob:-URLs auf dieser Seite gefunden."
      );
    } else {
      const parts = [];
      if (counts.manifest) parts.push(`${counts.manifest} Stream`);
      if (counts.video) parts.push(`${counts.video} Video`);
      if (counts.audio) parts.push(`${counts.audio} Audio`);
      if (counts.segment) parts.push(`${counts.segment} Segment`);
      if (counts.other) parts.push(`${counts.other} sonstige`);
      if (counts.origin) parts.push(`${counts.origin} Origin`);
      showStatus(statusEl, "ok", `✓ ${items.length} Treffer: ${parts.join(", ")}.`);
    }
  } catch (err) {
    console.error("Media scan error:", err);
    showStatus(statusEl, "err", `✗ ${err.message || "Fehler beim Durchsuchen der Seite."}`);
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
    btn.innerHTML = origContent;
  }
}

function countKinds(items) {
  const c = { manifest: 0, video: 0, audio: 0, segment: 0, other: 0, origin: 0 };
  items.forEach((i) => { if (c[i.kind] !== undefined) c[i.kind]++; });
  return c;
}

const KIND_META = {
  manifest: { label: "Stream",  color: "var(--accent)",  rank: 0, autoCheck: true },
  video:    { label: "Video",   color: "var(--success)", rank: 1, autoCheck: true },
  audio:    { label: "Audio",   color: "var(--accent2)", rank: 2, autoCheck: true },
  other:    { label: "Medien",  color: "var(--accent2)", rank: 3, autoCheck: true },
  origin:   { label: "Origin",  color: "var(--muted)",   rank: 4, autoCheck: false },
  segment:  { label: "Segment", color: "var(--muted)",   rank: 5, autoCheck: false }
};

function renderMediaList() {
  const resultsEl = document.getElementById("blob-results");
  const listEl = document.getElementById("blob-origin-list");
  const showSegments = document.getElementById("show-segments").checked;
  listEl.innerHTML = "";

  let items = lastScan.items;
  if (!showSegments) items = items.filter((i) => i.kind !== "segment");

  if (!items.length) {
    resultsEl.style.display = lastScan.blobCount || lastScan.items.length ? "block" : "none";
    listEl.innerHTML = `<div class="hint">Nichts gefunden${lastScan.items.length ? " (Segmente sind ausgeblendet)" : ""}.</div>`;
    return;
  }

  const sorted = [...items].sort((a, b) => {
    const ra = KIND_META[a.kind]?.rank ?? 9;
    const rb = KIND_META[b.kind]?.rank ?? 9;
    return ra - rb || a.value.localeCompare(b.value);
  });

  sorted.forEach((item) => {
    const meta = KIND_META[item.kind] || KIND_META.other;
    const row = document.createElement("label");
    row.className = "origin-item";
    row.title = item.value;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = meta.autoCheck;
    cb.dataset.value = item.value;

    const span = document.createElement("span");
    span.innerHTML =
      `<span style="color:${meta.color};font-weight:600;">${meta.label}</span> ${escapeHtml(shorten(item.value))}`;

    row.appendChild(cb);
    row.appendChild(span);
    listEl.appendChild(row);
  });

  resultsEl.style.display = "block";
}

function shorten(u) {
  if (u.length <= 160) return u;
  return u.slice(0, 100) + " … " + u.slice(-50);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

document.getElementById("show-segments").addEventListener("change", renderMediaList);

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
