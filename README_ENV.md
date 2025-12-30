# 🔐 Environment Variables Setup

## Lokale Entwicklung (.env)

### 1. Erstelle .env Datei

```bash
# Kopiere das Template
cp .env.example .env

# Bearbeite .env mit deinen Werten
# (Nutze einen Editor wie VS Code, Notepad++, etc.)
```

### 2. Fülle die Werte aus

Öffne `.env` und ersetze die Platzhalter:

```env
GEMINI_API_KEY=dein-echter-api-key-hier
FIREBASE_PROJECT_ID=idea-rate
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nDein-Key-Hier\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@idea-rate.iam.gserviceaccount.com
```

### 3. Testen

```bash
# Starte Netlify Dev (lädt automatisch .env)
netlify dev

# ODER mit Vite
npm run dev
```

**✅ Fertig!** Netlify Functions lesen automatisch die `.env` Datei.

---

## Production (Netlify Dashboard)

### 1. Gehe zu Netlify Dashboard

1. Öffne [Netlify Dashboard](https://app.netlify.com)
2. Wähle deine Site
3. Gehe zu **Site Settings → Environment Variables**

### 2. Füge Variablen hinzu

Klicke auf **Add variable** und füge hinzu:

| Key | Value | Beispiel |
|-----|-------|----------|
| `GEMINI_API_KEY` | Dein Gemini API Key | `AIzaSy...` |
| `FIREBASE_PROJECT_ID` | Dein Firebase Project ID | `idea-rate` |
| `FIREBASE_PRIVATE_KEY` | Service Account Private Key | `-----BEGIN PRIVATE KEY-----\n...` |
| `FIREBASE_CLIENT_EMAIL` | Service Account Email | `firebase-adminsdk-...@...` |

### 3. Deploy

```bash
git push
```

Netlify deployt automatisch und nutzt die Environment Variables.

---

## 🔍 Wo finde ich die Werte?

### GEMINI_API_KEY
1. Gehe zu [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Erstelle neuen API Key
3. Kopiere den Key

### FIREBASE_PROJECT_ID
- Steht in Firebase Console oben links
- Oder in `scripts/firebase.js` → `projectId: 'idea-rate'`

### FIREBASE_PRIVATE_KEY & FIREBASE_CLIENT_EMAIL
1. [Firebase Console](https://console.firebase.google.com)
2. Projekt wählen → **Project Settings** (⚙️)
3. Tab **Service Accounts**
4. Klicke **Generate New Private Key**
5. JSON-Datei herunterladen
6. Öffne JSON:
   - `private_key` → `FIREBASE_PRIVATE_KEY`
   - `client_email` → `FIREBASE_CLIENT_EMAIL`

---

## ⚠️ Sicherheit

- ✅ `.env` ist in `.gitignore` (wird NICHT committed)
- ✅ `.env.example` ist committed (Template ohne Secrets)
- ✅ Netlify Environment Variables sind verschlüsselt
- ❌ **NIEMALS** `.env` committen!

---

## 🧪 Testen ob es funktioniert

### Lokal:
```bash
netlify dev
# Prüfe Logs: Sollte keine "API Key missing" Fehler zeigen
```

### Production:
1. Mache einen API-Call in der App
2. Prüfe Netlify Function Logs:
   - Netlify Dashboard → Functions → Logs
   - Sollte keine "API Key missing" Fehler zeigen

---

## 📝 Troubleshooting

**Problem:** "GEMINI_API_KEY ist nicht gesetzt"
- **Lösung:** Prüfe ob `.env` existiert und korrekt formatiert ist
- **Lösung:** Prüfe Netlify Environment Variables

**Problem:** "FIREBASE_PRIVATE_KEY invalid"
- **Lösung:** Stelle sicher, dass `\n` in `.env` vorhanden sind
- **Lösung:** In Netlify: Key direkt einfügen (Netlify macht Newlines automatisch)

**Problem:** "Environment Variables werden nicht geladen"
- **Lösung:** Starte `netlify dev` neu
- **Lösung:** Prüfe ob `.env` im Root-Verzeichnis ist (nicht in `netlify/functions/`)

---

**Fertig!** 🎉

