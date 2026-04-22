# JDownloader Link Sender – Chrome Extension v1.1.0

Sendet Links aus dem Browser-Kontextmenü an JDownloader –
via **MyJDownloader** (Cloud-Relay) oder **direkt** an eine lokale Instanz.

## Was ist neu in v1.1.0
- ✅ MyJDownloader-Verbindungstest mit Geräteliste
- ✅ Direkte Verbindung korrekt implementiert (form-encoded POST)
- ✅ Korrektes MyJD-Krypto (AES-CBC + richtiges Passwort-Hashing)
- ✅ Vollständiges Feedback im Popup und in den Einstellungen

## Installation (Entwicklermodus)

1. ZIP entpacken → Ordner `jdownloader-extension` erscheint
2. Chrome → `chrome://extensions/`
3. **Entwicklermodus** oben rechts aktivieren
4. **„Entpackte Erweiterung laden"** → entpackten Ordner wählen
5. Extension in der Toolbar anpinnen (Puzzle-Icon)

## Konfiguration

Klick auf das ⬇-Icon → **⚙** oder `chrome://extensions/` → Details → Erweiterungsoptionen.

### MyJDownloader
1. E-Mail + Passwort deines **my.jdownloader.org**-Accounts eingeben
2. **„Verbindung testen & Geräte laden"** klicken
3. Gerät aus der Liste auswählen (oder leer lassen für automatisch)
4. **Speichern**

> JDownloader muss unter *Einstellungen → MyJDownloader* verbunden sein.

### Direkte Verbindung
- **Host**: IP/Hostname des JDownloader-PCs (Standard: `localhost`)
- **Port**: Standard `9666`
- Verbindungstest nutzen um zu prüfen ob alles erreichbar ist

> JDownloader: *Einstellungen → Erweiterungen → RemoteControl* aktivieren.
> In den JD Advanced Settings: `RemoteAPI Authorized Hosts` auf `["127.0.0.1","localhost"]` setzen.

## Benutzung

| Aktion | Beschreibung |
|--------|-------------|
| Rechtsklick auf Link | „Link senden an JDownloader" → Via MyJD oder Direkt |
| Rechtsklick auf Seite | „Aktuelle URL senden an JDownloader" |
| Toolbar-Popup | Aktuelle URL mit einem Klick senden, inkl. Statusanzeige |
