# 🔥 Firestore Rules deployen (OHNE Firebase CLI)

**Einfacher Weg:** Manuell in Firebase Console

---

## ✅ Schritt für Schritt

### 1. Gehe zu Firebase Console

1. Öffne: https://console.firebase.google.com
2. Wähle dein Projekt: **idea-rate**

### 2. Öffne Firestore Rules

1. Klicke links auf **Firestore Database**
2. Gehe zum Tab **Rules** (oben)

### 3. Kopiere die Rules

**Öffne die Datei `firebase.rules`** in deinem Editor und kopiere den KOMPLETTEN Inhalt.

### 4. Füge in Firebase Console ein

1. In Firebase Console → Firestore → Rules
2. **Lösche** den alten Inhalt
3. **Füge** den neuen Inhalt aus `firebase.rules` ein
4. Klicke **Publish**

**✅ Fertig!** Die Rules sind jetzt deployed.

---

## 📋 Alternative: Firebase CLI installieren (optional)

Falls du Firebase CLI installieren willst:

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only firestore:rules
```

**Aber:** Manuell ist einfacher! 😊

---

## ✅ Testen

Nach dem Deploy:
1. Mache einen API-Call in der App
2. Prüfe ob der Daily Usage Counter funktioniert
3. Prüfe Firestore: `system_stats/usage_2025-01-XX` sollte existieren

---

**Fertig!** 🎉

