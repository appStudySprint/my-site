# 🎯 Einfach Gemacht - Schritt für Schritt

**Keine Panik!** Wir machen das Schritt für Schritt. Du musst nur 3 Dinge tun:

---

## ✅ SCHRITT 1: Firebase Admin SDK installieren

**Einfach diesen Befehl ausführen:**

```bash
npm install firebase-admin
```

**Das war's!** ✅

---

## ✅ SCHRITT 2: Code ist bereits angepasst

**Ich habe den Code bereits für dich angepasst!** ✅

Du musst nichts ändern - die Function nutzt jetzt Firebase Admin SDK.

---

## ✅ SCHRITT 3: Environment Variables setzen

**Du hast 2 Optionen:**

### Option A: Lokal testen (.env Datei)

1. Erstelle `.env` Datei:
   ```bash
   cp .env.example .env
   ```

2. Öffne `.env` in einem Editor (VS Code, Notepad, etc.)

3. Fülle nur diese 2 Werte aus (rest kann später):
   ```env
   GEMINI_API_KEY=dein-api-key-hier
   FIREBASE_PROJECT_ID=idea-rate
   ```

**Das reicht erstmal zum Testen!** ✅

### Option B: Production (Netlify)

1. Gehe zu: https://app.netlify.com
2. Wähle deine Site
3. **Site Settings** → **Environment Variables**
4. Klicke **Add variable**
5. Füge hinzu:
   - `GEMINI_API_KEY` = dein API Key
   - `FIREBASE_PROJECT_ID` = `idea-rate`

**Das war's!** ✅

---

## 🎉 Fertig!

**Jetzt kannst du:**
- Lokal testen: `netlify dev`
- Oder direkt pushen: `git push` (Netlify macht den Rest)

---

## ❓ Was ist mit den anderen Variablen?

**FIREBASE_PRIVATE_KEY und FIREBASE_CLIENT_EMAIL** brauchst du nur, wenn der Daily Usage Counter funktionieren soll.

**Für den Anfang reicht:**
- ✅ `GEMINI_API_KEY` (damit die App funktioniert)
- ✅ `FIREBASE_PROJECT_ID` (damit Firebase funktioniert)

**Der Rest kann später kommen!**

---

## 🆘 Hilfe brauchen?

**Wenn etwas nicht funktioniert:**
1. Prüfe Netlify Function Logs (Netlify Dashboard → Functions → Logs)
2. Prüfe ob `.env` existiert (für lokal)
3. Prüfe ob Environment Variables in Netlify gesetzt sind (für Production)

**Alles wird gut!** 😊

