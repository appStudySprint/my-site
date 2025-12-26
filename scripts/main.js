import { auth, db, googleProvider } from './firebase.js';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';

// ============================================
// ZENTRALE API-KOMMUNIKATION (ROBUST)
// ============================================

/**
 * Zentrale Funktion für alle Gemini API-Aufrufe
 * Enthält Retry-Logik für 429 und robuste Fehlerbehandlung
 * Sendet Requests an Netlify Serverless Function (API-Key ist dort sicher)
 * @param {string} userPrompt - Der Prompt-Text
 * @param {number} retryCount - Retry-Zähler für Rate-Limiting
 * @param {boolean} useSearch - Wenn true, aktiviert Google Search Tool für echte Marktdaten
 * @returns {object} - { text: string, sources?: array } - Antwort mit optionalen Quellen
 */
async function callGeminiAPI(userPrompt, retryCount = 0, useSearch = false) {
  try {
    const requestBody = {
      contents: [{
        parts: [{
          text: userPrompt
        }]
      }],
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    };

    // Aktiviere Google Search Tool für echte Marktdaten
    if (useSearch) {
      requestBody.tools = [{ googleSearch: {} }];
    }

    const response = await fetch('/.netlify/functions/gemini-proxy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });

    // Behandle verschiedene HTTP-Status-Codes
    if (response.status === 429) {
      // Too Many Requests - Retry-Logik
      if (retryCount < 1) {
        console.warn('⚠️ API Rate Limit erreicht. Versuche es in 2 Sekunden erneut...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        return callGeminiAPI(userPrompt, retryCount + 1);
      } else {
        throw new Error('Die KI ist momentan überlastet. Bitte warte kurz und versuche es erneut.');
      }
    }

    if (response.status === 403) {
      const errorText = await response.text();
      console.error('403 Fehler Details:', errorText);
      throw new Error('API Key wurde abgelehnt. Bitte überprüfe die Domain-Einstellungen in der Google Cloud Console.');
    }

    if (response.status === 400) {
      const errorText = await response.text();
      console.error('400 Bad Request Details:', errorText);
      throw new Error('Ungültige Anfrage an die KI. Details in der Konsole.');
    }

    if (!response.ok) {
      throw new Error(`API-Fehler: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // Extrahiere die Antwort und optionale Quellen
    let aiResponse = '';
    let sources = [];
    
    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
      aiResponse = data.candidates[0].content.parts[0].text || '';
    }

    // Extrahiere Grounding Metadata (Quellen von Google Search)
    if (data.candidates && data.candidates[0] && data.candidates[0].groundingMetadata) {
      const metadata = data.candidates[0].groundingMetadata;
      if (metadata.searchEntryPoint && metadata.searchEntryPoint.renderedContent) {
        // Parse die Quellen aus dem Grounding Metadata
        sources = metadata.groundingChunks || [];
      }
      if (metadata.webSearchQueries) {
        console.log('🔍 Google Search Queries:', metadata.webSearchQueries);
      }
    }

    if (!aiResponse) {
      throw new Error('Keine Antwort von der API erhalten');
    }

    return { text: aiResponse, sources };

  } catch (error) {
    // Falls der Fehler bereits von uns geworfen wurde, leite ihn weiter
    if (error.message.includes('überlastet') || error.message.includes('abgelehnt') || error.message.includes('Ungültige')) {
      throw error;
    }
    // Netzwerkfehler oder andere Probleme
    console.error('Netzwerkfehler beim API-Aufruf:', error);
    throw new Error(`Verbindung zur KI fehlgeschlagen: ${error.message}`);
  }
}

/**
 * Bereinigt Markdown-Code-Blöcke und parst JSON robust
 */
function cleanAndParseJSON(text) {
  let cleanText = text.trim();

  // Entferne Markdown-Code-Blöcke
  cleanText = cleanText.replace(/^```json\s*/i, '');
  cleanText = cleanText.replace(/^```\s*/i, '');
  cleanText = cleanText.replace(/\s*```$/i, '');
  cleanText = cleanText.trim();

  try {
    return JSON.parse(cleanText);
  } catch (parseError) {
    // Fallback: Versuche JSON im Text zu finden
    const jsonMatch = cleanText.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error('Konnte JSON nicht parsen: ' + parseError.message);
  }
}

// ============================================
// ENDE ZENTRALE API-KOMMUNIKATION
// ============================================

const fieldIds = [
  'problem', 'solution', 'pitch',
  'persona_name', 'persona_demographics', 'persona_pains', 'persona_gains', 'persona_full',
  'mvp_core1', 'mvp_core2', 'mvp_core3', 'mvp_anti_features', 'mvp_features',
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

// Wizard State Management
let currentStep = 1;
const totalSteps = 6;

document.addEventListener('DOMContentLoaded', () => {
  setupAuthUi();
  loadLocalData();
  autosizeAll();
  setupAutosize(); // Initialisiere Autosize für alle Textareas
  bindFieldListeners();
  setupClearButton();
  setupInviteForm();
  captureInviteFromUrl();
  setupAnalyzeButtons();
  setupWizard();
  setupHistoryPanel();
  setupFinanceCalculator();
  showStep(1); // Starte mit Schritt 1
});

function storageKey() {
  if (!currentUser || !activeProjectId) return `${LOCAL_STORAGE_PREFIX}:guest`;
  return `${LOCAL_STORAGE_PREFIX}:${activeProjectId}`;
}

function setupAuthUi() {
  // Landing Page Start Button
  const landingBtn = document.getElementById('landingStartButton');
  if (landingBtn) {
    landingBtn.addEventListener('click', () => {
      console.log("Start-Button geklickt - starte Login...");
      signInWithPopup(auth, googleProvider).catch((error) => {
        console.error("Login Fehler:", error);
        alert("Login fehlgeschlagen: " + error.message);
      });
    });
  } else {
    console.error("ACHTUNG: Landing-Page Button nicht gefunden!");
  }

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

    const appContainer = document.getElementById('app-container');
    const landingPage = document.getElementById('landing-page');

    if (userBadge) {
      if (user) {
        // User eingeloggt -> Zeige App, verstecke Landing Page
        if (appContainer) appContainer.classList.remove('hidden');
        if (landingPage) landingPage.classList.add('hidden');
        
        userBadge.classList.remove('hidden');
        userBadge.classList.add('flex');
        if (signInButton) signInButton.classList.add('hidden');
        const historyButtonAuthed = document.getElementById('history-button-authed');
        if (historyButtonAuthed) historyButtonAuthed.classList.remove('hidden');
        if (userName) userName.textContent = user.displayName ?? 'Unbekannter Benutzer';
        if (userEmail) userEmail.textContent = user.email ?? '';
        await initializeForUser(user);
      } else {
        // User ausgeloggt -> Zeige Landing Page, verstecke App
        if (appContainer) appContainer.classList.add('hidden');
        if (landingPage) landingPage.classList.remove('hidden');
        
        userBadge.classList.add('hidden');
        userBadge.classList.remove('flex');
        if (signInButton) signInButton.classList.remove('hidden');
        const historyButtonAuthed = document.getElementById('history-button-authed');
        if (historyButtonAuthed) historyButtonAuthed.classList.add('hidden');
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
  if (!element) return;
  element.style.height = 'auto'; // Reset, um Schrumpfen zu erlauben
  element.style.height = element.scrollHeight + 'px'; // Setze auf Content-Höhe
}

function setupAutosize() {
  // Finde alle Textareas in der App
  const textareas = document.querySelectorAll('textarea');
  
  textareas.forEach(textarea => {
    // Entferne alte Listener (falls vorhanden)
    textarea.removeEventListener('input', handleAutosizeInput);
    
    // Füge neuen Listener hinzu
    textarea.addEventListener('input', handleAutosizeInput);
    
    // Initialisiere die Größe für vorhandenen Content
    autosize(textarea);
  });
}

function handleAutosizeInput(event) {
  autosize(event.target);
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
      const processedHeading = headingText.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      result.push(`<h4>${processedHeading}</h4>`);
      continue;
    }
    
    if (trimmedLine.startsWith('## ')) {
      if (inList) {
        result.push('</ul>');
        inList = false;
      }
      const headingText = trimmedLine.substring(3).trim();
      // Fett in Überschriften verarbeiten
      const processedHeading = headingText.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      result.push(`<h3>${processedHeading}</h3>`);
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
      listItem = listItem.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      result.push(`<li>${listItem}</li>`);
    } else {
      if (inList) {
        result.push('</ul>');
        inList = false;
      }
      
      if (trimmedLine) {
        // Fett: **text** oder __text__ (zuerst, damit sie nicht als Kursiv erkannt werden)
        let processedLine = trimmedLine
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/__(.+?)__/g, '<strong>$1</strong>')
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
      prompt: `Du bist ein erfahrener, analytischer Venture Capitalist. Deine Aufgabe ist ein objektiver Due-Diligence-Check.

REGELN:
1. Sei rigoros bei Schwachstellen (Marktgröße, Burggraben, Marge).
2. ABER: Wenn eine Idee Potenzial hat, erkenne das an! Lob ist erlaubt.
3. Unterscheide zwischen "tödlichen Fehlern" und "lösbaren Problemen".
4. Wenn die Idee nach einem Pivot (Optimierung) solide ist, gib ein "Vorsichtiges Go".

Antworte im Markdown-Format:
## 💡 Stärken der Idee
[Was funktioniert gut?]

## ⚠️ Kritische Schwachstellen
[Tödliche Fehler, die sofort behoben werden müssen]

## 🔧 Lösbare Probleme
[Dinge, die optimiert werden können]

## 🎯 Fazit
[Klares Verdict: Go / Pivot / No-Go]`,
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

    // API-Aufruf über zentrale Funktion
    const result = await callGeminiAPI(fullPrompt, 0, false);
    const aiResponse = result.text || result; // Backward compatibility

    // Konvertiere Markdown zu HTML und zeige an
    const htmlResponse = markdownToHtml(aiResponse);
    responseDiv.innerHTML = htmlResponse;
    responseDiv.classList.remove('hidden');
    // Stelle sicher, dass prose-invert Klasse vorhanden ist
    if (!responseDiv.classList.contains('prose-invert')) {
      responseDiv.classList.add('prose', 'prose-invert');
    }

    // Speichere die Analyse in Firestore (wenn User eingeloggt und Projekt aktiv)
    if (currentUser && activeProjectId) {
      try {
        await saveAnalysis(sectionName, content, aiResponse);
        showAnalysisSavedFeedback(button);
        showSavedFeedback('Analyse gespeichert');
      } catch (saveError) {
        console.error('Fehler beim Speichern der Analyse:', saveError);
        // Nicht kritisch - zeige Fehler nur in Console, nicht im UI
      }
    }

    // Zeige Pivot-Button für Hypothese-Sektion
    if (sectionName === 'hypothese') {
      const btnPivot = document.getElementById('btn-pivot');
      if (btnPivot) {
        btnPivot.classList.remove('hidden');
      }
      lastHypothesisAnalysis = { inputText: content, outputText: aiResponse };
    }

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

async function saveAnalysis(sectionName, inputText, outputText) {
  if (!currentUser || !activeProjectId) {
    return; // Nicht speichern, wenn kein User oder Projekt aktiv
  }

  try {
    await addDoc(collection(db, 'projects', activeProjectId, 'analyses'), {
      section: sectionName,
      inputText: inputText,
      outputText: outputText,
      createdAt: serverTimestamp(),
      createdBy: currentUser.uid,
      createdByEmail: currentUser.email ?? '',
    });
  } catch (error) {
    console.error('Fehler beim Speichern der Analyse:', error);
    throw error;
  }
}

function showAnalysisSavedFeedback(button) {
  if (!button) return;
  
  const originalText = button.innerHTML;
  const originalClasses = button.className;
  button.innerHTML = '<span>Gespeichert ✓</span>';
  button.disabled = true;
  button.className = 'w-full bg-green-600 text-white font-semibold py-4 px-6 rounded-lg transition-all duration-200 flex items-center justify-center gap-2';
  
  // Nach 2 Sekunden zurücksetzen
  setTimeout(() => {
    button.innerHTML = originalText;
    button.disabled = false;
    button.className = originalClasses;
  }, 2000);
}

// Speichere die letzte Hypothese-Analyse für Pivot
let lastHypothesisAnalysis = null;

async function pivotIdea() {
  if (!lastHypothesisAnalysis) {
    console.error('Keine Hypothese-Analyse verfügbar');
    return;
  }

  const pivotButton = document.getElementById('btn-pivot');
  const pivotButtonText = document.getElementById('pivot-button-text');
  const pivotSpinner = document.getElementById('pivot-spinner');
  const problemField = document.getElementById('problem');
  const solutionField = document.getElementById('solution');

  if (!pivotButton || !pivotButtonText || !pivotSpinner || !problemField || !solutionField) {
    console.error('Pivot-UI-Elemente nicht gefunden');
    return;
  }

  // UI: Loading-State
  pivotButton.disabled = true;
  pivotSpinner.classList.remove('hidden');
  pivotButtonText.textContent = 'Optimiere Idee...';

  try {
    // Erstelle den Pivot-Prompt
    const pivotPrompt = `Hier ist meine Startup-Idee:
${lastHypothesisAnalysis.inputText}

Hier ist das VC-Feedback dazu:
${lastHypothesisAnalysis.outputText}

DEINE AUFGABE:
Schreibe das Problem und die Lösung komplett neu, um die kritischen Schwachstellen zu beheben.

KRITERIEN FÜR DEN PIVOT:
1. **Marktfähigkeit**: Der Markt muss groß genug und erreichbar sein.
2. **Realistische Umsetzung**: Die Lösung muss mit begrenzten Ressourcen baubar sein.
3. **Klarer Mehrwert**: Die Lösung muss 10x besser sein als der Status Quo, nicht nur anders.
4. **Monetarisierung**: Es muss klar sein, wer wofür bezahlt.

Antworte NUR als reines JSON ohne Markdown-Formatierung:
{ "problem": "...", "solution": "..." }`;

    // API-Aufruf über zentrale Funktion
    const result = await callGeminiAPI(pivotPrompt, 0, false);
    const aiResponse = result.text || result;

    // Parse JSON robust mit zentraler Funktion
    const parsed = cleanAndParseJSON(aiResponse);

    if (!parsed.problem || !parsed.solution) {
      throw new Error('JSON enthält nicht die erwarteten Felder "problem" und "solution"');
    }

    // Setze die neuen Werte in die Felder
    problemField.value = parsed.problem;
    solutionField.value = parsed.solution;

    // Löse manuell ein 'input' Event aus, damit die Werte automatisch gespeichert werden
    const inputEvent = new Event('input', { bubbles: true });
    problemField.dispatchEvent(inputEvent);
    solutionField.dispatchEvent(inputEvent);

    // Autosize für die Textareas
    autosize(problemField);
    autosize(solutionField);

    // Feedback
    showSavedFeedback('Idea gepivoted! Neue Werte gespeichert.');

  } catch (error) {
    console.error('Fehler beim Pivot:', error);
    showSavedFeedback(`Fehler beim Pivot: ${error.message}`);
  } finally {
    // UI: Loading-State zurücksetzen
    pivotButton.disabled = false;
    pivotSpinner.classList.add('hidden');
    pivotButtonText.textContent = '🔄 Pivot: Idee basierend auf Kritik optimieren';
  }
}

async function analyzeCompetitors() {
  const button = document.getElementById('btn-competitors');
  const spinner = document.getElementById('spinner-competitors');
  const competitorSection = document.getElementById('competitor-section');
  const competitorGrid = document.getElementById('competitor-grid');
  const problemField = document.getElementById('problem');
  const solutionField = document.getElementById('solution');

  if (!button || !spinner || !competitorSection || !competitorGrid || !problemField || !solutionField) {
    console.error('Konkurrenz-Analyse-UI-Elemente nicht gefunden');
    return;
  }

  const problem = problemField.value.trim();
  const solution = solutionField.value.trim();

  if (!problem && !solution) {
    alert('Bitte fülle zuerst das Problem und die Lösung in Step 1 aus.');
    return;
  }

  // UI: Loading-State
  button.disabled = true;
  spinner.classList.remove('hidden');

  try {
    // Erstelle den Prompt mit Google Search für ECHTE Marktdaten
    const prompt = `Recherchiere LIVE im Internet nach Konkurrenten für diese Geschäftsidee:

Problem: ${problem}

Lösung: ${solution}

Finde 3 EXISTIERENDE Firmen oder Produkte, die in diesem Markt aktiv sind. Für jede Firma:
1. Name (echter Firmenname)
2. Website URL (wenn verfügbar)
3. Ihre größte Schwäche (basierend auf echten Reviews/Daten)
4. Unser unfairer Vorteil dagegen

Antworte NUR als valides JSON Array:
[{ "name": "...", "url": "...", "weakness": "...", "advantage": "..." }]`;

    // API-Aufruf mit Google Search aktiviert für echte Marktdaten
    const result = await callGeminiAPI(prompt, 0, true);
    const aiResponse = result.text || result;

    console.log('🔍 Konkurrenz-Analyse mit Google Search:', result.sources ? `${result.sources.length} Quellen gefunden` : 'Keine Quellen');

    // Parse JSON robust mit zentraler Funktion
    const competitors = cleanAndParseJSON(aiResponse);

    if (!Array.isArray(competitors) || competitors.length === 0) {
      throw new Error('Die API hat kein gültiges Array zurückgegeben');
    }

    // Rendere die Battle Cards mit URLs und Quellen-Badge
    competitorGrid.innerHTML = '';
    competitors.forEach((competitor) => {
      const card = document.createElement('div');
      card.className = 'glass-panel p-6 rounded-xl border-l-4 border-red-500 hover:translate-y-[-2px] transition-transform';
      
      const urlSection = competitor.url ? `
        <a href="${escapeHtml(competitor.url)}" target="_blank" rel="noopener" class="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 mb-3">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path>
          </svg>
          ${escapeHtml(competitor.url)}
        </a>
      ` : '';
      
      card.innerHTML = `
        <div class="flex items-start justify-between mb-2">
          <h4 class="text-xl font-bold text-white">${escapeHtml(competitor.name || 'Unbekannt')}</h4>
          <span class="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-1 rounded-full">LIVE</span>
        </div>
        ${urlSection}
        <div class="space-y-2">
          <div>
            <p class="text-xs text-gray-500 uppercase tracking-wide mb-1">Schwachstelle</p>
            <p class="text-sm text-red-300">${escapeHtml(competitor.weakness || 'Keine Angabe')}</p>
          </div>
          <div class="pt-2 border-t border-white/10">
            <p class="text-xs text-gray-500 uppercase tracking-wide mb-1">Unser Vorteil</p>
            <p class="text-sm text-emerald-400 font-bold">${escapeHtml(competitor.advantage || 'Keine Angabe')}</p>
          </div>
        </div>
      `;
      
      competitorGrid.appendChild(card);
    });

    // Zeige die Section
    competitorSection.classList.remove('hidden');

    // Speichere in Firestore (für Historie)
    if (currentUser && activeProjectId) {
      try {
        await addDoc(collection(db, 'projects', activeProjectId, 'analyses'), {
          section: 'competitors',
          inputText: `Problem: ${problem}\nLösung: ${solution}`,
          outputText: JSON.stringify(competitors, null, 2),
          createdAt: serverTimestamp(),
        });
        console.log('Konkurrenz-Analyse in Firestore gespeichert');
      } catch (saveError) {
        console.error('Fehler beim Speichern der Konkurrenz-Analyse:', saveError);
      }
    }

    showSavedFeedback('Konkurrenz-Analyse abgeschlossen!');

  } catch (error) {
    console.error('Fehler bei der Konkurrenz-Analyse:', error);
    alert(`Fehler bei der Konkurrenz-Analyse: ${error.message}`);
  } finally {
    // UI: Loading-State zurücksetzen
    button.disabled = false;
    spinner.classList.add('hidden');
  }
}

// Helper function to escape HTML
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

// ============================================
// VC FINAL SCORE CALCULATION
// ============================================

async function calculateFinalScore() {
  const button = document.getElementById('btn-final-score');
  const spinner = document.getElementById('spinner-final-score');
  const scoreCircle = document.getElementById('score-circle');
  const scoreValue = document.getElementById('score-value');
  const scoreVerdict = document.getElementById('score-verdict');
  const scoreBreakdown = document.getElementById('score-breakdown');

  if (!button || !spinner || !scoreCircle || !scoreValue) {
    console.error('Score UI-Elemente nicht gefunden');
    return;
  }

  // Sammle ALLE Daten aus dem Wizard
  const allData = {
    problem: document.getElementById('problem')?.value || '',
    solution: document.getElementById('solution')?.value || '',
    pitch: document.getElementById('pitch')?.value || '',
    persona_name: document.getElementById('persona_name')?.value || '',
    persona_demographics: document.getElementById('persona_demographics')?.value || '',
    persona_pains: document.getElementById('persona_pains')?.value || '',
    persona_gains: document.getElementById('persona_gains')?.value || '',
    mvp_features: document.getElementById('mvp_features')?.value || '',
    mvp_core1: document.getElementById('mvp_core1')?.value || '',
    mvp_core2: document.getElementById('mvp_core2')?.value || '',
    mvp_core3: document.getElementById('mvp_core3')?.value || '',
    mvp_anti_features: document.getElementById('mvp_anti_features')?.value || '',
    validation_method: document.getElementById('validation_method')?.value || '',
    validation_success: document.getElementById('validation_success')?.value || '',
    resources_stack: document.getElementById('resources_stack')?.value || '',
    resources_budget: document.getElementById('resources_budget')?.value || '',
    resources_time: document.getElementById('resources_time')?.value || '',
    calc_price: document.getElementById('calc_price')?.value || '0',
    calc_var_costs: document.getElementById('calc_var_costs')?.value || '0',
    calc_fixed_costs: document.getElementById('calc_fixed_costs')?.value || '0',
  };

  // Prüfe, ob genug Daten vorhanden sind
  const hasMinimalData = allData.problem && allData.solution;
  if (!hasMinimalData) {
    alert('Bitte fülle mindestens Problem und Lösung aus, bevor du das Scoring berechnest.');
    return;
  }

  // UI: Loading State
  button.disabled = true;
  spinner.classList.remove('hidden');
  scoreValue.textContent = '...';
  scoreValue.className = 'text-6xl font-bold text-gray-500';
  scoreCircle.className = 'absolute inset-0 flex items-center justify-center rounded-full border-8 border-gray-700 transition-all duration-500';
  scoreVerdict.classList.add('hidden');
  scoreBreakdown.classList.add('hidden');

  try {
    // Erstelle den Prompt für brutale VC-Bewertung
    const prompt = `Du bist ein erfahrener VC-Partner. Bewerte dieses Startup-Konzept BRUTAL EHRLICH auf einer Skala von 0-100.

DATEN:
Problem: ${allData.problem}
Lösung: ${allData.solution}
Elevator Pitch: ${allData.pitch}

Persona: ${allData.persona_name} (${allData.persona_demographics})
Schmerzpunkte: ${allData.persona_pains}
Wünsche: ${allData.persona_gains}

MVP Features: ${allData.mvp_features}
Kernfunktionen: ${allData.mvp_core1}, ${allData.mvp_core2}, ${allData.mvp_core3}
Anti-Features: ${allData.mvp_anti_features}

Validierung: ${allData.validation_method}
Erfolgsmetrik: ${allData.validation_success}

Ressourcen:
- Stack: ${allData.resources_stack}
- Budget: ${allData.resources_budget}
- Zeit: ${allData.resources_time}

Finanzen:
- Preis: ${allData.calc_price}€
- Variable Kosten: ${allData.calc_var_costs}€
- Fixkosten: ${allData.calc_fixed_costs}€/Monat

BEWERTUNGSKRITERIEN:
1. **Marktgröße** (0-100): Ist der Markt groß genug? Gibt es echte zahlende Kunden?
2. **Innovationsgrad** (0-100): Ist die Lösung wirklich innovativ oder nur "me too"?
3. **Umsetzbarkeit** (0-100): Sind die Ressourcen realistisch? Kann das Team es schaffen?

Berechne einen GESAMTSCORE (Durchschnitt der 3 Kriterien) und formuliere ein knappes, brutales VERDICT (1-2 Sätze).

Antworte NUR als JSON:
{
  "score": 45,
  "breakdown": {
    "market": 30,
    "innovation": 80,
    "feasibility": 25
  },
  "verdict": "Zu nischig. Die Umsetzung ist unrealistisch mit diesem Budget."
}`;

    // API-Aufruf (ohne Search - hier brauchen wir Logik, keine Marktdaten)
    const result = await callGeminiAPI(prompt, 0, false);
    const aiResponse = result.text || result;

    // Parse JSON
    const scoreData = cleanAndParseJSON(aiResponse);

    if (!scoreData.score || !scoreData.breakdown || !scoreData.verdict) {
      throw new Error('Ungültiges Score-Format von der API');
    }

    // Rendere das Ergebnis
    renderScore(scoreData);

    // Speichere in Firestore (für Historie)
    if (currentUser && activeProjectId) {
      try {
        await addDoc(collection(db, 'projects', activeProjectId, 'analyses'), {
          section: 'final-score',
          inputText: JSON.stringify(allData, null, 2),
          outputText: JSON.stringify(scoreData, null, 2),
          createdAt: serverTimestamp(),
        });
      } catch (saveError) {
        console.error('Fehler beim Speichern des Scores:', saveError);
      }
    }

    showSavedFeedback('VC-Score berechnet!');

  } catch (error) {
    console.error('Fehler beim Score-Berechnen:', error);
    scoreValue.textContent = '?';
    alert(`Fehler beim Berechnen des Scores: ${error.message}`);
  } finally {
    // UI: Loading State zurücksetzen
    button.disabled = false;
    spinner.classList.add('hidden');
  }
}

function renderScore(scoreData) {
  const scoreCircle = document.getElementById('score-circle');
  const scoreValue = document.getElementById('score-value');
  const scoreVerdict = document.getElementById('score-verdict');
  const scoreBreakdown = document.getElementById('score-breakdown');

  const score = Math.round(scoreData.score);
  const breakdown = scoreData.breakdown;

  // Färbe basierend auf Score
  let borderColor = 'border-red-500';
  let textColor = 'text-red-500';
  if (score >= 80) {
    borderColor = 'border-emerald-500';
    textColor = 'text-emerald-500';
  } else if (score >= 50) {
    borderColor = 'border-yellow-500';
    textColor = 'text-yellow-500';
  }

  // Update Score Circle
  scoreCircle.className = `absolute inset-0 flex items-center justify-center rounded-full border-8 ${borderColor} transition-all duration-500`;
  scoreValue.textContent = score;
  scoreValue.className = `text-6xl font-bold ${textColor}`;

  // Update Verdict
  scoreVerdict.classList.remove('hidden');
  scoreVerdict.querySelector('p').textContent = `"${scoreData.verdict}"`;

  // Update Breakdown Bars
  scoreBreakdown.classList.remove('hidden');
  
  const marketValue = Math.round(breakdown.market || 0);
  const innovationValue = Math.round(breakdown.innovation || 0);
  const feasibilityValue = Math.round(breakdown.feasibility || 0);

  document.getElementById('score-market-value').textContent = `${marketValue}/100`;
  document.getElementById('score-market-bar').style.width = `${marketValue}%`;

  document.getElementById('score-innovation-value').textContent = `${innovationValue}/100`;
  document.getElementById('score-innovation-bar').style.width = `${innovationValue}%`;

  document.getElementById('score-feasibility-value').textContent = `${feasibilityValue}/100`;
  document.getElementById('score-feasibility-bar').style.width = `${feasibilityValue}%`;

  // Animation
  setTimeout(() => {
    scoreCircle.style.transform = 'scale(1.05)';
    setTimeout(() => {
      scoreCircle.style.transform = 'scale(1)';
    }, 200);
  }, 100);
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

  // Event-Listener für Pivot-Button
  const pivotButton = document.getElementById('btn-pivot');
  if (pivotButton) {
    pivotButton.addEventListener('click', pivotIdea);
  }

  // Event-Listener für Konkurrenz-Button
  const competitorsButton = document.getElementById('btn-competitors');
  if (competitorsButton) {
    competitorsButton.addEventListener('click', analyzeCompetitors);
  }

  // Event-Listener für Final Score Button
  const finalScoreButton = document.getElementById('btn-final-score');
  if (finalScoreButton) {
    finalScoreButton.addEventListener('click', calculateFinalScore);
  }
}

// Wizard Functions
function setupWizard() {
  // Event Listener für alle Navigation Buttons
  document.querySelectorAll('.wizard-nav-next').forEach((button) => {
    button.addEventListener('click', () => {
      if (currentStep < totalSteps) {
        showStep(currentStep + 1);
      }
    });
  });

  document.querySelectorAll('.wizard-nav-back').forEach((button) => {
    button.addEventListener('click', () => {
      if (currentStep > 1) {
        showStep(currentStep - 1);
      }
    });
  });
}

function showStep(stepNumber) {
  if (stepNumber < 1 || stepNumber > totalSteps) {
    return;
  }

  currentStep = stepNumber;

  // Verstecke alle Steps
  document.querySelectorAll('.wizard-step').forEach((step) => {
    step.classList.add('hidden');
  });

  // Zeige aktuellen Step
  const currentStepElement = document.querySelector(`.wizard-step[data-step="${stepNumber}"]`);
  if (currentStepElement) {
    currentStepElement.classList.remove('hidden');
    currentStepElement.classList.add('fade-in-up');
  }

  // Update Progress Bar
  updateProgressBar(stepNumber);

  // Update Navigation Buttons
  updateNavigationButtons(stepNumber);

  // Autosize für alle Textareas im neuen Step
  setTimeout(() => {
    setupAutosize();
  }, 50); // Kurze Verzögerung, damit DOM bereit ist

  // Scroll nach oben
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateProgressBar(stepNumber) {
  document.querySelectorAll('.step-indicator').forEach((indicator, index) => {
    const stepNum = index + 1;
    indicator.classList.remove('active', 'completed');

    if (stepNum === stepNumber) {
      indicator.classList.add('active');
    } else if (stepNum < stepNumber) {
      indicator.classList.add('completed');
    }
  });

  // Update Connectors
  document.querySelectorAll('.step-connector').forEach((connector, index) => {
    const stepNum = index + 1;
    connector.classList.remove('completed');
    if (stepNum < stepNumber) {
      connector.classList.add('completed');
    }
  });
}

function updateNavigationButtons(stepNumber) {
  // Update "Zurück" Buttons
  document.querySelectorAll('.wizard-nav-back').forEach((button) => {
    if (stepNumber === 1) {
      button.classList.add('hidden');
    } else {
      button.classList.remove('hidden');
    }
  });

  // Update "Weiter" Button Text für letzten Schritt
  document.querySelectorAll('.wizard-nav-next').forEach((button) => {
    if (stepNumber === totalSteps) {
      button.textContent = 'Abschließen ✓';
      button.classList.remove('bg-blue-500', 'hover:bg-blue-600');
      button.classList.add('bg-green-600', 'hover:bg-green-700');
    } else {
      button.textContent = 'Weiter →';
      button.classList.remove('bg-green-600', 'hover:bg-green-700');
      button.classList.add('bg-blue-500', 'hover:bg-blue-600');
    }
  });
}


// History Panel Functions
function setupHistoryPanel() {
  const historyButton = document.getElementById('history-button');
  const historyButtonAuthed = document.getElementById('history-button-authed');
  const historyClose = document.getElementById('history-close');
  const historyPanel = document.getElementById('history-panel');

  const toggleHistory = () => {
    if (historyPanel) {
      const isHidden = historyPanel.classList.contains('hidden');
      if (isHidden) {
        historyPanel.classList.remove('hidden');
        setTimeout(() => {
          historyPanel.classList.remove('translate-x-full');
        }, 10);
        loadHistory();
      } else {
        historyPanel.classList.add('translate-x-full');
        setTimeout(() => {
          historyPanel.classList.add('hidden');
        }, 300);
      }
    }
  };

  if (historyButton) {
    historyButton.addEventListener('click', toggleHistory);
  }
  if (historyButtonAuthed) {
    historyButtonAuthed.addEventListener('click', toggleHistory);
  }
  if (historyClose) {
    historyClose.addEventListener('click', toggleHistory);
  }
}

async function loadHistory() {
  if (!currentUser || !activeProjectId) {
    const historyContent = document.getElementById('history-content');
    if (historyContent) {
      historyContent.innerHTML = '<p class="text-gray-400 text-center">Bitte melden Sie sich an, um die Historie zu sehen.</p>';
    }
    return;
  }

  const historyContent = document.getElementById('history-content');
  if (!historyContent) return;

  historyContent.innerHTML = '<p class="text-gray-400 text-center">Lade Historie...</p>';

  try {
    const analysesRef = collection(db, 'projects', activeProjectId, 'analyses');
    const q = query(analysesRef, orderBy('createdAt', 'desc'), limit(20));
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      historyContent.innerHTML = '<p class="text-gray-400 text-center">Noch keine Analysen vorhanden.</p>';
      return;
    }

    const analyses = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    historyContent.innerHTML = analyses.map(analysis => {
      const date = analysis.createdAt?.toDate ? analysis.createdAt.toDate().toLocaleDateString('de-DE') : 'Unbekannt';
      const sectionNames = {
        'hypothese': 'Hypothese',
        'persona': 'Persona',
        'mvp': 'MVP',
        'validierung': 'Validierung'
      };
      const sectionName = sectionNames[analysis.section] || analysis.section;
      
      return `
        <div class="glass-panel p-4">
          <div class="flex items-center justify-between mb-2">
            <span class="text-blue-400 font-semibold">${sectionName}</span>
            <span class="text-xs text-gray-500">${date}</span>
          </div>
          <p class="text-sm text-gray-300 line-clamp-3">${analysis.outputText?.substring(0, 150) || 'Keine Antwort'}...</p>
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error('Fehler beim Laden der Historie:', error);
    historyContent.innerHTML = '<p class="text-red-400 text-center">Fehler beim Laden der Historie.</p>';
  }
}

// Finance Calculator Functions
function setupFinanceCalculator() {
  const priceInput = document.getElementById('calc_price');
  const varCostsInput = document.getElementById('calc_var_costs');
  const fixedCostsInput = document.getElementById('calc_fixed_costs');

  if (priceInput && varCostsInput && fixedCostsInput) {
    [priceInput, varCostsInput, fixedCostsInput].forEach(input => {
      input.addEventListener('input', calculateBreakEven);
    });
    
    // Initial calculation
    calculateBreakEven();
  }
}

function calculateBreakEven() {
  const priceInput = document.getElementById('calc_price');
  const varCostsInput = document.getElementById('calc_var_costs');
  const fixedCostsInput = document.getElementById('calc_fixed_costs');
  const resultEl = document.getElementById('calc_result');

  if (!priceInput || !varCostsInput || !fixedCostsInput || !resultEl) {
    return;
  }

  const price = parseFloat(priceInput.value) || 0;
  const varCosts = parseFloat(varCostsInput.value) || 0;
  const fixedCosts = parseFloat(fixedCostsInput.value) || 0;

  // Berechne Deckungsbeitragsmarge
  const contributionMargin = price - varCosts;

  // Break-Even Formel: Fixkosten / (Preis - Variable Kosten)
  let breakEven;
  if (contributionMargin > 0) {
    breakEven = fixedCosts / contributionMargin;
  } else if (contributionMargin === 0 && fixedCosts === 0) {
    breakEven = 0;
  } else {
    breakEven = Infinity; // Negativer Deckungsbeitrag = nie Break-Even
  }

  // Formatierung und Anzeige
  if (isNaN(breakEven) || breakEven === Infinity || breakEven < 0) {
    resultEl.textContent = '-';
    resultEl.className = 'text-3xl font-bold text-red-400';
  } else {
    const roundedBreakEven = Math.ceil(breakEven);
    resultEl.textContent = `${roundedBreakEven.toLocaleString('de-DE')} Einheiten`;
    
    // Visuelles Feedback: Grün wenn Deckungsbeitrag positiv, sonst rot
    if (contributionMargin > 0) {
      resultEl.className = 'text-3xl font-bold text-emerald-400';
    } else {
      resultEl.className = 'text-3xl font-bold text-red-400';
    }
  }
}

// PDF Export Function
window.exportToPDF = async function() {
  const exportButton = document.getElementById('export-pdf-button');
  const exportText = document.getElementById('export-pdf-text');
  const exportSpinner = document.getElementById('export-pdf-spinner');
  
  if (!exportButton || !exportText) {
    console.error('Export-Button nicht gefunden');
    return;
  }

  // UI: Loading State
  exportButton.disabled = true;
  exportText.textContent = 'Generiere PDF...';
  exportSpinner.classList.remove('hidden');

  try {
    // Schritt A: Daten füllen
    const template = document.getElementById('pdf-template');
    if (!template) {
      throw new Error('PDF-Template nicht gefunden');
    }

    // Projektname
    const projectNameEl = document.getElementById('pdf-project-name');
    if (projectNameEl) {
      const activeProjectNameEl = document.getElementById('activeProjectName');
      projectNameEl.textContent = activeProjectNameEl ? activeProjectNameEl.textContent : 'Persönliches Projekt';
    }

    // Datum
    const dateEl = document.getElementById('pdf-date');
    if (dateEl) {
      dateEl.textContent = new Date().toLocaleDateString('de-DE', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      });
    }

    // Problem & Lösung
    const problemEl = document.getElementById('pdf-problem');
    const solutionEl = document.getElementById('pdf-solution');
    if (problemEl) {
      const problemInput = document.getElementById('problem');
      problemEl.textContent = problemInput ? problemInput.value || '-' : '-';
    }
    if (solutionEl) {
      const solutionInput = document.getElementById('solution');
      solutionEl.textContent = solutionInput ? solutionInput.value || '-' : '-';
    }

    // Persona
    const personaEl = document.getElementById('pdf-persona');
    if (personaEl) {
      const personaName = document.getElementById('persona_name')?.value || '';
      const personaDemo = document.getElementById('persona_demographics')?.value || '';
      const personaPains = document.getElementById('persona_pains')?.value || '';
      const personaGains = document.getElementById('persona_gains')?.value || '';
      
      let personaHtml = '';
      if (personaName) personaHtml += `<p style="margin: 0 0 3mm 0;"><strong>Name:</strong> ${personaName}</p>`;
      if (personaDemo) personaHtml += `<p style="margin: 0 0 3mm 0;"><strong>Demografie:</strong> ${personaDemo}</p>`;
      if (personaPains) personaHtml += `<p style="margin: 0 0 3mm 0;"><strong>Schmerzpunkte:</strong> ${personaPains}</p>`;
      if (personaGains) personaHtml += `<p style="margin: 0 0 3mm 0;"><strong>Gewünschte Ergebnisse:</strong> ${personaGains}</p>`;
      
      personaEl.innerHTML = personaHtml || '<p style="margin: 0;">-</p>';
    }

    // Validierung
    const validationEl = document.getElementById('pdf-validation');
    if (validationEl) {
      const validationMethod = document.getElementById('validation_method')?.value || '';
      const validationSuccess = document.getElementById('validation_success')?.value || '';
      
      let validationHtml = '';
      if (validationMethod) validationHtml += `<p style="margin: 0 0 3mm 0;"><strong>Testmethode:</strong> ${validationMethod}</p>`;
      if (validationSuccess) validationHtml += `<p style="margin: 0 0 3mm 0;"><strong>Erfolgsmetrik:</strong> ${validationSuccess}</p>`;
      
      validationEl.innerHTML = validationHtml || '<p style="margin: 0;">-</p>';
    }

    // Kritik (letzte Hypothese-Analyse)
    const critiqueEl = document.getElementById('pdf-critique');
    if (critiqueEl && lastHypothesisAnalysis) {
      // Konvertiere Markdown zu einfachem Text für PDF
      const critiqueText = lastHypothesisAnalysis.outputText || '-';
      critiqueEl.innerHTML = `<p style="margin: 0; white-space: pre-wrap;">${critiqueText.replace(/\*\*/g, '').replace(/##/g, '').replace(/###/g, '')}</p>`;
    } else if (critiqueEl) {
      const responseHypothese = document.getElementById('response-hypothese');
      if (responseHypothese && !responseHypothese.classList.contains('hidden')) {
        const critiqueText = responseHypothese.innerText || '-';
        critiqueEl.innerHTML = `<p style="margin: 0; white-space: pre-wrap;">${critiqueText}</p>`;
      } else {
        critiqueEl.innerHTML = '<p style="margin: 0;">-</p>';
      }
    }

    // Pivot (falls vorhanden)
    const pivotEl = document.getElementById('pdf-pivot-content');
    if (pivotEl) {
      const problemInput = document.getElementById('problem');
      const solutionInput = document.getElementById('solution');
      if (problemInput && solutionInput && (problemInput.value || solutionInput.value)) {
        pivotEl.innerHTML = `
          <p style="margin: 0 0 3mm 0;"><strong>Problem:</strong> ${problemInput.value || '-'}</p>
          <p style="margin: 0;"><strong>Lösung:</strong> ${solutionInput.value || '-'}</p>
        `;
      } else {
        pivotEl.innerHTML = '<p style="margin: 0;">-</p>';
      }
    }

    // Schritt B: PDF generieren
    // Klone das Template und mache es sichtbar (off-screen)
    const clonedTemplate = template.cloneNode(true);
    clonedTemplate.id = 'pdf-template-clone';
    clonedTemplate.classList.remove('hidden');
    clonedTemplate.style.position = 'absolute';
    clonedTemplate.style.left = '-9999px';
    clonedTemplate.style.top = '0';
    document.body.appendChild(clonedTemplate);

    // Warte kurz, damit das Layout gerendert wird
    await new Promise(resolve => setTimeout(resolve, 100));

    // PDF generieren
    const projectName = document.getElementById('activeProjectName')?.textContent || 'Projekt';
    const filename = `Investment-Memo-${projectName.replace(/\s+/g, '-')}.pdf`;

    await html2pdf().set({
      margin: 15,
      filename: filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    }).from(clonedTemplate).save();

    // Cleanup: Entferne geklontes Template
    document.body.removeChild(clonedTemplate);

    showSavedFeedback('PDF erfolgreich erstellt!');

  } catch (error) {
    console.error('Fehler beim PDF-Export:', error);
    alert('Fehler beim Erstellen des PDFs: ' + error.message);
  } finally {
    // UI: Loading State zurücksetzen
    exportButton.disabled = false;
    exportText.textContent = '📄 Als Investment Memo exportieren (PDF)';
    exportSpinner.classList.add('hidden');
  }
};