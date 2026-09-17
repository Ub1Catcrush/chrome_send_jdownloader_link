// blob-tracker.js — runs in the page's MAIN world (same JS realm as the
// page itself), injected at document_start on every frame.
//
// Two jobs:
//
// 1) blob: provenance. blob: URLs carry no reference to the network
//    resource they were built from. We log recent fetch()/XHR requests and
//    snapshot the media-looking ones around each URL.createObjectURL()
//    call. Heuristic, but the only way to recover a real source URL for
//    streaming players that build blobs from MediaSource/fetch chunks.
//
// 2) Media sniffing. Every fetch()/XHR that looks like media (.m3u8, .mpd,
//    .mp4, .m4s, .ts …) is kept in its own list, independent of blobs, so
//    the popup can offer *all* media a page loaded — not just what ended
//    up behind a blob: URL. We also watch <video>/<audio> src changes and
//    MediaSource.addSourceBuffer for mime hints.
//
// Nothing here ever leaves the browser. The popup pulls this data on
// demand via a DOM CustomEvent bridge (MAIN and ISOLATED worlds share the
// DOM/window event target, not JS objects).

(function () {
  if (window.__jdBlobTrackerInstalled) return;
  window.__jdBlobTrackerInstalled = true;

  const MAX_REQUESTS = 800;
  const MAX_MEDIA = 600;
  const MAX_BLOBS = 200;
  const LOOKBACK_MS = 20000; // how far back to look for a "source" request

  // Extensions we consider "media". Kept in sync with popup.js.
  const MEDIA_EXT =
    "m3u8|m3u|mpd|ism|mp4|m4v|m4a|m4s|webm|mov|mkv|avi|flv|wmv|3gp|ogv|ts|mp3|aac|flac|wav|ogg|opus|srt|vtt";
  const MEDIA_RE = new RegExp("\\.(" + MEDIA_EXT + ")(\\?|#|$)", "i");
  // Some CDNs serve manifests/segments without a file extension but with a
  // telltale path segment.
  const MEDIA_HINT_RE =
    /(\/manifest|\/master\.|\/playlist|\/chunklist|\/hls\/|\/dash\/|format=m3u8|mime=video|videoplayback|\/segment)/i;

  const recentRequests = []; // { url, method, t }
  const mediaRequests = [];  // { url, method, t, type }
  const blobRegistry = [];   // { blobUrl, size, type, t, candidates: [] }
  const seenMedia = new Set();

  function absolutize(u) {
    try { return new URL(String(u), document.baseURI || location.href).href; }
    catch (e) { return String(u); }
  }

  function looksLikeMedia(url) {
    if (!url) return false;
    if (/^(blob:|data:)/i.test(url)) return false;
    return MEDIA_RE.test(url) || MEDIA_HINT_RE.test(url);
  }

  function logMedia(url, method, type) {
    try {
      const abs = absolutize(url);
      if (!looksLikeMedia(abs)) return;
      if (seenMedia.has(abs)) return;
      seenMedia.add(abs);
      mediaRequests.push({ url: abs, method: method || "GET", t: performance.now(), type: type || null });
      if (mediaRequests.length > MAX_MEDIA) mediaRequests.shift();
    } catch (e) {}
  }

  function logRequest(url, method) {
    try {
      if (!url) return;
      const abs = absolutize(url);
      recentRequests.push({ url: abs, method: method || "GET", t: performance.now() });
      if (recentRequests.length > MAX_REQUESTS) recentRequests.shift();
      logMedia(abs, method);
    } catch (e) {}
  }

  // ── fetch() ──
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : (input && input.url);
        logRequest(url, (init && init.method) || (input && input.method));
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

  // ── <video>/<audio> src assignments (incl. programmatic ones) ──
  try {
    ["HTMLVideoElement", "HTMLAudioElement", "HTMLSourceElement"].forEach((name) => {
      const ctor = window[name];
      if (!ctor) return;
      const desc = Object.getOwnPropertyDescriptor(ctor.prototype, "src")
        || Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
      if (!desc || !desc.set) return;
      Object.defineProperty(ctor.prototype, "src", {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (v) {
          try { logMedia(v, "ELEMENT"); } catch (e) {}
          return desc.set.call(this, v);
        }
      });
    });
  } catch (e) {}

  // ── MediaSource mime hints (tells us what a blob will contain) ──
  try {
    if (window.MediaSource && MediaSource.prototype.addSourceBuffer) {
      const origAdd = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (mime) {
        try { window.__jdLastMseMime = String(mime); } catch (e) {}
        return origAdd.apply(this, arguments);
      };
    }
  } catch (e) {}

  // ── URL.createObjectURL ──
  const origCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    const blobUrl = origCreateObjectURL(obj);
    try {
      const now = performance.now();
      const candidates = recentRequests
        .filter((r) => now - r.t <= LOOKBACK_MS)
        .map((r) => r.url)
        .filter((u) => looksLikeMedia(u));
      const uniqueCandidates = Array.from(new Set(candidates)).slice(-10);

      blobRegistry.push({
        blobUrl,
        size: obj && obj.size,
        type: (obj && obj.type) || window.__jdLastMseMime || null,
        t: now,
        candidates: uniqueCandidates
      });
      if (blobRegistry.length > MAX_BLOBS) blobRegistry.shift();
    } catch (e) {}
    return blobUrl;
  };

  // ── Bridge to the popup's on-demand scan (runs in the ISOLATED world) ──
  // Payload shape: { blobs: [...], media: [...] }
  window.addEventListener("__jd_blob_tracker_query__", () => {
    let payload = '{"blobs":[],"media":[]}';
    try {
      payload = JSON.stringify({ blobs: blobRegistry, media: mediaRequests });
    } catch (e) {}
    window.dispatchEvent(new CustomEvent("__jd_blob_tracker_response__", { detail: payload }));
  });
})();
