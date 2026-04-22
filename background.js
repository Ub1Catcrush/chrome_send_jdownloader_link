// background.js - Service Worker v1.1.0
// MyJDownloader uses AES-CBC encryption for all API calls.
// Reference: AppWork GmbH official JS client (pastebin.com/z3n6iPZh)
// Key layout: loginSecret[0..15] = IV, loginSecret[16..31] = AES-Key

// ── Context Menu Setup ───────────────────────────────────────────────────────

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "jd-link-parent",
      title: "Link senden an JDownloader",
      contexts: ["link"]
    });
    chrome.contextMenus.create({
      id: "jd-link-myjd",
      parentId: "jd-link-parent",
      title: "🌐 Via MyJDownloader",
      contexts: ["link"]
    });
    chrome.contextMenus.create({
      id: "jd-link-direct",
      parentId: "jd-link-parent",
      title: "🖥️ Direkt (lokale Instanz)",
      contexts: ["link"]
    });

    chrome.contextMenus.create({
      id: "jd-page-parent",
      title: "Aktuelle URL senden an JDownloader",
      contexts: ["page", "frame"]
    });
    chrome.contextMenus.create({
      id: "jd-page-myjd",
      parentId: "jd-page-parent",
      title: "🌐 Via MyJDownloader",
      contexts: ["page", "frame"]
    });
    chrome.contextMenus.create({
      id: "jd-page-direct",
      parentId: "jd-page-parent",
      title: "🖥️ Direkt (lokale Instanz)",
      contexts: ["page", "frame"]
    });
  });
}

chrome.runtime.onInstalled.addListener(createContextMenus);
chrome.runtime.onStartup.addListener(createContextMenus);

// ── Context Menu Clicks ──────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const settings = await getSettings();
  let url = info.menuItemId.startsWith("jd-link-") ? info.linkUrl
          : info.menuItemId.startsWith("jd-page-") ? (info.pageUrl || tab?.url)
          : null;
  if (!url) { notify("Fehler", "Keine URL gefunden."); return; }

  if (info.menuItemId.endsWith("-myjd")) {
    await sendViaMyJDownloader(url, settings);
  } else {
    await sendViaDirect(url, settings);
  }
});

// ── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const settings = await getSettings();
    switch (msg.action) {
      case "sendUrl":
        if (msg.method === "myjd") {
          const r = await sendViaMyJDownloader(msg.url, settings);
          sendResponse(r);
        } else {
          const r = await sendViaDirect(msg.url, settings);
          sendResponse(r);
        }
        break;
      case "testMyJD":
        sendResponse(await testMyJD(msg.email, msg.password));
        break;
      case "listDevices":
        sendResponse(await listMyJDDevices(msg.email, msg.password));
        break;
      case "testDirect":
        sendResponse(await testDirectConnection(msg.host, msg.port));
        break;
    }
  })();
  return true; // async
});

// ════════════════════════════════════════════════════════════════════════════
// MyJDownloader API  –  AES-CBC encrypted, reference: AppWork GmbH JS client
// ════════════════════════════════════════════════════════════════════════════

const MYJD_API = "https://api.jdownloader.org";
const APP_KEY  = "jd-chrome-ext";

// Incrementing request ID — matches Python's update_request_id() pattern.
// Using seconds-since-epoch as base (fits Java int32), incremented per call.
let _ridBase = Math.floor(Date.now() / 1000);
function nextRid() { return ++_ridBase; }

// ── Crypto helpers ───────────────────────────────────────────────────────────

/** SHA-256 of UTF-8 string, returns Uint8Array (32 bytes) */
async function sha256bytes(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return new Uint8Array(buf);
}

/** HMAC-SHA256 of UTF-8 string with raw key bytes, returns hex string */
async function hmacSha256hex(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key,
    new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(sig));
}

/**
 * AES-256-CBC decrypt.
 * Secret layout (32 bytes): iv = secret[0..15], key = secret[16..31]
 * Ciphertext is Base64-encoded (as sent by api.jdownloader.org).
 */
async function aesDecrypt(keyBytes32, ciphertextBase64) {
  const iv  = keyBytes32.slice(0, 16);
  const key = keyBytes32.slice(16, 32);
  const ct  = base64ToBytes(ciphertextBase64.trim());
  const cryptoKey = await crypto.subtle.importKey("raw", key,
    { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, ct);
  return new TextDecoder().decode(plain);
}

/** AES-256-CBC encrypt a JS object as JSON, returns Base64 string.
 *  Web Crypto AES-CBC adds PKCS#7 padding automatically — do NOT pre-pad. */
async function aesEncryptJson(keyBytes32, obj) {
  const iv  = keyBytes32.slice(0, 16);
  const key = keyBytes32.slice(16, 32);
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const cryptoKey = await crypto.subtle.importKey("raw", key,
    { name: "AES-CBC" }, false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, cryptoKey, data);
  return bytesToBase64(new Uint8Array(ct));
}

/** AES-256-CBC encrypt an already-serialised string, returns Base64.
 *  Web Crypto AES-CBC adds PKCS#7 padding automatically — do NOT pre-pad. */
async function aesEncryptStr(keyBytes32, str) {
  const iv  = keyBytes32.slice(0, 16);
  const key = keyBytes32.slice(16, 32);
  const data = new TextEncoder().encode(str);
  const cryptoKey = await crypto.subtle.importKey("raw", key,
    { name: "AES-CBC" }, false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, cryptoKey, data);
  return bytesToBase64(new Uint8Array(ct));
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++)
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return arr;
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function bytesToBase64(bytes) {
  let bin = "";
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

/**
 * updateEncryptionToken: SHA256(token_bytes + sessiontoken_hex_as_bytes)
 * This is how the official client derives serverEncryptionToken after login.
 */
async function updateEncryptionToken(tokenBytes, sessionTokenHex) {
  const sessionBytes = hexToBytes(sessionTokenHex);
  const combined = new Uint8Array(tokenBytes.length + sessionBytes.length);
  combined.set(tokenBytes);
  combined.set(sessionBytes, tokenBytes.length);
  const hash = await crypto.subtle.digest("SHA-256", combined);
  return new Uint8Array(hash);
}

// ── MyJD Session ─────────────────────────────────────────────────────────────

/**
 * Connect to MyJDownloader and return session info.
 * Returns: { sessionToken, serverEncToken, deviceEncToken, error? }
 */
async function myJDConnect(email, password) {
  // Derive secrets:
  // loginSecret  = SHA256(email_lower + password + "server")
  // deviceSecret = SHA256(email_lower + password + "device")
  const e = email.toLowerCase();
  const loginSecret  = await sha256bytes(e + password + "server");
  const deviceSecret = await sha256bytes(e + password + "device");

  const rid = nextRid(); // unique per call, seconds-based (fits Java int32)
  const queryStr = `/my/connect?email=${encodeURIComponent(email)}&appkey=${encodeURIComponent(APP_KEY)}&rid=${rid}`;
  const signature = await hmacSha256hex(loginSecret, queryStr);
  const fullQuery = queryStr + "&signature=" + signature;

  // /my/connect is a GET request (confirmed from Python reference implementation)
  const resp = await fetch(MYJD_API + fullQuery, { method: "GET" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} beim Login`);

  // Response body is AES-CBC encrypted with loginSecret, Base64-encoded
  const cipherB64 = await resp.text();
  let plain;
  try {
    plain = await aesDecrypt(loginSecret, cipherB64);
  } catch (e) {
    throw new Error("Antwort konnte nicht entschlüsselt werden – Passwort falsch oder Account-Problem?");
  }
  const data = JSON.parse(plain);

  if (data.error) throw new Error(`Login-Fehler: ${data.error}`);
  // rid check: server may return as string or number
  if (String(data.rid) !== String(rid)) throw new Error("Replay-Fehler (rid stimmt nicht überein)");

  // Derive session encryption tokens
  const serverEncToken = await updateEncryptionToken(loginSecret, data.sessiontoken);
  const deviceEncToken = await updateEncryptionToken(deviceSecret, data.sessiontoken);

  return {
    sessionToken: data.sessiontoken,
    serverEncToken,
    deviceEncToken
  };
}

/**
 * Make an authenticated server call to MyJDownloader (GET).
 * Used for /my/listdevices – server calls are GET with signature.
 */
async function myJDServerCall(session, action) {
  const rid = nextRid(); // unique per call, seconds-based (fits Java int32)
  const queryStr = `${action}?sessiontoken=${encodeURIComponent(session.sessionToken)}&rid=${rid}`;
  const signature = await hmacSha256hex(session.serverEncToken, queryStr);
  const fullQuery = queryStr + "&signature=" + signature;

  const resp = await fetch(MYJD_API + fullQuery, { method: "GET" });
  if (!resp.ok) throw new Error(`Server-Call HTTP ${resp.status} für ${action}`);

  const cipherB64 = await resp.text();
  const plain = await aesDecrypt(session.serverEncToken, cipherB64);
  return JSON.parse(plain);
}

/**
 * Make a device call via MyJDownloader tunnel.
 * URL: POST https://api.jdownloader.org/t_{sessionToken}_{deviceId}{action}
 *
 * Per the Python reference (myjdapi.__adapt_params_for_request):
 *   - each dict/object param is JSON.stringify'd individually into the array
 *   - '"null"' is replaced with bare null in the final JSON string
 */
async function myJDDeviceCall(session, deviceId, action, params = {}) {
  const rid = nextRid(); // unique per call, seconds-based (fits Java int32)
  const tunnelUrl = `/t_${session.sessionToken}_${deviceId}${action}`;

  // Each param element must be a JSON string, not a native object
  const adaptedParams = [JSON.stringify(params)];

  const payloadObj = { apiVer: 1, params: adaptedParams, url: action, rid };

  // Serialise then replace quoted nulls with bare nulls (as Python client does)
  const payloadStr = JSON.stringify(payloadObj)
    .replace(/"null"/g, "null")
    .replace(/'null'/g, "null");

  const encBody = await aesEncryptStr(session.deviceEncToken, payloadStr);

  const resp = await fetch(MYJD_API + tunnelUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: encBody
  });

  if (!resp.ok) {
    let detail = "";
    try {
      const errB64 = await resp.text();
      const errPlain = await aesDecrypt(session.deviceEncToken, errB64);
      const errJson = JSON.parse(errPlain);
      detail = ` (${errJson.type || errJson.src || JSON.stringify(errJson)})`;
    } catch (_) {}
    throw new Error(`Device-Call HTTP ${resp.status} fuer ${action}${detail}`);
  }

  const cipherB64 = await resp.text();
  const plain = await aesDecrypt(session.deviceEncToken, cipherB64);
  return JSON.parse(plain);
}

// ── High-level MyJD functions ────────────────────────────────────────────────

async function sendViaMyJDownloader(url, settings) {
  const { myjdEmail, myjdPassword, myjdDevice } = settings;
  if (!myjdEmail || !myjdPassword) {
    notify("MyJDownloader nicht konfiguriert",
           "Bitte E-Mail und Passwort in den Einstellungen eingeben.");
    return { ok: false, error: "not_configured" };
  }

  let step = "Login";
  try {
    step = "Login";
    const session = await myJDConnect(myjdEmail, myjdPassword);

    step = "Geräteliste";
    const devData = await myJDServerCall(session, "/my/listdevices");
    const devices = devData.list || [];

    if (!devices.length) {
      const msg = "Kein JDownloader-Gerät mit deinem MyJDownloader-Account verbunden.";
      notify("Kein Gerät gefunden", msg);
      return { ok: false, error: msg };
    }

    // Pick device
    let device = devices[0];
    if (myjdDevice) {
      const found = devices.find(d =>
        d.name.toLowerCase() === myjdDevice.trim().toLowerCase() ||
        d.id === myjdDevice.trim()
      );
      if (found) device = found;
    }

    step = "Link hinzufügen";
    await myJDDeviceCall(session, device.id, "/linkgrabberv2/addLinks", {
      autostart: false,
      links: url,
      packageName: null,
      extractPassword: null,
      priority: "DEFAULT",
      downloadPassword: null,
      destinationFolder: null,
      overwritePackagizerRules: false
    });

    notify("✅ Link gesendet",
           `Via MyJDownloader → ${device.name}\n${truncate(url)}`);
    return { ok: true, device: device.name };

  } catch (err) {
    console.error("MyJDownloader error:", err);
    notify(`MyJDownloader Fehler (${step})`, err.message || String(err));
    return { ok: false, error: err.message };
  }
}

async function testMyJD(email, password) {
  if (!email || !password) return { ok: false, error: "E-Mail und Passwort erforderlich" };
  try {
    const session = await myJDConnect(email, password);
    const devData = await myJDServerCall(session, "/my/listdevices");
    const devices = (devData.list || []).map(d => ({ id: d.id, name: d.name, type: d.type, status: d.status }));
    return { ok: true, devices };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function listMyJDDevices(email, password) {
  return testMyJD(email, password);
}

// ════════════════════════════════════════════════════════════════════════════
// Direct JDownloader (Flash/RemoteControl Plugin, Port 9666)
// ════════════════════════════════════════════════════════════════════════════

async function sendViaDirect(url, settings) {
  const host = settings.directHost || "localhost";
  const port = settings.directPort || "9666";
  const baseUrl = `http://${host}:${port}`;

  const headers = {};
  if (settings.directUser && settings.directPassword) {
    headers["Authorization"] = "Basic " + btoa(
      `${settings.directUser}:${settings.directPassword}`
    );
  }

  // The FlashGot/RemoteControl plugin expects application/x-www-form-urlencoded
  // with field "urls" (newline-separated for multiple URLs)
  // POST /flash/add  — standard JD2 remote interface
  const body = new URLSearchParams({ urls: url, source: "", referer: "" });

  try {
    const resp = await fetch(`${baseUrl}/flash/add`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    if (resp.ok || resp.status === 200) {
      notify("✅ Link gesendet", `Direkt → ${host}:${port}\n${truncate(url)}`);
      return { ok: true };
    } else {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
  } catch (err) {
    const msg = `${err.message} — Läuft JDownloader auf ${host}:${port}? (RemoteControl-Plugin aktiviert?)`;
    console.error("Direct error:", err);
    notify("Direkt-Verbindung fehlgeschlagen", msg);
    return { ok: false, error: msg };
  }
}

async function testDirectConnection(host, port) {
  const h = host || "localhost";
  const p = port || "9666";
  try {
    // Send a dummy OPTIONS or HEAD — JD responds with 200 even to empty POSTs
    const resp = await fetch(`http://${h}:${p}/flash/add`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "urls=&source=&referer="
    });
    return { ok: true, status: resp.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getSettings() {
  return new Promise(resolve =>
    chrome.storage.sync.get({
      myjdEmail: "", myjdPassword: "", myjdDevice: "",
      directHost: "localhost", directPort: "9666",
      directUser: "", directPassword: ""
    }, resolve)
  );
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title,
    message: message.slice(0, 200)
  });
}

function truncate(str, n = 80) {
  return str.length > n ? str.slice(0, n) + "…" : str;
}
