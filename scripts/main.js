import { auth, db, googleProvider } from './firebase.js';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';

const fieldIds = [
  'problem', 'solution', 'pitch',
  'persona_name', 'persona_demographics', 'persona_pains', 'persona_gains',
  'mvp_core1', 'mvp_core2', 'mvp_core3', 'mvp_anti_features',
  'validation_method', 'validation_success',
  'resources_stack', 'resources_budget', 'resources_time',
];

const storageKey = 'projektDashboardData';

let currentUser = null;
let projectDocRef = null;
let unsubscribeProject = null;
let isApplyingRemoteData = false;
let pendingRemoteUpdates = {};

const throttledLocalSave = throttle(saveLocalData, 200);
const throttledFirestoreSave = throttle(persistRemoteUpdates, 500);

document.addEventListener('DOMContentLoaded', () => {
  setupAuthUi();
  loadLocalData();
  autosizeAll();
  bindFieldListeners();
  setupClearButton();
});

function setupAuthUi() {
  const signInButton = document.getElementById('signInButton');
  const signOutButton = document.getElementById('signOutButton');
  const userBadge = document.getElementById('userBadge');
  const userName = document.getElementById('userName');
  const userEmail = document.getElementById('userEmail');

  if (signInButton) {
    signInButton.addEventListener('click', async () => {
      try {
        await signInWithPopup(auth, googleProvider);
      } catch (error) {
        console.error('Fehler bei der Anmeldung:', error);
        alert('Die Anmeldung ist fehlgeschlagen. Bitte versuchen Sie es erneut.');
      }
    });
  }

  if (signOutButton) {
    signOutButton.addEventListener('click', async () => {
      try {
        await signOut(auth);
      } catch (error) {
        console.error('Fehler beim Abmelden:', error);
      }
    });
  }

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;

    if (userBadge) {
      if (user) {
        userBadge.classList.remove('hidden');
        userBadge.classList.add('flex');
        if (signInButton) signInButton.classList.add('hidden');
        if (userName) userName.textContent = user.displayName ?? 'Unbekannter Benutzer';
        if (userEmail) userEmail.textContent = user.email ?? '';
        await connectProject(user);
      } else {
        userBadge.classList.add('hidden');
        userBadge.classList.remove('flex');
        if (signInButton) signInButton.classList.remove('hidden');
        detachProject();
        loadLocalData();
        autosizeAll();
      }
    }
  });
}

function bindFieldListeners() {
  fieldIds.forEach((id) => {
    const element = document.getElementById(id);
    if (!element) return;

    element.addEventListener('input', () => {
      autosize(element);
      if (isApplyingRemoteData) return;

      if (currentUser && projectDocRef) {
        pendingRemoteUpdates[id] = element.value;
        throttledFirestoreSave();
      } else {
        throttledLocalSave();
      }
    });
  });
}

async function connectProject(user) {
  try {
    const projectId = `${user.uid}-personal`;
    projectDocRef = doc(db, 'projects', projectId);
    const snapshot = await getDoc(projectDocRef);

    if (!snapshot.exists()) {
      const initialFields = getCurrentFieldValues();
      await setDoc(projectDocRef, {
        ownerId: user.uid,
        fields: initialFields,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    if (unsubscribeProject) unsubscribeProject();

    unsubscribeProject = onSnapshot(projectDocRef, (docSnap) => {
      if (!docSnap.exists()) return;
      const data = docSnap.data();
      const remoteFields = data?.fields ?? {};

      isApplyingRemoteData = true;
      fieldIds.forEach((id) => {
        const element = document.getElementById(id);
        if (!element) return;
        const remoteValue = remoteFields[id] ?? '';
        if (element.value !== remoteValue) {
          element.value = remoteValue;
          autosize(element);
        }
      });
      isApplyingRemoteData = false;
    });
  } catch (error) {
    console.error('Fehler beim Verbinden mit Firestore:', error);
  }
}

function detachProject() {
  if (unsubscribeProject) {
    unsubscribeProject();
    unsubscribeProject = null;
  }
  projectDocRef = null;
  pendingRemoteUpdates = {};
}

async function persistRemoteUpdates() {
  if (!currentUser || !projectDocRef) return;
  const updates = {};
  const fields = Object.keys(pendingRemoteUpdates);

  if (!fields.length) return;

  fields.forEach((id) => {
    updates[`fields.${id}`] = pendingRemoteUpdates[id];
  });
  pendingRemoteUpdates = {};

  try {
    await updateDoc(projectDocRef, {
      ...updates,
      updatedAt: serverTimestamp(),
      lastEditor: currentUser.uid,
    });
    showSaved();
  } catch (error) {
    console.error('Fehler beim Speichern in Firestore:', error);
  }
}

function saveLocalData() {
  const data = getCurrentFieldValues();
  localStorage.setItem(storageKey, JSON.stringify(data));
  showSaved();
}

function loadLocalData() {
  const dataString = localStorage.getItem(storageKey);
  if (!dataString) return;

  try {
    const data = JSON.parse(dataString);
    fieldIds.forEach((id) => {
      const element = document.getElementById(id);
      if (element && data[id] !== undefined) {
        element.value = data[id];
      }
    });
  } catch (error) {
    console.error('Fehler beim Laden lokaler Daten:', error);
    localStorage.removeItem(storageKey);
  }
}

function getCurrentFieldValues() {
  return fieldIds.reduce((acc, id) => {
    const element = document.getElementById(id);
    acc[id] = element ? element.value : '';
    return acc;
  }, {});
}

function autosizeAll() {
  fieldIds.forEach((id) => {
    const element = document.getElementById(id);
    if (element && element.tagName === 'TEXTAREA') {
      autosize(element);
    }
  });
}

function setupClearButton() {
  const clearButton = document.getElementById('clearButton');
  if (!clearButton) return;

  clearButton.addEventListener('click', async () => {
    fieldIds.forEach((id) => {
      const element = document.getElementById(id);
      if (element) {
        element.value = '';
        autosize(element);
      }
    });

    localStorage.removeItem(storageKey);

    if (currentUser && projectDocRef) {
      try {
        const clearedFields = fieldIds.reduce((acc, id) => {
          acc[`fields.${id}`] = '';
          return acc;
        }, {});
        await updateDoc(projectDocRef, {
          ...clearedFields,
          updatedAt: serverTimestamp(),
          lastEditor: currentUser.uid,
        });
      } catch (error) {
        console.error('Fehler beim Zurücksetzen in Firestore:', error);
      }
    }
  });
}

// UX helpers
function autosize(element) {
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

function throttle(fn, wait) {
  let last = 0;
  let timer;

  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);

    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else {
      clearTimeout(timer);
      timer = setTimeout(() => {
        last = Date.now();
        fn(...args);
      }, remaining);
    }
  };
}

const showSaved = (() => {
  let t;
  const el = document.createElement('div');
  el.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 z-50 rounded-full bg-gray-800/90 text-gray-100 px-4 py-2 shadow ring-1 ring-white/10';
  el.textContent = 'Gespeichert';
  return () => {
    if (!document.body.contains(el)) document.body.appendChild(el);
    el.style.opacity = '1';
    clearTimeout(t);
    t = setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 300ms'; }, 600);
  };
})();