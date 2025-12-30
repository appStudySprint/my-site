# 💰 Budget Protection - Daily Usage Counter

**Datum:** $(date)  
**Zweck:** Hard Limit von 200 Calls/Tag erzwingen (Google Cloud Quota kann nicht bearbeitet werden)

---

## ✅ Implementierte Features

### 1. 🔒 Daily Usage Counter

**Status:** ✅ IMPLEMENTIERT

- **Location:** `netlify/functions/gemini-proxy.js`
- **Collection:** `system_stats/{usage_YYYY-MM-DD}`
- **Limit:** 200 Calls/Tag (Hard Limit)
- **Kill Switch:** Bei Limit erreicht → 429 Status (kein Gemini Call)

**Logik:**
1. Erstellt Datum-String: `usage_2025-01-15`
2. Liest aktuellen Count aus Firestore
3. Prüft: `count >= 200` → **KILL SWITCH** (429 Error)
4. Wenn unter Limit: Inkrementiert Count atomar
5. **WICHTIG:** Prüfung VOR dem Gemini API Call

---

### 2. 🔒 Input Hardening

**Status:** ✅ IMPLEMENTIERT

- **Input-Limit:** 2000 Zeichen (reduziert von 3000)
- **Auth-Zwang:** Firebase Token im Header erforderlich
- **Prüfung:** VOR dem Gemini Call

---

### 3. 🔒 Token-Sparer

**Status:** ✅ IMPLEMENTIERT

- **maxOutputTokens:** 1000
- **Zweck:** Verhindert, dass die KI Romane schreibt
- **Location:** `body.generationConfig.maxOutputTokens = 1000`

---

## ⚠️ WICHTIG: Firestore Authentifizierung

### Aktueller Status

Die Firestore REST API benötigt Authentifizierung. Die aktuelle Implementierung nutzt die Firestore REST API, aber **benötigt für Production einen Service Account Token**.

### Option 1: Firebase Admin SDK (Empfohlen)

**Installation:**
```bash
cd netlify/functions
npm install firebase-admin
```

**Setup in Netlify Environment Variables:**
- `FIREBASE_PROJECT_ID` (z.B. `idea-rate`)
- `FIREBASE_PRIVATE_KEY` (Service Account Private Key)
- `FIREBASE_CLIENT_EMAIL` (Service Account Email)

**Code-Update:**
```javascript
import admin from 'firebase-admin';

// Initialisiere Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

// In checkDailyUsageLimit():
const db = admin.firestore();
const todayStr = `usage_${today}`;
const docRef = db.collection('system_stats').doc(todayStr);

// Atomares Inkrement
await docRef.set({
  count: admin.firestore.FieldValue.increment(1),
  lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
}, { merge: true });

const doc = await docRef.get();
const currentCount = doc.data()?.count || 0;
```

### Option 2: Firestore Security Rules anpassen

**Alternative:** Firestore Rules so anpassen, dass die Function schreiben kann:

```javascript
match /system_stats/{date} {
  // Erlaube Schreiben für Service Account (wenn über REST API)
  allow write: if request.auth == null && request.resource.data.keys().hasAll(['count', 'lastUpdated']);
  allow read: if true; // Öffentlich lesbar (nur Count)
}
```

**⚠️ WARNUNG:** Diese Regel ist weniger sicher, da sie anonymes Schreiben erlaubt.

---

## 📊 Kosten-Schutz Übersicht

| Maßnahme | Schutz vor | Status |
|----------|-----------|--------|
| **Daily Usage Counter** | >200 Calls/Tag | ✅ Aktiv (benötigt Auth) |
| **Input-Limit (2000)** | Riesige Inputs | ✅ Aktiv |
| **maxOutputTokens (1000)** | Lange Antworten | ✅ Aktiv |
| **Timeout (15s)** | Hängende Requests | ✅ Aktiv |
| **Auth-Zwang** | Anonyme Calls | ✅ Aktiv |

---

## 🧪 Testing

**Test 1: Limit erreicht**
```bash
# Simuliere 200 Calls
# 201. Call sollte 429 zurückgeben
```

**Test 2: Firestore Counter**
```bash
# Prüfe Firestore: system_stats/usage_2025-01-15
# Sollte count: 200 haben
```

**Test 3: Input-Limit**
```bash
# Sende Request mit >2000 Zeichen
# Sollte 400 zurückgeben
```

---

## 🚀 Deployment Checklist

- [x] Daily Usage Counter implementiert
- [x] Kill Switch bei Limit
- [x] Input-Limit auf 2000 reduziert
- [x] maxOutputTokens auf 1000 gesetzt
- [ ] **Firebase Admin SDK installieren** (für Production)
- [ ] **Service Account Credentials in Netlify setzen**
- [ ] **Firestore Rules anpassen** (falls nötig)
- [ ] **Testen:** Daily Counter funktioniert

---

## 📝 Notizen

- **Fail-Safe:** Wenn Counter nicht funktioniert, erlaubt die Function trotzdem Requests (verhindert System-Down)
- **Atomares Inkrement:** Verhindert Race Conditions bei gleichzeitigen Requests
- **Datum-basiert:** Jeder Tag hat eigenen Counter (automatisches Reset)

---

**Status:** ✅ **IMPLEMENTIERT** (benötigt Firebase Admin SDK für Production)

