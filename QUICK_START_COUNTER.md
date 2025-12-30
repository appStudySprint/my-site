# ⚡ Quick Start: Daily Usage Counter aktivieren

**5 Minuten Setup!** 🚀

---

## 📋 Schritt 1: Firebase Service Account erstellen

1. **Gehe zu:** https://console.firebase.google.com
2. **Wähle Projekt:** `idea-rate`
3. **⚙️ Zahnrad** → **Project Settings** → Tab **Service Accounts**
4. **Klicke:** "Generate New Private Key"
5. **Klicke:** "Generate Key" im Dialog
6. **✅ JSON-Datei wird heruntergeladen**

---

## 📋 Schritt 2: Werte kopieren

**Öffne die JSON-Datei** und kopiere:

1. **`private_key`** (der komplette Key mit `-----BEGIN...` und `-----END...`)
2. **`client_email`** (z.B. `firebase-adminsdk-xxxxx@idea-rate.iam.gserviceaccount.com`)

---

## 📋 Schritt 3: In Netlify setzen

1. **Gehe zu:** https://app.netlify.com
2. **Wähle deine Site**
3. **Site Settings** → **Environment Variables**
4. **Klicke "Add variable"** und füge hinzu:

   **Variable 1:**
   - Key: `FIREBASE_PRIVATE_KEY`
   - Value: *Füge den kompletten `private_key` aus der JSON ein*
   
   **Variable 2:**
   - Key: `FIREBASE_CLIENT_EMAIL`
   - Value: *Füge den `client_email` aus der JSON ein*

5. **✅ Fertig!**

---

## 📋 Schritt 4: Firestore Rules deployen

**WICHTIG:** Die Rules wurden bereits angepasst, müssen aber deployed werden!

```bash
firebase deploy --only firestore:rules
```

**ODER manuell:**
1. Gehe zu: https://console.firebase.google.com
2. Wähle Projekt → **Firestore Database** → **Rules**
3. Kopiere den Inhalt von `firebase.rules`
4. Füge ihn ein → **Publish**

---

## ✅ Testen

1. **Mache einen API-Call** in der App
2. **Prüfe Firestore:**
   - Firebase Console → Firestore Database
   - Collection: `system_stats`
   - Dokument: `usage_2025-01-XX` (heutiges Datum)
   - Sollte `count: 1` haben

**✅ Wenn das funktioniert, ist der Counter aktiv!**

---

## 🎯 Was passiert jetzt?

- ✅ Jeder API-Call wird gezählt
- ✅ Bei 200 Calls/Tag: **Kill Switch** aktiviert (429 Error)
- ✅ Counter resetet täglich automatisch
- ✅ Du bist vor Kosten-Explosionen geschützt!

---

**Fertig!** 🎉

