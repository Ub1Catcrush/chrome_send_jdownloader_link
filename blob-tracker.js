// blob-tracker.js — runs in the page's MAIN world (same JS realm as the
// page itself), injected at document_start on every frame.
//
// Purpose: blob: URLs carry no provenance of the network resource they were
// built from. To recover it we log recent fetch()/XHR requests the page
// makes, and when the page calls URL.createObjectURL(), we snapshot which
// media-looking requests happened shortly before/around that moment. This
// is a heuristic, not a guarantee — but it's the only way to recover the
// real source URL for streaming players that build blobs from
// MediaSource/fetch chunks.
//
// Nothing here ever leaves the browser. The popup pulls this data on
// demand via a DOM CustomEvent bridge (MAIN and ISOLATED worlds share the
// DOM/window event target, not JS objects).

(function () {
  if (window.__jdBlobTrackerInstalled) return;
  window.__jdBlobTrackerInstalled = true;

  const MAX_REQUESTS = 500;
  const MAX_BLOBS = 200;
  const LOOKBACK_MS = 20000; // how far back to look for a "source" request
  const MEDIA_RE = /\.(m3u8|mpd|mp4|m4s|m4v|webm|mov|mkv|ts|aac|mp3|flac|wav)(\?|#|$)/i;

  const recentRequests = []; // { url, method, t }
  const blobRegistry = [];   // { blobUrl, size, type, t, candidates: [] }

  function logRequest(url, method) {
    try {
      if (!url) return;
      recentRequests.push({ url: String(url), method: method || "GET", t: performance.now() });
      if (recentRequests.length > MAX_REQUESTS) recentRequests.shift();
    } catch (e) {}
  }

  // ── fetch() ──
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : (input && input.url);
        logRequest(url, init && init.method);
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  }

  // ── XMLHttpRequest ──
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { logRequest(url, method); } catch (e) {}
    return origOpen.apply(this, arguments);
  };

  // ── URL.createObjectURL ──
  const origCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    const blobUrl = origCreateObjectURL(obj);
    try {
      const now = performance.now();
      const candidates = recentRequests
        .filter((r) => now - r.t <= LOOKBACK_MS)
        .map((r) => r.url)
        .filter((u) => MEDIA_RE.test(u));
      const uniqueCandidates = Array.from(new Set(candidates)).slice(-10);

      blobRegistry.push({
        blobUrl,
        size: obj && obj.size,
        type: obj && obj.type,
        t: now,
        candidates: uniqueCandidates
      });
      if (blobRegistry.length > MAX_BLOBS) blobRegistry.shift();
    } catch (e) {}
    return blobUrl;
  };

  // ── Bridge to the popup's on-demand scan (runs in the ISOLATED world) ──
  window.addEventListener("__jd_blob_tracker_query__", () => {
    let payload = "[]";
    try { payload = JSON.stringify(blobRegistry); } catch (e) {}
    window.dispatchEvent(new CustomEvent("__jd_blob_tracker_response__", { detail: payload }));
  });
})();
