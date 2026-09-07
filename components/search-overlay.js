// Search overlay — the bottom-nav search FAB opens this as a sheet over
// whatever tab is currently showing, rather than switching to its own tab
// page. It owns only the presentation/UX; the actual classroom text search
// (data, index, card builders) lives in search-classrooms-script.js.

import { t, getLocale, onLanguageSwitch } from '../i18n.js';
import { haptics, defaultPatterns } from './haptics.js';
import { escapeHtml, highlight } from '../utils/html.js';
import { createTimeFormatter } from '../utils/time-format.js';
import {
  ensureSearchData,
  runClassroomSearch,
  buildSearchResultCard,
  runOccupationSearch,
  hasOccupationData,
  SEARCH_MAX_RESULTS,
  OCC_MAX_GROUPS,
} from '../search-classrooms-script.js';

const DEBOUNCE_MS = 200;

// Shared view-transition name: the bottom-nav search FAB morphs into the
// overlay's search bar on open, and back on close. Only ever assigned to one
// of the two elements at a time (cleared before it's handed over).
const MORPH_NAME = 'search-fab-morph';
const fabEl = () => document.getElementById('bn-search-btn');
const barEl = () => overlay.querySelector('.search-bar-wrapper');

// The translucent chrome (header blur layers, pill nav) can't keep a live
// backdrop-filter through a view transition — Safari doesn't rasterise it into
// the snapshot, so it flashes unblurred / resamples the wrong backdrop. While
// `html.search-vt` is set (only for the duration of the open/close VT) those
// surfaces drop their blur — see search-overlay.css.
function beginChromeVT() { document.documentElement.classList.add('search-vt'); }
// Restore the blur a couple of frames AFTER the VT resolves — snapping it back
// while the ::view-transition pseudo-elements are still tearing down double-
// exposes the FAB (unblurred snapshot + freshly-blurred live element).
function endChromeVT() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.documentElement.classList.remove('search-vt');
  }));
}

let overlay, panel, input, clearBtn, closeBtn, resultsEl;
let isOpen = false;
let debounce = null;
let savedScrollPos = 0;

let occRecheckTimer = null;

function renderResults(query) {
  _renderResults(query);
  requestAnimationFrame(syncHeaderClearance);
}

function sectionLabel(text) {
  const el = document.createElement('div');
  el.className = 'search-section-label';
  el.textContent = text;
  return el;
}

function tooManyNotice(n) {
  const p = document.createElement('p');
  p.className = 'search-too-many-notice';
  p.textContent = t('search.tooManyResults').replace('{n}', n);
  return p;
}

function _renderResults(query) {
  const q = query.trim();
  resultsEl.innerHTML = '';
  clearTimeout(occRecheckTimer);

  if (!q) return; // idle: empty results area, placeholder styling handles the hint

  const rooms = runClassroomSearch(q);
  const events = runOccupationSearch(q);
  const hasRooms = rooms.visible.length > 0;
  const hasEvents = events.groups.length > 0;

  if (!hasRooms && !hasEvents) {
    const state = document.createElement('div');
    state.className = 'search-empty-state';
    state.innerHTML = `
      <span class="material-symbols-outlined empty-container-icon">search_off</span>
      <p class="empty-container-title">${t('search.emptyTitle')}</p>
      <p class="empty-container-subtitle">${t('search.emptySubtitle')}</p>
    `;
    resultsEl.appendChild(state);
    if (!hasOccupationData()) scheduleOccRecheck(query);
    return;
  }

  if (hasRooms) {
    if (hasEvents) resultsEl.appendChild(sectionLabel(t('search.sectionClassrooms')));
    const grid = document.createElement('div');
    grid.className = 'search-grid search-grid--classroom';
    rooms.visible.forEach(room => grid.appendChild(buildSearchResultCard(room, q)));
    resultsEl.appendChild(grid);
    if (rooms.capped) resultsEl.appendChild(tooManyNotice(SEARCH_MAX_RESULTS));
    requestAnimationFrame(() => setTimeout(() => grid.classList.add('appeared'), 400));
  }

  if (hasEvents) {
    resultsEl.appendChild(sectionLabel(t('search.sectionEvents')));
    const list = document.createElement('div');
    list.className = 'search-event-list';
    const dateFmt = new Intl.DateTimeFormat(getLocale(), { weekday: 'short', day: 'numeric', month: 'short' });
    const timeFmt = createTimeFormatter();
    events.groups.forEach(g => list.appendChild(buildEventCard(g, events.maxSessions, q, dateFmt, timeFmt)));
    resultsEl.appendChild(list);
    if (events.capped) resultsEl.appendChild(tooManyNotice(OCC_MAX_GROUPS));
  }

  // Occupancy data loads in the background — if it isn't here yet, the events
  // section is missing; re-run the search once it arrives.
  if (!hasOccupationData()) scheduleOccRecheck(query);
}

function fmtTime(hhmm, timeFmt) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return String(hhmm ?? '');
  return timeFmt.format(new Date(2000, 0, 1, h, m));
}

function fmtDate(iso, dateFmt) {
  const d = new Date(`${iso}T00:00`);
  return Number.isNaN(d.getTime()) ? String(iso ?? '') : dateFmt.format(d);
}

function buildEventCard(g, maxSessions, query, dateFmt, timeFmt) {
  const card = document.createElement('div');
  card.className = 'search-event-card';

  const head = document.createElement('div');
  head.className = 'search-event-head';
  head.innerHTML =
    `<span class="search-event-title">${highlight(g.title || t('detail.occupied'), query)}</span>` +
    (g.isExam ? `<span class="timeline-popover-badge">${t('detail.examLabel')}</span>` : '');
  card.appendChild(head);

  const meta = [];
  if (g.code != null) meta.push(String(g.code).padStart(6, '0'));
  if (g.section) meta.push(g.section);
  if (g.professors.length) meta.push(g.professors.join(', '));
  if (meta.length) {
    const m = document.createElement('div');
    m.className = 'timeline-popover-meta';
    m.innerHTML = meta.map(x => `<span>${highlight(x, query)}</span>`).join('');
    card.appendChild(m);
  }

  const sessions = document.createElement('div');
  sessions.className = 'search-event-sessions';
  g.sessions.slice(0, maxSessions).forEach(s => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'search-event-session liquid-glass';
    b.dataset.openClassroom = s.roomId;
    b.innerHTML =
      `<span class="ses-when">${escapeHtml(fmtDate(s.date, dateFmt))} · ` +
      `${escapeHtml(fmtTime(s.inizio, timeFmt))}–${escapeHtml(fmtTime(s.fine, timeFmt))}</span>` +
      `<span class="ses-where secondary">${escapeHtml(s.roomName)} · ` +
      `${escapeHtml(s.buildingAltName || s.buildingName)}</span>`;
    sessions.appendChild(b);
  });
  if (g.sessionCount > maxSessions) {
    const more = document.createElement('p');
    more.className = 'search-event-more secondary';
    more.textContent = t('search.moreSessions').replace('{n}', g.sessionCount - maxSessions);
    sessions.appendChild(more);
  }
  card.appendChild(sessions);
  return card;
}

function scheduleOccRecheck(query, tries = 0) {
  clearTimeout(occRecheckTimer);
  if (tries > 6) return;
  occRecheckTimer = setTimeout(() => {
    if (!isOpen || input.value !== query) return;
    if (hasOccupationData()) renderResults(query);
    else scheduleOccRecheck(query, tries + 1);
  }, 1200);
}

// Hide the header only once the results box has actually grown tall enough to
// reach up behind it (body.search-covers-header, consumed by the mobile CSS).
// opacity:0 on the header doesn't change its box, so this can't oscillate.
function syncHeaderClearance() {
  const header = document.querySelector('.header');
  if (!header || !panel || !isOpen) return;
  const covers = panel.getBoundingClientRect().top < header.getBoundingClientRect().bottom + 8;
  document.body.classList.toggle('search-covers-header', covers);
}

// Mobile pins the search field just above the on-screen keyboard. iOS Safari
// doesn't shrink the layout viewport for the keyboard, so `position: fixed;
// bottom` alone would sit behind it — track visualViewport and expose the
// keyboard height as --search-kb for the CSS to offset by.
function onViewportResize() {
  const vv = window.visualViewport;
  if (!vv) return;
  const kb = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
  overlay.style.setProperty('--search-kb', kb + 'px');
  requestAnimationFrame(syncHeaderClearance);
}

function startViewportTracking() {
  const vv = window.visualViewport;
  if (!vv) return;
  onViewportResize();
  vv.addEventListener('resize', onViewportResize);
  vv.addEventListener('scroll', onViewportResize);
}

function stopViewportTracking() {
  const vv = window.visualViewport;
  if (vv) {
    vv.removeEventListener('resize', onViewportResize);
    vv.removeEventListener('scroll', onViewportResize);
  }
  overlay.style.removeProperty('--search-kb');
}

function conceal() {
  overlay.classList.remove('visible');
  overlay.setAttribute('hidden', '');
  document.body.classList.remove('search-overlay-open');
  document.body.classList.remove('search-covers-header');
  clearTimeout(occRecheckTimer);
  stopViewportTracking();
  window.scrollTo(0, savedScrollPos);
}

// Land the caret in the field ready to type; select any leftover query so the
// first keystroke replaces it. Must run inside the FAB-tap callstack — iOS
// Safari only opens the keyboard for a focus() that's user-initiated.
function grabInput() {
  input.focus({ preventScroll: true });
  input.select();
}

export async function openSearchOverlay() {
  if (isOpen || !overlay) return;
  isOpen = true;
  haptics.trigger(defaultPatterns.light);
  savedScrollPos = window.scrollY;

  // Unhide + focus synchronously (still inside the FAB-tap callstack, so iOS
  // opens the keyboard). The overlay is only opacity:0 here, not display:none,
  // so focus() works. `search-overlay-open` (which hides the FAB/nav) is held
  // back until inside the VT callback so the FAB stays in the "old" snapshot
  // to morph from. The panel rides above the keyboard via the visualViewport
  // tracking below, so it doesn't matter that Safari resizes late.
  overlay.removeAttribute('hidden');
  grabInput();

  const fab = fabEl();
  if (document.startViewTransition && fab) {
    fab.style.viewTransitionName = MORPH_NAME;
    beginChromeVT();
    const vt = document.startViewTransition(() => {
      fab.style.viewTransitionName = '';
      document.body.classList.add('search-overlay-open');
      overlay.classList.add('visible');
      startViewportTracking();
      const bar = barEl();
      if (bar) bar.style.viewTransitionName = MORPH_NAME;
    });
    vt.finished.finally(() => {
      const bar = barEl();
      if (bar) bar.style.viewTransitionName = '';
      endChromeVT();
      // Re-grab only if the transition stole focus (some engines blur on the
      // DOM churn); avoids yanking the selection back if the user's already typing.
      if (isOpen && document.activeElement !== input) grabInput();
    });
  } else {
    document.body.classList.add('search-overlay-open');
    requestAnimationFrame(() => overlay.classList.add('visible'));
    startViewportTracking();
    grabInput();
  }

  await ensureSearchData();
  if (isOpen) renderResults(input.value);
}

export function closeSearchOverlay() {
  if (!isOpen || !overlay) return;
  isOpen = false;
  clearTimeout(debounce);
  input.blur();

  const fab = fabEl();
  if (document.startViewTransition && fab) {
    const bar = barEl();
    if (bar) bar.style.viewTransitionName = MORPH_NAME;
    beginChromeVT();
    const vt = document.startViewTransition(() => {
      if (bar) bar.style.viewTransitionName = '';
      conceal();
      fab.style.viewTransitionName = MORPH_NAME;
    });
    vt.finished.finally(() => {
      fab.style.viewTransitionName = '';
      endChromeVT();
    });
  } else {
    overlay.classList.remove('visible');
    const done = () => conceal();
    overlay.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 260); // fallback if transitionend doesn't fire
  }
}

// Drop the overlay with no transition of its own — for when the click that
// dismisses it also navigates somewhere that runs its own transition (info
// page, classroom detail), so the two don't fight.
function dismissInstant() {
  if (!isOpen) return;
  isOpen = false;
  clearTimeout(debounce);
  input.blur();
  const fab = fabEl();
  if (fab) fab.style.viewTransitionName = '';
  document.documentElement.classList.remove('search-vt');
  conceal();
}

export function initSearchOverlay() {
  overlay = document.getElementById('search-overlay');
  if (!overlay) return;
  panel = overlay.querySelector('.search-overlay-panel');
  input = document.getElementById('classroom-search-input');
  clearBtn = document.getElementById('classroom-search-clear');
  closeBtn = document.getElementById('search-overlay-close');
  resultsEl = document.getElementById('search-overlay-results');

  closeBtn.addEventListener('click', () => {
    haptics.trigger(defaultPatterns.light);
    closeSearchOverlay();
  });

  // Tap the blurred backdrop (outside the panel) to dismiss.
  overlay.addEventListener('click', (e) => {
    if (!panel.contains(e.target)) closeSearchOverlay();
  });

  document.addEventListener('keydown', (e) => {
    if (isOpen && e.key === 'Escape') closeSearchOverlay();
  });

  // Opening a result navigates to the classroom detail page — get the
  // overlay out of the way so the card → page morph isn't behind the blur.
  resultsEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-classroom]')) closeSearchOverlay();
  });

  // The header sits above the overlay (z-index), so its controls stay
  // clickable while search is open. Any such click (info page, settings, …)
  // should take the overlay down first — the destination runs its own
  // transition. Capture phase so this beats the buttons' own handlers.
  document.querySelector('.header')?.addEventListener('click', () => {
    if (isOpen) dismissInstant();
  }, true);

  // Safety net: any other hash route opened while we're open takes it down too
  // (isOpen is already false by here for the result-card path above).
  window.addEventListener('hashchange', () => {
    if (isOpen && location.hash) dismissInstant();
  });

  clearBtn.addEventListener('click', () => {
    haptics.trigger(defaultPatterns.light);
    input.value = '';
    input.dispatchEvent(new Event('input'));
    input.focus();
  });

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const query = input.value;
    if (!query.trim()) { renderResults(''); return; }
    debounce = setTimeout(() => renderResults(query), DEBOUNCE_MS);
  });

  onLanguageSwitch(() => { if (isOpen) renderResults(input.value); });
}
