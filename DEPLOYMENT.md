# 🚀 Deployment Anleitung

## 🔐 Sicherheits-Update: API-Key Migration

Wir haben den Gemini API-Key aus dem Frontend-Code entfernt und auf eine sichere Serverless-Architektur umgestellt.

---

## ⚙️ Netlify Setup (WICHTIG!)

### 1. Environment Variable konfigurieren

Nach dem Deployment auf Netlify:

1. Gehe zu deinem Netlify Dashboard
2. Wähle deine Site aus
3. Navigiere zu **Site Settings → Environment Variables**
4. Klicke auf **Add a variable**
5. Setze:
   - **Key**: `GEMINI_API_KEY`
   - **Value**: `AIzaSyCE27me4vv7Yo6u3FGOVncG7Z5_WFytHN0`
   - **Scopes**: Alle (Production, Deploy Previews, Branch deploys)

### 2. Redeploy auslösen

Nach dem Setzen der Environment Variable:
- Gehe zu **Deploys**
- Klicke auf **Trigger deploy → Clear cache and deploy site**

---

## 🏗️ Architektur

### Vorher (UNSICHER ❌)
```
Frontend (Browser) → Google Gemini API (mit API-Key im Code)
```
**Problem**: API-Key ist öffentlich sichtbar auf GitHub und im Browser-Code.

### Nachher (SICHER ✅)
```
Frontend (Browser) → Netlify Function → Google Gemini API
```
**Vorteil**: API-Key ist nur auf dem Server bekannt und niemals im Browser-Code.

---

## 📁 Wichtige Dateien

### `netlify/functions/gemini-proxy.js`
Serverless Function, die als sicherer Proxy fungiert.

### `netlify.toml`
Netlify-Konfiguration für Functions und Build-Settings.

### `scripts/main.js`
Frontend-Code, der jetzt zu `/.netlify/functions/gemini-proxy` sendet.

---

## 🧪 Lokale Entwicklung

### Netlify CLI installieren
```bash
npm install -g netlify-cli
```

### Environment Variables lokal setzen
Erstelle eine `.env` Datei im Root:
```env
GEMINI_API_KEY=AIzaSyCE27me4vv7Yo6u3FGOVncG7Z5_WFytHN0
```

⚠️ **WICHTIG**: Die `.env` Datei ist in `.gitignore` und wird NICHT commitet!

### Lokalen Dev-Server starten
```bash
netlify dev
```

Das startet die App auf `http://localhost:8888` mit den Serverless Functions.

---

## 🔒 Sicherheits-Checkliste

- [x] API-Key aus Frontend-Code entfernt
- [x] Serverless Proxy-Function erstellt
- [x] Netlify Environment Variable konfiguriert
- [x] `.gitignore` enthält `.env`
- [x] Dokumentation erstellt

---

## 🆘 Troubleshooting

### "API Key missing" Fehler
→ Stelle sicher, dass `GEMINI_API_KEY` in Netlify Environment Variables gesetzt ist.

### "Function not found" Fehler
→ Prüfe, ob `netlify/functions/gemini-proxy.js` existiert und deployt wurde.

### "CORS" Fehler
→ Die Function enthält bereits CORS-Headers. Wenn das Problem besteht, prüfe die Browser-Konsole.

---

## 📞 Support

Bei Problemen: Prüfe die Netlify Function Logs im Dashboard unter **Functions → gemini-proxy → Logs**.

