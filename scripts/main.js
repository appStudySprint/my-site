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

// ===================================================================
// === ANALYTICS & MONITORING (Sentry & Google Analytics) ===
// ===================================================================

/**
 * Initialisiert Sentry für Error Logging
 * Wird am Anfang von initializeForUser aufgerufen
 * 
 * Hinweis: Das Loader-Script (js-de.sentry-cdn.com) initialisiert Sentry automatisch.
 * Diese Funktion konfiguriert zusätzliche Einstellungen, falls nötig.
 */
function initializeSentry() {
  if (typeof Sentry === 'undefined') {
    console.warn('[initializeSentry] Sentry SDK nicht geladen');
    return;
  }

  try {
    // Das Loader-Script initialisiert Sentry automatisch mit der DSN
    // Wir können zusätzliche Konfigurationen setzen, falls die API verfügbar ist
    if (typeof Sentry.configureScope === 'function') {
      Sentry.configureScope((scope) => {
        scope.setTag('environment', window.location.hostname === 'localhost' ? 'development' : 'production');
      });
    }

    // Prüfe, ob Sentry bereits initialisiert wurde
    try {
      const client = Sentry.getCurrentHub?.()?.getClient?.();
      if (client) {
        console.log('[initializeSentry] Sentry bereits durch Loader-Script initialisiert');
      } else {
        console.log('[initializeSentry] Sentry wird durch Loader-Script initialisiert');
      }
    } catch (checkError) {
      // API möglicherweise nicht verfügbar, aber Sentry funktioniert trotzdem
      console.log('[initializeSentry] Sentry Loader-Script aktiv');
    }

    console.log('[initializeSentry] Sentry erfolgreich konfiguriert');
  } catch (error) {
    console.error('[initializeSentry] Fehler bei Sentry-Konfiguration:', error);
  }
}

/**
 * Helper-Funktion für Google Analytics 4 Event Tracking
 * @param {string} action - Die Aktion (z.B. 'analysis_run', 'pdf_download')
 * @param {string} label - Optional: Label für zusätzlichen Kontext
 */
function trackEvent(action, label = '') {
  if (typeof gtag === 'undefined') {
    console.warn('[trackEvent] Google Analytics nicht geladen');
    return;
  }

  try {
    const eventData = {
      event_category: 'venture_validator',
      event_label: label || action,
    };

    gtag('event', action, eventData);
    console.log('[trackEvent] Event gesendet:', action, eventData);
  } catch (error) {
    console.error('[trackEvent] Fehler beim Senden des Events:', error);
  }
}

// ===================================================================
// === 1. IMPORTS & KONFIGURATION ===
// ===================================================================

// ===================================================================
// === 6. AI ENGINE (Das Gehirn) ===
// HINWEIS: Diese Funktionen stehen am Anfang, da sie von vielen anderen
// Funktionen verwendet werden. Sie gehören inhaltlich zu Abschnitt 6.
// ===================================================================

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
  // Sicherung: Blockiere API-Calls während Chaos-Tests, um Quota zu schützen
  if (isChaosMode) {
    console.warn("🔒 API Call blockiert durch Chaos-Mode (Quota Schutz).");
    showToast("🤖 API Call simuliert (Chaos Mode)", "warning");
    // Simuliere eine Antwort nach 500ms
    await new Promise(r => setTimeout(r, 500));
    return { 
      candidates: [{ content: { parts: [{ text: "Dies ist eine simulierte Antwort im Chaos-Modus, um Kosten zu sparen." }] } }] 
    };
  }

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

    // 🔒 Hole Firebase Auth Token für Backend-Authentifizierung
    let authToken = null;
    if (currentUser && typeof currentUser.getIdToken === 'function') {
      try {
        authToken = await currentUser.getIdToken();
      } catch (tokenError) {
        console.warn('[callGeminiAPI] Konnte Auth Token nicht abrufen:', tokenError);
        // Fallback: Versuche es trotzdem (für Development)
      }
    }

    // Erstelle Headers mit Auth Token
    const headers = {
      'Content-Type': 'application/json',
    };
    
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await fetch('/.netlify/functions/gemini-proxy', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(requestBody)
    });

    // Behandle verschiedene HTTP-Status-Codes
    if (response.status === 401) {
      // Unauthorized - Auth Token fehlt oder ungültig
      const errorText = await response.text();
      console.error('401 Unauthorized:', errorText);
      throw new Error('Authentifizierung fehlgeschlagen. Bitte melde dich erneut an.');
    }
    
    if (response.status === 400) {
      // Bad Request - Input zu lang oder ungültig
      const errorData = await response.json().catch(() => ({ message: 'Invalid request' }));
      if (errorData.message && errorData.message.includes('too long')) {
        throw new Error(`Input zu lang: ${errorData.yourLength} Zeichen (max: ${errorData.maxLength}). Bitte kürze deine Eingabe.`);
      }
      throw new Error(errorData.message || 'Ungültige Anfrage');
    }
    
    if (response.status === 408) {
      // Request Timeout
      throw new Error('Die Anfrage hat zu lange gedauert. Bitte versuche es mit kürzerem Input erneut.');
    }
    
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
    // Sende Fehler an Sentry
    if (typeof Sentry !== 'undefined') {
      try {
        Sentry.captureException(error, {
          tags: {
            function: 'callGeminiAPI',
            retryCount: retryCount,
            useSearch: useSearch,
          },
          extra: {
            userPrompt: userPrompt.substring(0, 200), // Erste 200 Zeichen für Kontext
          },
        });
      } catch (sentryError) {
        console.error('[callGeminiAPI] Fehler beim Senden an Sentry:', sentryError);
      }
    }

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

// ===================================================================
// === 1. KONFIGURATION: FIELD_IDS & Globale Variablen ===
// ===================================================================

// Alle Input/Textarea IDs, die gespeichert werden müssen (EXAKT wie im HTML)
const FIELD_IDS = [
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

// Alias für Rückwärtskompatibilität
const fieldIds = FIELD_IDS;

// Demo-Ideen für Magic Dice Feature
const DEMO_IDEAS = [
  {
    problem: "Landwirte haben Schwierigkeiten, ihre Traktoren und Maschinen effizient zu vermieten, wenn sie nicht genutzt werden. Viele teure Geräte stehen monatelang ungenutzt herum.",
    solution: "Eine Plattform, die Landwirte mit anderen Landwirten oder kleinen Betrieben verbindet, um Traktoren, Mähdrescher und andere Agrar-Maschinen zu vermieten. Ähnlich wie Uber, aber für landwirtschaftliche Geräte mit GPS-Tracking, Versicherung und automatischer Abrechnung.",
    pitch: "Uber für Traktoren: Vermiete deine Agrar-Maschinen, wenn du sie nicht brauchst, und verdiene passives Einkommen."
  },
  {
    problem: "Kleine Unternehmen und Privatpersonen haben oft zu wenig Lagerraum, während andere ungenutzten Platz in Garagen, Kellern oder Lagerhallen haben. Die Suche nach passendem Lagerraum ist zeitaufwändig und teuer.",
    solution: "Eine Marktplatz-App, die Lagerraum-Anbieter mit Suchenden verbindet. Nutzer können ihren verfügbaren Raum (Garage, Keller, Lagerhalle) mit Fotos, Größe und Preis anbieten. Suchende finden passenden Raum in ihrer Nähe, buchen online und zahlen sicher über die Plattform.",
    pitch: "Airbnb für Lagerraum: Finde oder vermiete Lagerplatz in deiner Nachbarschaft - einfach, sicher und günstig."
  },
  {
    problem: "Kinder mit Legasthenie und Lese-Rechtschreib-Schwäche bekommen oft nicht die individuelle Unterstützung, die sie brauchen. Schullehrer sind überlastet, und private Nachhilfe ist teuer und schwer verfügbar.",
    solution: "Ein KI-gestützter Tutor, der sich an jeden Schüler individuell anpasst. Die App erkennt die spezifischen Schwierigkeiten, bietet personalisierte Übungen, liest Texte vor, korrigiert Fehler in Echtzeit und motiviert mit Gamification. Eltern und Lehrer erhalten detaillierte Fortschrittsberichte.",
    pitch: "AI-Tutor für Legasthenie: Personalisierte Lernunterstützung, die sich an jedes Kind anpasst und echte Fortschritte macht."
  },
  {
    problem: "Freelancer und kleine Agenturen verbringen zu viel Zeit mit Rechnungsstellung, Steuerdokumentation und Finanzplanung. Die Tools sind entweder zu komplex, zu teuer oder nicht auf deutsche Steuergesetze ausgelegt.",
    solution: "Eine all-in-one Finanz-App speziell für deutsche Freelancer: Automatische Rechnungsgenerierung, Steuer-Vorbereitung, Einnahmen-Ausgaben-Tracking, und intelligente Steuertipps. Integriert mit DATEV und Elster, spricht Deutsch und erklärt alles in einfacher Sprache.",
    pitch: "Finanz-Assistent für Freelancer: Von der Rechnung bis zur Steuererklärung - alles automatisch, alles auf Deutsch."
  },
  {
    problem: "Senioren und Menschen mit eingeschränkter Mobilität haben Schwierigkeiten, frische Lebensmittel und Medikamente zu bekommen. Lieferdienste sind oft zu teuer oder liefern nicht in ländliche Gebiete.",
    solution: "Eine Community-basierte Plattform, die Nachbarn miteinander verbindet. Jüngere Menschen können beim Einkaufen für Senioren mitbestellen, Senioren können sich gegenseitig helfen. Die App organisiert Einkaufsgruppen, teilt Fahrtkosten und belohnt Helfer mit einem Punktesystem oder kleinen Vergütungen.",
    pitch: "Nachbarschafts-Einkaufshilfe: Jüngere helfen Älteren beim Einkaufen, alle profitieren - Community statt Isolation."
  }
];

const LOCAL_STORAGE_PREFIX = 'projektDashboardData';

let currentUser = null;
let currentUserPlan = 'free'; // 'free' oder 'pro'
let userProfile = null; // User-Profil aus Firestore (email, plan, isWaitlisted)
let projectDocRef = null;
let isChaosMode = false; // Flag zum Blockieren von API-Calls während Chaos-Tests
let unsubscribeProject = null;
let unsubscribeMembers = null;
let unsubscribePendingInvites = null;
let unsubscribeIncomingInvites = null;
let isApplyingRemoteData = false;
let pendingRemoteUpdates = {};

let activeProjectId = null;
let activeProjectName = 'Persönliches Projekt';
let currentMembership = { role: 'owner' };
let userProjects = []; // Liste aller Projekte des Users

// Globale Variable für Analysis-Resolver (Promise-Pattern für Modal)
if (typeof window !== 'undefined') {
  window.analysisResolver = null;
}

// Throttled functions werden später initialisiert, nachdem die Funktionen definiert sind
let throttledLocalSave = null;
let throttledFirestoreSave = null;

// Wizard State Management
let currentStep = 1;
const totalSteps = 6;

// ===================================================================
// === 2. INITIALISIERUNG (Lifecycle) ===
// ===================================================================

document.addEventListener('DOMContentLoaded', () => {
  console.log('[DOMContentLoaded] Starte Initialisierung');
  
  try {
    // Initialisiere throttled functions zuerst
    initializeThrottledFunctions();
    
    // Auth & Landing Page Setup - MUSS ZUERST passieren!
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
    setupProjectGateModal();
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
    
    // Confirm Limit Modal Buttons Setup
    const confirmLimitYesBtn = document.getElementById('confirm-limit-yes');
    const confirmLimitNoBtn = document.getElementById('confirm-limit-no');
    
    if (confirmLimitYesBtn) {
      confirmLimitYesBtn.addEventListener('click', () => {
        if (window.analysisResolver) {
          window.analysisResolver(true);
        }
        const modal = document.getElementById('confirm-limit-modal');
        if (modal) {
          modal.classList.add('hidden');
          modal.classList.remove('flex');
        }
      });
    }
    
    if (confirmLimitNoBtn) {
      confirmLimitNoBtn.addEventListener('click', () => {
        if (window.analysisResolver) {
          window.analysisResolver(false);
        }
        const modal = document.getElementById('confirm-limit-modal');
        if (modal) {
          modal.classList.add('hidden');
          modal.classList.remove('flex');
        }
      });
    }
    
  // Wizard wird erst nach Projekt-Laden angezeigt (in initializeForUser)
  } catch (error) {
    console.error('[DOMContentLoaded] Fehler bei Initialisierung:', error);
  }
});

// Globale Window-Bindings (für onclick-Handler in HTML)
if (typeof window !== 'undefined') {
  window.analyzeSection = null; // Wird in Abschnitt 6 gesetzt
  window.loadProject = null; // Wird in Abschnitt 4 gesetzt
  window.switchProject = null; // Wird in Abschnitt 4 gesetzt
}

// ===================================================================
// === 3. AUTH & ROUTING (Der Türsteher) ===
// ===================================================================

// Helper: Storage Key Generator
function storageKey() {
  if (!currentUser || !activeProjectId) return `${LOCAL_STORAGE_PREFIX}:guest`;
  return `${LOCAL_STORAGE_PREFIX}:${activeProjectId}`;
}

function updateUIState(user) {
  const landing = document.getElementById('landing-page');
  const app = document.getElementById('app-container');
  
  console.log("UI State Update. User:", user ? "Logged In" : "Logged Out");

  // Header-Elemente
  const btnLogin = document.getElementById('signInButton');
  const userBadge = document.getElementById('userBadge');
  const userName = document.getElementById('userName');
  const userEmail = document.getElementById('userEmail');
  const historyButtonAuthed = document.getElementById('history-button-authed');

  if (user) {
    if (landing) landing.classList.add('hidden');
    if (app) app.classList.remove('hidden');
    
    // Modals schließen
    document.querySelectorAll('.fixed').forEach(el => {
      if (el.id && (el.id.includes('modal') || el.id.includes('gate'))) {
        el.classList.add('hidden');
        el.classList.remove('flex');
      }
    });
    
    // Header-Status: Zeige Badge, Verstecke Login-Button
    if (btnLogin) btnLogin.classList.add('hidden');
    if (userBadge) {
      userBadge.classList.remove('hidden');
      userBadge.classList.add('flex');
    }
    if (userName) userName.textContent = user.displayName || user.email || 'Gründer';
    if (userEmail) userEmail.textContent = user.email || '';
    if (historyButtonAuthed) historyButtonAuthed.classList.remove('hidden');
    
    initializeForUser(user);
  } else {
    if (landing) landing.classList.remove('hidden');
    if (app) app.classList.add('hidden');
    
    // Header-Status: Zeige Login-Button, Verstecke Badge
    if (btnLogin) btnLogin.classList.remove('hidden');
    if (userBadge) {
      userBadge.classList.add('hidden');
      userBadge.classList.remove('flex');
    }
    if (historyButtonAuthed) historyButtonAuthed.classList.add('hidden');
  }
}

function triggerLogin() {
      signInWithPopup(auth, googleProvider).catch((error) => {
        console.error("Login Fehler:", error);
    showToast("Login fehlgeschlagen: " + error.message, "error");
  });
}

function setupLandingPageEvents() {
  console.log('[setupLandingPageEvents] Starte Setup');
  
  // Free Plan Button -> Direkter Login
  const btnPlanFree = document.getElementById('btn-plan-free');
  if (btnPlanFree) {
    btnPlanFree.addEventListener('click', () => {
      console.log('[setupLandingPageEvents] btn-plan-free geklickt');
      triggerLogin();
    });
  } else {
    console.warn('[setupLandingPageEvents] btn-plan-free nicht gefunden');
  }
  
  // Pro Plan Button -> Öffne Warteliste Modal
  const btnPlanPro = document.getElementById('btn-plan-pro');
  if (btnPlanPro) {
    btnPlanPro.addEventListener('click', () => {
      console.log('[setupLandingPageEvents] btn-plan-pro geklickt');
      // GA4 Event: Upgrade Intent (Landing Page)
      trackEvent('upgrade_intent', 'landing_page_pro_button');
      openWaitlistModal();
    });
  } else {
    console.warn('[setupLandingPageEvents] btn-plan-pro nicht gefunden');
  }
  
  // Direkt Login Button (für Bestandskunden)
  const btnLoginDirect = document.getElementById('btn-login-direct');
  if (btnLoginDirect) {
    btnLoginDirect.addEventListener('click', () => {
      console.log('[setupLandingPageEvents] btn-login-direct geklickt');
      triggerLogin();
    });
  } else {
    console.warn('[setupLandingPageEvents] btn-login-direct nicht gefunden');
  }
}

function setupAuthUi() {
  console.log('[setupAuthUi] Starte Setup');
  
  // Landing Page Events
  setupLandingPageEvents();
  
  // Warteliste Modal Setup
  setupWaitlistModal();
  
  // Upgrade Modal Setup
  setupUpgradeModal();
  
  // Confirm Limit Modal Setup - ENTFERNT (Funktion existiert nicht)
  // setupConfirmLimitModal();
  
  // Downsell Modal Setup
  setupDownsellModal();
  
  // Upsell Gate Setup
  setupUpsellGate();

  // App Header Buttons
  const signInButton = document.getElementById('signInButton');
  const signOutButton = document.getElementById('signOutButton');

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
        localStorage.clear(); // Alles lokale löschen
        window.location.reload(); // Hard Reload erzwingen
      } catch (error) {
        console.error('Fehler beim Abmelden:', error);
      }
    });
  }

  // Auth State Listener - ruft zentrale updateUIState auf
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    updateUIState(user);
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
    console.log('[setupWaitlistModal] Form Submit');
    
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
      // PRÜFUNG: Ist die E-Mail bereits in der Warteliste?
      const waitlistQuery = query(
        collection(db, 'waitlist'),
        where('email', '==', email)
      );
      const waitlistSnap = await getDocs(waitlistQuery);
      
      // Szenario A: E-Mail bereits vorhanden
      if (!waitlistSnap.empty) {
        console.log('[setupWaitlistModal] E-Mail bereits auf Warteliste:', email);
        showToast('Du stehst bereits auf der Liste! Danke für dein Vertrauen.', 'success');
        
        // Warteliste Modal hart schließen
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        
        // Warte 1 Sekunde, dann Login
        setTimeout(() => {
          signInWithPopup(auth, googleProvider).catch((error) => {
            console.error('[setupWaitlistModal] Login Fehler:', error);
            showToast('Login fehlgeschlagen: ' + error.message, 'error');
          });
        }, 1000);
        return;
      }
      
      // Szenario B: Neu -> E-Mail zur Warteliste hinzufügen
      await saveToWaitlist(email, notify);
      console.log('[setupWaitlistModal] Warteliste erfolgreich gespeichert');
      showToast('Du stehst auf der Liste! Wir melden uns.', 'success');
      
      // Warteliste Modal hart schließen
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      
      // Downsell Modal hart öffnen
      const downsellModal = document.getElementById('downsell-modal');
      if (downsellModal) {
        console.log('[setupWaitlistModal] Öffne Downsell Modal');
        downsellModal.classList.remove('hidden');
        downsellModal.classList.add('flex');
      } else {
        console.error('[setupWaitlistModal] Downsell Modal nicht gefunden!');
      }
    } catch (error) {
      console.error('[setupWaitlistModal] Fehler beim Speichern:', error);
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
    // GA4 Event: Upgrade Intent (Upgrade Modal)
    trackEvent('upgrade_intent', 'upgrade_modal_to_pricing');
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
  
  // IMMER parallel prüfen: Steht user.email in der waitlist Collection?
  let isWaitlisted = false;
  if (user.email) {
    try {
      const waitlistQuery = query(
        collection(db, 'waitlist'),
        where('email', '==', user.email)
      );
      const waitlistSnap = await getDocs(waitlistQuery);
      isWaitlisted = !waitlistSnap.empty;
      console.log('[syncUserProfile] Wartelisten-Prüfung für', user.email, ':', isWaitlisted);
    } catch (error) {
      console.error('[syncUserProfile] Fehler bei Wartelisten-Prüfung:', error);
      // Im Fehlerfall: false (sicherer Default)
    }
  }
  
  if (!userSnap.exists()) {
    // Neues User-Doc erstellen mit korrektem isWaitlisted Status
    await setDoc(userRef, {
      email: user.email ?? '',
      plan: 'free',
      isWaitlisted: isWaitlisted, // Korrekt basierend auf waitlist Collection
      createdAt: serverTimestamp()
    });
    
    userProfile = {
      email: user.email ?? '',
      plan: 'free',
      isWaitlisted: isWaitlisted
    };
    
    console.log('[syncUserProfile] Neues User-Profil erstellt mit isWaitlisted:', isWaitlisted);
  } else {
    // Bestehendes Profil: Update isWaitlisted basierend auf waitlist Collection
    const data = userSnap.data();
    
    // Update User-Doc, falls isWaitlisted sich geändert hat
    if (data.isWaitlisted !== isWaitlisted) {
      await updateDoc(userRef, {
        isWaitlisted: isWaitlisted,
        ...(isWaitlisted && !data.waitlistedAt ? { waitlistedAt: serverTimestamp() } : {})
      }, { merge: true });
      console.log('[syncUserProfile] isWaitlisted aktualisiert:', data.isWaitlisted, '->', isWaitlisted);
    }
    
    userProfile = {
      email: data.email ?? user.email ?? '',
      plan: data.plan ?? 'free',
      isWaitlisted: isWaitlisted // Verwende immer den aktuellen Wert aus waitlist Collection
    };
    
    // Synchronisiere currentUserPlan mit userProfile.plan
    currentUserPlan = userProfile.plan;
    
    console.log('[syncUserProfile] User-Profil geladen/synchronisiert:', userProfile);
  }
  
  return userProfile;
}

// ============================================
// UPSELL GATE (Für Free-User)
// ============================================

function setupUpsellGate() {
  const upsellGate = document.getElementById('upsell-gate');
  const btnUpsellPro = document.getElementById('btn-upsell-pro');
  const btnUpsellSkip = document.getElementById('btn-upsell-skip');
    const appContainer = document.getElementById('app-container');
  
  if (!upsellGate) {
    console.warn('[setupUpsellGate] Upsell Gate nicht gefunden');
    return;
  }
  
  // Pro Button -> Öffnet Warteliste-Modal (fake-door-modal) UND schließt Gate
  if (btnUpsellPro) {
    btnUpsellPro.addEventListener('click', () => {
      console.log('[setupUpsellGate] btn-upsell-pro geklickt');
      // GA4 Event: Upgrade Intent (Upsell Gate)
      trackEvent('upgrade_intent', 'upsell_gate_pro_button');
      closeUpsellGate();
      // Öffne Warteliste-Modal (waitlist-modal)
      const waitlistModal = document.getElementById('waitlist-modal');
      if (waitlistModal) {
        waitlistModal.classList.remove('hidden');
        waitlistModal.classList.add('flex');
        // Focus auf E-Mail Input
        const emailInput = document.getElementById('waitlist-email');
        if (emailInput) {
          setTimeout(() => emailInput.focus(), 100);
        }
      } else {
        console.error('[setupUpsellGate] waitlist-modal nicht gefunden');
      }
    });
  } else {
    console.warn('[setupUpsellGate] btn-upsell-pro nicht gefunden');
  }
  
  // Skip Button -> Schließt Gate, zeigt App und öffnet Projekt-Gate-Modal
  if (btnUpsellSkip) {
    btnUpsellSkip.addEventListener('click', async () => {
      console.log('[setupUpsellGate] btn-upsell-skip geklickt');
      closeUpsellGate();
      // Starte Projekt-Setup mit Modal
      if (currentUser) {
        try {
          // Lade Projekte und öffne Modal (wie in initializeForUser)
          const projectsRef = collection(db, 'projects');
          
          // Versuche zuerst mit orderBy (benötigt Index)
          let snapshot;
          try {
            const q = query(
              projectsRef,
              where('ownerId', '==', currentUser.uid),
              orderBy('updatedAt', 'desc')
            );
            snapshot = await getDocs(q);
          } catch (indexError) {
            // Fallback: Lade alle Projekte ohne orderBy und sortiere im Client
            console.warn('[setupUpsellGate] Index-Fehler, verwende Fallback:', indexError.message);
            const q = query(
              projectsRef,
              where('ownerId', '==', currentUser.uid)
            );
            snapshot = await getDocs(q);
          }
          
          userProjects = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          }));
          
          // Sortiere im Client nach updatedAt (falls kein Index vorhanden)
          userProjects.sort((a, b) => {
            const aTime = a.updatedAt?.toMillis?.() || a.updatedAt?._seconds * 1000 || 0;
            const bTime = b.updatedAt?.toMillis?.() || b.updatedAt?._seconds * 1000 || 0;
            return bTime - aTime; // Neueste zuerst
          });
          
          console.log('[setupUpsellGate] Gefundene Projekte:', userProjects.length);
          
          // Öffne Projekt-Gate-Modal
          await openProjectGateModal();
          
          watchIncomingInvites(currentUser);
        } catch (error) {
          console.error('[setupUpsellGate] Fehler beim Initialisieren nach Upsell Gate:', error);
          showToast('Fehler beim Laden der App. Bitte aktualisiere die Seite.', 'error');
        }
      }
    });
  } else {
    console.warn('[setupUpsellGate] btn-upsell-skip nicht gefunden');
  }
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
    triggerLogin();
  });
  
  // "Nein, ich warte" Button -> Schließt Modal
  noBtn.addEventListener('click', () => {
    closeDownsellModal();
  });
}

// ===================================================================
// === 4. PROJEKT-MANAGEMENT (Gatekeeper) ===
// ===================================================================

async function initializeForUser(user) {
  console.log('[initializeForUser] START für User:', user.uid);
  
  // SCHRITT 0: Initialisiere Sentry (ganz am Anfang, um Ladefehler zu fangen)
  initializeSentry();
  
  // Setze User-Context für Sentry
  if (typeof Sentry !== 'undefined') {
    try {
      Sentry.setUser({
        id: user.uid,
        email: user.email,
        username: user.displayName || user.email,
      });
    } catch (error) {
      console.error('[initializeForUser] Fehler beim Setzen des Sentry User-Context:', error);
    }
  }
  
  // SCHRITT 1: User-Profil synchronisieren (prüft IMMER waitlist Collection)
  console.log('[initializeForUser] syncUserProfile...');
  const profile = await syncUserProfile(user);
  
  // SCHRITT 1: Routing basierend auf User-Status
  const appContainer = document.getElementById('app-container');
  const landingPage = document.getElementById('landing-page');
  const upsellGate = document.getElementById('upsell-gate');
  
  // Wartelisten-User: Zeige Danke-Toast
  if (profile.isWaitlisted) {
    // Prüfe Session Storage, um Toast nur einmal pro Session zu zeigen
    const thanksShown = sessionStorage.getItem('waitlistThanksShown');
    if (!thanksShown) {
      showToast('👋 Willkommen zurück! Danke für deine Geduld bei der Pro-Version.', 'success');
      sessionStorage.setItem('waitlistThanksShown', 'true');
    }
    // Zeige App direkt
    if (appContainer) appContainer.classList.remove('hidden');
    if (landingPage) landingPage.classList.add('hidden');
    if (upsellGate) upsellGate.classList.add('hidden');
  } 
  // Free-User (nicht waitlisted): Zeige Upsell-Gate
  else if (profile.plan === 'free' && !profile.isWaitlisted) {
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
  else if (profile.plan === 'pro') {
    if (appContainer) appContainer.classList.remove('hidden');
    if (landingPage) landingPage.classList.add('hidden');
    if (upsellGate) upsellGate.classList.add('hidden');
  }
  
  // SCHRITT 2: Verstecke Wizard bis Projekt geladen
  hideWizardUntilProjectLoaded();

  try {
    // SCHRITT 3: Lade ALLE Projekte des Users
    console.log('[initializeForUser] Lade Projekte...');
    const projectsRef = collection(db, 'projects');
    
    // Versuche zuerst mit orderBy (benötigt Index)
    let snapshot;
    try {
      const q = query(
        projectsRef,
        where('ownerId', '==', user.uid),
        orderBy('updatedAt', 'desc')
      );
      snapshot = await getDocs(q);
    } catch (indexError) {
      // Fallback: Lade alle Projekte ohne orderBy und sortiere im Client
      console.warn('[initializeForUser] Index-Fehler, verwende Fallback:', indexError.message);
      const q = query(
        projectsRef,
        where('ownerId', '==', user.uid)
      );
      snapshot = await getDocs(q);
    }
    
    userProjects = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    // Sortiere im Client nach updatedAt (falls kein Index vorhanden)
    userProjects.sort((a, b) => {
      const aTime = a.updatedAt?.toMillis?.() || a.updatedAt?._seconds * 1000 || 0;
      const bTime = b.updatedAt?.toMillis?.() || b.updatedAt?._seconds * 1000 || 0;
      return bTime - aTime; // Neueste zuerst
    });
    
    console.log('[initializeForUser] Gefundene Projekte:', userProjects.length);
    
    // SCHRITT 4: Öffne IMMER das Projekt-Gate-Modal
    await openProjectGateModal();
    
    watchIncomingInvites(user);
    
  } catch (error) {
    console.error('[initializeForUser] FEHLER bei der Initialisierung:', error);
    showToast("Initialisierungs-Fehler: " + error.message, 'error');
  }
}
// Öffne das Projekt-Gate-Modal
async function openProjectGateModal() {
  const modal = document.getElementById('project-gate-modal');
  if (!modal) {
    console.error('[openProjectGateModal] Modal nicht gefunden!');
    return;
  }

  console.log('[openProjectGateModal] Öffne Modal...');

  // Rendere Projekt-Liste
  await renderProjectList();
  
  // Zeige Modal (mit höchstem z-index)
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  
  console.log('[openProjectGateModal] Modal sollte jetzt sichtbar sein');
}

// Schließe das Projekt-Gate-Modal
function closeProjectGateModal() {
  const modal = document.getElementById('project-gate-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
  
  // Reset Create-Form
  const createForm = document.getElementById('project-create-form');
  const createSection = document.getElementById('project-create-section');
  if (createForm) createForm.classList.add('hidden');
  if (createSection) createSection.classList.remove('hidden');
  
  const nameInput = document.getElementById('new-project-name');
  if (nameInput) nameInput.value = '';
}

// Rendere die Projekt-Liste im Modal
async function renderProjectList() {
  const container = document.getElementById('project-list-container');
  if (!container) return;

  try {
    if (userProjects.length === 0) {
      container.innerHTML = '<p class="text-gray-400 text-center">Noch keine Projekte vorhanden.</p>';
      return;
    }

    container.innerHTML = userProjects.map(project => {
      const createdAt = project.createdAt?.toDate ? project.createdAt.toDate().toLocaleDateString('de-DE') : 'Unbekannt';
      const isActive = project.id === activeProjectId;
      const statusBadge = project.status === 'completed' 
        ? '<span class="bg-green-500/20 text-green-400 px-2 py-1 rounded-full text-xs">Abgeschlossen</span>'
        : isActive
        ? '<span class="bg-blue-500/20 text-blue-400 px-2 py-1 rounded-full text-xs">Aktiv</span>'
        : '<span class="bg-gray-500/20 text-gray-400 px-2 py-1 rounded-full text-xs">Offen</span>';
      
      // Extrahiere Score falls vorhanden
      let scoreDisplay = '';
      if (project.results && project.results['hypothese']) {
        // Versuche Score aus final-score Analyse zu extrahieren (falls vorhanden)
        scoreDisplay = '<span class="text-xs text-gray-500">Score: -</span>';
      }
      
      return `
        <div class="glass-panel p-4 ${isActive ? 'border-2 border-blue-500' : 'cursor-pointer hover:bg-dark-800/50'} transition-colors" ${!isActive ? `onclick="loadProject('${project.id}')"` : ''}>
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-lg font-bold text-white">${escapeHtml(project.name || 'Unbenanntes Projekt')}</h3>
            ${statusBadge}
          </div>
          <div class="flex items-center justify-between text-sm text-gray-400">
            <span>Erstellt: ${createdAt}</span>
            ${scoreDisplay}
          </div>
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error('[renderProjectList] Fehler beim Rendern der Projekt-Liste:', error);
    
    // Sende Fehler an Sentry
    if (typeof Sentry !== 'undefined') {
      try {
        Sentry.captureException(error, {
          tags: {
            function: 'renderProjectList',
          },
          extra: {
            userProjectsCount: userProjects?.length || 0,
            activeProjectId: activeProjectId,
          },
        });
      } catch (sentryError) {
        console.error('[renderProjectList] Fehler beim Senden an Sentry:', sentryError);
      }
    }
    
    // Zeige Fehlermeldung im Container
    if (container) {
      container.innerHTML = '<p class="text-red-400 text-center">Fehler beim Laden der Projekte. Bitte Seite neu laden.</p>';
    }
  }
}

// Verstecke Wizard bis Projekt geladen
function hideWizardUntilProjectLoaded() {
  const wizardSteps = document.querySelectorAll('.wizard-step');
  wizardSteps.forEach(step => {
    step.classList.add('hidden');
  });
}

// Zeige Wizard nach Projekt-Laden
function showWizardAfterProjectLoaded() {
  // Stelle sicher, dass Wizard-Container sichtbar ist
  const wizardContainer = document.querySelector('.wizard-container') || document.querySelector('[class*="wizard"]');
  
  if (currentStep >= 1 && currentStep <= totalSteps) {
    showStep(currentStep);
  } else {
    showStep(1);
  }
}

// Erstelle ein neues Projekt mit automatischer ID (UI-Version mit Limit-Check)
async function createNewProjectUI(name) {
  if (!currentUser) {
    showToast("Nicht eingeloggt!", "error");
    return;
  }

  // Limit Check
  if (currentUserPlan === 'free' && userProjects.length >= 1) {
    showToast("Free User dürfen nur 1 Projekt haben", "warning");
    openUpgradeModal();
    return;
  }

  if (currentUserPlan === 'pro' && userProjects.length >= 100) {
    showToast("Projekt-Limit erreicht (100 Projekte)", "error");
    return;
  }

  if (!name || !name.trim()) {
    showToast("Bitte gib einen Projektnamen ein", "warning");
    return;
  }

  try {
    const planFromProfile = userProfile?.plan || 'free';
    const initialFields = getCurrentFieldValues();
    
    const projectsRef = collection(db, 'projects');
    const newProjectRef = await addDoc(projectsRef, {
      ownerId: currentUser.uid,
      name: name.trim(),
      plan: planFromProfile,
      status: 'active',
      fields: initialFields,
      results: {},
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    
    console.log('[createNewProjectUI] Neues Projekt erstellt:', newProjectRef.id);
    currentUserPlan = planFromProfile;
    
    // Erstelle Mitgliedschaft
    await setDoc(doc(db, 'projects', newProjectRef.id, 'members', currentUser.uid), {
      role: 'owner',
      email: currentUser.email ?? '',
      displayName: currentUser.displayName ?? '',
      addedAt: serverTimestamp(),
    }, { merge: true });
    
    // Füge zum userProjects Array hinzu
    userProjects.unshift({
      id: newProjectRef.id,
      name: name.trim(),
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    
    // Lade das Projekt und schließe Modal
    await loadProject(newProjectRef.id);
    
  } catch (error) {
    console.error('[createNewProjectUI] Fehler:', error);
    showToast("Fehler beim Erstellen: " + error.message, "error");
  }
}

// Lade ein Projekt (ersetzt setActiveProject für Gate-Flow)
async function loadProject(projectId) {
  console.log('[loadProject] Lade Projekt:', projectId);
  
  if (!currentUser) {
    showToast("Nicht eingeloggt!", "error");
    return;
  }

  try {
    await setActiveProject(projectId);
    
    // Schließe Gate-Modal
    closeProjectGateModal();
    
    // Zeige Wizard
    showWizardAfterProjectLoaded();
    
    showToast("Projekt geladen!", "success");
  } catch (error) {
    console.error('[loadProject] Fehler:', error);
    showToast("Fehler beim Laden: " + error.message, "error");
  }
}

// Mache loadProject global verfügbar für onclick-Handler
window.loadProject = loadProject;

async function resolveActiveProject(user) {
  console.log('[resolveActiveProject] START für User:', user.uid);
  
  // Versuche zuerst gespeicherte Projekt-ID
  const stored = localStorage.getItem('activeProjectId');
  if (stored) {
    const existing = await getDoc(doc(db, 'projects', stored));
    if (existing.exists()) {
      const data = existing.data();
      // Nur laden, wenn es nicht abgeschlossen ist oder dem User gehört
      if (data.ownerId === user.uid && data.status !== 'completed') {
        console.log('[resolveActiveProject] Verwende gespeichertes Projekt:', stored);
        await setActiveProject(stored);
        return;
      }
    }
    localStorage.removeItem('activeProjectId');
  }

  // Suche das letzte aktive Projekt des Users
  try {
    const projectsRef = collection(db, 'projects');
    const q = query(
      projectsRef,
      where('ownerId', '==', user.uid),
      orderBy('updatedAt', 'desc'),
      limit(1)
    );
    const snapshot = await getDocs(q);

    if (!snapshot.empty) {
      const projectDoc = snapshot.docs[0];
      const projectData = projectDoc.data();
      
      // Nur laden, wenn nicht abgeschlossen
      if (projectData.status !== 'completed') {
        console.log('[resolveActiveProject] Letztes aktives Projekt gefunden:', projectDoc.id);
        await setActiveProject(projectDoc.id);
        return;
      }
    }
  } catch (error) {
    console.error('[resolveActiveProject] Fehler beim Suchen des letzten Projekts:', error);
    // Falls orderBy nicht funktioniert (z.B. fehlender Index), erstelle neues Projekt
  }

  // Kein aktives Projekt gefunden -> erstelle neues
  console.log('[resolveActiveProject] Erstelle neues Projekt');
  await createNewProject(user);
}

// Erstelle ein neues Projekt ohne UI (wird von finishProject und resolveActiveProject verwendet)
async function createNewProject(user) {
  if (!user) {
    console.error('[createNewProject] KEIN USER - Abbrechen');
    return;
  }

  try {
    const planFromProfile = userProfile?.plan || 'free';
    const initialFields = getCurrentFieldValues();
    
    const projectsRef = collection(db, 'projects');
    const newProjectRef = await addDoc(projectsRef, {
      ownerId: user.uid,
      name: 'Neues Projekt',
      plan: planFromProfile,
      status: 'active',
      fields: initialFields,
      results: {},
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    
    console.log('[createNewProject] Neues Projekt erstellt:', newProjectRef.id);
    
    // Erstelle Mitgliedschaft
    await setDoc(doc(db, 'projects', newProjectRef.id, 'members', user.uid), {
      role: 'owner',
      email: user.email ?? '',
      displayName: user.displayName ?? '',
      addedAt: serverTimestamp(),
    }, { merge: true });
    
    // Füge zum userProjects Array hinzu
    userProjects.unshift({
      id: newProjectRef.id,
      name: 'Neues Projekt',
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    
    // Lade das Projekt
    await loadProject(newProjectRef.id);
    
  } catch (error) {
    console.error('[createNewProject] Fehler:', error);
    showToast("Fehler beim Erstellen: " + error.message, "error");
  }
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
    const planFromProfile = userProfile?.plan || 'free';
    await setDoc(projectDocRef, {
      ownerId: currentUser.uid,
      name: 'Neues Projekt',
      plan: planFromProfile,
      status: 'active',
      fields: getCurrentFieldValues(),
      results: {},
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

  // Lade gespeicherte Ergebnisse (KI-Analysen) und zeige sie an
  await loadProjectResults(data.results || {});

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

// Lade gespeicherte KI-Ergebnisse aus dem Projekt-Dokument
async function loadProjectResults(results) {
  console.log('[loadProjectResults] Lade Ergebnisse:', Object.keys(results || {}));
  
  // Mapping von Section-Namen zu HTML-Container-IDs
  const sectionMap = {
    'hypothese': 'response-hypothese',
    'persona': 'response-persona',
    'mvp': 'response-mvp',
    'validierung': 'response-validierung'
  };

  // Iteriere durch alle Sections
  for (const [section, containerId] of Object.entries(sectionMap)) {
    const resultHtml = results[section];
    if (resultHtml && typeof resultHtml === 'string') {
      const container = document.getElementById(containerId);
      if (container) {
        container.innerHTML = resultHtml;
        container.classList.remove('hidden');
        
        // Stelle sicher, dass prose-invert Klasse vorhanden ist
        if (!container.classList.contains('prose-invert')) {
          container.classList.add('prose', 'prose-invert');
        }
        
        // Zeige Pivot-Button für Hypothese-Sektion, wenn Ergebnis vorhanden
        if (section === 'hypothese') {
          const btnPivot = document.getElementById('btn-pivot');
          if (btnPivot) {
            btnPivot.classList.remove('hidden');
          }
        }
        
        console.log(`[loadProjectResults] Ergebnis für ${section} geladen`);
      }
    }
  }
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
  
  const saveStatus = document.getElementById('save-status');
  
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
    
    // Erstelle debounced Save-Funktion für dieses Feld (1000ms Delay)
    const debouncedSave = debounce(async () => {
      if (isApplyingRemoteData) {
        console.log(`[bindFieldListeners] Ignoriere Save für "${id}" - Remote-Daten werden angewendet`);
        return;
      }

      if (currentUser && projectDocRef && activeProjectId) {
        console.log(`[bindFieldListeners] Speichere Feld "${id}" in Firestore`);
        pendingRemoteUpdates[id] = element.value;
        
        // Führe updateDoc aus
        try {
          const updates = {};
          updates[`fields.${id}`] = element.value;
          await updateDoc(projectDocRef, {
            ...updates,
            updatedAt: serverTimestamp(),
            lastEditor: currentUser.uid,
          });
          
          // Erfolg: Zeige "Gespeichert"
          if (saveStatus) {
            saveStatus.textContent = '✓ Gespeichert';
            saveStatus.style.color = '#10b981'; // Grün
            saveStatus.style.opacity = '1';
            // Nach 2 Sekunden opacity auf 0 setzen
            setTimeout(() => {
              if (saveStatus) {
                saveStatus.style.opacity = '0';
              }
            }, 2000);
          }
        } catch (error) {
          console.error(`[bindFieldListeners] Fehler beim Speichern von "${id}":`, error);
          if (saveStatus) {
            saveStatus.textContent = 'Fehler';
            saveStatus.style.color = 'red';
          }
        }
      } else {
        console.log(`[bindFieldListeners] Speichere Feld "${id}" lokal (kein User/Project)`);
        throttledLocalSave();
      }
    }, 1000);
    
    element.addEventListener('input', () => {
      console.log(`[bindFieldListeners] Input Event für "${id}"`, element.value.substring(0, 50));
      autosize(element);
      
      if (isApplyingRemoteData) {
        console.log(`[bindFieldListeners] Ignoriere Input für "${id}" - Remote-Daten werden angewendet`);
        return;
      }

      // SOFORT: UI Feedback zeigen
      if (saveStatus) {
        saveStatus.textContent = '✍️ Tippt...';
        saveStatus.style.color = '#eab308'; // Gelb/Orange
        saveStatus.style.opacity = '1';
      }
      
      // Rufe debounced Funktion auf
      debouncedSave();
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

// Sammle Analyse-Daten aus dem aktuellen Projekt-Dokument
async function getAnalysisData() {
  if (!activeProjectId || !projectDocRef) {
    return {};
  }
  
  try {
    const projectSnap = await getDoc(projectDocRef);
    if (projectSnap.exists()) {
      const data = projectSnap.data();
      return data.results || {};
    }
  } catch (error) {
    console.error('[getAnalysisData] Fehler:', error);
  }
  
  return {};
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

// Toast-Utility für Benachrichtigungen
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  const isError = type === 'error';
  const isWarning = type === 'warning';
  
  const bgColor = isError ? 'bg-red-600/95' : isWarning ? 'bg-yellow-600/95' : 'bg-emerald-600/95';
  const icon = isError ? '❌' : isWarning ? '⚠️' : '✓';
  
  // Toast unten rechts, sicher im Bild, mit extrem hohem Z-Index
  toast.className = `fixed bottom-6 right-6 z-[9999] ${bgColor} text-white border border-white/20 backdrop-blur-sm px-6 py-4 rounded-lg shadow-2xl flex items-center gap-3 transform translate-x-[500px] transition-transform duration-300 max-w-sm`;
  toast.innerHTML = `
    <span class="text-2xl">${icon}</span>
    <span class="font-medium text-white">${message}</span>
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

// Markdown zu HTML Konverter
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

// ===================================================================
// === 6. AI ENGINE (Das Gehirn) - Fortsetzung ===
// ===================================================================

async function analyzeSection(sectionName) {
  console.log('[analyzeSection] Start für Sektion:', sectionName);
  console.log('[analyzeSection] currentUserPlan:', currentUserPlan);
  
  // VARIABLE HOISTING: Definiere alle benötigten Variablen ganz oben
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

  // Definiere btn, spinner, responseDiv GANZ OBEN
  const btn = document.getElementById(config.buttonId);
  const spinner = document.getElementById(config.spinnerId);
  const responseDiv = document.getElementById(config.responseId);

  if (!btn || !spinner || !responseDiv) {
    console.error('Elemente nicht gefunden für Sektion:', sectionName);
    return;
  }

  // CHAOS MODE SCHUTZ: Prüfe ganz am Anfang
  if (typeof isChaosMode !== 'undefined' && isChaosMode) {
    console.warn('[analyzeSection] Chaos Mode aktiv, simuliere Analyse');
    showToast('🤖 Analyse simuliert (Chaos Mode)', 'warning');
    
    // Simuliere Antwort nach 500ms
    await new Promise(r => setTimeout(r, 500));
    responseDiv.innerHTML = '<p class="text-gray-400">Simulierte Analyse im Chaos-Modus.</p>';
    responseDiv.classList.remove('hidden');
    return;
  }
  
  // SCHRITT 1: INPUT-VALIDIERUNG (BEVOR irgendwas passiert)
  // Sammle Feldwerte
  const fieldValues = config.fields.map(fieldId => {
    const element = document.getElementById(fieldId);
    return element ? element.value.trim() : '';
  }).filter(val => val.length > 0);

  if (fieldValues.length === 0) {
    showToast('Bitte fülle die Felder erst aus!', 'warning');
    return;
  }

  // Kombiniere alle Feldwerte für Validierung
  const combinedText = fieldValues.join('\n\n');
  
  // Client-Side Validierung (kostenlos, vor API-Call)
  if (!isInputValid(combinedText)) {
    showToast('Bitte gib eine ernsthafte Beschreibung ein (min. 10 Wörter, kein Spam).', 'warning');
    
    // UI Feedback: Rote Rahmen für betroffene Felder
    config.fields.forEach(fieldId => {
      const element = document.getElementById(fieldId);
      if (element) {
        element.classList.add('border-red-500');
        element.classList.add('animate-pulse');
        setTimeout(() => {
          element.classList.remove('border-red-500');
          element.classList.remove('animate-pulse');
        }, 2000);
      }
    });
    
    return; // KEIN API Call, KEIN Modal, KEIN Credit-Abzug
  }
  
  // SCHRITT 2: LIMIT-CHECK (Nur für Free User)
  if (currentUserPlan === 'free') {
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
      
      // ROBUSTE LIMIT-PRÜFUNG: Wenn lastAnalysisAt fehlt/undefined -> ERLAUBEN (Neuer User!)
      if (!lastAnalysisAt || lastAnalysisAt === null || lastAnalysisAt === undefined) {
        console.log('[analyzeSection] Limit Check: lastAnalysisAt fehlt -> ERLAUBEN (Neuer User)');
        // Neuer User: Limit verfügbar -> Zeige Bestätigungs-Modal
        console.log('[analyzeSection] Limit verfügbar, zeige Bestätigungs-Modal');
      } else {
        // lastAnalysisAt existiert -> Berechne Differenz
        const lastAnalysisDate = lastAnalysisAt.toDate();
        const now = new Date();
        const daysDiff = Math.floor((now - lastAnalysisDate) / (1000 * 60 * 60 * 24));
        
        console.log('[analyzeSection] Limit Check: lastAnalysisAt:', lastAnalysisAt, 'Days Diff:', daysDiff);
        
        if (daysDiff < 30) {
          // Limit erreicht (< 30 Tage) -> Zeige Upgrade Modal
          console.log('[analyzeSection] Limit erreicht (vor', daysDiff, 'Tagen), zeige Upgrade Modal');
          openUpgradeModal();
          return;
        } else {
          // Limit nicht erreicht (> 30 Tage) -> Erlauben
          console.log('[analyzeSection] Limit verfügbar (vor', daysDiff, 'Tagen), zeige Bestätigungs-Modal');
        }
      }
      
      // Limit verfügbar -> Zeige Bestätigungs-Modal
      const confirmModal = document.getElementById('confirm-limit-modal');
      if (confirmModal) {
        confirmModal.classList.remove('hidden');
        confirmModal.classList.add('flex');
      }
      
      // Warte auf User-Bestätigung mit Promise-Pattern
      const confirmed = await new Promise((resolve) => {
        window.analysisResolver = resolve;
      });
      
      // Modal schließen
      if (confirmModal) {
        confirmModal.classList.add('hidden');
        confirmModal.classList.remove('flex');
      }
      
      window.analysisResolver = null;
      
      if (!confirmed) {
        console.log('[analyzeSection] Analyse vom User abgebrochen');
        return;
      }
      
      console.log('[analyzeSection] Analyse vom User bestätigt, starte API-Call');
    } catch (error) {
      console.error('[analyzeSection] Fehler beim Prüfen des Limits:', error);
      showToast('Fehler beim Prüfen des Limits. Bitte versuche es erneut.', 'error');
      return;
    }
  } else if (currentUserPlan === 'pro') {
    // Pro-User: Alles erlaubt, direkt weiter
    console.log('[analyzeSection] Pro-User, führe Analyse direkt aus');
  } else {
    // Unbekannter Plan -> Blockiere
    console.warn('[analyzeSection] Unbekannter Plan, blockiere Analyse');
    openUpgradeModal();
    return;
  }
  
  // SCHRITT 3: API CALL & CREDIT-ABZUG (Transaktion)
  // UI: Loading-State setzen
  btn.disabled = true;
  spinner.classList.remove('hidden');
  responseDiv.classList.add('hidden');

  try {
    // Erstelle den vollständigen Prompt
    const content = fieldValues.join('\n\n');
    const fullPrompt = `${config.prompt}\n\n${content}`;

    // API-Aufruf über zentrale Funktion
    const result = await callGeminiAPI(fullPrompt, 0, false);
    const aiResponse = result.text || result; // Backward compatibility

    // NUR WENN ERFOLGREICH: Zeige Ergebnis an
    const htmlResponse = markdownToHtml(aiResponse);
    responseDiv.innerHTML = htmlResponse;
    responseDiv.classList.remove('hidden');
    // Stelle sicher, dass prose-invert Klasse vorhanden ist
    if (!responseDiv.classList.contains('prose-invert')) {
      responseDiv.classList.add('prose', 'prose-invert');
    }

    // NUR WENN ERFOLGREICH: Speichere in History UND im Projekt-Dokument
    if (currentUser && activeProjectId) {
      try {
        await saveAnalysis(sectionName, content, aiResponse);
        
        // Speichere Ergebnis auch im Projekt-Dokument für sofortiges Laden nach Reload
        const projectRef = doc(db, 'projects', activeProjectId);
        await updateDoc(projectRef, {
          [`results.${sectionName}`]: htmlResponse,
          updatedAt: serverTimestamp()
        });
        console.log(`[analyzeSection] Ergebnis in results.${sectionName} gespeichert`);
        
        showAnalysisSavedFeedback(btn);
        showSavedFeedback('Analyse gespeichert');
        
        // GA4 Event: Analyse erfolgreich durchgeführt
        trackEvent('analysis_run', sectionName);
      } catch (saveError) {
        console.error('Fehler beim Speichern der Analyse:', saveError);
        // Nicht kritisch - zeige Fehler nur in Console, nicht im UI
      }
    }

    // NUR WENN ERFOLGREICH: Update lastAnalysisAt (Verbrauche Credit)
    if (currentUserPlan === 'free' && currentUser && activeProjectId) {
      try {
        const projectRef = doc(db, 'projects', activeProjectId);
        await updateDoc(projectRef, {
          lastAnalysisAt: serverTimestamp()
        });
        console.log('[analyzeSection] lastAnalysisAt gesetzt für Free-User (Credit verbraucht)');
      } catch (error) {
        console.error('[analyzeSection] Fehler beim Setzen von lastAnalysisAt:', error);
        // Nicht kritisch, Log nur
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
    // WENN FEHLER: Kein Credit-Abzug!
    console.error('Fehler bei der Analyse:', error);
    showToast(`Fehler: ${error.message}`, 'error');
    responseDiv.innerHTML = `<p class="text-red-400">Fehler: ${error.message}</p>`;
    responseDiv.classList.remove('hidden');
    // WICHTIG: lastAnalysisAt wird NICHT gesetzt - User behält seinen Versuch
    console.log('[analyzeSection] Analyse fehlgeschlagen - Credit NICHT abgezogen');
  } finally {
    // UI: Loading-State zurücksetzen
    btn.disabled = false;
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

/**
 * Rendert das Venture Radar Chart mit Chart.js
 * @param {object} scoreData - Score-Daten mit breakdown
 */
function renderRadarChart(scoreData) {
  // Zerstöre alte Chart-Instanz, falls vorhanden
  if (window.myRadar) {
    window.myRadar.destroy();
    window.myRadar = null;
  }

  const canvas = document.getElementById('ventureRadarChart');
  const container = document.getElementById('venture-radar-container');
  
  if (!canvas || !container) {
    console.warn('[renderRadarChart] Canvas oder Container nicht gefunden');
    return;
  }

  // Zeige Container
  container.classList.remove('hidden');

  const breakdown = scoreData.breakdown || {};
  
  // Berechne Finanz-Score (nutze feasibility als Fallback, falls nicht separat vorhanden)
  const financeScore = breakdown.finance || breakdown.feasibility || 0;
  
  // Daten für Radar-Chart
  const data = {
    labels: ['Markt', 'Innovation', 'Umsetzung', 'Finanzen'],
    datasets: [{
      label: 'VC Readiness',
      data: [
        Math.round(breakdown.market || 0),
        Math.round(breakdown.innovation || 0),
        Math.round(breakdown.feasibility || 0),
        Math.round(financeScore)
      ],
      backgroundColor: 'rgba(99, 102, 241, 0.2)', // Indigo mit Transparenz
      borderColor: 'rgba(99, 102, 241, 1)', // Indigo fest
      borderWidth: 2,
      pointBackgroundColor: 'rgba(99, 102, 241, 1)',
      pointBorderColor: '#fff',
      pointHoverBackgroundColor: '#fff',
      pointHoverBorderColor: 'rgba(99, 102, 241, 1)'
    }]
  };

  // Chart.js Konfiguration
  const config = {
    type: 'radar',
    data: data,
    options: {
      responsive: true,
      maintainAspectRatio: true,
      scales: {
        r: {
          beginAtZero: true,
          max: 100,
          min: 0,
          ticks: {
            stepSize: 20,
            color: 'rgba(156, 163, 175, 0.8)', // Gray-400
            font: {
              size: 11
            }
          },
          grid: {
            color: 'rgba(156, 163, 175, 0.2)' // Gray-400 mit Transparenz
          },
          pointLabels: {
            color: 'rgba(229, 231, 235, 1)', // Gray-200
            font: {
              size: 13,
              weight: '500'
            }
          }
        }
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: 'rgba(17, 24, 39, 0.9)', // Gray-900
          titleColor: 'rgba(229, 231, 235, 1)', // Gray-200
          bodyColor: 'rgba(229, 231, 235, 1)',
          borderColor: 'rgba(99, 102, 241, 0.5)',
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: function(context) {
              return context.label + ': ' + context.parsed.r + '/100';
            }
          }
        }
      }
    }
  };

  // Erstelle Chart
  try {
    window.myRadar = new Chart(canvas, config);
  } catch (error) {
    console.error('[renderRadarChart] Fehler beim Erstellen des Charts:', error);
    container.classList.add('hidden');
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

  // Rendere Radar Chart
  renderRadarChart(scoreData);

  // Animation
  setTimeout(() => {
    scoreCircle.style.transform = 'scale(1.05)';
    setTimeout(() => {
      scoreCircle.style.transform = 'scale(1)';
    }, 200);
  }, 100);
}

/**
 * Magic Dice: Generiert eine zufällige Startup-Idee und füllt die Felder aus
 */
function generateRandomIdea() {
  if (!DEMO_IDEAS || DEMO_IDEAS.length === 0) {
    showToast('Keine Demo-Ideen verfügbar', 'warning');
    return;
  }

  // Wähle zufällige Idee
  const randomIndex = Math.floor(Math.random() * DEMO_IDEAS.length);
  const idea = DEMO_IDEAS[randomIndex];

  // Hole Input-Felder
  const problemInput = document.getElementById('problem');
  const solutionInput = document.getElementById('solution');
  const pitchInput = document.getElementById('pitch');

  if (!problemInput || !solutionInput || !pitchInput) {
    console.error('[generateRandomIdea] Input-Felder nicht gefunden');
    return;
  }

  // Fülle Felder aus
  problemInput.value = idea.problem;
  solutionInput.value = idea.solution;
  pitchInput.value = idea.pitch;

  // Autosize und Trigger Auto-Save
  [problemInput, solutionInput, pitchInput].forEach(field => {
    // Autosize anpassen
    if (typeof autosize === 'function') {
      autosize(field);
    }
    
    // Input-Event simulieren für Auto-Save
    const inputEvent = new Event('input', { bubbles: true });
    field.dispatchEvent(inputEvent);
  });

  // Zeige Feedback
  showToast('🎲 Zufällige Idee geladen!', 'success');
  
  // Optional: Scroll zu den Feldern für bessere UX
  setTimeout(() => {
    problemInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

  // Event-Listener für Magic Dice Button
  const magicDiceButton = document.getElementById('btn-magic-dice');
  if (magicDiceButton) {
    magicDiceButton.addEventListener('click', generateRandomIdea);
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

// ===================================================================
// === 5. CORE LOGIK (Wizard & Daten) ===
// ===================================================================

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
  // Desktop Stepper
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

  // Mobile Progress Indicator
  const mobileStepText = document.getElementById('mobile-step-text');
  const mobileProgressBar = document.getElementById('mobile-progress-bar');
  
  if (mobileStepText && mobileProgressBar) {
    const stepNames = ['Hypothese', 'Persona', 'MVP', 'Validierung', 'Ressourcen', 'Team'];
    const stepName = stepNames[stepNumber - 1] || 'Unbekannt';
    mobileStepText.textContent = `Schritt ${stepNumber}/6: ${stepName}`;
    
    // Update Progress Bar
    mobileProgressBar.value = stepNumber;
    mobileProgressBar.max = 6;
    
    // Fallback für Browser ohne native Progress-Bar (nutze innere div für visuelles Feedback)
    let progressFill = mobileProgressBar.querySelector('div');
    if (!progressFill) {
      progressFill = document.createElement('div');
      progressFill.className = 'h-full bg-blue-500 rounded-full transition-all duration-300';
      mobileProgressBar.appendChild(progressFill);
    }
    const progressValue = (stepNumber / 6) * 100;
    progressFill.style.width = `${progressValue}%`;
  }
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
// Setup Projekt-Gate-Modal
function setupProjectGateModal() {
  const btnCreateProject = document.getElementById('btn-create-project-ui');
  const btnConfirmCreate = document.getElementById('btn-confirm-create');
  const btnCancelCreate = document.getElementById('btn-cancel-create');
  const createForm = document.getElementById('project-create-form');
  const createSection = document.getElementById('project-create-section');
  const nameInput = document.getElementById('new-project-name');

  // Zeige Create-Form
  if (btnCreateProject) {
    btnCreateProject.addEventListener('click', () => {
      if (createForm) createForm.classList.remove('hidden');
      if (createSection) createSection.classList.add('hidden');
      if (nameInput) {
        nameInput.focus();
        nameInput.value = '';
      }
    });
  }

  // Bestätige Erstellung
  if (btnConfirmCreate) {
    btnConfirmCreate.addEventListener('click', async () => {
      const name = nameInput?.value?.trim();
      if (!name) {
        showToast("Bitte gib einen Projektnamen ein", "warning");
        return;
      }
      await createNewProjectUI(name);
    });
    
    // Enter-Taste im Input-Feld
    if (nameInput) {
      nameInput.addEventListener('keypress', async (e) => {
        if (e.key === 'Enter') {
          const name = nameInput.value.trim();
          if (name) {
            await createNewProjectUI(name);
          }
        }
      });
    }
  }

  // Abbrechen
  if (btnCancelCreate) {
    btnCancelCreate.addEventListener('click', () => {
      if (createForm) createForm.classList.add('hidden');
      if (createSection) createSection.classList.remove('hidden');
      if (nameInput) nameInput.value = '';
    });
  }

  // PDF Import Button
  const btnImportPdf = document.getElementById('btn-import-pdf');
  const pdfUpload = document.getElementById('pdf-upload');
  
  if (btnImportPdf && pdfUpload) {
    btnImportPdf.addEventListener('click', () => {
      pdfUpload.click();
    });
    
    pdfUpload.addEventListener('change', (event) => {
      handlePDFImport(event);
    });
  }

  // Schließen-Button für Projekt-Gate-Modal
  const btnCloseProjectGate = document.getElementById('btn-close-project-gate');
  if (btnCloseProjectGate) {
    btnCloseProjectGate.addEventListener('click', () => {
      closeProjectGateModal();
    });
  }
}

function setupHistoryPanel() {
  const historyButton = document.getElementById('history-button');
  const historyButtonAuthed = document.getElementById('history-button-authed');
  const historyClose = document.getElementById('history-close');
  const historyPanel = document.getElementById('history-panel');

  // Öffne Projekt-Gate-Modal statt History-Panel
  const openProjectGate = async () => {
    // Lade Projekte neu (falls nötig)
    const user = currentUser || auth?.currentUser;
    if (user) {
      try {
        const projectsRef = collection(db, 'projects');
        
        // Versuche zuerst mit orderBy (benötigt Index)
        let snapshot;
        try {
          const q = query(
            projectsRef,
            where('ownerId', '==', user.uid),
            orderBy('updatedAt', 'desc')
          );
          snapshot = await getDocs(q);
        } catch (indexError) {
          // Fallback: Lade alle Projekte ohne orderBy und sortiere im Client
          console.warn('[setupHistoryPanel] Index-Fehler, verwende Fallback:', indexError.message);
          const q = query(
            projectsRef,
            where('ownerId', '==', user.uid)
          );
          snapshot = await getDocs(q);
        }
        
        userProjects = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
        
        // Sortiere im Client nach updatedAt (falls kein Index vorhanden)
        userProjects.sort((a, b) => {
          const aTime = a.updatedAt?.toMillis?.() || a.updatedAt?._seconds * 1000 || 0;
          const bTime = b.updatedAt?.toMillis?.() || b.updatedAt?._seconds * 1000 || 0;
          return bTime - aTime; // Neueste zuerst
        });
      } catch (error) {
        console.error('[setupHistoryPanel] Fehler beim Laden der Projekte:', error);
      }
    }
    
    // Öffne Projekt-Gate-Modal
    await openProjectGateModal();
  };

  // Alte History-Panel-Funktion (für Fallback oder wenn History-Panel noch verwendet wird)
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

  // Verbinde Button mit Projekt-Gate-Modal
  if (historyButton) {
    historyButton.addEventListener('click', openProjectGate);
  }
  if (historyButtonAuthed) {
    historyButtonAuthed.addEventListener('click', openProjectGate);
  }
  // Close-Button für History-Panel (falls noch verwendet)
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

  historyContent.innerHTML = '<p class="text-gray-400 text-center">Lade Projekte...</p>';

  try {
    // Lade alle Projekte des Users
    const projectsRef = collection(db, 'projects');
    const q = query(
      projectsRef,
      where('ownerId', '==', user.uid),
      orderBy('updatedAt', 'desc')
    );
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      historyContent.innerHTML = '<p class="text-gray-400 text-center">Noch keine Projekte vorhanden.</p>';
      return;
    }

    const projects = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    historyContent.innerHTML = projects.map(project => {
      const createdAt = project.createdAt?.toDate ? project.createdAt.toDate().toLocaleDateString('de-DE') : 'Unbekannt';
      const isActive = project.id === activeProjectId;
      const statusBadge = project.status === 'completed' 
        ? '<span class="bg-green-500/20 text-green-400 px-2 py-1 rounded-full text-xs">Abgeschlossen</span>'
        : isActive
        ? '<span class="bg-blue-500/20 text-blue-400 px-2 py-1 rounded-full text-xs">Aktiv</span>'
        : '<span class="bg-gray-500/20 text-gray-400 px-2 py-1 rounded-full text-xs">Offen</span>';
      
      return `
        <div class="glass-panel p-4 ${isActive ? 'border-2 border-blue-500' : ''}">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-lg font-bold text-white">${escapeHtml(project.name || 'Unbenanntes Projekt')}</h3>
            ${statusBadge}
          </div>
          <div class="flex items-center justify-between text-sm text-gray-400 mb-3">
            <span>Erstellt: ${createdAt}</span>
          </div>
          <button 
            onclick="switchProject('${project.id}')" 
            class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors ${isActive ? 'opacity-50 cursor-not-allowed' : ''}"
            ${isActive ? 'disabled' : ''}
          >
            ${isActive ? 'Aktuelles Projekt' : 'Projekt laden'}
          </button>
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error('Fehler beim Laden der Projekte:', error);
    historyContent.innerHTML = '<p class="text-red-400 text-center">Fehler beim Laden der Projekte.</p>';
  }
}

// Wechsle zu einem anderen Projekt
async function switchProject(projectId) {
  console.log('[switchProject] Wechsle zu Projekt:', projectId);
  
  if (!currentUser) {
    showToast("Nicht eingeloggt!", "error");
    return;
  }

  try {
    // Schließe History-Panel
    const historyPanel = document.getElementById('history-panel');
    if (historyPanel) {
      historyPanel.classList.add('translate-x-full');
      setTimeout(() => {
        historyPanel.classList.add('hidden');
      }, 300);
    }

    // Lade das Projekt
    await setActiveProject(projectId);
    showToast("Projekt geladen!", "success");
  } catch (error) {
    console.error('[switchProject] Fehler:', error);
    showToast("Fehler beim Laden des Projekts: " + error.message, "error");
  }
}

// Mache switchProject global verfügbar
window.switchProject = switchProject;

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

// ===================================================================
// === 7. FEATURES & UTILS (Werkzeuge) ===
// ===================================================================

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
    const projectName = getText('activeProjectName') || activeProjectName || 'Startup-Projekt';
    const date = new Date().toLocaleDateString('de-DE', { 
      day: 'numeric', 
      month: 'long', 
      year: 'numeric' 
    });
    
    // Score-Daten extrahieren
    const finalScore = getText('score-value') || '-';
    const finalVerdict = getText('score-verdict')?.replace(/"/g, '') || 'Noch nicht berechnet';
    const marketScore = getText('score-market-value') || document.getElementById('score-market-bar')?.style.width || '0%';
    const innovationScore = getText('score-innovation-value') || document.getElementById('score-innovation-bar')?.style.width || '0%';
    const executionScore = getText('score-feasibility-value') || document.getElementById('score-feasibility-bar')?.style.width || '0%';
    
    // Extrahiere Zahlen aus Score-Strings (z.B. "45/100" -> 45)
    const extractScoreNumber = (scoreStr) => {
      if (!scoreStr || scoreStr === '-') return null;
      const match = scoreStr.match(/(\d+)/);
      return match ? parseInt(match[1]) : null;
    };
    
    const scoreNum = extractScoreNumber(finalScore);
    const marketNum = extractScoreNumber(marketScore);
    const innovationNum = extractScoreNumber(innovationScore);
    const executionNum = extractScoreNumber(executionScore);

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
      <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1f2937; line-height: 1.6;">
        
        <!-- HEADER -->
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #2563eb; padding-bottom: 20px; margin-bottom: 40px;">
            <div>
                <h1 style="font-size: 28px; font-weight: 900; color: #111827; margin: 0; letter-spacing: -0.5px;">VENTURE REPORT</h1>
                <p style="margin: 5px 0 0; color: #6b7280; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Algorithmic Due Diligence</p>
            </div>
            <div style="text-align: right;">
                <div style="font-size: 18px; font-weight: bold; color: #2563eb;">${escapeHtml(projectName)}</div>
                <div style="font-size: 12px; color: #9ca3af;">${date}</div>
            </div>
        </div>

        <!-- SCORE CARD (Das Highlight) -->
        ${scoreNum !== null ? `
        <div style="background: linear-gradient(135deg, #f3f4f6 0%, #e5e7eb 100%); border-radius: 12px; padding: 25px; margin-bottom: 40px; border: 2px solid #2563eb;">
            <div style="display: flex; align-items: center; gap: 30px;">
                <div style="text-align: center; min-width: 120px;">
                    <div style="font-size: 48px; font-weight: 900; color: ${scoreNum >= 80 ? '#059669' : scoreNum >= 50 ? '#d97706' : '#dc2626'}; line-height: 1;">
                        ${scoreNum}
                    </div>
                    <div style="font-size: 12px; color: #6b7280; margin-top: 5px; text-transform: uppercase; letter-spacing: 1px;">VC Score</div>
                </div>
                <div style="flex: 1;">
                    <div style="font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 0.5px;">Verdict</div>
                    <div style="font-size: 16px; color: #111827; font-style: italic; line-height: 1.5;">"${escapeHtml(finalVerdict)}"</div>
                    ${marketNum !== null || innovationNum !== null || executionNum !== null ? `
                    <div style="margin-top: 20px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px;">
                        ${marketNum !== null ? `
                        <div style="text-align: center;">
                            <div style="font-size: 24px; font-weight: bold; color: #2563eb;">${marketNum}</div>
                            <div style="font-size: 10px; color: #6b7280; text-transform: uppercase; margin-top: 3px;">Markt</div>
                        </div>
                        ` : ''}
                        ${innovationNum !== null ? `
                        <div style="text-align: center;">
                            <div style="font-size: 24px; font-weight: bold; color: #9333ea;">${innovationNum}</div>
                            <div style="font-size: 10px; color: #6b7280; text-transform: uppercase; margin-top: 3px;">Innovation</div>
                        </div>
                        ` : ''}
                        ${executionNum !== null ? `
                        <div style="text-align: center;">
                            <div style="font-size: 24px; font-weight: bold; color: #dc2626;">${executionNum}</div>
                            <div style="font-size: 10px; color: #6b7280; text-transform: uppercase; margin-top: 3px;">Umsetzung</div>
                        </div>
                        ` : ''}
                    </div>
                    ` : ''}
                </div>
            </div>
        </div>
        ` : ''}

      <!-- EXECUTIVE SUMMARY -->
      <div style="margin-bottom: 35px; page-break-inside: avoid;">
        <h2 style="font-size: 18px; color: #2563eb; text-transform: uppercase; letter-spacing: 1.5px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 20px; font-weight: 700;">
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
      <div style="margin-bottom: 35px; page-break-inside: avoid;">
        <h2 style="font-size: 18px; color: #2563eb; text-transform: uppercase; letter-spacing: 1.5px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 20px; font-weight: 700;">
          2. Zielgruppe & Psychologie
        </h2>
        <p style="margin-top: 10px; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(getVal('persona_full'))}</p>
      </div>

      <!-- STRATEGY & MVP -->
      <div style="margin-bottom: 35px; page-break-inside: avoid;">
        <h2 style="font-size: 18px; color: #2563eb; text-transform: uppercase; letter-spacing: 1.5px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 20px; font-weight: 700;">
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
      <div style="margin-bottom: 35px; page-break-inside: avoid;">
        <h2 style="font-size: 18px; color: #2563eb; text-transform: uppercase; letter-spacing: 1.5px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 20px; font-weight: 700;">
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
      <div style="margin-bottom: 35px; page-break-inside: avoid;">
        <h2 style="font-size: 18px; color: #2563eb; text-transform: uppercase; letter-spacing: 1.5px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 20px; font-weight: 700;">
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
      <div style="margin-bottom: 35px; page-break-inside: avoid;">
        <h2 style="font-size: 18px; color: #2563eb; text-transform: uppercase; letter-spacing: 1.5px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 20px; font-weight: 700;">
          6. Risiko-Analyse (AI Vetted)
        </h2>
        <div style="background: #f8fafc; border-left: 4px solid #2563eb; padding: 20px; margin-top: 10px; font-size: 12px; border-radius: 4px;">
          ${getHTML('response-hypothese')}
        </div>
      </div>

      <!-- FOOTER -->
      <div style="margin-top: 50px; border-top: 2px solid #e5e7eb; padding-top: 20px; text-align: center; color: #9ca3af; font-size: 10px;">
        <p style="margin: 0;">Erstellt mit VentureValidator | ${date}</p>
      </div>
      </div>
    `;

    // 6. Sammle Backup-Daten (Fields + Analysis Results)
    const fields = getCurrentFieldValues();
    const analysis = await getAnalysisData();
    const backupData = {
      version: '1.2',
      date: Date.now(),
      fields: fields,
      analysis: analysis
    };
    const payload = "###VENTURE_DATA_START###" + JSON.stringify(backupData) + "###VENTURE_DATA_END###";

    // 7. Füge Ghost-Element zum Body hinzu
    document.body.appendChild(ghostElement);

    // 8. Warte kurz, damit Layout gerendert wird
    await new Promise(resolve => setTimeout(resolve, 200));

    // 9. Verwende html2pdf um PDF zu generieren und Daten einzufügen
    const opt = {
      margin: 0,
      filename: `${projectName || 'VentureReport'}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    // html2pdf mit Daten-Einbettung
    await html2pdf().from(ghostElement).set(opt).toPdf().get('pdf').then((pdf) => {
      // Füge Backup-Daten als versteckten Text ein (weiß auf weiß, sehr klein)
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(1);
      pdf.text(payload, 10, 10); // Versteckt oben links
    }).save();

    // 10. Button wieder aktivieren
    btn.disabled = false;
    btnText.textContent = '📄 Als Investment Memo exportieren (PDF)';
    if (btnSpinner) btnSpinner.classList.add('hidden');

    // Erfolg-Feedback
    showToast('PDF erfolgreich erstellt mit Backup-Daten!', 'success');
    
    // GA4 Event: PDF erfolgreich exportiert
    trackEvent('pdf_download', 'investment_memo');
    
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
// PDF IMPORT FUNCTION (Restore from PDF)
// ============================================

async function handlePDFImport(event) {
  const file = event.target.files[0];
  if (!file) {
    return;
  }

  // Prüfe, ob es eine PDF-Datei ist
  if (file.type !== 'application/pdf' && !file.name.endsWith('.pdf')) {
    showToast("Bitte wähle eine PDF-Datei aus", "error");
    return;
  }

  if (!currentUser) {
    showToast("Nicht eingeloggt!", "error");
    return;
  }

  try {
    showToast("PDF wird gelesen...", "info");

    // Lese PDF mit PDF.js
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdfDocument = await loadingTask.promise;

    // Lese Text von Seite 1
    const page = await pdfDocument.getPage(1);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(' ');

    // Suche nach Backup-Daten
    const startMarker = "###VENTURE_DATA_START###";
    const endMarker = "###VENTURE_DATA_END###";
    const startIndex = pageText.indexOf(startMarker);
    const endIndex = pageText.indexOf(endMarker);

    if (startIndex === -1 || endIndex === -1) {
      showToast("Fehler: Kein VentureValidator-Backup in diesem PDF gefunden.", "error");
      return;
    }

    // Extrahiere JSON-Daten
    const jsonString = pageText.substring(startIndex + startMarker.length, endIndex);
    const backupData = JSON.parse(jsonString);

    console.log('[handlePDFImport] Backup-Daten gefunden:', backupData);

    // Erstelle neues Projekt mit den wiederhergestellten Daten
    const planFromProfile = userProfile?.plan || 'free';
    const projectsRef = collection(db, 'projects');
    const newProjectRef = await addDoc(projectsRef, {
      ownerId: currentUser.uid,
      name: `Wiederhergestellt ${new Date().toLocaleDateString('de-DE')}`,
      plan: planFromProfile,
      status: 'active',
      fields: backupData.fields || {},
      results: backupData.analysis || {},
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    console.log('[handlePDFImport] Projekt wiederhergestellt:', newProjectRef.id);

    // Erstelle Mitgliedschaft
    await setDoc(doc(db, 'projects', newProjectRef.id, 'members', currentUser.uid), {
      role: 'owner',
      email: currentUser.email ?? '',
      displayName: currentUser.displayName ?? '',
      addedAt: serverTimestamp(),
    }, { merge: true });

    // Füge zum userProjects Array hinzu
    userProjects.unshift({
      id: newProjectRef.id,
      name: `Wiederhergestellt ${new Date().toLocaleDateString('de-DE')}`,
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    // Lade das Projekt
    await loadProject(newProjectRef.id);

    showToast("Projekt erfolgreich aus PDF wiederhergestellt!", "success");

    // Reset File Input
    event.target.value = '';

  } catch (error) {
    console.error('[handlePDFImport] Fehler:', error);
    showToast("Fehler beim Import: " + error.message, "error");
    event.target.value = '';
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

  if (!activeProjectId) {
    showToast("Kein aktives Projekt!", "error");
    return;
  }

  const originalText = btn.innerText;
  btn.disabled = true;
  btn.innerHTML = "💾 Speichere...";

  try {
    const docRef = doc(db, 'projects', activeProjectId);
    
    // 2. Daten sammeln (Snapshot der aktuellen Eingaben)
    const currentData = {};
    fieldIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        currentData[id] = el.value;
      }
    });

    // 3. Setze Status auf 'completed' und speichere finale Daten
    await updateDoc(docRef, {
      status: 'completed',
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      fields: currentData
    });

    console.log("[finishProject] Projekt abgeschlossen:", activeProjectId);

    // 4. Setze activeProjectId zurück
    activeProjectId = null;
    localStorage.removeItem('activeProjectId');

    // 5. Erfolg-Feedback
    if (window.confetti) {
      window.confetti({
        particleCount: 150,
        spread: 70,
        origin: { y: 0.6 }
      });
    }
    showToast("Projekt erfolgreich abgeschlossen!", "success");

    // 6. Erstelle neues Projekt und lade es
    setTimeout(async () => {
      await createNewProject(currentUser || auth.currentUser);
      showToast("Neues Projekt erstellt!", "success");
    }, 1000);

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

// ============================================
// QA & CHAOS TESTING
// ============================================

document.getElementById('btn-chaos-test')?.addEventListener('click', startChaosMonkey);

function startChaosMonkey() {
  // Prüfe ob gremlins verfügbar ist
  if (typeof gremlins === 'undefined') {
    showToast("Gremlins.js nicht geladen!", "error");
    console.error("Gremlins.js nicht verfügbar. Stelle sicher, dass die Bibliothek im Head eingebunden ist.");
    return;
  }

  const confirmChaos = confirm("ACHTUNG: Dies startet 1000 zufällige Klicks (Gremlins). Die Seite wird wild flackern. Fortfahren?");
  if (!confirmChaos) return;

  // Aktiviere Chaos-Mode (blockiert API-Calls)
  isChaosMode = true;
  showToast("👾 Gremlins freigelassen! Check die Konsole.", "warning");

  gremlins.createHorde({
    species: [
      gremlins.species.clicker(), // Klickt überall
      gremlins.species.formFiller(), // Füllt Inputs mit Unsinn
      gremlins.species.toucher() // Simuliert Touch
    ],
    mogwais: [
      gremlins.mogwais.alert(), // Verhindert Alerts (nervig)
      gremlins.mogwais.fps(), // Überwacht Performance
      gremlins.mogwais.gizmo() // Stoppt bei Fehlern
    ],
    strategies: [
      gremlins.strategies.distribution({
        delay: 50, // Schnell (50ms pro Aktion)
        nb: 1000   // 1000 Aktionen
      })
    ]
  }).unleash()
  .then(() => {
    isChaosMode = false; // Chaos-Mode deaktivieren
    showToast("✅ Chaos-Test überlebt!", "success");
  })
  .catch((err) => {
    isChaosMode = false; // Chaos-Mode auch bei Fehler deaktivieren
    console.error("CRASH DURCH BOT:", err);
    showToast("❌ App gecrasht! Siehe Konsole.", "error");
    // Hier würde man den Fehler an Sentry senden
    if (window.Sentry) {
      Sentry.captureException(err);
    }
  });
}

// ============================================
// DEBOUNCE HELPER FUNCTION
// ============================================

function debounce(func, timeout = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      func.apply(this, args);
    }, timeout);
  };
}

// ============================================
// INPUT VALIDIERUNG (Client-Side, kostenlos)
// ============================================

function isInputValid(text) {
  if (!text || typeof text !== 'string') {
    return false;
  }
  
  const trimmed = text.trim();
  
  // 1. Zu kurz: Weniger als 10 Wörter
  const words = trimmed.split(/\s+/).filter(word => word.length > 0);
  if (words.length < 10) {
    console.log('[isInputValid] Text zu kurz:', words.length, 'Wörter');
    return false;
  }
  
  // 2. Wiederholungen: Ein Wort wiederholt sich zu oft hintereinander (z.B. "bla bla bla")
  const repetitionPattern = /\b(\w+)\s+\1\s+\1/i;
  if (repetitionPattern.test(trimmed)) {
    console.log('[isInputValid] Zu viele Wiederholungen erkannt');
    return false;
  }
  
  // 3. Tastatur-Gehämmer: Ein Wort ist länger als 30 Zeichen (unwahrscheinlich in normaler Sprache)
  const longWordPattern = /\b\w{31,}\b/;
  if (longWordPattern.test(trimmed)) {
    console.log('[isInputValid] Sehr langes Wort gefunden (>30 Zeichen)');
    return false;
  }
  
  // 4. Zu wenig Vielfalt: Der Text besteht zu >50% aus demselben Zeichen
  const charCounts = {};
  const relevantChars = trimmed.replace(/\s/g, ''); // Ignoriere Leerzeichen
  for (const char of relevantChars) {
    charCounts[char] = (charCounts[char] || 0) + 1;
  }
  
  const maxCount = Math.max(...Object.values(charCounts));
  const maxPercentage = (maxCount / relevantChars.length) * 100;
  
  if (maxPercentage > 50) {
    console.log('[isInputValid] Zu wenig Vielfalt:', maxPercentage.toFixed(1), '% aus einem Zeichen');
    return false;
  }
  
  return true;
}

// ============================================
// ADMIN FUNKTION: User auf Pro upgraden
// ============================================

async function upgradeUserToPro(email) {
  try {
    console.log('[upgradeUserToPro] Suche User mit Email:', email);
    
    // Suche User über Email in der users Collection
    // Da users/{uid} als Struktur, müssen wir alle User durchsuchen
    const usersRef = collection(db, 'users');
    const usersSnapshot = await getDocs(usersRef);
    
    let userUid = null;
    usersSnapshot.forEach((docSnap) => {
      const userData = docSnap.data();
      if (userData.email === email || userData.email?.toLowerCase() === email.toLowerCase()) {
        userUid = docSnap.id; // uid ist die Dokument-ID
        console.log('[upgradeUserToPro] User gefunden:', userUid);
      }
    });
    
    if (!userUid) {
      console.error('[upgradeUserToPro] User nicht gefunden:', email);
      return false;
    }
    
    // Update User-Dokument auf Pro
    const userRef = doc(db, 'users', userUid);
    await updateDoc(userRef, {
      plan: 'pro',
      upgradedAt: serverTimestamp()
    });
    console.log('[upgradeUserToPro] User-Dokument auf Pro upgegraded:', userUid);
    
    // Entferne lastAnalysisAt aus allen Projekten dieses Users (Projekte haben ownerId = uid)
    const projectsRef = collection(db, 'projects');
    const projectsQuery = query(projectsRef, where('ownerId', '==', userUid));
    const projectsSnapshot = await getDocs(projectsQuery);
    
    const projectPromises = [];
    projectsSnapshot.forEach((projectDoc) => {
      const projectRef = doc(db, 'projects', projectDoc.id);
      projectPromises.push(
        updateDoc(projectRef, {
          plan: 'pro',
          lastAnalysisAt: null // Entferne Limit für unbegrenzte Analysen
        })
      );
      console.log('[upgradeUserToPro] Projekt aktualisiert:', projectDoc.id);
    });
    
    await Promise.all(projectPromises);
    
    console.log('[upgradeUserToPro] ERFOLG - User auf Pro upgegraded mit unbegrenzten Analysen:', email);
    return true;
  } catch (error) {
    console.error('[upgradeUserToPro] FEHLER:', error);
    return false;
  }
}

// Einmalig ausführen für rhynxpvp1@gmail.com (beim Seitenladen)
(async () => {
  if (typeof window !== 'undefined') {
    // Führe nach kurzer Verzögerung aus (damit Firebase initialisiert ist)
    setTimeout(async () => {
      await upgradeUserToPro('rhynxpvp1@gmail.com');
    }, 2000);
  }
})();