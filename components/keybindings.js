// Desktop keyboard shortcuts.
//
// The web makes the obvious choices (Ctrl+T, Ctrl+1/2, Ctrl+K) unavailable —
// the browser owns them and won't let a page override its accelerators. So the
// scheme here is: one safe modifier combo the browser doesn't bind (Ctrl/Cmd
// +,) plus bare single keys that only fire when focus isn't in a text field,
// the same approach Linear / GitHub / Notion use.
//
//   /  or  s     open search
//   1 / 2        switch the Available / Campus tabs
//   Ctrl/Cmd + , open settings (toggle)
//   ?            show this list
//   Esc          close the shortcuts list
//
// Shortcuts are gated to the desktop breakpoint (matching bottom-nav.js) — a
// touch device with no hardware keyboard never needs them, and it keeps the
// help affordance off small screens.

import { t, applyTranslations, onLanguageSwitch } from '../i18n.js';
import { activateGroupTab } from './bottom-nav.js';
import { openSearchOverlay } from './search-overlay.js';
import { toggleSettings } from './settings.js';

const desktopMQ = matchMedia('(min-width: 600px)');

// Bare-key shortcuts must not hijack typing. Bail if focus is in any editable
// control, or if the user is mid-IME-composition.
function isTypingContext(e) {
  if (e.isComposing) return true;
  const el = e.target;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// True while any full-screen overlay is up — the tab / search shortcuts stay
// out of the way then (each overlay owns its own Escape handling).
function anyOverlayOpen() {
  return document.body.classList.contains('search-overlay-open')
    || !!document.querySelector('.settings-overlay--active')
    || !document.getElementById('classroom-detail-overlay')?.hidden
    || !document.getElementById('info-page-overlay')?.hidden
    || isHelpOpen();
}

/* ── Shortcuts help overlay ─────────────────────────────────────────────── */

let helpEl = null;

const ROWS = [
  { keys: ['/'],          i18n: 'shortcuts.search' },
  { keys: ['1'],          i18n: 'shortcuts.tabAvailable' },
  { keys: ['2'],          i18n: 'shortcuts.tabCampus' },
  { keys: ['Ctrl', ','],  i18n: 'shortcuts.settings' },
  { keys: ['?'],          i18n: 'shortcuts.help' },
];

function buildHelp() {
  const backdrop = document.createElement('div');
  backdrop.className = 'kb-help-backdrop';
  backdrop.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'kb-help-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', t('shortcuts.title'));

  const title = document.createElement('h2');
  title.className = 'kb-help-title';
  title.dataset.i18n = 'shortcuts.title';
  panel.appendChild(title);

  const list = document.createElement('dl');
  list.className = 'kb-help-list';
  for (const row of ROWS) {
    const dt = document.createElement('dt');
    row.keys.forEach((k, i) => {
      if (i) dt.appendChild(document.createTextNode(' '));
      const kbd = document.createElement('kbd');
      kbd.textContent = k;
      dt.appendChild(kbd);
    });
    const dd = document.createElement('dd');
    dd.dataset.i18n = row.i18n;
    list.append(dt, dd);
  }
  panel.appendChild(list);
  backdrop.appendChild(panel);

  backdrop.addEventListener('click', (e) => {
    if (!panel.contains(e.target)) closeHelp();
  });

  document.body.appendChild(backdrop);
  applyTranslations(backdrop);
  return backdrop;
}

function isHelpOpen() {
  return !!helpEl && !helpEl.hidden;
}

function openHelp() {
  if (!helpEl) helpEl = buildHelp();
  helpEl.hidden = false;
  requestAnimationFrame(() => helpEl.classList.add('visible'));
}

function closeHelp() {
  if (!isHelpOpen()) return;
  helpEl.classList.remove('visible');
  const done = () => { helpEl.hidden = true; };
  helpEl.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 250);
}

function toggleHelp() {
  isHelpOpen() ? closeHelp() : openHelp();
}

/* ── Key handling ──────────────────────────────────────────────────────── */

function onKeyDown(e) {
  if (!desktopMQ.matches) return;

  // Ctrl/Cmd + ,  → settings. Works regardless of focus (as long as it's not a
  // text field, where a comma should just be typed).
  if ((e.ctrlKey || e.metaKey) && e.key === ',' && !e.altKey && !e.shiftKey) {
    if (isTypingContext(e)) return;
    e.preventDefault();
    toggleSettings();
    return;
  }

  // Everything below is a bare key — ignore it with modifiers held or while
  // typing.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingContext(e)) return;

  if (e.key === 'Escape') {
    if (isHelpOpen()) { e.preventDefault(); closeHelp(); }
    return;
  }

  if (e.key === '?') {          // Shift + / on most layouts
    e.preventDefault();
    toggleHelp();
    return;
  }

  // The remaining shortcuts navigate the shell — skip them behind an overlay.
  if (anyOverlayOpen()) return;

  switch (e.key) {
    case '/':
    case 's':
      e.preventDefault();
      openSearchOverlay();
      break;
    case '1':
      e.preventDefault();
      activateGroupTab('available-classrooms-container');
      break;
    case '2':
      e.preventDefault();
      activateGroupTab('search-classrooms-container');
      break;
  }
}

export function initKeybindings() {
  document.addEventListener('keydown', onKeyDown);
  onLanguageSwitch(() => { if (helpEl) applyTranslations(helpEl); });
}
