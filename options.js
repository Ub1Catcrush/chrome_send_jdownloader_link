// options.js v1.1.0

const F = {
  email:    () => document.getElementById("myjd-email"),
  password: () => document.getElementById("myjd-password"),
  device:   () => document.getElementById("myjd-device"),
  host:     () => document.getElementById("direct-host"),
  port:     () => document.getElementById("direct-port"),
  user:     () => document.getElementById("direct-user"),
  dpass:    () => document.getElementById("direct-password"),
};

// ── Load settings ──────────────────────────────────────────────────────────

chrome.storage.sync.get({
  myjdEmail: "", myjdPassword: "", myjdDevice: "",
  directHost: "localhost", directPort: "9666",
  directUser: "", directPassword: ""
}, (s) => {
  F.email().value    = s.myjdEmail;
  F.password().value = s.myjdPassword;
  F.device().value   = s.myjdDevice;
  F.host().value     = s.directHost;
  F.port().value     = s.directPort;
  F.user().value     = s.directUser;
  F.dpass().value    = s.directPassword;
});

// ── Tabs ───────────────────────────────────────────────────────────────────

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
  });
});

// ── MyJD: Test + Device List ───────────────────────────────────────────────

document.getElementById("btn-test-myjd").addEventListener("click", async () => {
  const btn = document.getElementById("btn-test-myjd");
  const box = document.getElementById("myjd-result");
  const email    = F.email().value.trim();
  const password = F.password().value;

  if (!email || !password) {
    showBox(box, "err", "❌ Bitte E-Mail und Passwort eingeben.");
    return;
  }

  setBtnLoading(btn, true, "🔌 Verbinde…");
  hideBox(box);

  chrome.runtime.sendMessage({ action: "listDevices", email, password }, (resp) => {
    setBtnLoading(btn, false, "🔌 Verbindung testen &amp; Geräte laden");

    if (resp?.ok) {
      const devices = resp.devices || [];
      if (devices.length === 0) {
        showBox(box, "warn",
          "⚠️ Login erfolgreich, aber kein Gerät verbunden.\n" +
          "Stelle sicher, dass JDownloader läuft und mit MyJDownloader verbunden ist."
        );
        document.getElementById("device-card").style.display = "none";
      } else {
        showBox(box, "ok",
          `✅ Login erfolgreich! ${devices.length} Gerät${devices.length > 1 ? "e" : ""} gefunden.`
        );
        renderDeviceList(devices);
      }
    } else {
      const err = resp?.error || "Unbekannter Fehler";
      showBox(box, "err", `❌ Verbindung fehlgeschlagen:\n${err}`);
      document.getElementById("device-card").style.display = "none";
    }
  });
});

function renderDeviceList(devices) {
  const card = document.getElementById("device-card");
  const list = document.getElementById("device-list");
  const currentDevice = F.device().value.trim().toLowerCase();

  card.style.display = "block";
  list.innerHTML = "";

  devices.forEach(d => {
    const li = document.createElement("li");
    li.className = "device-item";
    const isSelected = currentDevice === d.name.toLowerCase() || currentDevice === d.id;
    if (isSelected) li.classList.add("selected");

    const online = d.status === "ONLINE";
    li.innerHTML = `
      <div class="device-dot ${online ? "online" : ""}"></div>
      <div>
        <div class="device-name">${escHtml(d.name)}</div>
        <div class="device-id">${escHtml(d.id)}</div>
      </div>
      <div class="device-use">${isSelected ? "✓ Ausgewählt" : "Klick zum Wählen"}</div>
    `;
    li.addEventListener("click", () => {
      F.device().value = d.name;
      // Update selection highlight
      document.querySelectorAll(".device-item").forEach(el => {
        el.classList.remove("selected");
        el.querySelector(".device-use").textContent = "Klick zum Wählen";
      });
      li.classList.add("selected");
      li.querySelector(".device-use").textContent = "✓ Ausgewählt";
    });
    list.appendChild(li);
  });
}

// ── Direct: Test ────────────────────────────────────────────────────────────

document.getElementById("btn-test-direct").addEventListener("click", () => {
  const btn = document.getElementById("btn-test-direct");
  const box = document.getElementById("direct-result");
  const host = F.host().value.trim() || "localhost";
  const port = F.port().value.trim() || "9666";

  setBtnLoading(btn, true, "Verbinde…");
  hideBox(box);

  chrome.runtime.sendMessage({ action: "testDirect", host, port }, (resp) => {
    setBtnLoading(btn, false, "🔌 Verbindung testen");
    if (resp?.ok) {
      showBox(box, "ok",
        `✅ JDownloader antwortet auf ${host}:${port} (HTTP ${resp.status}).`
      );
    } else {
      showBox(box, "err",
        `❌ Keine Antwort von ${host}:${port}.\n` +
        `Fehler: ${resp?.error ?? "Verbindung abgelehnt"}\n\n` +
        "→ Stelle sicher dass JDownloader läuft und das RemoteControl-Plugin aktiviert ist."
      );
    }
  });
});

// ── Save ───────────────────────────────────────────────────────────────────

document.getElementById("btn-save").addEventListener("click", () => {
  const data = {
    myjdEmail:      F.email().value.trim(),
    myjdPassword:   F.password().value,
    myjdDevice:     F.device().value.trim(),
    directHost:     F.host().value.trim() || "localhost",
    directPort:     F.port().value.trim() || "9666",
    directUser:     F.user().value.trim(),
    directPassword: F.dpass().value,
  };
  chrome.storage.sync.set(data, () => {
    showSaveStatus("✓ Gespeichert", "ok");
  });
});

// ── Reset ──────────────────────────────────────────────────────────────────

document.getElementById("btn-reset").addEventListener("click", () => {
  if (!confirm("Alle Einstellungen zurücksetzen?")) return;
  const d = {
    myjdEmail: "", myjdPassword: "", myjdDevice: "",
    directHost: "localhost", directPort: "9666",
    directUser: "", directPassword: ""
  };
  chrome.storage.sync.set(d, () => {
    F.email().value = ""; F.password().value = ""; F.device().value = "";
    F.host().value = "localhost"; F.port().value = "9666";
    F.user().value = ""; F.dpass().value = "";
    document.getElementById("device-card").style.display = "none";
    hideBox(document.getElementById("myjd-result"));
    hideBox(document.getElementById("direct-result"));
    showSaveStatus("Zurückgesetzt", "ok");
  });
});

// ── UI helpers ─────────────────────────────────────────────────────────────

function setBtnLoading(btn, loading, text) {
  btn.disabled = loading;
  btn.innerHTML = loading
    ? `<span class="spinner"></span> ${text}`
    : text;
}

function showBox(el, type, text) {
  el.className = `result-box show ${type}`;
  el.style.whiteSpace = "pre-wrap";
  el.textContent = text;
}
function hideBox(el) {
  el.className = "result-box";
  el.textContent = "";
}

function showSaveStatus(text, type) {
  const el = document.getElementById("save-status");
  el.textContent = text;
  el.className = `save-status show ${type}`;
  setTimeout(() => el.classList.remove("show"), 3000);
}

function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
