history.scrollRestoration = 'manual';
window.scrollTo(0, 0);

const h = location.hostname;
const envLabel = h === 'beta.poliaule.com' ? 'Beta'
               : h === 'dev.poliaule.com'  ? 'Dev'
               : h === 'poliaule.com'      ? null
               :                             'Local';
if (envLabel) {
  const badge = document.getElementById('env-badge');
  badge.textContent = envLabel;
  badge.removeAttribute('hidden');
}

import {
  classroomsData,
  findAvailableClassrooms,
  fetchClassroomsData,
  SKIP_DAYS
} from './available-rooms-script.js';

import { initSearchTab, navigateToBuilding, classroomsData as staticClassroomsData } from './search-classrooms-script.js';
import { activateGroupTab } from './components/bottom-nav.js';
import { initSearchOverlay } from './components/search-overlay.js';
import { classroomDetail } from './components/classroom-detail.js';
import { infoPage } from './components/info-page.js';

import { initTimePickers } from './components/time-picker.js';
import { initTimeRangeSlider } from './components/time-range-slider.js';
import { setupCampusPicker } from './components/campus-picker.js';
import { setupDatePicker } from './components/date-picker.js';
import './components/date-chip-picker.js';
import './components/time-range-chip-picker.js';
import { initPickerDock } from './components/picker-dock.js';
import './components/data-fetch-card.js';

import { haptics, defaultPatterns } from './components/haptics.js';
import { buildCardForClassroom } from './components/classroom-list.js';
import { buildingOverview } from './components/building-overview.js';
import { initLiquidGlass } from './components/liquid-glass.js';
import { initFavourites, renderFavourites } from './components/favourites.js';

import { initI18n, t, getLocale, applyTranslations, onLanguageSwitch, animateI18nElement } from './i18n.js';
import { escapeHtml } from './utils/html.js';
import './components/tooltip.js';
import { initSettings, applyPreferredCampusIfEnabled, applyRememberLastCampusIfEnabled, SHOW_PARTIAL_KEY, INTERVAL_HOURS_KEY, AUTO_SEARCH_KEY, LIVE_SEARCH_KEY } from './components/settings.js';
import { initKeybindings } from './components/keybindings.js';

// ---------- SPLASH SCREEN ----------
const _splashStartTime = Date.now();
const _SPLASH_MIN_MS = 300;

function dismissSplash() {
  const overlay = document.getElementById('splash-overlay');
  if (!overlay) return;

  const splashLogo = overlay.querySelector('.splash-logo');
  const realLogo = document.querySelector('.header-logo');
  const isInfo = location.hash === '#info';

  const revealHeader = () =>
    document.querySelectorAll('.splash-header-item')
      .forEach(el => el.classList.add('splash-revealed'));

  if (document.startViewTransition) {
    // --- View Transition path ---
    splashLogo.style.viewTransitionName = 'splash-icon';

    if (isInfo) {
      // Also name the header title/badge so they morph directly into the hero
      const titleEl = document.querySelector('.header-title');
      const badgeEl = document.getElementById('env-badge');
      if (titleEl) titleEl.style.viewTransitionName = 'info-title';
      if (badgeEl && !badgeEl.hidden) {
        badgeEl.style.lineHeight = '1';
        badgeEl.style.viewTransitionName = 'info-badge';
      }

      const vt = document.startViewTransition(() => {
        splashLogo.style.viewTransitionName = '';
        if (titleEl) titleEl.style.viewTransitionName = '';
        if (badgeEl) { badgeEl.style.lineHeight = ''; badgeEl.style.viewTransitionName = ''; }

        overlay.remove();
        revealHeader();

        // Open info page in this same VT — no second transition needed
        infoPage._applyOpenState('splash-icon');
      });

      vt.finished.then(() => infoPage._clearVtNames()).catch(() => infoPage._clearVtNames());
    } else {
      const vt = document.startViewTransition(() => {
        splashLogo.style.viewTransitionName = '';
        overlay.remove();
        revealHeader();
        realLogo.style.viewTransitionName = 'splash-icon';
      });

      const cleanup = () => { realLogo.style.viewTransitionName = ''; };
      vt.finished.then(cleanup).catch(cleanup);
    }
  } else {
    // --- FLIP fallback ---
    const firstRect = splashLogo.getBoundingClientRect();
    const lastRect  = realLogo.getBoundingClientRect();
    const dx    = (lastRect.left + lastRect.width  / 2) - (firstRect.left + firstRect.width  / 2);
    const dy    = (lastRect.top  + lastRect.height / 2) - (firstRect.top  + firstRect.height / 2);
    const scale = lastRect.height / firstRect.height;

    realLogo.style.opacity = '0';
    overlay.style.pointerEvents = 'none';

    splashLogo.classList.add('splash-logo-flying');
    void splashLogo.offsetWidth;

    splashLogo.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    overlay.classList.add('splash-hiding');
    revealHeader();

    splashLogo.addEventListener('transitionend', () => {
      realLogo.style.opacity = '';
      overlay.remove();
      if (isInfo) infoPage.checkHash();
    }, { once: true });
  }
}

function showSplashError() {
  const overlay = document.getElementById('splash-overlay');
  if (!overlay) return;
  overlay.classList.add('splash-error');
  overlay.innerHTML = `
    <span class="material-symbols-outlined splash-error-icon">wifi_off</span>
    <p class="splash-error-title">Unable to load</p>
    <p class="splash-error-subtitle">Check your connection and try again.</p>
    <button class="button-primary splash-error-reload" onclick="location.reload()">Reload</button>
  `;
}

// ---------- THEME COLOR META TAGS ----------
const lightMeta = document.querySelector('meta[name="theme-color"][media="(prefers-color-scheme: light)"]');
const darkMeta = document.querySelector('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]');
const mq = window.matchMedia('(prefers-color-scheme: dark)');

function updateThemeColor(e) {
  // Force Safari to re-read by briefly swapping content
  if (e.matches) {
    darkMeta.content = '#1E1E1E';
  } else {
    lightMeta.content = '#ECECEC';
  }
}

mq.addEventListener('change', updateThemeColor);

document.addEventListener('DOMContentLoaded', () => {
  const isSamsungBrowser = /SamsungBrowser/i.test(navigator.userAgent);
  if (isSamsungBrowser) {
    document.documentElement.classList.add('samsung');
  }

  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  if (!isSafari) {
    document.documentElement.classList.add('no-safari');
  }

  const header = document.querySelector('.header');
  const setHeaderHeight = () =>
    document.documentElement.style.setProperty('--header-height', `${header.offsetHeight}px`);
  setHeaderHeight();
  new ResizeObserver(setHeaderHeight).observe(header);

  // Live height of the sticky picker bar (mobile), so the results' sticky
  // per-building headers can park directly beneath it instead of overlapping.
  const pickerBar = document.getElementById('available-classrooms-form');
  if (pickerBar) {
    const setPickerBarHeight = () =>
      document.documentElement.style.setProperty('--picker-bar-height', `${pickerBar.offsetHeight}px`);
    setPickerBarHeight();
    new ResizeObserver(setPickerBarHeight).observe(pickerBar);
  }
})

document.querySelectorAll('.button-primary').forEach(btn => {
  btn.addEventListener('touchend', () => { }, { passive: true });
});

// ---------- TAB BAR ----------
// Tab switching is owned by components/bottom-nav.js (the bottom pill nav).

// ---------- BUILDING CARD ----------

// Builds one building's section: a single <li class="building-section"> (its
// own card grid) holding a sticky header followed by that building's room
// cards, to append directly into the outer <ul>. Returns { node, cardIndex }
// (the next cardIndex feeds the stagger-animation sequencing).
function buildBuildingSection(building, rooms, from, to, cardIndex = 0, isToday = false, date = null, campusId = null, allResults = []) {
  const buildingName = building.name;

  const allPartial = rooms.every(r => r.status === 'partially-free');

  // One <li> per building: its own card grid, so the sticky header stays
  // confined to this section (see .building-section in classroom-list.css).
  const section = document.createElement('li');
  section.className = 'building-section';
  section.dataset.buildingName = buildingName;
  if (building.id != null) section.dataset.buildingId = building.id;
  if (allPartial) section.dataset.allPartial = 'true';

  const headerEl = document.createElement('div');
  headerEl.className = 'building-section-header';
  headerEl.style.animationDelay = `${Math.min(cardIndex * 30, 300)}ms`;
  headerEl.innerHTML = `
    <button class="building-section-titles liquid-glass" type="button" aria-haspopup="dialog" aria-label="${escapeHtml(t('building.prefix'))} ${escapeHtml(buildingName)}">
      <span class="building-name">${t('building.prefix')} ${escapeHtml(buildingName)}</span>
      ${building.altName ? `<span class="building-alt-name">${escapeHtml(building.altName)}</span>` : ''}
    </button>
    <button class="header-button building-section-btn liquid-glass" type="button" aria-label="${escapeHtml(t('building.prefix'))} ${escapeHtml(buildingName)}">
      <i class="hgi-stroke hgi-arrow-right-01" aria-hidden="true"></i>
    </button>
  `;
  cardIndex++;
  section.appendChild(headerEl);

  // Tapping the name pill "zooms out" into the building overview grid.
  const titlesBtn = headerEl.querySelector('.building-section-titles');
  const openOverview = () => buildingOverview.open({
    campusId,
    date,
    from,
    to,
    results: allResults,
    sourceSection: section,
    buildingName,
  });
  let downAt = null;
  titlesBtn.addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    buildingOverview.prewarm(section);
  });
  // Open on pointerup, not click: iOS Safari swallows the click when the tap
  // lands while the page is still rubber-banding from a scroll (very easy to
  // hit when you've just scrolled to the bottom of the list), and the shared
  // liquid-glass handler eats it after a few px of finger travel. A short,
  // near-stationary press is a tap. open() is a no-op if one already ran.
  titlesBtn.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const held = performance.now() - downAt.t;
    downAt = null;
    if (moved <= 12 && held < 700) openOverview();
  });
  // Fallback for keyboard / assistive-tech activation, which fires click only.
  titlesBtn.addEventListener('click', openOverview);

  // Jump to this building's page in the Campus tab. The tab has to be made
  // visible *before* renderClassrooms runs — building the grid while the tab
  // is still content-visibility:hidden makes every card first lay out at a
  // zero-width container, and content-visibility:auto then caches that wrong
  // intrinsic size (cards balloon after the next view transition).
  headerEl.querySelector('.building-section-btn').addEventListener('click', () => {
    const campus = staticClassroomsData?.find(c => c.id === campusId);
    const target = campus?.buildings.find(b =>
      (building.id != null && b.id === building.id) || b.name === building.name);
    if (!campus || !target) return;

    haptics.trigger(defaultPatterns.light);

    const campusTab = document.getElementById('search-classrooms-container');
    const go = () => navigateToBuilding(campusId, building.id ?? null, building.name);
    if (campusTab.classList.contains('visible')) {
      go();
    } else {
      campusTab.addEventListener('tabvisible', go, { once: true });
    }
    activateGroupTab('search-classrooms-container');
  });

  rooms.forEach(room => {
    const roomItem = document.createElement('div');
    roomItem.className = 'classroom-list-item-container';
    roomItem.dataset.status = room.status;
    const cardEl = buildCardForClassroom(room, building, from, to, isToday, date, '', true);
    cardEl.style.animationDelay = `${Math.min(cardIndex * 30, 300)}ms`;
    roomItem.appendChild(cardEl);
    section.appendChild(roomItem);
    cardIndex++;
  });

  return { node: section, cardIndex };
}

// ---------- DATA FETCHING ----------

// Triggers the fetching of data as soon as the page loads
document.addEventListener('DOMContentLoaded', async () => {
  // Safety net: if init hangs for any reason (e.g. fonts.ready stalls on bad
  // connectivity), surface the error screen instead of staying stuck forever.
  const _initTimeoutId = setTimeout(showSplashError, 15000);

  try {
    await initI18n();
    applyTranslations();
    // <date-chip-picker> renders its date label via Intl at module-eval time,
    // before initI18n() resolves — re-render it now that the locale is known.
    document.querySelector('date-chip-picker')?.retranslate();
    document.querySelector('time-range-chip-picker')?.retranslate();

    initSettings();

    // Desktop keyboard shortcuts (no-ops on touch / narrow viewports)
    initKeybindings();

    // Init info page overlay immediately — no data dependency
    infoPage.init();

    // Search overlay (bottom-nav FAB) — lazy-loads its data on first open
    initSearchOverlay();

    // Only the static classroom directory blocks the splash — it's what the
    // page shell (campus picker, search tab, classroom detail) is built from.
    // Occupancy data is fetched separately in the background (see
    // initOccupancyData below) and fills in its own skeleton once ready.
    await initSearchTab();

    // Init classroom detail overlay (hash routing + VT morph)
    classroomDetail.init(staticClassroomsData);

    // Delegated press / swipe-deform for every .liquid-glass control
    initLiquidGlass();

    // Favourites carousel on the Available page
    initFavourites(staticClassroomsData);

    // Setup the campus picker with the available ones
    setupCampusPicker(staticClassroomsData);
    applyPreferredCampusIfEnabled();
    applyRememberLastCampusIfEnabled();

    // Setup the time pickers to ensure valid time ranges
    // (these don't depend on occupancy data)
    setupTimePickers();
    initTimePickers();
    initTimeRangeSlider();

    // Decide pill vs. inline-expanded pickers based on the form column's width
    // (desktop two-column layout only).
    initPickerDock();

    // Setup the language switch handler immediately — doesn't depend on
    // fonts and shouldn't wait for the splash to dismiss
    onLanguageSwitch(() => {
      setupDataFetchIndicatorText(true);
      setupDatePicker(() => preferInitialDate);
      document.querySelector('campus-chip-picker')?.retranslate();
      renderFavourites();
      const container = document.getElementById('available-classrooms-results');
      if (!container.classList.contains('empty')) {
        document.getElementById('available-classrooms-form').dispatchEvent(
          new Event('submit', { cancelable: true, bubbles: true })
        );
      }
    });

    // Kick off occupancy fetching in the background. It doesn't block the
    // splash — the date picker/results area stay in their skeleton/loading
    // state until it resolves.
    initOccupancyData();

    // Wait for fonts so time pickers render correctly, then dismiss splash.
    await document.fonts.ready;
    document.querySelector('.time-pickers-container').style.opacity = '1';
    document.querySelector('campus-chip-picker')?.removeAttribute('data-loading');

    clearTimeout(_initTimeoutId);
    const elapsed = Date.now() - _splashStartTime;
    const remaining = Math.max(0, _SPLASH_MIN_MS - elapsed);
    setTimeout(dismissSplash, remaining);

  } catch (error) {
    clearTimeout(_initTimeoutId);
    console.error('Initialization failed:', error);
    const elapsed = Date.now() - _splashStartTime;
    const remaining = Math.max(0, _SPLASH_MIN_MS - elapsed);
    setTimeout(showSplashError, remaining);
  }
});

// Fetches occupancy data in the background (independent of the splash
// screen) and populates everything that depends on it once it's ready.
async function initOccupancyData() {
  await fetchClassroomsData();

  // Use the fetched data to set the only valid dates into the date picker
  setupDatePicker(() => preferInitialDate);
  document.getElementById('available-classrooms-form').removeAttribute('data-loading');
  document.querySelector('date-chip-picker')?.removeAttribute('data-loading');

  setupDataFetchIndicator();
  setupLiveSearch();

  // If a classroom detail page was opened before occupancy data arrived
  // (e.g. a direct link), fill in its status badge and timeline now.
  classroomDetail.refreshOccupancy();
  renderFavourites();

  const autoSearchEnabled = localStorage.getItem(AUTO_SEARCH_KEY) !== 'false';
  if (autoSearchEnabled) {
    document.getElementById('available-classrooms-form').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true })
    );
  }
}

// ---------- FORM 1: AVAILABLE CLASSROOMS ----------
// Setup the 'Available Classrooms' form
document.getElementById('available-classrooms-form').addEventListener('submit', (e) => {
  // Skip default submit behavior since we will handle it with JavaScript
  e.preventDefault();

  // Haptic feedback
  haptics.trigger(defaultPatterns.light);

  // Check if data was already fetched
  if (!classroomsData.length) {
    console.warn('Data not yet loaded, please wait...');
    return;
  }

  // Read input data
  const data = new FormData(e.target);
  const campus = data.get('campus');
  const date = data.get('date'); // comes from the hidden select
  const from = data.get('from');
  const to = data.get('to');

  // Compute results
  const results = findAvailableClassrooms(campus, date, from, to);

  // Render results
  renderAvailableClassroomsResults(results, date, from, to, campus);
});

// Builds the UI to show the results of the 'Available Classrooms' form submission,
function renderAvailableClassroomsResults(results, date, from, to, campusId = null) {
  const container = document.getElementById('available-classrooms-results');
  buildingOverview.reset(); // tear down the zoom-out view if it's open
  container.dataset.searched = 'true';
  container.innerHTML = ''; // Clear previous results

  // Find the day entry matching the selected date
  const dateKey = date.replace(/-/g, ''); // "2026-03-16" → "20260316"
  const dayData = classroomsData.find(day => day.date === dateKey) ?? classroomsData[0];

  if (results.length === 0) {
    renderNoResultsClassroomsContainer(container);
    return;
  }

  container.classList.remove('empty');

  // Filter row (rendered only when partial-free filter is needed)
  const filterRow = document.createElement('div');
  filterRow.className = 'results-filter-row';

  // Partial-free filter toggle — initial state driven by Show Partially Free setting
  const showPartialSaved = localStorage.getItem(SHOW_PARTIAL_KEY);
  const showPartialDefault = showPartialSaved === null ? true : showPartialSaved === 'true';
  const hasPartial = results.some(b => b.rooms.some(r => r.status === 'partially-free'));
  if (hasPartial) {
    const toggleBtn = document.createElement('button');
    toggleBtn.className = showPartialDefault ? 'results-filter-btn active' : 'results-filter-btn';
    toggleBtn.innerHTML = `<span class="material-symbols-outlined">filter_alt</span> ${t('results.filterPartial')}`;
    if (!showPartialDefault) container.classList.add('hide-partial');
    toggleBtn.addEventListener('click', () => {
      haptics.trigger(defaultPatterns.light);
      const isActive = toggleBtn.classList.toggle('active');
      container.classList.toggle('hide-partial', !isActive);
    });
    filterRow.appendChild(toggleBtn);
    container.appendChild(filterRow);
  }

  const list = document.createElement('ul');
  list.className = 'list-outer-container';

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const isToday = date === todayStr;

  let cardIndex = 0;
  results.forEach(buildingResult => {
    const { node, cardIndex: next } = buildBuildingSection(buildingResult.building, buildingResult.rooms, from, to, cardIndex, isToday, date, campusId, results);
    cardIndex = next;
    list.appendChild(node);
  });

  container.appendChild(list);

  // Mark the list as appeared after the staggered animation finishes.
  // This avoids re-triggering the animation when returning from the details page
  // or switching back and forth between tabs.
  requestAnimationFrame(() => {
    setTimeout(() => {
      list.classList.add('appeared');
    }, 800);
  });
}

// Render the error state for the Available Classrooms results container
function renderNoResultsClassroomsContainer(container) {
  container.classList.add('empty');

  container.innerHTML = `
    <span class="material-symbols-outlined empty-container-icon">search_off</span>
    <p class="empty-container-title">${t('results.noResultsTitle')}</p>
    <p class="empty-container-subtitle">${t('results.noResultsSubtitle')}</p>
  `;
}

const TIME_MIN_MINS = 7 * 60 + 15;  // 07:15
const TIME_MAX_MINS = 20 * 60 + 15; // 20:15

// Set by setupTimePickers when the current time is after 20:15 (need tomorrow's date)
let preferInitialDate = null;

// Sets up the time pickers to ensure that the 'to' time
// is always at least 1 hour after the 'from' time, within 07:15–20:15
function setupTimePickers() {
  const fromPicker = document.getElementById('from-time-picker');
  const toPicker = document.getElementById('to-time-picker');

  function toMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  }

  function formatMins(mins) {
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }

  function formatTime(date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  fromPicker.addEventListener('input', () => {
    if (!fromPicker.value) return;

    const fromMins = toMinutes(fromPicker.value);
    const minToMins = Math.min(fromMins + 60, TIME_MAX_MINS);
    toPicker.min = formatMins(minToMins);

    if (toPicker.value && toMinutes(toPicker.value) < minToMins) {
      toPicker.value = formatMins(minToMins);
    }
  });

  toPicker.addEventListener('input', () => {
    if (!toPicker.value || !fromPicker.value) return;

    const diffMinutes = toMinutes(toPicker.value) - toMinutes(fromPicker.value);
    if (diffMinutes < 60) {
      const corrected = Math.min(toMinutes(fromPicker.value) + 60, TIME_MAX_MINS);
      toPicker.value = formatMins(corrected);
    }
  });

  // Set initial values
  const intervalHours = parseInt(localStorage.getItem(INTERVAL_HOURS_KEY), 10) || 2;
  const now = new Date();

  // Snap to next :15 slot
  const snapped = new Date(now);
  snapped.setMinutes(15, 0, 0);
  if (now.getMinutes() >= 15) snapped.setHours(snapped.getHours() + 1);

  const snappedMins = snapped.getHours() * 60 + snapped.getMinutes();

  if (snappedMins > TIME_MAX_MINS) {
    // After 20:15 → next non-skipped day at 07:15; signal date picker to advance
    do { snapped.setDate(snapped.getDate() + 1); } while (SKIP_DAYS.includes(snapped.getDay()));
    snapped.setHours(7, 15, 0, 0);
    preferInitialDate = [
      snapped.getFullYear(),
      String(snapped.getMonth() + 1).padStart(2, '0'),
      String(snapped.getDate()).padStart(2, '0'),
    ].join('-');
  } else if (snappedMins < TIME_MIN_MINS) {
    // Before 07:15 → today at 07:15
    snapped.setHours(7, 15, 0, 0);
  }

  let fromMins = snapped.getHours() * 60 + snapped.getMinutes();
  let toMins = fromMins + intervalHours * 60;

  if (toMins > TIME_MAX_MINS) {
    toMins = TIME_MAX_MINS;
    fromMins = Math.max(TIME_MIN_MINS, toMins - Math.max(60, intervalHours * 60));
    // Re-sync snapped object for formatTime(snapped)
    snapped.setHours(Math.floor(fromMins / 60), fromMins % 60, 0, 0);
  }

  const minToMins = Math.min(fromMins + 60, TIME_MAX_MINS);

  fromPicker.value = formatTime(snapped);
  toPicker.value = formatMins(toMins);
  toPicker.min = formatMins(minToMins);
}

function setupDataFetchIndicator() {
  const indicator = document.getElementById('data-fetch-indicator');

  if (!classroomsData.length) {
    indicator.classList.add('red');
    return;
  }

  const today = new Date();
  const todayKey = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0')
  ].join('');

  const generationDate = new Date(classroomsData[0].generated_at + 'Z');
  const generationKey = [
    generationDate.getFullYear(),
    String(generationDate.getMonth() + 1).padStart(2, '0'),
    String(generationDate.getDate()).padStart(2, '0')
  ].join('');

  const hasFutureData = classroomsData.some(entry => entry.date > todayKey);

  if (generationKey === todayKey) {
    // Generated today — fresh
    indicator.classList.add('green');
  } else if (hasFutureData) {
    // Not generated today but still has upcoming days — tolerable
    indicator.classList.add('yellow');
  } else {
    // No future data at all — outdated
    indicator.classList.add('red');
  }

  setupDataFetchIndicatorText();
}

// Setups the text inside the popover shown in the Data Fetch Indicator
function setupDataFetchIndicatorText(animate = false) {
  const container = document.getElementById('data-fetch-indicator-popover-container');

  const states = {
    green: {
      title: t('data.greenTitle'),
      description: t('data.greenDesc'),
    },
    yellow: {
      title: t('data.yellowTitle'),
      description: t('data.yellowDesc'),
    },
    red: {
      title: t('data.redTitle'),
      description: t('data.redDesc'),
    },
  };

  // Derive current status from the indicator's classes
  const indicator = document.getElementById('data-fetch-indicator');
  const status = ['green', 'yellow', 'red'].find(s => indicator.classList.contains(s)) ?? 'red';
  const { title, description } = states[status];

  // Last fetch time
  const generationDate = classroomsData[0]
    ? new Date(classroomsData[0].generated_at + 'Z')
    : null;

  const dateLocale = getLocale() === 'it' ? 'it-IT' : 'en-GB';
  const formattedTime = generationDate
    ? generationDate.toLocaleString(dateLocale, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Europe/Rome',
    })
    : '—';

  container.innerHTML = `
    <h1 class="popover-title ${status}">${title}</h1>
    <p class="data-status-description secondary">${description}</p>
    <label class="data-status-time secondary">${t('data.lastFetched')}: ${formattedTime}</label>
    <button id="reload-data-btn" class="button-primary button-secondary data-reload-btn">
      <span class="material-symbols-outlined data-reload-icon">refresh</span>
      <span class="data-reload-label">${t('data.reload')}</span>
    </button>
  `;
  document.getElementById('reload-data-btn').addEventListener('click', reloadOccupancyData);
  if (animate) animateI18nElement(container);
}

async function reloadOccupancyData() {
  const btn = document.getElementById('reload-data-btn');
  if (!btn || btn.disabled) return;

  btn.disabled = true;
  btn.querySelector('.data-reload-icon').classList.add('spinning');
  btn.querySelector('.data-reload-label').textContent = t('data.reloading');

  await fetchClassroomsData();

  const indicator = document.getElementById('data-fetch-indicator');
  indicator.classList.remove('green', 'yellow', 'red');
  setupDataFetchIndicator();
  setupDatePicker(() => preferInitialDate);

  const resultsContainer = document.getElementById('available-classrooms-results');
  if (resultsContainer && !resultsContainer.classList.contains('empty')) {
    document.getElementById('available-classrooms-form').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true })
    );
  }
}

// ---------- LIVE SEARCH ----------

function setupLiveSearch() {
  const form = document.getElementById('available-classrooms-form');
  const results = document.getElementById('available-classrooms-results');

  function isEnabled() {
    return localStorage.getItem(LIVE_SEARCH_KEY) !== 'false';
  }

  function trigger() {
    if (!isEnabled() || !classroomsData.length || !results.dataset.searched) return;
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  }

  let debounceTimer = null;
  function triggerDebounced() {
    if (!isEnabled()) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(trigger, 320);
  }

  document.addEventListener('campuschange', trigger);
  document.getElementById('date-picker').addEventListener('change', trigger);
  document.getElementById('from-time-picker').addEventListener('input', triggerDebounced);
  document.getElementById('to-time-picker').addEventListener('input', triggerDebounced);
}

