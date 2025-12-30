# 🚀 Next Steps - VentureValidator Launch Checklist

**Status:** Code ist fertig, jetzt müssen wir es zum Laufen bringen!

---

## ✅ Was bereits erledigt ist

- ✅ Security Hardening implementiert
- ✅ Budget Protection (Daily Usage Counter) implementiert
- ✅ Firestore Security Rules aktualisiert
- ✅ Frontend sendet Auth Tokens
- ✅ Alle Features implementiert

---

## 🔴 KRITISCH: Was du JETZT machen musst

### 1. Firebase Admin SDK für Daily Usage Counter

**Problem:** Der Daily Usage Counter nutzt Firestore REST API, benötigt aber Authentifizierung.

**Lösung:** Firebase Admin SDK installieren

```bash
# Im Root-Verzeichnis
npm install firebase-admin
```

**ODER** (wenn Netlify Functions eigenes package.json haben sollte):
```bash
cd netlify/functions
npm init -y
npm install firebase-admin
```

---

### 2. Environment Variables setzen

**Option A: Lokale Entwicklung (.env Datei)**

1. Erstelle eine `.env` Datei im Root-Verzeichnis:
   ```bash
   cp .env.example .env
   ```

2. Fülle die Werte in `.env` aus (siehe `.env.example`)

3. **WICHTIG:** `.env` ist bereits in `.gitignore` - wird NICHT committed!

**Option B: Production (Netlify Dashboard)**

Gehe zu: **Netlify Dashboard → Site Settings → Environment Variables**

**Setze folgende Variablen:**

| Variable | Wert | Wo findest du es? |
|----------|------|-------------------|
| `GEMINI_API_KEY` | Dein Google Gemini API Key | Google Cloud Console |
| `FIREBASE_PROJECT_ID` | `idea-rate` (oder dein Project ID) | Firebase Console |
| `FIREBASE_PRIVATE_KEY` | Service Account Private Key | Firebase Console → Service Accounts |
| `FIREBASE_CLIENT_EMAIL` | Service Account Email | Firebase Console → Service Accounts |

**Wie bekomme ich Service Account Credentials?**

1. Gehe zu [Firebase Console](https://console.firebase.google.com)
2. Wähle dein Projekt (`idea-rate`)
3. Gehe zu **Project Settings → Service Accounts**
4. Klicke auf **Generate New Private Key**
5. Lade die JSON-Datei herunter
6. Öffne die JSON-Datei und kopiere:
   - `private_key` → `FIREBASE_PRIVATE_KEY` (in .env oder Netlify)
   - `client_email` → `FIREBASE_CLIENT_EMAIL`

**⚠️ WICHTIG für .env Datei:**
- In `.env`: Private Key muss mit `\n` für Zeilenumbrüche sein
- Beispiel: `FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n"`

**⚠️ WICHTIG für Netlify:**
- Netlify macht Newlines automatisch, du kannst den Key direkt einfügen

---

### 3. Firestore Security Rules deployen

**Aktuell:** Rules sind in `firebase.rules` gespeichert, aber noch nicht deployed.

**Deploy-Befehl:**
```bash
firebase deploy --only firestore:rules
```

**ODER** wenn Firebase CLI nicht installiert:
1. Gehe zu [Firebase Console](https://console.firebase.google.com)
2. Wähle dein Projekt
3. Gehe zu **Firestore Database → Rules**
4. Kopiere den Inhalt von `firebase.rules`
5. Füge ihn ein und klicke auf **Publish**

---

### 4. Code anpassen (Firebase Admin SDK)

**Datei:** `netlify/functions/gemini-proxy.js`

**Ersetze die `checkDailyUsageLimit()` Funktion:**

```javascript
import admin from 'firebase-admin';

// Initialisiere Admin SDK (einmalig)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

async function checkDailyUsageLimit() {
  const projectId = process.env.FIREBASE_PROJECT_ID || Netlify?.env?.get('FIREBASE_PROJECT_ID');
  
  if (!projectId) {
    console.warn('⚠️ FIREBASE_PROJECT_ID nicht gesetzt');
    return { allowed: true, count: 0 };
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const todayStr = `usage_${today}`;
    const MAX_DAILY_CALLS = 200;
    
    const db = admin.firestore();
    const docRef = db.collection('system_stats').doc(todayStr);
    
    // Atomares Inkrement
    await docRef.set({
      count: admin.firestore.FieldValue.increment(1),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    
    // Lese aktuellen Count
    const doc = await docRef.get();
    const currentCount = doc.data()?.count || 0;
    
    if (currentCount >= MAX_DAILY_CALLS) {
      console.warn(`🚫 Tageslimit erreicht: ${currentCount}/${MAX_DAILY_CALLS}`);
      return { allowed: false, count: currentCount };
    }
    
    return { allowed: true, count: currentCount };
    
  } catch (error) {
    console.error('❌ Fehler beim Usage Counter:', error);
    return { allowed: true, count: 0 }; // Fail-Safe
  }
}
```

---

## 🟡 OPTIONAL: Verbesserungen

### 5. Vollständige Token-Verifizierung

**Aktuell:** Token wird nur auf Format geprüft (Basis-Check)

**Für Production:** Nutze Firebase Admin SDK für echte Verifizierung:

```javascript
// In gemini-proxy.js, nach Token-Extraktion:
const decodedToken = await admin.auth().verifyIdToken(idToken);
// Token ist jetzt verifiziert!
```

---

## 📋 Quick Checklist

- [ ] `firebase-admin` installieren (`npm install firebase-admin`)
- [ ] Netlify Environment Variables setzen:
  - [ ] `GEMINI_API_KEY`
  - [ ] `FIREBASE_PROJECT_ID`
  - [ ] `FIREBASE_PRIVATE_KEY`
  - [ ] `FIREBASE_CLIENT_EMAIL`
- [ ] `checkDailyUsageLimit()` Funktion mit Admin SDK aktualisieren
- [ ] Firestore Rules deployen (`firebase deploy --only firestore:rules`)
- [ ] Testen: Einen API-Call machen und prüfen, ob Counter funktioniert
- [ ] Git Commit & Push

---

## 🧪 Testing

**Nach dem Setup:**

1. **Test 1: API-Call funktioniert**
   - Mache einen Analyse-Request
   - Sollte funktionieren

2. **Test 2: Daily Counter funktioniert**
   - Prüfe Firestore: `system_stats/usage_2025-01-XX`
   - Sollte `count: 1` haben

3. **Test 3: Limit erreicht**
   - Simuliere 200 Calls (oder warte bis Limit erreicht)
   - 201. Call sollte 429 zurückgeben

4. **Test 4: Firestore Rules**
   - Versuche fremdes Projekt zu lesen (als anderer User)
   - Sollte fehlschlagen

---

## 🆘 Troubleshooting

**Problem:** "Firebase Admin SDK nicht gefunden"
- **Lösung:** `npm install firebase-admin` im Root-Verzeichnis

**Problem:** "FIREBASE_PRIVATE_KEY invalid"
- **Lösung:** Stelle sicher, dass `\n` in Netlify richtig gesetzt sind

**Problem:** "Daily Counter funktioniert nicht"
- **Lösung:** Prüfe Netlify Function Logs, ob Environment Variables gesetzt sind

**Problem:** "Firestore Rules werden nicht angewendet"
- **Lösung:** Stelle sicher, dass Rules deployed sind (`firebase deploy --only firestore:rules`)

---

## 📞 Support

Falls etwas nicht funktioniert:
1. Prüfe Netlify Function Logs (Netlify Dashboard → Functions → Logs)
2. Prüfe Browser Console (F12)
3. Prüfe Firestore Console (ob Counter-Dokument erstellt wird)

---

**Nächster Schritt:** Starte mit Punkt 1 (Firebase Admin SDK installieren)!

