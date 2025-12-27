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
      // Metadata available for future use
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

// Alle Input/Textarea IDs, die gespeichert werden müssen (EXAKT wie im HTML)
const fieldIds = [
  'problem',              // Step 1: Problem
  'solution',             // Step 1: Lösung
  'pitch',                // Step 1: Elevator Pitch
  'persona_full',         // Step 2: Persona (vollständig)
  'mvp_features',         // Step 3: MVP Features
  'mvp_anti_features',    // Step 3: Anti-Features
  'validation_method',    // Step 4: Validierungsmethode
  'validation_success',   // Step 4: Erfolgsmetrik
  'calc_price',           // Step 5: Verkaufspreis
  'calc_var_costs',       // Step 5: Variable Kosten
  'calc_fixed_costs',     // Step 5: Fixkosten
  'resources_stack',      // Step 6: Tech Stack
  'resources_budget',     // Step 6: Budget
  'resources_time',       // Step 6: Zeit
];

const LOCAL_STORAGE_PREFIX = 'projektDashboardData';

let currentUser = null;
let currentUserPlan = 'free'; // 'free' oder 'pro'
let userProfile = null; // User-Profil aus Firestore (email, plan, isWaitlisted)
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

// Throttled functions werden später initialisiert, nachdem die Funktionen definiert sind
let throttledLocalSave = null;
let throttledFirestoreSave = null;

// Wizard State Management
let currentStep = 1;
const totalSteps = 6;

document.addEventListener('DOMContentLoaded', () => {
  // Initialisiere throttled functions zuerst
  initializeThrottledFunctions();
  
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
  
  // PDF Export Button
  const pdfButton = document.getElementById('btn-export-pdf');
  if (pdfButton) {
    pdfButton.addEventListener('click', exportToPDF);
  }
  
  // Finish Project Button
  const finishButton = document.getElementById('btn-finish-project');
  if (finishButton) {
    finishButton.addEventListener('click', finishProject);
  }
  
  showStep(1); // Starte mit Schritt 1
});

function storageKey() {
  if (!currentUser || !activeProjectId) return `${LOCAL_STORAGE_PREFIX}:guest`;
  return `${LOCAL_STORAGE_PREFIX}:${activeProjectId}`;
}

function setupAuthUi() {
  // Pricing Section Buttons
  const btnPlanFree = document.getElementById('btn-plan-free');
  const btnPlanPro = document.getElementById('btn-plan-pro');
  
  const handleLogin = () => {
      signInWithPopup(auth, googleProvider).catch((error) => {
        console.error("Login Fehler:", error);
      showToast("Login fehlgeschlagen: " + error.message, "error");
    });
  };
  
  // Free Plan Button -> Direkter Login
  if (btnPlanFree) {
    btnPlanFree.addEventListener('click', handleLogin);
  } else {
    console.error("ACHTUNG: btn-plan-free Button nicht gefunden!");
  }
  
  // Pro Plan Button -> Öffne Warteliste Modal
  if (btnPlanPro) {
    btnPlanPro.addEventListener('click', () => {
      openWaitlistModal();
    });
  } else {
    console.error("ACHTUNG: btn-plan-pro Button nicht gefunden!");
  }
  
  // Warteliste Modal Setup
  setupWaitlistModal();
  
  // Upgrade Modal Setup
  setupUpgradeModal();
  
  // Confirm Limit Modal Setup
  setupConfirmLimitModal();
  
  // Downsell Modal Setup
  setupDownsellModal();
  
  // Upsell Gate Setup
  setupUpsellGate();

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
        showToast('Die Anmeldung ist fehlgeschlagen. Bitte versuchen Sie es erneut.', 'error');
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
    const upsellGate = document.getElementById('upsell-gate');

    if (userBadge) {
      if (user) {
        // User eingeloggt -> Routing erfolgt in initializeForUser
        userBadge.classList.remove('hidden');
        userBadge.classList.add('flex');
        if (signInButton) signInButton.classList.add('hidden');
        const historyButtonAuthed = document.getElementById('history-button-authed');
        if (historyButtonAuthed) historyButtonAuthed.classList.remove('hidden');
        if (userName) userName.textContent = user.displayName ?? 'Unbekannter Benutzer';
        if (userEmail) userEmail.textContent = user.email ?? '';
        await initializeForUser(user);
      } else {
        // User ausgeloggt -> Zeige Landing Page, verstecke alles andere
        if (appContainer) appContainer.classList.add('hidden');
        if (landingPage) landingPage.classList.remove('hidden');
        if (upsellGate) upsellGate.classList.add('hidden');
        
        userBadge.classList.add('hidden');
        userBadge.classList.remove('flex');
        if (signInButton) signInButton.classList.remove('hidden');
        const historyButtonAuthed = document.getElementById('history-button-authed');
        if (historyButtonAuthed) historyButtonAuthed.classList.add('hidden');
        clearProjectSubscriptions();
        activeProjectId = null;
        activeProjectName = 'Persönliches Projekt';
        currentMembership = { role: 'viewer' };
        userProfile = null; // Reset User-Profil
        currentUserPlan = 'free'; // Reset Plan
        updateProjectLabel();
        toggleTeamSection(false);
        loadLocalData();
        autosizeAll();
      }
    }
  });
}

// ============================================
// WARLISTE MODAL (Fake Door Test)
// ============================================

function openWaitlistModal() {
  const modal = document.getElementById('waitlist-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    // Focus auf E-Mail Input
    const emailInput = document.getElementById('waitlist-email');
    if (emailInput) {
      setTimeout(() => emailInput.focus(), 100);
    }
  }
}

function closeWaitlistModal() {
  const modal = document.getElementById('waitlist-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    // Reset Form
    const form = document.getElementById('waitlist-form');
    if (form) form.reset();
  }
}

function setupWaitlistModal() {
  const modal = document.getElementById('waitlist-modal');
  const closeBtn = document.getElementById('waitlist-close');
  const form = document.getElementById('waitlist-form');
  
  if (!modal || !closeBtn || !form) {
    console.warn('Warteliste-Modal Elemente nicht gefunden');
    return;
  }
  
  // Close Button
  closeBtn.addEventListener('click', closeWaitlistModal);
  
  // Close bei Klick auf Backdrop
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeWaitlistModal();
    }
  });
  
  // Close bei ESC
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeWaitlistModal();
    }
  });
  
  // Form Submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('waitlist-email');
    const notifyCheckbox = document.getElementById('waitlist-notify');
    const email = emailInput?.value?.trim();
    const notify = notifyCheckbox ? notifyCheckbox.checked : true;
    
    if (!email) {
      showToast('Bitte gib eine E-Mail-Adresse ein', 'error');
      return;
    }
    
    // Email validieren
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      showToast('Bitte gib eine gültige E-Mail-Adresse ein', 'error');
      return;
    }
    
    try {
      await saveToWaitlist(email, notify);
      showToast('Du stehst auf der Liste! Wir melden uns.', 'success');
      closeWaitlistModal();
      // Öffne Downsell-Modal nach erfolgreicher Warteliste
      openDownsellModal();
    } catch (error) {
      console.error('Fehler beim Speichern in Warteliste:', error);
      showToast('Fehler beim Speichern. Bitte versuche es erneut.', 'error');
    }
  });
}

// ============================================
// UPGRADE MODAL (Premium Feature Gating)
// ============================================

function openUpgradeModal() {
  const modal = document.getElementById('upgrade-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
}

function closeUpgradeModal() {
  const modal = document.getElementById('upgrade-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

function setupUpgradeModal() {
  const modal = document.getElementById('upgrade-modal');
  const closeBtn = document.getElementById('upgrade-close');
  const toPricingBtn = document.getElementById('upgrade-to-pricing');
  const toWaitlistBtn = document.getElementById('upgrade-to-waitlist');
  
  if (!modal || !closeBtn || !toPricingBtn || !toWaitlistBtn) {
    console.warn('Upgrade-Modal Elemente nicht gefunden');
    return;
  }
  
  // Close Button
  closeBtn.addEventListener('click', closeUpgradeModal);
  
  // Close bei Klick auf Backdrop
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeUpgradeModal();
    }
  });
  
  // Close bei ESC
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeUpgradeModal();
    }
  });
  
  // "Zu den Preisen" Button -> Scrollt zur Pricing Section
  toPricingBtn.addEventListener('click', () => {
    closeUpgradeModal();
    const pricingSection = document.getElementById('pricing');
    if (pricingSection) {
      pricingSection.scrollIntoView({ behavior: 'smooth' });
    } else {
      console.warn('Pricing Section nicht gefunden');
    }
  });
  
  // "Auf die Warteliste" Button -> Öffnet Warteliste Modal
  toWaitlistBtn.addEventListener('click', () => {
    closeUpgradeModal();
    openWaitlistModal();
  });
}

async function saveToWaitlist(email, notify = true) {
  try {
    // Speichere in Warteliste-Collection
    await addDoc(collection(db, 'waitlist'), {
      email: email,
      notify: notify,
      createdAt: serverTimestamp(),
      source: 'landing-page-pro-button',
      discount: 50 // 50% Rabatt
    });
    
    // Wenn User eingeloggt ist, update User-Profil
    if (currentUser) {
      try {
        const userRef = doc(db, 'users', currentUser.uid);
        await updateDoc(userRef, {
          isWaitlisted: true,
          waitlistedAt: serverTimestamp()
        }, { merge: true });
        // Update lokale Variable
        if (userProfile) {
          userProfile.isWaitlisted = true;
        }
        console.log('✅ User-Profil aktualisiert: isWaitlisted = true');
      } catch (profileError) {
        console.error('⚠️ Fehler beim Update des User-Profils:', profileError);
        // Nicht kritisch, Log nur
      }
    } else {
      // Nicht eingeloggt: Speichere Flag im localStorage
      localStorage.setItem('isWaitlisted', 'true');
      console.log('✅ isWaitlisted Flag im localStorage gespeichert');
    }
    
    console.log('✅ E-Mail erfolgreich zur Warteliste hinzugefügt:', email, 'Notify:', notify);
  } catch (error) {
    console.error('❌ Fehler beim Speichern in Warteliste:', error);
    throw error;
  }
}

// ============================================
// USER PROFILE SYNC
// ============================================

async function syncUserProfile(user) {
  console.log('[syncUserProfile] Start für User:', user.uid);
  
  const userRef = doc(db, 'users', user.uid);
  const userSnap = await getDoc(userRef);
  
  if (!userSnap.exists()) {
    // Neues User-Profil erstellen
    await setDoc(userRef, {
      email: user.email ?? '',
      plan: 'free',
      isWaitlisted: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    userProfile = {
      email: user.email ?? '',
      plan: 'free',
      isWaitlisted: false
    };
    console.log('[syncUserProfile] Neues User-Profil erstellt');
  } else {
    // Bestehendes Profil laden
    const data = userSnap.data();
    userProfile = {
      email: data.email ?? user.email ?? '',
      plan: data.plan ?? 'free',
      isWaitlisted: data.isWaitlisted ?? false
    };
    // Synchronisiere currentUserPlan mit userProfile.plan
    currentUserPlan = userProfile.plan;
    console.log('[syncUserProfile] User-Profil geladen:', userProfile);
  }
  
  // Prüfe localStorage für nicht eingeloggte Wartelisten-User
  if (!userProfile.isWaitlisted && localStorage.getItem('isWaitlisted') === 'true') {
    try {
      await updateDoc(userRef, {
        isWaitlisted: true,
        waitlistedAt: serverTimestamp()
      }, { merge: true });
      userProfile.isWaitlisted = true;
      localStorage.removeItem('isWaitlisted'); // Flag aufräumen
      console.log('[syncUserProfile] isWaitlisted von localStorage übernommen');
    } catch (error) {
      console.error('[syncUserProfile] Fehler beim Update von isWaitlisted:', error);
    }
  }
  
  return userProfile;
}

// ============================================
// UPSELL GATE (Für Free-User)
// ============================================

function setupUpsellGate() {
  const upsellGate = document.getElementById('upsell-gate');
  const upgradeBtn = document.getElementById('upsell-upgrade');
  const continueBtn = document.getElementById('upsell-continue');
  const appContainer = document.getElementById('app-container');
  
  if (!upsellGate || !upgradeBtn || !continueBtn) {
    console.warn('Upsell Gate Elemente nicht gefunden');
    return;
  }
  
  // Upgrade Button -> Öffnet Warteliste-Modal
  upgradeBtn.addEventListener('click', () => {
    closeUpsellGate();
    openWaitlistModal();
  });
  
  // Continue Button -> Schließt Gate, zeigt App
  continueBtn.addEventListener('click', async () => {
    closeUpsellGate();
    // Starte Projekt-Setup nur, wenn noch nicht initialisiert
    if (currentUser) {
      // Prüfe ob Projekt bereits initialisiert wurde
      if (!activeProjectId) {
        try {
          // Nur Projekt-Setup ausführen (ohne Routing, da wir das Gate schon geschlossen haben)
          await ensureOwnerProject(currentUser);
          await resolveActiveProject(currentUser);
          if (!activeProjectId) {
            const defaultId = `${currentUser.uid}-personal`;
            activeProjectId = defaultId;
            await setActiveProject(defaultId);
          }
          watchIncomingInvites(currentUser);
          toggleTeamSection(true);
        } catch (error) {
          console.error('Fehler beim Initialisieren nach Upsell Gate:', error);
          showToast('Fehler beim Laden der App. Bitte aktualisiere die Seite.', 'error');
        }
      } else {
        // Projekt bereits initialisiert, nur UI aktivieren
        toggleTeamSection(true);
      }
    }
  });
}

function closeUpsellGate() {
  const upsellGate = document.getElementById('upsell-gate');
  const appContainer = document.getElementById('app-container');
  
  if (upsellGate) {
    upsellGate.classList.add('hidden');
    upsellGate.classList.remove('flex');
  }
  
  // Zeige App nach Gate
  if (appContainer) {
    appContainer.classList.remove('hidden');
  }
  
  // Team-Section aktivieren
  toggleTeamSection(true);
}

// ============================================
// DOWNSELL MODAL (Nach Warteliste)
// ============================================

function openDownsellModal() {
  const modal = document.getElementById('downsell-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
}

function closeDownsellModal() {
  const modal = document.getElementById('downsell-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

function setupDownsellModal() {
  const modal = document.getElementById('downsell-modal');
  const yesBtn = document.getElementById('btn-downsell-yes');
  const noBtn = document.getElementById('btn-downsell-no');
  
  if (!modal || !yesBtn || !noBtn) {
    console.warn('Downsell-Modal Elemente nicht gefunden');
    return;
  }
  
  // Close bei Klick auf Backdrop
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeDownsellModal();
    }
  });
  
  // Close bei ESC
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeDownsellModal();
    }
  });
  
  // "Ja, kostenlos starten" Button -> Login
  yesBtn.addEventListener('click', () => {
    closeDownsellModal();
    signInWithPopup(auth, googleProvider).catch((error) => {
      console.error("Login Fehler:", error);
      showToast("Login fehlgeschlagen: " + error.message, "error");
    });
  });
  
  // "Nein, ich warte" Button -> Schließt Modal
  noBtn.addEventListener('click', () => {
    closeDownsellModal();
  });
}

async function initializeForUser(user) {
  console.log('[initializeForUser] START für User:', user.uid);
  
  // SCHRITT 0: User-Profil synchronisieren
  console.log('[initializeForUser] syncUserProfile...');
  await syncUserProfile(user);
  
  // SCHRITT 1: Routing basierend auf User-Status
  const appContainer = document.getElementById('app-container');
  const landingPage = document.getElementById('landing-page');
  const upsellGate = document.getElementById('upsell-gate');
  
  // Wartelisten-User: Zeige Danke-Toast
  if (userProfile.isWaitlisted) {
    // Prüfe Session Storage, um Toast nur einmal pro Session zu zeigen
    const thanksShown = sessionStorage.getItem('waitlistThanksShown');
    if (!thanksShown) {
      showToast('👋 Danke für deine Geduld! Pro kommt bald. Hier ist dein Free-Zugang.', 'success');
      sessionStorage.setItem('waitlistThanksShown', 'true');
    }
    // Zeige App direkt
    if (appContainer) appContainer.classList.remove('hidden');
    if (landingPage) landingPage.classList.add('hidden');
    if (upsellGate) upsellGate.classList.add('hidden');
  } 
  // Free-User (nicht waitlisted): Zeige Upsell-Gate
  else if (userProfile.plan === 'free' && !userProfile.isWaitlisted) {
    if (upsellGate) {
      upsellGate.classList.remove('hidden');
      upsellGate.classList.add('flex');
    }
    if (appContainer) appContainer.classList.add('hidden');
    if (landingPage) landingPage.classList.add('hidden');
    toggleTeamSection(false); // Team-Section verstecken bis Gate geschlossen
    return; // Früher Return, Projekt-Setup erfolgt später (wird beim Klick auf "Weiter" ausgelöst)
  }
  // Pro-User: Zeige App direkt
  else if (userProfile.plan === 'pro') {
    if (appContainer) appContainer.classList.remove('hidden');
    if (landingPage) landingPage.classList.add('hidden');
    if (upsellGate) upsellGate.classList.add('hidden');
  }
  
  // SCHRITT 2: SOFORTIGE UI-AKTIVIERUNG (Optimistisch)
  // Wir warten nicht auf die Datenbank. Wenn der User da ist, zeig die Sektion!
  toggleTeamSection(true); 

  try {
    // SCHRITT 3: Datenbank-Operationen
    console.log('[initializeForUser] ensureOwnerProject...');
    await ensureOwnerProject(user);
    
    console.log('[initializeForUser] resolveActiveProject...');
    await resolveActiveProject(user);
    
    console.log('[initializeForUser] activeProjectId nach resolveActiveProject:', activeProjectId);
    
    // KRITISCH: Prüfe ob activeProjectId wirklich gesetzt wurde
    if (!activeProjectId) {
      console.error('[initializeForUser] FEHLER: activeProjectId ist NULL nach resolveActiveProject!');
      const defaultId = `${user.uid}-personal`;
      console.log('[initializeForUser] Setze activeProjectId manuell auf:', defaultId);
      activeProjectId = defaultId;
      await setActiveProject(defaultId);
    }
    
    console.log('[initializeForUser] FINAL activeProjectId:', activeProjectId);
    console.log('[initializeForUser] projectDocRef:', projectDocRef?.id);
    
    watchIncomingInvites(user);
    
    console.log('[initializeForUser] ERFOLG - Initialisierung abgeschlossen');
    
  } catch (error) {
    // SCHRITT 3: Fehler sichtbar machen
    console.error('[initializeForUser] FEHLER bei der Initialisierung:', error);
    console.error('[initializeForUser] Error Details:', {
      code: error.code,
      message: error.message,
      stack: error.stack
    });
    
    // WICHTIG: Wir zeigen den Fehler jetzt direkt auf dem Bildschirm an via Toast.
    // So wissen wir SOFORT, ob es an den Regeln oder der Verbindung liegt.
    showToast("Initialisierungs-Fehler: " + error.message, 'error');
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
      plan: 'free', // Standard-Plan ist 'free'
      fields: initialFields,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    console.log('[ensureOwnerProject] Neues Projekt erstellt mit plan: free');
    currentUserPlan = 'free';
  } else {
    // Lade Plan aus bestehendem Projekt
    const data = snapshot.data();
    if (data.plan) {
      currentUserPlan = data.plan;
      console.log('[ensureOwnerProject] Plan geladen:', currentUserPlan);
    } else {
      // Fallback: Setze Plan auf 'free' wenn nicht vorhanden
      await updateDoc(ref, { plan: 'free' });
      currentUserPlan = 'free';
      console.log('[ensureOwnerProject] Plan auf free gesetzt (Fallback)');
    }
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
  console.log('[setActiveProject] START für projectId:', projectId);
  console.log('[setActiveProject] currentUser:', currentUser?.uid);
  
  if (!currentUser) {
    console.error('[setActiveProject] KEIN USER - Abbrechen');
    return;
  }
  
  if (activeProjectId === projectId) {
    console.log('[setActiveProject] Project bereits aktiv, überspringe');
    return;
  }

  console.log('[setActiveProject] Setze activeProjectId auf:', projectId);
  clearProjectSubscriptions();
  activeProjectId = projectId;
  localStorage.setItem('activeProjectId', projectId);

  projectDocRef = doc(db, 'projects', projectId);
  console.log('[setActiveProject] projectDocRef erstellt:', projectDocRef.id);
  
  const projectSnap = await getDoc(projectDocRef);

  if (!projectSnap.exists()) {
    console.log('[setActiveProject] Projekt existiert nicht, erstelle neues Projekt');
    await setDoc(projectDocRef, {
      ownerId: currentUser.uid,
      name: 'Projekt',
      fields: getCurrentFieldValues(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    console.log('[setActiveProject] Neues Projekt erstellt');
  } else {
    console.log('[setActiveProject] Projekt existiert bereits');
  }

  const data = projectSnap.data() ?? {};
  activeProjectName = data.name ?? 'Projekt';
  console.log('[setActiveProject] activeProjectName:', activeProjectName);
  updateProjectLabel();

  const membershipSnap = await getDoc(doc(db, 'projects', projectId, 'members', currentUser.uid));
  currentMembership = membershipSnap.exists() ? membershipSnap.data() : { role: 'viewer' };
  if (!membershipSnap.exists()) {
    console.log('[setActiveProject] Mitgliedschaft existiert nicht, erstelle');
    await setDoc(doc(db, 'projects', projectId, 'members', currentUser.uid), {
      role: currentUser.uid === data.ownerId ? 'owner' : 'editor',
      email: currentUser.email ?? '',
      displayName: currentUser.displayName ?? '',
      addedAt: serverTimestamp(),
    }, { merge: true });
  }

  console.log('[setActiveProject] Starte Subscriptions...');
  subscribeToProject(projectId);
  subscribeToMembers(projectId);
  subscribeToPendingInvites(projectId);

  loadIncomingInvitesVisibility();
  bindFieldListeners();
  
  console.log('[setActiveProject] ERFOLG - activeProjectId:', activeProjectId);
  console.log('[setActiveProject] projectDocRef:', projectDocRef?.id);
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

    // Lade User Plan aus Projekt-Daten
    if (data.plan) {
      currentUserPlan = data.plan;
      console.log('[subscribeToProject] Plan aktualisiert:', currentUserPlan);
    }

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
  console.log('[bindFieldListeners] Starte Feld-Listener Setup');
  console.log('[bindFieldListeners] fieldIds:', fieldIds);
  console.log('[bindFieldListeners] currentUser:', currentUser?.uid);
  console.log('[bindFieldListeners] activeProjectId:', activeProjectId);
  console.log('[bindFieldListeners] projectDocRef:', projectDocRef);
  
  fieldIds.forEach((id) => {
    const element = document.getElementById(id);
    if (!element) {
      console.warn(`[bindFieldListeners] Element mit ID "${id}" nicht gefunden!`);
      return;
    }
    
    if (element.dataset.bound === 'true') {
      console.log(`[bindFieldListeners] Element "${id}" bereits gebunden, überspringe`);
      return;
    }

    element.dataset.bound = 'true';
    console.log(`[bindFieldListeners] Binde Listener für "${id}"`);
    
    element.addEventListener('input', () => {
      console.log(`[bindFieldListeners] Input Event für "${id}"`, element.value.substring(0, 50));
      autosize(element);
      
      if (isApplyingRemoteData) {
        console.log(`[bindFieldListeners] Ignoriere Input für "${id}" - Remote-Daten werden angewendet`);
        return;
      }

      if (currentUser && projectDocRef && activeProjectId) {
        console.log(`[bindFieldListeners] Speichere Feld "${id}" in Firestore`);
        pendingRemoteUpdates[id] = element.value;
        throttledFirestoreSave();
      } else {
        console.log(`[bindFieldListeners] Speichere Feld "${id}" lokal (kein User/Project)`);
        throttledLocalSave();
      }
    });
  });
  
  console.log('[bindFieldListeners] Setup abgeschlossen');
}

async function persistRemoteUpdates() {
  console.log('[persistRemoteUpdates] Start');
  console.log('[persistRemoteUpdates] currentUser:', currentUser?.uid);
  console.log('[persistRemoteUpdates] activeProjectId:', activeProjectId);
  console.log('[persistRemoteUpdates] projectDocRef:', projectDocRef);
  console.log('[persistRemoteUpdates] pendingRemoteUpdates:', Object.keys(pendingRemoteUpdates));
  
  if (!currentUser) {
    console.error('[persistRemoteUpdates] KEIN USER - Speichern abgebrochen');
    return;
  }
  
  if (!activeProjectId) {
    console.error('[persistRemoteUpdates] KEIN activeProjectId - Speichern abgebrochen');
    return;
  }
  
  if (!projectDocRef) {
    console.error('[persistRemoteUpdates] KEIN projectDocRef - Speichern abgebrochen');
    return;
  }
  
  const updates = {};
  const fields = Object.keys(pendingRemoteUpdates);

  if (!fields.length) {
    console.log('[persistRemoteUpdates] Keine Updates vorhanden');
    return;
  }

  fields.forEach((id) => {
    updates[`fields.${id}`] = pendingRemoteUpdates[id];
    console.log(`[persistRemoteUpdates] Feld "${id}":`, pendingRemoteUpdates[id].substring(0, 50));
  });
  
  // Kopie für Logging, dann leeren
  const fieldsToSave = [...fields];
  pendingRemoteUpdates = {};

  try {
    console.log('[persistRemoteUpdates] Starte Firestore updateDoc');
    showSaveStatus('saving');
    
    // Erstelle projectDocRef falls nicht vorhanden
    if (!projectDocRef) {
      projectDocRef = doc(db, 'projects', activeProjectId);
      console.log('[persistRemoteUpdates] projectDocRef neu erstellt:', projectDocRef.id);
    }
    
    await updateDoc(projectDocRef, {
      ...updates,
      updatedAt: serverTimestamp(),
      lastEditor: currentUser.uid,
    });
    
    console.log('[persistRemoteUpdates] ERFOLG - Felder gespeichert:', fieldsToSave);
    showSaveStatus('saved');
  } catch (error) {
    console.error('[persistRemoteUpdates] FEHLER beim Speichern in Firestore:', error);
    console.error('[persistRemoteUpdates] Error Details:', {
      code: error.code,
      message: error.message,
      activeProjectId,
      projectDocRef: projectDocRef?.id
    });
    showSaveStatus(); // Reset status on error
    showToast('Fehler beim Speichern: ' + error.message, 'error');
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
      showToast('Nur Besitzer können Einladungen versenden.', 'warning');
      return;
    }

    const emailInput = document.getElementById('inviteEmail');
    const roleSelect = document.getElementById('inviteRole');
    if (!emailInput || !roleSelect) return;

    const invitedEmail = emailInput.value.trim().toLowerCase();
    const role = roleSelect.value || 'editor';

    if (!invitedEmail) {
      showToast('Bitte eine gültige E-Mail-Adresse eingeben.', 'warning');
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
        // Fallback: Zeige Link via Toast
        showToast('Einladung erstellt! Link wurde kopiert.', 'success');
      }
      
      // Zeige Link auch visuell an
      const linkDisplay = document.createElement('div');
      linkDisplay.className = 'mt-3 p-3 bg-gray-900/80 rounded border border-brand-500/30';
      linkDisplay.innerHTML = `
        <p class="text-xs text-gray-400 mb-1">Einladungslink:</p>
        <div class="flex items-center gap-2">
          <input type="text" readonly value="${inviteLink}" class="flex-1 bg-gray-800 text-gray-200 text-xs px-2 py-1 rounded border border-white/10" id="inviteLinkInput-${inviteId}" />
          <button class="bg-brand-500 hover:bg-brand-600 text-white text-xs px-3 py-1 rounded" onclick="navigator.clipboard.writeText('${inviteLink}').then(() => showToast('Link kopiert!', 'success'))">Kopieren</button>
        </div>
      `;
      const pendingContainer = document.getElementById('pendingInvites');
      if (pendingContainer) {
        pendingContainer.insertBefore(linkDisplay, pendingContainer.firstChild);
        setTimeout(() => linkDisplay.remove(), 10000); // Entferne nach 10 Sekunden
      }
    } catch (error) {
      console.error('Fehler beim Erstellen der Einladung:', error);
      showToast('Die Einladung konnte nicht erstellt werden.', 'error');
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
        showToast('Konnte Link nicht kopieren.', 'error');
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
        showToast('Einladung konnte nicht widerrufen werden.', 'error');
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
    showToast('Einladung konnte nicht angenommen werden.', 'error');
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

// Initialisiere throttled functions nach Definition
function initializeThrottledFunctions() {
  if (!throttledLocalSave) {
    throttledLocalSave = throttle(saveLocalData, 200);
  }
  if (!throttledFirestoreSave) {
    throttledFirestoreSave = throttle(persistRemoteUpdates, 500);
  }
}

// ============================================
// TOAST SYSTEM (Professional Feedback)
// ============================================

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  const isError = type === 'error';
  const isWarning = type === 'warning';
  
  const bgColor = isError ? 'bg-red-500/90' : isWarning ? 'bg-yellow-500/90' : 'bg-emerald-500/90';
  const icon = isError ? '❌' : isWarning ? '⚠️' : '✓';
  
  toast.className = `fixed bottom-6 right-6 z-[100] ${bgColor} backdrop-blur-sm text-white px-6 py-4 rounded-lg shadow-2xl ring-1 ring-white/20 flex items-center gap-3 transform translate-x-[500px] transition-transform duration-300`;
  toast.innerHTML = `
    <span class="text-2xl">${icon}</span>
    <span class="font-medium">${message}</span>
  `;
  
  document.body.appendChild(toast);
  
  // Slide in
  setTimeout(() => {
    toast.style.transform = 'translateX(0)';
  }, 10);
  
  // Slide out and remove
  setTimeout(() => {
    toast.style.transform = 'translateX(500px)';
    setTimeout(() => {
      if (document.body.contains(toast)) {
        document.body.removeChild(toast);
      }
    }, 300);
  }, 3000);
}

// ============================================
// AUTO-SAVE FEEDBACK
// ============================================

function showSaveStatus(state = 'saved') {
  const saveStatus = document.getElementById('save-status');
  if (!saveStatus) return;
  
  if (state === 'saving') {
    saveStatus.textContent = 'Speichere...';
    saveStatus.className = 'ml-4 text-xs font-mono font-bold text-yellow-500 opacity-100 transition-opacity duration-500';
  } else if (state === 'saved') {
    saveStatus.textContent = '✓ Gespeichert';
    saveStatus.className = 'ml-4 text-xs font-mono font-bold text-emerald-500 opacity-100 transition-opacity duration-500';
    
    setTimeout(() => {
      saveStatus.style.opacity = '0';
    }, 2000);
  } else {
    saveStatus.style.opacity = '0';
  }
}

// Legacy showSaved for backward compatibility
const showSaved = () => showSaveStatus('saved');

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
  console.log('[analyzeSection] Start für Sektion:', sectionName);
  console.log('[analyzeSection] currentUserPlan:', currentUserPlan);
  
  // FEATURE GATING: Prüfe Plan und Limits
  if (currentUserPlan === 'pro') {
    // Pro-User: Alles erlaubt, direkt weiter
    console.log('[analyzeSection] Pro-User, führe Analyse direkt aus');
  } else if (currentUserPlan === 'free') {
    // Free-User: Prüfe Limit
    console.log('[analyzeSection] Free-User, prüfe monatliches Limit');
    
    if (!currentUser || !activeProjectId) {
      showToast('Bitte melde dich an, um eine Analyse zu starten', 'error');
      return;
    }
    
    try {
      const projectRef = doc(db, 'projects', activeProjectId);
      const projectSnap = await getDoc(projectRef);
      
      if (!projectSnap.exists()) {
        console.error('[analyzeSection] Projekt nicht gefunden');
        return;
      }
      
      const projectData = projectSnap.data();
      const lastAnalysisAt = projectData.lastAnalysisAt;
      
      if (lastAnalysisAt) {
        // Prüfe ob letzte Analyse < 30 Tage her ist
        const lastAnalysisDate = lastAnalysisAt.toDate();
        const now = new Date();
        const daysDiff = Math.floor((now - lastAnalysisDate) / (1000 * 60 * 60 * 24));
        
        console.log('[analyzeSection] Letzte Analyse vor', daysDiff, 'Tagen');
        
        if (daysDiff < 30) {
          // Limit erreicht -> Zeige Upgrade Modal
          console.log('[analyzeSection] Limit erreicht, zeige Upgrade Modal');
          openUpgradeModal();
          return;
        }
      }
      
      // Limit nicht erreicht -> Zeige Bestätigungs-Modal
      console.log('[analyzeSection] Limit verfügbar, zeige Bestätigungs-Modal');
      
      // Warte auf User-Bestätigung
      const confirmed = await new Promise((resolve) => {
        pendingAnalysisCallback = resolve;
        
        // Setup "Ja" Button (wird nur einmal beim Öffnen gesetzt)
        const yesBtn = document.getElementById('confirm-limit-yes');
        if (yesBtn) {
          // Entferne alte Listener (falls vorhanden)
          const newYesBtn = yesBtn.cloneNode(true);
          yesBtn.parentNode.replaceChild(newYesBtn, yesBtn);
          
          newYesBtn.addEventListener('click', () => {
            closeConfirmLimitModal();
            resolve(true);
          });
          
          // Setup "Noch mal prüfen" Button
          const noBtn = document.getElementById('confirm-limit-no');
          if (noBtn) {
            const newNoBtn = noBtn.cloneNode(true);
            noBtn.parentNode.replaceChild(newNoBtn, noBtn);
            
            newNoBtn.addEventListener('click', () => {
              closeConfirmLimitModal();
              resolve(false);
            });
          }
        }
        
        openConfirmLimitModal();
      });
      
      pendingAnalysisCallback = null;
      
      if (!confirmed) {
        console.log('[analyzeSection] Analyse vom User abgebrochen');
        // UI zurücksetzen (falls bereits gesetzt)
        if (button) button.disabled = false;
        if (spinner) spinner.classList.add('hidden');
        return;
      }
      
      console.log('[analyzeSection] Analyse vom User bestätigt, starte API-Call');
    } catch (error) {
      console.error('[analyzeSection] Fehler beim Prüfen des Limits:', error);
      showToast('Fehler beim Prüfen des Limits. Bitte versuche es erneut.', 'error');
      // UI zurücksetzen
      if (button) button.disabled = false;
      if (spinner) spinner.classList.add('hidden');
      return;
    }
  } else {
    // Unbekannter Plan -> Blockiere
    console.warn('[analyzeSection] Unbekannter Plan, blockiere Analyse');
    openUpgradeModal();
    // UI zurücksetzen
    if (button) button.disabled = false;
    if (spinner) spinner.classList.add('hidden');
    return;
  }
  
  // AB HIER: Normale Analyse-Logik (für Pro-User oder bestätigte Free-User)
  // UI: Loading-State setzen (jetzt, wo wir wissen, dass die Analyse startet)
  button.disabled = true;
  spinner.classList.remove('hidden');
  responseDiv.classList.add('hidden');
  
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
      prompt: 'Du bist ein Produktmanager. Finde Lücken in dieser Persona. Ist die Zielgruppe klar definiert? Sind die Pain Points spezifisch genug? Ist das gewünschte Ergebnis messbar?',
      fields: ['persona_full']
    },
    'mvp': {
      buttonId: 'analyze-mvp',
      spinnerId: 'spinner-mvp',
      responseId: 'response-mvp',
      prompt: 'Du bist ein Lean-Startup-Coach. Welches Feature ist unnötig? Sind 3 Features wirklich das Minimum? Was kann noch weg?',
      fields: ['mvp_features', 'mvp_anti_features']
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

  // UI: Loading-State wird später gesetzt (nach Limit-Check für Free-User)

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
        
        // Nach erfolgreicher Analyse: Setze lastAnalysisAt für Free-User
        if (currentUserPlan === 'free') {
          try {
            const projectRef = doc(db, 'projects', activeProjectId);
            await updateDoc(projectRef, {
              lastAnalysisAt: serverTimestamp()
            });
            console.log('[analyzeSection] lastAnalysisAt gesetzt für Free-User');
          } catch (error) {
            console.error('[analyzeSection] Fehler beim Setzen von lastAnalysisAt:', error);
            // Nicht kritisch, Log nur
          }
        }
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
  console.log('[saveAnalysis] Start für Sektion:', sectionName);
  console.log('[saveAnalysis] currentUser:', currentUser?.uid);
  console.log('[saveAnalysis] activeProjectId:', activeProjectId);
  
  if (!currentUser) {
    const errorMsg = 'Kein User eingeloggt - Analyse kann nicht gespeichert werden';
    console.error('[saveAnalysis]', errorMsg);
    showToast(errorMsg, 'error');
    throw new Error(errorMsg);
  }
  
  if (!activeProjectId) {
    const errorMsg = 'Kein aktives Projekt - Analyse kann nicht gespeichert werden';
    console.error('[saveAnalysis]', errorMsg);
    showToast(errorMsg, 'error');
    throw new Error(errorMsg);
  }

  try {
    const analysesRef = collection(db, 'projects', activeProjectId, 'analyses');
    console.log('[saveAnalysis] Speichere in Collection:', analysesRef.path);
    
    const analysisData = {
      section: sectionName,
      inputText: inputText,
      outputText: outputText,
      createdAt: serverTimestamp(),
      createdBy: currentUser.uid,
      createdByEmail: currentUser.email ?? '',
    };
    
    console.log('[saveAnalysis] Daten:', {
      section: sectionName,
      inputLength: inputText.length,
      outputLength: outputText.length
    });
    
    const docRef = await addDoc(analysesRef, analysisData);
    console.log('[saveAnalysis] ERFOLG - Analyse gespeichert mit ID:', docRef.id);
  } catch (error) {
    console.error('[saveAnalysis] FEHLER beim Speichern:', error);
    console.error('[saveAnalysis] Error Details:', {
      code: error.code,
      message: error.message,
      activeProjectId
    });
    showToast('Fehler beim Speichern der Analyse: ' + error.message, 'error');
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

// ============================================
// FEATURE GATING (Free vs. Pro)
// ============================================

function checkFeatureAccess(featureName) {
  console.log('[checkFeatureAccess] Prüfe Zugriff für:', featureName);
  console.log('[checkFeatureAccess] currentUserPlan:', currentUserPlan);
  
  // Pro-User haben Zugriff auf alle Features
  if (currentUserPlan === 'pro') {
    console.log('[checkFeatureAccess] Zugriff GEWÄHRT (Pro-User)');
    return true;
  }
  
  // Free-User: Nur Basis-Analyse erlaubt
  if (currentUserPlan === 'free') {
    if (featureName === 'analyze') {
      console.log('[checkFeatureAccess] Zugriff GEWÄHRT (Free-User, Basis-Analyse)');
      return true;
    }
    
    // Alle anderen Features sind Premium
    console.log('[checkFeatureAccess] Zugriff VERWEIGERT (Premium-Feature)');
    openUpgradeModal();
    return false;
  }
  
  // Fallback: Kein Plan bekannt -> Blockiere
  console.warn('[checkFeatureAccess] Unbekannter Plan, blockiere Zugriff');
  openUpgradeModal();
  return false;
}

async function pivotIdea() {
  // Feature Gating: Pivot ist Premium-Feature
  if (!checkFeatureAccess('pivot')) {
    return;
  }
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
    showToast('Bitte fülle zuerst das Problem und die Lösung in Step 1 aus.', 'warning');
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
      } catch (saveError) {
        console.error('Fehler beim Speichern der Konkurrenz-Analyse:', saveError);
      }
    }

    showSavedFeedback('Konkurrenz-Analyse abgeschlossen!');

  } catch (error) {
    console.error('Fehler bei der Konkurrenz-Analyse:', error);
    showToast(`Fehler bei der Konkurrenz-Analyse: ${error.message}`, 'error');
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
    showToast('Bitte fülle mindestens Problem und Lösung aus, bevor du das Scoring berechnest.', 'warning');
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

    // 🎉 Confetti bei gutem Score!
    if (scoreData.score >= 70 && typeof confetti !== 'undefined') {
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 }
      });
    }

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
    showToast(`Fehler beim Berechnen des Scores: ${error.message}`, 'error');
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

  // Stepper-Navigation (klickbare Step-Indikatoren)
  setupStepperNavigation();
}

// ============================================
// STEPPER NAVIGATION (Klickbare Step-Kreise)
// ============================================

function setupStepperNavigation() {
  for (let step = 1; step <= totalSteps; step++) {
    const indicator = document.querySelector(`.step-indicator[data-step="${step}"]`);
    if (indicator) {
      indicator.addEventListener('click', () => {
        jumpToStep(step);
      });
    }
  }
}

function jumpToStep(step) {
  if (step < 1 || step > totalSteps) {
    return;
  }

  currentStep = step;
  showStep(step);
  
  // Scroll nach oben für bessere UX
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
      // Für Step 6: Button hat bereits ID btn-finish-project und korrekten Text
      if (button.id === 'btn-finish-project') {
        button.textContent = '🏁 Projekt abschließen & Neustart';
      } else {
      button.textContent = 'Abschließen ✓';
      }
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
        
        // Prüfe auth.currentUser als sicheren Fallback
        const user = currentUser || auth?.currentUser;
        if (user) {
        loadHistory();
        } else {
          const historyContent = document.getElementById('history-content');
          if (historyContent) {
            historyContent.innerHTML = '<p class="text-gray-400 text-center">Bitte melden Sie sich an, um die Historie zu sehen.</p>';
          }
        }
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
    const historyContent = document.getElementById('history-content');
  if (!historyContent) return;

  // Prüfe auth.currentUser als sicheren Fallback
  const user = currentUser || auth?.currentUser;
  
  if (!user) {
      historyContent.innerHTML = '<p class="text-gray-400 text-center">Bitte melden Sie sich an, um die Historie zu sehen.</p>';
    return;
  }

  // Wenn activeProjectId noch nicht gesetzt ist, warte kurz
  if (!activeProjectId) {
    historyContent.innerHTML = '<p class="text-gray-400 text-center">Lade Projekt...</p>';
    
    // Warte maximal 3 Sekunden auf activeProjectId
    let attempts = 0;
    while (!activeProjectId && attempts < 30) {
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }
    
    if (!activeProjectId) {
      historyContent.innerHTML = '<p class="text-red-400 text-center">Projekt konnte nicht geladen werden.</p>';
      return;
    }
  }

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

// ============================================
// PDF EXPORT FUNCTION (Simplified & Fixed)
// ============================================

// ============================================
// PDF EXPORT FUNCTION (Robust & Safe)
// ============================================

// ============================================
// PDF EXPORT - "GHOST-WRITER" METHODE
// Programmatisches Zusammenbauen des PDFs
// ============================================

async function exportToPDF() {
  // Feature Gating: PDF-Export ist Premium-Feature
  if (!checkFeatureAccess('pdf')) {
    return;
  }

  const btn = document.getElementById('btn-export-pdf');
  const btnText = document.getElementById('text-export-pdf');
  const btnSpinner = document.getElementById('spinner-export-pdf');
  
  if (!btn || !btnText) {
    console.error('Export-Button nicht gefunden');
    return;
  }

  // Hilfsfunktionen zum sicheren Lesen von Werten
  const getVal = (id) => {
    const el = document.getElementById(id);
    return el?.value?.trim() || '-(Keine Eingabe)-';
  };
  
  const getText = (id) => {
    const el = document.getElementById(id);
    return el?.innerText?.trim() || el?.textContent?.trim() || '-(Nicht verfügbar)-';
  };
  
  const getHTML = (id) => {
    const el = document.getElementById(id);
    if (!el || el.classList.contains('hidden')) {
      return '<p style="color: #9ca3af; font-style: italic;">Keine Analyse vorhanden.</p>';
    }
    return el.innerHTML || '<p>Keine Analyse vorhanden.</p>';
  };

  // Variable für Cleanup (außerhalb try-Block für finally-Zugriff)
  let ghostElement = null;

  try {
    // 1. UI Feedback
    btn.disabled = true;
    btnText.textContent = 'Erstelle Memo...';
    if (btnSpinner) btnSpinner.classList.remove('hidden');
    showToast('Generiere Investment Memo...', 'success');

    // 2. Sammle ALLE Daten (auch aus nicht sichtbaren Steps)
    const projectName = getText('activeProjectName') || 'Startup-Projekt';
    const date = new Date().toLocaleDateString('de-DE', { 
      day: 'numeric', 
        month: 'long', 
      year: 'numeric' 
    });

    // 3. Erstelle Ghost-Element (Off-Screen Container)
    ghostElement = document.createElement('div');
    ghostElement.id = 'pdf-ghost-element';
    Object.assign(ghostElement.style, {
      width: '210mm',
      minHeight: '297mm',
      padding: '20mm',
      backgroundColor: 'white',
      color: '#1a202c',
      fontFamily: 'Helvetica, Arial, sans-serif',
      fontSize: '12px',
      lineHeight: '1.6',
      position: 'fixed',
      left: '-10000px', // Weit außerhalb des sichtbaren Bereichs
      top: '0',
      zIndex: '-9999', // Sehr niedriger z-index - niemals im Vordergrund
      pointerEvents: 'none', // Blockiert keine Maus-Events
      overflow: 'hidden' // Verhindert Scrollbars
    });

    // 4. Berechne Break-Even (falls vorhanden)
    const price = parseFloat(document.getElementById('calc_price')?.value || 0);
    const varCosts = parseFloat(document.getElementById('calc_var_costs')?.value || 0);
    const fixedCosts = parseFloat(document.getElementById('calc_fixed_costs')?.value || 0);
    const contributionMargin = price - varCosts;
    const breakEven = contributionMargin > 0 && fixedCosts > 0 
      ? Math.ceil(fixedCosts / contributionMargin).toLocaleString('de-DE')
      : '-';

    // 5. Erstelle HTML-Content (Professionelles Investment-Memo Layout)
    ghostElement.innerHTML = `
      <div style="border-bottom: 2px solid #3b82f6; padding-bottom: 20px; margin-bottom: 30px;">
        <h1 style="font-size: 24px; font-weight: bold; margin: 0; color: #111827;">INVESTMENT MEMO</h1>
        <p style="margin: 5px 0 0; color: #6b7280; font-size: 14px;">
          Projekt: <strong>${escapeHtml(projectName)}</strong> • Datum: ${date}
        </p>
      </div>

      <!-- EXECUTIVE SUMMARY -->
      <div style="margin-bottom: 30px;">
        <h2 style="font-size: 16px; color: #3b82f6; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #e5e7eb; padding-bottom: 5px; margin-bottom: 15px;">
          1. Executive Summary
        </h2>
        <div style="margin-top: 10px;">
          <strong style="display: block; font-size: 11px; color: #6b7280; text-transform: uppercase; margin-bottom: 5px;">Das Problem</strong>
          <p style="margin: 0; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(getVal('problem'))}</p>
        </div>
        <div style="margin-top: 15px;">
          <strong style="display: block; font-size: 11px; color: #6b7280; text-transform: uppercase; margin-bottom: 5px;">Die Lösung</strong>
          <p style="margin: 0; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(getVal('solution'))}</p>
        </div>
        ${getVal('pitch') !== '-(Keine Eingabe)-' ? `
        <div style="margin-top: 15px;">
          <strong style="display: block; font-size: 11px; color: #6b7280; text-transform: uppercase; margin-bottom: 5px;">Elevator Pitch</strong>
          <p style="margin: 0; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(getVal('pitch'))}</p>
        </div>
        ` : ''}
      </div>

      <!-- TARGET AUDIENCE -->
      <div style="margin-bottom: 30px; page-break-inside: avoid;">
        <h2 style="font-size: 16px; color: #3b82f6; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #e5e7eb; padding-bottom: 5px; margin-bottom: 15px;">
          2. Zielgruppe & Psychologie
        </h2>
        <p style="margin-top: 10px; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(getVal('persona_full'))}</p>
      </div>

      <!-- STRATEGY & MVP -->
      <div style="margin-bottom: 30px; page-break-inside: avoid;">
        <h2 style="font-size: 16px; color: #3b82f6; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #e5e7eb; padding-bottom: 5px; margin-bottom: 15px;">
          3. Strategie & MVP
        </h2>
        <div style="margin-top: 10px;">
          <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
            <strong style="display: block; color: #059669; margin-bottom: 8px; font-size: 13px;">CORE FEATURES</strong>
            <p style="margin: 0; font-size: 12px; white-space: pre-wrap;">${escapeHtml(getVal('mvp_features'))}</p>
          </div>
          <div style="background: #fff1f2; padding: 15px; border-radius: 8px;">
            <strong style="display: block; color: #dc2626; margin-bottom: 8px; font-size: 13px;">OUT OF SCOPE (Anti-Features)</strong>
            <p style="margin: 0; font-size: 12px; white-space: pre-wrap;">${escapeHtml(getVal('mvp_anti_features'))}</p>
          </div>
        </div>
      </div>

      <!-- VALIDIERUNG -->
      <div style="margin-bottom: 30px; page-break-inside: avoid;">
        <h2 style="font-size: 16px; color: #3b82f6; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #e5e7eb; padding-bottom: 5px; margin-bottom: 15px;">
          4. Markt-Validierung
        </h2>
        <div style="margin-top: 10px;">
          <strong style="display: block; font-size: 11px; color: #6b7280; text-transform: uppercase; margin-bottom: 5px;">Testmethode</strong>
          <p style="margin: 0 0 15px 0; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(getVal('validation_method'))}</p>
          <strong style="display: block; font-size: 11px; color: #6b7280; text-transform: uppercase; margin-bottom: 5px;">Erfolgsmetrik</strong>
          <p style="margin: 0; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(getVal('validation_success'))}</p>
        </div>
      </div>

      <!-- FINANCE & SCORING -->
      ${(price > 0 || fixedCosts > 0) ? `
      <div style="margin-bottom: 30px; page-break-inside: avoid;">
        <h2 style="font-size: 16px; color: #3b82f6; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #e5e7eb; padding-bottom: 5px; margin-bottom: 15px;">
          5. Finanzplan
        </h2>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin-top: 10px;">
          <div style="background: #f9fafb; padding: 12px; border-radius: 6px;">
            <div style="font-size: 10px; color: #6b7280; text-transform: uppercase; margin-bottom: 5px;">Verkaufspreis</div>
            <div style="font-size: 18px; font-weight: bold; color: #059669;">${price.toFixed(2)}€</div>
          </div>
          <div style="background: #f9fafb; padding: 12px; border-radius: 6px;">
            <div style="font-size: 10px; color: #6b7280; text-transform: uppercase; margin-bottom: 5px;">Fixkosten/Monat</div>
            <div style="font-size: 18px; font-weight: bold; color: #dc2626;">${fixedCosts.toFixed(2)}€</div>
          </div>
          <div style="background: #eff6ff; padding: 12px; border-radius: 6px; border: 2px solid #3b82f6;">
            <div style="font-size: 10px; color: #3b82f6; text-transform: uppercase; margin-bottom: 5px;">Break-Even</div>
            <div style="font-size: 18px; font-weight: bold; color: #3b82f6;">${breakEven}</div>
            <div style="font-size: 10px; color: #6b7280; margin-top: 3px;">Einheiten</div>
          </div>
        </div>
      </div>
      ` : ''}

      <!-- VC VERDICT (KI-Analyse) -->
      <div style="margin-bottom: 30px; page-break-inside: avoid;">
        <h2 style="font-size: 16px; color: #3b82f6; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #e5e7eb; padding-bottom: 5px; margin-bottom: 15px;">
          6. Risiko-Analyse (AI Vetted)
        </h2>
        <div style="background: #f8fafc; border-left: 4px solid #3b82f6; padding: 15px; margin-top: 10px; font-size: 12px;">
          ${getHTML('response-hypothese')}
        </div>
      </div>

      <!-- FOOTER -->
      <div style="margin-top: 40px; border-top: 2px solid #e5e7eb; padding-top: 20px; text-align: center; color: #9ca3af; font-size: 10px;">
        <p style="margin: 0;">Erstellt mit VentureValidator | ${date}</p>
      </div>
    `;

    // 6. Füge Ghost-Element zum Body hinzu (sichtbar für Druck-Dialog)
    // WICHTIG: Wir verwenden window.print() statt html2pdf - das ist stabiler und blockiert nicht
    document.body.appendChild(ghostElement);

    // 7. Kurz warten, damit Layout gerendert wird
    await new Promise(resolve => setTimeout(resolve, 200));

    // 8. Button SOFORT wieder aktivieren (bevor Druck-Dialog öffnet)
    btn.disabled = false;
    btnText.textContent = '📄 Als Investment Memo exportieren (PDF)';
    if (btnSpinner) btnSpinner.classList.add('hidden');

    // 9. Öffne Browser-Druck-Dialog (sehr stabil, blockiert UI nicht)
    // window.print() verwendet automatisch die @media print Styles
    showToast('Öffne Druck-Dialog... Wähle "Als PDF speichern"', 'success');
    
    // Kurz warten, damit Toast sichtbar ist
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Druck-Dialog öffnen (blockiert nicht - Browser öffnet Dialog asynchron)
    window.print();

    // Erfolg-Feedback
    showToast('Druck-Dialog geöffnet. Wähle "Als PDF speichern".', 'success');
    
    // 🎉 Confetti!
    if (typeof confetti !== 'undefined') {
      setTimeout(() => {
        confetti({
          particleCount: 100,
          spread: 70,
          origin: { y: 0.6 }
        });
      }, 500);
    }

  } catch (error) {
    console.error('Fehler beim PDF-Export:', error);
    showToast('Fehler: ' + error.message, 'error');
  } finally {
    // KRITISCH: Cleanup GARANTIERT - verhindert Zombie-Element
    // Warte kurz, damit PDF-Generierung abgeschlossen ist
    setTimeout(() => {
      if (ghostElement && document.body.contains(ghostElement)) {
        try {
          document.body.removeChild(ghostElement);
        } catch (cleanupError) {
          console.error('Fehler beim Cleanup:', cleanupError);
        }
      }
    }, 500); // Kurze Verzögerung für PDF-Download
    
    // UI: Button ist bereits wieder aktiviert (wurde vor PDF-Generierung gemacht)
    // Aber sicherheitshalber nochmal setzen
    btn.disabled = false;
    btnText.textContent = '📄 Als Investment Memo exportieren (PDF)';
    if (btnSpinner) btnSpinner.classList.add('hidden');
  }
}

// ============================================
// FINISH PROJECT FUNCTION
// ============================================

async function finishProject() {
  const btn = document.getElementById('btn-finish-project');
  
  // 1. Sicherheits-Check (User muss da sein)
  if (!auth.currentUser) {
    showToast("Nicht eingeloggt!", "error");
    return;
  }

  // 2. SELF-HEALING: ID rekonstruieren
  // Wenn activeProjectId fehlt (durch Fehler beim Start), bauen wir sie uns selbst.
  // Das Format ist immer: UID + "-personal"
  const targetProjectId = activeProjectId || `${auth.currentUser.uid}-personal`;
  console.log("[finishProject] Versuche Abschluss für Projekt:", targetProjectId);
  console.log("[finishProject] activeProjectId war:", activeProjectId);
  console.log("[finishProject] targetProjectId ist:", targetProjectId);

  const originalText = btn.innerText;
  btn.disabled = true;
  btn.innerHTML = "💾 Speichere...";

  try {
    const docRef = doc(db, 'projects', targetProjectId);
    
    // 3. Daten sammeln (Snapshot der aktuellen Eingaben)
    // Wir holen uns die Werte direkt aus dem DOM, um sicherzugehen
    const currentData = {};
    fieldIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        currentData[id] = el.value;
        console.log(`[finishProject] Feld "${id}":`, el.value.substring(0, 50));
      }
    });

    console.log("[finishProject] Speichere mit setDoc (merge: true)");

    // 4. "Upsert" (Update oder Erstellen)
    // Wir nutzen setDoc mit merge:true. Das funktioniert IMMER.
    // Wenn das Projekt existiert -> Update. Wenn nicht -> Erstellen.
    await setDoc(docRef, {
      ownerId: auth.currentUser.uid,
      name: 'Persönliches Projekt',
      status: 'completed',
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      fields: currentData // Speichere die aktuellen Eingaben sicherheitshalber mit
    }, { merge: true });

    console.log("[finishProject] ERFOLG - Projekt gespeichert & abgeschlossen");

    // 5. Erfolg & Reset
    if (window.confetti) {
      window.confetti({
        particleCount: 150,
        spread: 70,
        origin: { y: 0.6 }
      });
    }
    showToast("Projekt erfolgreich gespeichert & abgeschlossen!", "success");

    setTimeout(() => {
      // Hartes Neuladen, um die App für das nächste Projekt zu resetten
      console.log("[finishProject] Starte window.location.reload()");
      window.location.reload();
    }, 2000);

  } catch (error) {
    console.error("[finishProject] FEHLER:", error);
    console.error("[finishProject] Error Details:", {
      code: error.code,
      message: error.message,
      targetProjectId
    });
    showToast("Fehler: " + error.message, "error");
    btn.disabled = false;
    btn.innerText = originalText;
  }
}