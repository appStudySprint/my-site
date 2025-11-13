// Persist form values in localStorage

document.addEventListener('DOMContentLoaded', (event) => {
    const fieldIds = [
        'problem', 'solution', 'pitch',
        'persona_name', 'persona_demographics', 'persona_pains', 'persona_gains',
        'mvp_core1', 'mvp_core2', 'mvp_core3', 'mvp_anti_features',
        'validation_method', 'validation_success',
        'resources_stack', 'resources_budget', 'resources_time'
    ];

    const storageKey = 'projektDashboardData';

    const throttledSave = throttle(saveData, 200);
function saveData() {
        const data = {};
        fieldIds.forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                data[id] = element.value;
            }
        });
        localStorage.setItem(storageKey, JSON.stringify(data));
    }

    function loadData() {
        const dataString = localStorage.getItem(storageKey);
        if (dataString) {
            try {
                const data = JSON.parse(dataString);
                fieldIds.forEach(id => {
                    const element = document.getElementById(id);
                    if (element && data[id] !== undefined) {
                        element.value = data[id];
                    }
                });
            } catch (e) {
                console.error('Fehler beim Parsen der localStorage-Daten:', e);
                localStorage.removeItem(storageKey);
            }
        }
    }

    // Initialize
    loadData();
    // Autosize existing values on load
    fieldIds.forEach(id => { const el = document.getElementById(id); if (el && el.tagName === "TEXTAREA") autosize(el); });

    // Save on input
    fieldIds.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('input', (e) => { autosize(element); throttledSave(); });
        }
    });

    // Clear all
    const clearButton = document.getElementById('clearButton');
    if (clearButton) {
        clearButton.addEventListener('click', () => {
            localStorage.removeItem(storageKey);
            location.reload();
        });
    }
});


// UX enhancements: autosize textareas and visual save feedback
function autosize(element) {
  element.style.height = 'auto';
  element.style.height = element.scrollHeight + 'px';
}

function throttle(fn, wait) {
  let last = 0, timer;
  return (...args) => {
    const now = Date.now();
    if (now - last >= wait) { last = now; fn(...args); }
    else {
      clearTimeout(timer);
      timer = setTimeout(() => { last = Date.now(); fn(...args); }, wait - (now - last));
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





