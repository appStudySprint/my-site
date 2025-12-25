import { auth, db, googleProvider } from './firebase.js';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';

// Gemini API Konstante
const GEMINI_API_KEY = 'AIzaSyCE27me4vv7Yo6u3FGOVncG7Z5_WFytHN0';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;

const fieldIds = [
  'problem', 'solution', 'pitch',
  'persona_name', 'persona_demographics', 'persona_pains', 'persona_gains',
  'mvp_core1', 'mvp_core2', 'mvp_core3', 'mvp_anti_features',
  'validation_method', 'validation_success',
  'resources_stack', 'resources_budget', 'resources_time',
];

const LOCAL_STORAGE_PREFIX = 'projektDashboardData';

let currentUser = null;
let projectDocRef = null;
let unsubscribeProject = null;
let unsubscribeMembers = null;
let unsubscribePendingInvites = null;
let unsubscribeIncomingInvites = null;
let isApplyingRemoteData = false;
let pendingRemoteUpdates = {};

let activeProjectId = null;
let activeProjectName = 'Persönliches Projekt';
let currentMembership = { role: 'owner' };

const throttledLocalSave = throttle(saveLocalData, 200);
const throttledFirestoreSave = throttle(persistRemoteUpdates, 500);

document.addEventListener('DOMContentLoaded', () => {
  setupAuthUi();
  loadLocalData();
  autosizeAll();
  bindFieldListeners();
  setupClearButton();
  setupInviteForm();
  captureInviteFromUrl();
  setupAnalyzeButtons();
});

function storageKey() {
  if (!currentUser || !activeProjectId) return `${LOCAL_STORAGE_PREFIX}:guest`;
  return `${LOCAL_STORAGE_PREFIX}:${activeProjectId}`;
}

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
        await initializeForUser(user);
      } else {
        userBadge.classList.add('hidden');
        userBadge.classList.remove('flex');
        if (signInButton) signInButton.classList.remove('hidden');
        clearProjectSubscriptions();
        activeProjectId = null;
        activeProjectName = 'Persönliches Projekt';
        currentMembership = { role: 'viewer' };
        updateProjectLabel();
        toggleTeamSection(false);
        loadLocalData();
        autosizeAll();
      }
    }
  });
}

async function initializeForUser(user) {
  // SCHRITT 1: SOFORTIGE UI-AKTIVIERUNG (Optimistisch)
  // Wir warten nicht auf die Datenbank. Wenn der User da ist, zeig die Sektion!
  console.log("Benutzer erkannt. Aktiviere Team-Sektion...");
  toggleTeamSection(true); 

  try {
    // SCHRITT 2: Datenbank-Operationen
    await ensureOwnerProject(user);
    await resolveActiveProject(user);
    watchIncomingInvites(user);
    
  } catch (error) {
    // SCHRITT 3: Fehler sichtbar machen
    console.error('Fehler bei der Initialisierung:', error);
    
    // WICHTIG: Wir zeigen den Fehler jetzt direkt auf dem Bildschirm an via Alert.
    // So wissen wir SOFORT, ob es an den Regeln oder der Verbindung liegt.
    alert("Ein Fehler ist aufgetreten:\n\n" + error.message + "\n\n(Bitte prüfen Sie die Firestore-Regeln oder den Account-Status)");
  }
}
async function ensureOwnerProject(user) {
  const projectId = `${user.uid}-personal`;
  const ref = doc(db, 'projects', projectId);
  const snapshot = await getDoc(ref);
  if (!snapshot.exists()) {
    const initialFields = getCurrentFieldValues();
    await setDoc(ref, {
      ownerId: user.uid,
      name: 'Persönliches Projekt',
      fields: initialFields,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
  await setDoc(doc(db, 'projects', projectId, 'members', user.uid), {
    role: 'owner',
    email: user.email ?? '',
    displayName: user.displayName ?? '',
    addedAt: serverTimestamp(),
  }, { merge: true });
}

async function resolveActiveProject(user) {
  const stored = localStorage.getItem('activeProjectId');

  if (stored) {
    const existing = await getDoc(doc(db, 'projects', stored));
    if (existing.exists()) {
      await setActiveProject(stored);
      return;
    }
    localStorage.removeItem('activeProjectId');
  }

  const defaultId = `${user.uid}-personal`;
  await setActiveProject(defaultId);
}

async function setActiveProject(projectId) {
  if (!currentUser) return;
  if (activeProjectId === projectId) return;

  clearProjectSubscriptions();
  activeProjectId = projectId;
  localStorage.setItem('activeProjectId', projectId);

  projectDocRef = doc(db, 'projects', projectId);
  const projectSnap = await getDoc(projectDocRef);

  if (!projectSnap.exists()) {
    await setDoc(projectDocRef, {
      ownerId: currentUser.uid,
      name: 'Projekt',
      fields: getCurrentFieldValues(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  const data = projectSnap.data() ?? {};
  activeProjectName = data.name ?? 'Projekt';
  updateProjectLabel();

  const membershipSnap = await getDoc(doc(db, 'projects', projectId, 'members', currentUser.uid));
  currentMembership = membershipSnap.exists() ? membershipSnap.data() : { role: 'viewer' };
  if (!membershipSnap.exists()) {
    await setDoc(doc(db, 'projects', projectId, 'members', currentUser.uid), {
      role: currentUser.uid === data.ownerId ? 'owner' : 'editor',
      email: currentUser.email ?? '',
      displayName: currentUser.displayName ?? '',
      addedAt: serverTimestamp(),
    }, { merge: true });
  }

  subscribeToProject(projectId);
  subscribeToMembers(projectId);
  subscribeToPendingInvites(projectId);

  loadIncomingInvitesVisibility();
  bindFieldListeners();
}

function clearProjectSubscriptions() {
  if (unsubscribeProject) unsubscribeProject();
  if (unsubscribeMembers) unsubscribeMembers();
  if (unsubscribePendingInvites) unsubscribePendingInvites();
  if (unsubscribeIncomingInvites) unsubscribeIncomingInvites();
  unsubscribeProject = null;
  unsubscribeMembers = null;
  unsubscribePendingInvites = null;
  unsubscribeIncomingInvites = null;
  projectDocRef = null;
  pendingRemoteUpdates = {};
}

function subscribeToProject(projectId) {
  if (unsubscribeProject) unsubscribeProject();
  projectDocRef = doc(db, 'projects', projectId);

  unsubscribeProject = onSnapshot(projectDocRef, (docSnap) => {
    if (!docSnap.exists()) return;
    const data = docSnap.data() ?? {};
    activeProjectName = data.name ?? activeProjectName;
    updateProjectLabel();

    const remoteFields = data.fields ?? {};
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
  }, (error) => {
    console.error('Fehler beim Beobachten des Projekts:', error);
  });
}

function subscribeToMembers(projectId) {
  if (unsubscribeMembers) unsubscribeMembers();
  const membersRef = collection(db, 'projects', projectId, 'members');

  unsubscribeMembers = onSnapshot(membersRef, (snapshot) => {
    const members = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));

    if (currentUser) {
      const self = members.find((member) => member.id === currentUser.uid);
      if (self) {
        const previousRole = currentMembership?.role;
        currentMembership = self;
        if (previousRole !== currentMembership.role) {
          updateProjectLabel();
          subscribeToPendingInvites(projectId);
        }
      }
    }

    renderCollaborators(members);
  }, (error) => {
    console.error('Fehler beim Beobachten der Mitglieder:', error);
  });
}

function subscribeToPendingInvites(projectId) {
  if (unsubscribePendingInvites) unsubscribePendingInvites();
  const container = document.getElementById('pendingInvites');

  if (!currentUser || currentMembership.role !== 'owner') {
    if (container) container.innerHTML = `<p class="text-xs text-gray-500">Nur Besitzer sehen offene Einladungen.</p>`;
    unsubscribePendingInvites = null;
    return;
  }

  const invitesQuery = query(
    collection(db, 'projectInvites'),
    where('projectId', '==', projectId),
    where('status', '==', 'pending'),
  );

  unsubscribePendingInvites = onSnapshot(invitesQuery, (snapshot) => {
    const invites = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));
    renderPendingInvites(invites);
  }, (error) => {
    console.error('Fehler beim Beobachten der Einladungen:', error);
  });
}

function watchIncomingInvites(user) {
  if (unsubscribeIncomingInvites) unsubscribeIncomingInvites();
  const incomingQuery = query(
    collection(db, 'projectInvites'),
    where('invitedEmail', '==', (user.email ?? '').toLowerCase()),
    where('status', '==', 'pending'),
  );

  unsubscribeIncomingInvites = onSnapshot(incomingQuery, (snapshot) => {
    const invites = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));
    renderIncomingInvites(invites);
  }, (error) => {
    console.error('Fehler beim Beobachten eigener Einladungen:', error);
  });
}

function bindFieldListeners() {
  fieldIds.forEach((id) => {
    const element = document.getElementById(id);
    if (!element || element.dataset.bound === 'true') return;

    element.dataset.bound = 'true';
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
  localStorage.setItem(storageKey(), JSON.stringify(data));
  showSaved();
}

function loadLocalData() {
  const dataString = localStorage.getItem(storageKey());
  if (!dataString) return;

  try {
    const data = JSON.parse(dataString);
    fieldIds.forEach((id) => {
      const element = document.getElementById(id);
      if (element && data[id] !== undefined) {
        element.value = data[id];
        autosize(element);
      }
    });
  } catch (error) {
    console.error('Fehler beim Laden lokaler Daten:', error);
    localStorage.removeItem(storageKey());
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

    localStorage.removeItem(storageKey());

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

function setupInviteForm() {
  const inviteForm = document.getElementById('inviteForm');
  if (!inviteForm) return;

  inviteForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentUser || !activeProjectId) return;
    if (currentMembership.role !== 'owner') {
      alert('Nur Besitzer können Einladungen versenden.');
      return;
    }

    const emailInput = document.getElementById('inviteEmail');
    const roleSelect = document.getElementById('inviteRole');
    if (!emailInput || !roleSelect) return;

    const invitedEmail = emailInput.value.trim().toLowerCase();
    const role = roleSelect.value || 'editor';

    if (!invitedEmail) {
      alert('Bitte eine gültige E-Mail-Adresse eingeben.');
      return;
    }

    try {
      const inviteId = (window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID().replace(/-/g, '')
        : `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      const inviteRef = doc(db, 'projectInvites', inviteId);
      await setDoc(inviteRef, {
        projectId: activeProjectId,
        projectName: activeProjectName,
        invitedEmail,
        role,
        status: 'pending',
        createdBy: currentUser.uid,
        createdByEmail: currentUser.email ?? '',
        createdAt: serverTimestamp(),
      });
      emailInput.value = '';
      const inviteLink = `${window.location.origin}${window.location.pathname}?invite=${inviteId}`;
      
      // Kopiere Link in Zwischenablage
      try {
        await navigator.clipboard.writeText(inviteLink);
        showSavedFeedback('Einladung erstellt. Link wurde kopiert.');
      } catch (err) {
        // Fallback: Zeige Link in Alert, falls Clipboard nicht funktioniert
        alert(`Einladung erstellt!\n\nEinladungslink:\n${inviteLink}\n\n(Dieser Link wurde in die Zwischenablage kopiert, falls möglich)`);
      }
      
      // Zeige Link auch visuell an
      const linkDisplay = document.createElement('div');
      linkDisplay.className = 'mt-3 p-3 bg-gray-900/80 rounded border border-brand-500/30';
      linkDisplay.innerHTML = `
        <p class="text-xs text-gray-400 mb-1">Einladungslink:</p>
        <div class="flex items-center gap-2">
          <input type="text" readonly value="${inviteLink}" class="flex-1 bg-gray-800 text-gray-200 text-xs px-2 py-1 rounded border border-white/10" id="inviteLinkInput-${inviteId}" />
          <button class="bg-brand-500 hover:bg-brand-600 text-white text-xs px-3 py-1 rounded" onclick="navigator.clipboard.writeText('${inviteLink}').then(() => alert('Link kopiert!'))">Kopieren</button>
        </div>
      `;
      const pendingContainer = document.getElementById('pendingInvites');
      if (pendingContainer) {
        pendingContainer.insertBefore(linkDisplay, pendingContainer.firstChild);
        setTimeout(() => linkDisplay.remove(), 10000); // Entferne nach 10 Sekunden
      }
    } catch (error) {
      console.error('Fehler beim Erstellen der Einladung:', error);
      alert('Die Einladung konnte nicht erstellt werden.');
    }
  });
}

function renderCollaborators(members) {
  const list = document.getElementById('collaboratorList');
  if (!list) return;

  if (!members.length) {
    list.innerHTML = `<p class="text-gray-500 text-sm">Noch keine Teammitglieder vorhanden.</p>`;
    return;
  }

  list.innerHTML = members.map((member) => `
    <div class="flex items-center justify-between rounded-md border border-white/10 bg-gray-900/60 px-4 py-3">
      <div>
        <p class="text-sm font-medium text-gray-100">${member.displayName || 'Unbekannt'}</p>
        <p class="text-xs text-gray-400">${member.email || member.id}</p>
      </div>
      <span class="text-xs uppercase tracking-wide text-brand-300">${member.role ?? 'editor'}</span>
    </div>
  `).join('');
}

function renderPendingInvites(invites) {
  const container = document.getElementById('pendingInvites');
  if (!container) return;

  if (!invites.length) {
    container.innerHTML = `<p class="text-xs text-gray-500">Keine offenen Einladungen.</p>`;
    return;
  }

  container.innerHTML = invites.map((invite) => {
    const inviteLink = `${window.location.origin}${window.location.pathname}?invite=${invite.id}`;
    return `
    <div class="border border-white/10 rounded-md bg-gray-800/80 px-3 py-2 text-xs mb-2">
      <div class="flex items-center justify-between gap-2 mb-2">
        <div>
          <p class="text-gray-200 font-medium">${invite.invitedEmail}</p>
          <p class="text-gray-500 uppercase tracking-wide text-[10px]">${invite.role}</p>
        </div>
        <div class="flex items-center gap-2">
          <button data-action="copy-invite" data-id="${invite.id}" class="text-brand-300 hover:text-brand-200 text-[10px]">Link kopieren</button>
          <button data-action="revoke-invite" data-id="${invite.id}" class="text-red-400 hover:text-red-300 text-[10px]">Widerrufen</button>
        </div>
      </div>
      <div class="flex items-center gap-2 mt-2 pt-2 border-t border-white/5">
        <input type="text" readonly value="${inviteLink}" class="flex-1 bg-gray-900/60 text-gray-300 text-[10px] px-2 py-1 rounded border border-white/5 font-mono" onclick="this.select()" />
        <button data-action="copy-invite-full" data-link="${inviteLink}" class="bg-brand-500 hover:bg-brand-600 text-white text-[10px] px-2 py-1 rounded">Kopieren</button>
      </div>
    </div>
  `;
  }).join('');

  container.querySelectorAll('button[data-action="copy-invite"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const inviteId = button.dataset.id;
      const link = `${window.location.origin}${window.location.pathname}?invite=${inviteId}`;
      try {
        await navigator.clipboard.writeText(link);
        showSavedFeedback('Einladungslink kopiert.');
      } catch {
        alert('Konnte Link nicht kopieren.');
      }
    });
  });

  container.querySelectorAll('button[data-action="copy-invite-full"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const link = button.dataset.link;
      try {
        await navigator.clipboard.writeText(link);
        showSavedFeedback('Link kopiert!');
      } catch {
        alert('Konnte Link nicht kopieren.');
      }
    });
  });

  container.querySelectorAll('button[data-action="revoke-invite"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const inviteId = button.dataset.id;
      if (!inviteId) return;
      try {
        await updateDoc(doc(db, 'projectInvites', inviteId), {
          status: 'revoked',
          revokedAt: serverTimestamp(),
          revokedBy: currentUser?.uid ?? null,
        });
        showSavedFeedback('Einladung widerrufen.');
      } catch (error) {
        console.error('Fehler beim Widerrufen:', error);
        alert('Einladung konnte nicht widerrufen werden.');
      }
    });
  });
}

function renderIncomingInvites(invites) {
  const section = document.getElementById('incomingInvitesSection');
  const list = document.getElementById('incomingInvitesList');
  if (!section || !list) return;
  const storedToken = localStorage.getItem('pendingInviteToken');

  if (!currentUser) {
    section.classList.add('hidden');
    list.innerHTML = '';
    return;
  }

  if (!invites.length) {
    section.classList.add('hidden');
    list.innerHTML = '';
    return;
  }

  section.classList.remove('hidden');
  list.innerHTML = invites.map((invite) => `
    <div class="rounded-md border border-white/10 bg-gray-800/80 px-4 py-3 ${storedToken === invite.id ? 'ring-2 ring-brand-400/70' : ''}">
      <p class="text-sm text-gray-100 mb-1">Du wurdest zu <span class="font-semibold">${invite.projectName ?? 'einem Projekt'}</span> eingeladen.</p>
      <p class="text-xs text-gray-400 mb-2">Rolle: ${invite.role}</p>
      <div class="flex items-center gap-2">
        <button data-action="accept-invite" data-id="${invite.id}" class="bg-brand-500 hover:bg-brand-600 text-white text-sm font-semibold px-3 py-1 rounded">Annehmen</button>
        <button data-action="dismiss-invite" data-id="${invite.id}" class="text-xs text-gray-400 hover:text-gray-200">Ablehnen</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('button[data-action="accept-invite"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const inviteId = button.dataset.id;
      const invite = invites.find((item) => item.id === inviteId);
      if (!invite) return;
      await acceptInvite(inviteId, invite);
      localStorage.removeItem('pendingInviteToken');
    });
  });

  list.querySelectorAll('button[data-action="dismiss-invite"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const inviteId = button.dataset.id;
      try {
        await updateDoc(doc(db, 'projectInvites', inviteId), {
          status: 'dismissed',
          dismissedAt: serverTimestamp(),
          dismissedBy: currentUser?.uid ?? null,
        });
        if (localStorage.getItem('pendingInviteToken') === inviteId) {
          localStorage.removeItem('pendingInviteToken');
        }
      } catch (error) {
        console.error('Fehler beim Ablehnen der Einladung:', error);
      }
    });
  });
}

async function acceptInvite(inviteId, invite) {
  if (!currentUser) return;
  try {
    const memberRef = doc(db, 'projects', invite.projectId, 'members', currentUser.uid);
    await setDoc(memberRef, {
      role: invite.role,
      email: currentUser.email ?? '',
      displayName: currentUser.displayName ?? '',
      addedAt: serverTimestamp(),
    }, { merge: true });

    await updateDoc(doc(db, 'projectInvites', inviteId), {
      status: 'accepted',
      acceptedAt: serverTimestamp(),
      acceptedBy: currentUser.uid,
    });

    await setActiveProject(invite.projectId);
    showSavedFeedback('Einladung angenommen. Projekt aktiviert.');
    localStorage.removeItem('pendingInviteToken');
  } catch (error) {
    console.error('Fehler beim Annehmen der Einladung:', error);
    alert('Einladung konnte nicht angenommen werden.');
  }
}

function updateProjectLabel() {
  const nameEl = document.getElementById('activeProjectName');
  if (nameEl) nameEl.textContent = activeProjectName;

  const teamSection = document.getElementById('teamSection');
  const inviteForm = document.getElementById('inviteForm');
  if (teamSection) {
    const isOwner = currentMembership?.role === 'owner';
    if (isOwner) {
      teamSection.classList.remove('hidden');
      if (inviteForm) inviteForm.classList.remove('opacity-50', 'pointer-events-none');
    } else {
      teamSection.classList.remove('hidden');
      if (inviteForm) inviteForm.classList.add('opacity-50', 'pointer-events-none');
    }
  }
}

function toggleTeamSection(visible) {
  const teamSection = document.getElementById('teamSection');
  if (!teamSection) return;
  if (visible) teamSection.classList.remove('hidden');
  else teamSection.classList.add('hidden');
}

function loadIncomingInvitesVisibility() {
  const section = document.getElementById('incomingInvitesSection');
  if (section && !currentUser) {
    section.classList.add('hidden');
  }
}

function captureInviteFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('invite');
  if (token) {
    localStorage.setItem('pendingInviteToken', token);
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

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

function showSavedFeedback(message) {
  const el = document.createElement('div');
  el.textContent = message;
  el.className = 'fixed bottom-16 left-1/2 -translate-x-1/2 z-50 rounded-md bg-gray-900/90 text-gray-100 px-4 py-2 shadow ring-1 ring-white/10 text-sm';
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 300ms';
    setTimeout(() => {
      if (document.body.contains(el)) document.body.removeChild(el);
    }, 300);
  }, 1200);
}

// Markdown zu HTML Konverter (verbessert)
function markdownToHtml(markdown) {
  if (!markdown) return '';
  
  // Zuerst Code-Blöcke schützen (werden später wieder eingefügt)
  const codeBlocks = [];
  let html = markdown.replace(/```[\s\S]*?```/g, (match) => {
    const id = `CODE_BLOCK_${codeBlocks.length}`;
    codeBlocks.push(match);
    return id;
  });
  
  // Inline-Code schützen
  const inlineCodes = [];
  html = html.replace(/`([^`]+)`/g, (match, content) => {
    const id = `INLINE_CODE_${inlineCodes.length}`;
    inlineCodes.push(`<code class="ai-response-code">${content}</code>`);
    return id;
  });
  
  // Zeilenweise verarbeiten
  const lines = html.split('\n');
  const result = [];
  let inList = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();
    
    // Überschriften erkennen (muss vor anderen Verarbeitungen kommen)
    if (trimmedLine.startsWith('### ')) {
      if (inList) {
        result.push('</ul>');
        inList = false;
      }
      const headingText = trimmedLine.substring(4).trim();
      // Fett in Überschriften verarbeiten
      const processedHeading = headingText.replace(/\*\*(.+?)\*\*/g, '<strong class="text-brand-400">$1</strong>');
      result.push(`<h4 class="text-lg font-semibold text-gray-200 mt-3 mb-1">${processedHeading}</h4>`);
      continue;
    }
    
    if (trimmedLine.startsWith('## ')) {
      if (inList) {
        result.push('</ul>');
        inList = false;
      }
      const headingText = trimmedLine.substring(3).trim();
      // Fett in Überschriften verarbeiten
      const processedHeading = headingText.replace(/\*\*(.+?)\*\*/g, '<strong class="text-brand-400">$1</strong>');
      result.push(`<h3 class="text-xl font-bold text-white mt-4 mb-2">${processedHeading}</h3>`);
      continue;
    }
    
    // Listen erkennen
    const listMatch = trimmedLine.match(/^[\-\*]\s+(.+)$/) || trimmedLine.match(/^\d+\.\s+(.+)$/);
    
    if (listMatch) {
      if (!inList) {
        result.push('<ul class="list-disc pl-5 space-y-1">');
        inList = true;
      }
      // Fett in Listenpunkten verarbeiten
      let listItem = listMatch[1];
      listItem = listItem.replace(/\*\*(.+?)\*\*/g, '<strong class="text-brand-400">$1</strong>');
      result.push(`<li>${listItem}</li>`);
    } else {
      if (inList) {
        result.push('</ul>');
        inList = false;
      }
      
      if (trimmedLine) {
        // Fett: **text** oder __text__ (zuerst, damit sie nicht als Kursiv erkannt werden)
        let processedLine = trimmedLine
          .replace(/\*\*(.+?)\*\*/g, '<strong class="text-brand-400">$1</strong>')
          .replace(/__(.+?)__/g, '<strong class="text-brand-400">$1</strong>')
          // Kursiv: *text* oder _text_ (nur wenn nicht am Anfang/Ende und nicht Teil von **)
          .replace(/([^*])\*([^*]+?)\*([^*])/g, '$1<em>$2</em>$3')
          .replace(/([^_])_([^_]+?)_([^_])/g, '$1<em>$2</em>$3');
        
        result.push(`<p>${processedLine}</p>`);
      } else if (i < lines.length - 1) {
        // Leere Zeile zwischen Paragraphen
        result.push('');
      }
    }
  }
  
  if (inList) {
    result.push('</ul>');
  }
  
  html = result.join('\n');
  
  // Code-Blöcke wieder einfügen
  codeBlocks.forEach((block, index) => {
    html = html.replace(`CODE_BLOCK_${index}`, `<pre class="ai-response-code-block">${block.replace(/```/g, '')}</pre>`);
  });
  
  // Inline-Code wieder einfügen
  inlineCodes.forEach((code, index) => {
    html = html.replace(`INLINE_CODE_${index}`, code);
  });
  
  return html;
}

async function analyzeSection(sectionName) {
  const sectionConfig = {
    'hypothese': {
      buttonId: 'analyze-hypothese',
      spinnerId: 'spinner-hypothese',
      responseId: 'response-hypothese',
      prompt: 'Du bist ein skeptischer VC. Kritisiere dieses Problem und die Lösung hart.',
      fields: ['problem', 'solution', 'pitch']
    },
    'persona': {
      buttonId: 'analyze-persona',
      spinnerId: 'spinner-persona',
      responseId: 'response-persona',
      prompt: 'Du bist ein Produktmanager. Finde Lücken in dieser Persona.',
      fields: ['persona_name', 'persona_demographics', 'persona_pains', 'persona_gains']
    },
    'mvp': {
      buttonId: 'analyze-mvp',
      spinnerId: 'spinner-mvp',
      responseId: 'response-mvp',
      prompt: 'Du bist ein Lean-Startup-Coach. Welches Feature ist unnötig?',
      fields: ['mvp_core1', 'mvp_core2', 'mvp_core3', 'mvp_anti_features']
    },
    'validierung': {
      buttonId: 'analyze-validierung',
      spinnerId: 'spinner-validierung',
      responseId: 'response-validierung',
      prompt: 'Du bist ein Marktanalyst. Welche Konkurrenten gibt es?',
      fields: ['validation_method', 'validation_success']
    }
  };

  const config = sectionConfig[sectionName];
  if (!config) {
    console.error('Unbekannte Sektion:', sectionName);
    return;
  }

  const button = document.getElementById(config.buttonId);
  const spinner = document.getElementById(config.spinnerId);
  const responseDiv = document.getElementById(config.responseId);

  if (!button || !spinner || !responseDiv) {
    console.error('Elemente nicht gefunden für Sektion:', sectionName);
    return;
  }

  // Sammle Feldwerte
  const fieldValues = config.fields.map(fieldId => {
    const element = document.getElementById(fieldId);
    return element ? element.value.trim() : '';
  }).filter(val => val.length > 0);

  if (fieldValues.length === 0) {
    responseDiv.innerHTML = '<p class="text-yellow-400">Bitte füllen Sie zuerst die Felder aus.</p>';
    responseDiv.classList.remove('hidden');
    return;
  }

  // UI: Loading-State
  button.disabled = true;
  spinner.classList.remove('hidden');
  responseDiv.classList.add('hidden');

  try {
    // Erstelle den vollständigen Prompt
    const content = fieldValues.join('\n\n');
    const fullPrompt = `${config.prompt}\n\n${content}`;

    // API-Aufruf
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: fullPrompt
          }]
        }]
      })
    });

    if (!response.ok) {
      throw new Error(`API-Fehler: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    // Extrahiere die Antwort
    let aiResponse = '';
    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
      aiResponse = data.candidates[0].content.parts[0].text || '';
    }

    if (!aiResponse) {
      throw new Error('Keine Antwort von der API erhalten');
    }

    // Konvertiere Markdown zu HTML und zeige an
    const htmlResponse = markdownToHtml(aiResponse);
    responseDiv.innerHTML = htmlResponse;
    responseDiv.classList.remove('hidden');

  } catch (error) {
    console.error('Fehler bei der Analyse:', error);
    responseDiv.innerHTML = `<p class="text-red-400">Fehler: ${error.message}</p>`;
    responseDiv.classList.remove('hidden');
  } finally {
    // UI: Loading-State zurücksetzen
    button.disabled = false;
    spinner.classList.add('hidden');
  }
}

function setupAnalyzeButtons() {
  // Event-Listener für alle Analyse-Buttons
  const buttonMappings = [
    { buttonId: 'analyze-hypothese', sectionName: 'hypothese' },
    { buttonId: 'analyze-persona', sectionName: 'persona' },
    { buttonId: 'analyze-mvp', sectionName: 'mvp' },
    { buttonId: 'analyze-validierung', sectionName: 'validierung' }
  ];

  buttonMappings.forEach(({ buttonId, sectionName }) => {
    const button = document.getElementById(buttonId);
    if (button) {
      button.addEventListener('click', () => analyzeSection(sectionName));
    }
  });
}