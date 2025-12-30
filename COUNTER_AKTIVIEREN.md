# 🎯 Daily Usage Counter aktivieren - Schritt für Schritt

**Ziel:** Daily Usage Counter (max 200 Calls/Tag) zum Laufen bringen

---

## ✅ Schritt 1: Firebase Service Account erstellen

### 1.1 Gehe zu Firebase Console

1. Öffne: https://console.firebase.google.com
2. Wähle dein Projekt: **idea-rate** (oder dein Projekt-Name)

### 1.2 Service Account erstellen

1. Klicke auf das **⚙️ Zahnrad** oben links → **Project Settings**
2. Gehe zum Tab **Service Accounts**
3. Klicke auf **Generate New Private Key**
4. Ein Dialog öffnet sich → Klicke **Generate Key**
5. Eine JSON-Datei wird heruntergeladen (z.B. `idea-rate-xxxxx-firebase-adminsdk-xxxxx.json`)

**✅ Fertig!** Du hast jetzt die JSON-Datei.

---

## ✅ Schritt 2: Werte aus JSON extrahieren

### 2.1 Öffne die JSON-Datei

Öffne die heruntergeladene JSON-Datei in einem Editor (VS Code, Notepad, etc.)

**Die Datei sieht so aus:**
```json
{
  "type": "service_account",
  "project_id": "idea-rate",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-xxxxx@idea-rate.iam.gserviceaccount.com",
  "client_id": "...",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  ...
}
```

### 2.2 Kopiere die Werte

Du brauchst nur 2 Werte:

1. **`private_key`** → Das ist dein `FIREBASE_PRIVATE_KEY`
2. **`client_email`** → Das ist dein `FIREBASE_CLIENT_EMAIL`

**WICHTIG:** Kopiere den `private_key` KOMPLETT (inkl. `-----BEGIN PRIVATE KEY-----` und `-----END PRIVATE KEY-----`)

---

## ✅ Schritt 3: Environment Variables setzen

### Option A: Lokal (.env Datei)

1. Öffne deine `.env` Datei (oder erstelle sie: `cp .env.example .env`)

2. Füge diese Zeilen hinzu:
   ```env
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n"
   FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@idea-rate.iam.gserviceaccount.com
   ```

   **⚠️ WICHTIG:** 
   - Der `private_key` muss in Anführungszeichen stehen
   - Die `\n` müssen drin bleiben (für Zeilenumbrüche)
   - Kopiere den kompletten Key aus der JSON-Datei

3. Speichere die Datei

### Option B: Production (Netlify Dashboard)

1. Gehe zu: https://app.netlify.com
2. Wähle deine Site
3. **Site Settings** → **Environment Variables**
4. Klicke **Add variable**

5. **Variable 1:**
   - Key: `FIREBASE_PRIVATE_KEY`
   - Value: Kopiere den kompletten `private_key` aus der JSON-Datei
     ```
     -----BEGIN PRIVATE KEY-----
     MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...
     -----END PRIVATE KEY-----
     ```
   - **WICHTIG:** Netlify macht Newlines automatisch, du kannst den Key direkt einfügen

6. Klicke **Add variable**

7. **Variable 2:**
   - Key: `FIREBASE_CLIENT_EMAIL`
   - Value: `firebase-adminsdk-xxxxx@idea-rate.iam.gserviceaccount.com`
     (Kopiere aus der JSON-Datei)

8. Klicke **Add variable**

**✅ Fertig!**

---

## ✅ Schritt 4: Testen

### Lokal:
```bash
netlify dev
```

### Production:
```bash
git push
```

**Nach dem Deploy:**
1. Mache einen API-Call in der App
2. Prüfe Firestore: Gehe zu Firebase Console → Firestore Database
3. Suche nach Collection: `system_stats`
4. Es sollte ein Dokument geben: `usage_2025-01-XX` (mit heutigem Datum)
5. Das Dokument sollte `count: 1` haben

**✅ Wenn das funktioniert, ist der Counter aktiv!**

---

## 🧪 Test: Limit erreicht

**Um zu testen, ob der Kill Switch funktioniert:**

1. Setze temporär `MAX_DAILY_CALLS = 1` in `netlify/functions/gemini-proxy.js` (Zeile 74)
2. Mache 2 API-Calls
3. Der 2. Call sollte **429 Status** zurückgeben mit "Tageslimit erreicht"
4. Setze `MAX_DAILY_CALLS = 200` wieder zurück

---

## 🆘 Troubleshooting

**Problem:** "Firebase Admin SDK nicht initialisiert"
- **Lösung:** Prüfe ob `FIREBASE_PRIVATE_KEY` und `FIREBASE_CLIENT_EMAIL` gesetzt sind
- **Lösung:** Prüfe Netlify Function Logs (Netlify Dashboard → Functions → Logs)

**Problem:** "Invalid private key"
- **Lösung:** Stelle sicher, dass der komplette Key kopiert wurde (inkl. BEGIN/END Zeilen)
- **Lösung:** In `.env`: Key muss in Anführungszeichen stehen
- **Lösung:** In Netlify: Key direkt einfügen (Netlify macht Newlines automatisch)

**Problem:** "Counter funktioniert nicht"
- **Lösung:** Prüfe Firestore Security Rules (müssen deployed sein)
- **Lösung:** Prüfe ob `FIREBASE_PROJECT_ID` gesetzt ist

---

## 📝 Checkliste

- [ ] Firebase Service Account JSON heruntergeladen
- [ ] `private_key` aus JSON kopiert
- [ ] `client_email` aus JSON kopiert
- [ ] `FIREBASE_PRIVATE_KEY` in `.env` oder Netlify gesetzt
- [ ] `FIREBASE_CLIENT_EMAIL` in `.env` oder Netlify gesetzt
- [ ] Getestet: API-Call gemacht
- [ ] Getestet: Firestore `system_stats` Collection prüfen
- [ ] Getestet: Counter-Dokument wurde erstellt

---

**Fertig!** 🎉 Der Daily Usage Counter ist jetzt aktiv und schützt dich vor Kosten-Explosionen!

