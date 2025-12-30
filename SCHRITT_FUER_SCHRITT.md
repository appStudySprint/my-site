# 🎯 Schritt für Schritt - Keine Panik!

**Alles wird gut!** Ich habe den Code bereits angepasst. Du musst nur noch 2 Dinge tun:

---

## ✅ SCHRITT 1: Environment Variables setzen

### Für lokale Entwicklung:

1. **Erstelle `.env` Datei:**
   ```bash
   cp .env.example .env
   ```

2. **Öffne `.env`** in einem Editor (VS Code, Notepad, etc.)

3. **Fülle nur diese 2 Werte aus:**
   ```env
   GEMINI_API_KEY=dein-gemini-api-key-hier
   FIREBASE_PROJECT_ID=idea-rate
   ```

**Das reicht erstmal!** ✅

### Für Production (Netlify):

1. Gehe zu: https://app.netlify.com
2. Wähle deine Site
3. **Site Settings** → **Environment Variables**
4. Klicke **Add variable** und füge hinzu:
   - `GEMINI_API_KEY` = dein API Key
   - `FIREBASE_PROJECT_ID` = `idea-rate`

**Das war's!** ✅

---

## ✅ SCHRITT 2: Testen

### Lokal:
```bash
netlify dev
```

### Oder direkt pushen:
```bash
git add .
git commit -m "Security hardening & budget protection"
git push
```

**Fertig!** 🎉

---

## 💡 Was ist mit dem Daily Usage Counter?

**Der Daily Usage Counter funktioniert automatisch**, wenn du diese zusätzlichen Variablen setzt:

- `FIREBASE_PRIVATE_KEY` (aus Firebase Service Account)
- `FIREBASE_CLIENT_EMAIL` (aus Firebase Service Account)

**Aber:** Die App funktioniert auch OHNE diese Variablen! Der Counter ist dann deaktiviert (Fail-Safe).

**Du kannst das später machen, wenn du willst.**

---

## 🆘 Hilfe

**Wenn etwas nicht funktioniert:**
- Prüfe ob `.env` existiert (für lokal)
- Prüfe Netlify Environment Variables (für Production)
- Prüfe Netlify Function Logs (Netlify Dashboard → Functions → Logs)

**Alles wird gut!** 😊

