// components/settings.js
// Settings button that morphs into a centered popup.
// Contains the language switcher and any future settings.

import { haptics, defaultPatterns } from './haptics.js';
import { t, getLocale, setLocale, onLanguageSwitch, animateI18nElement } from '../i18n.js';
import { classroomsData } from '../available-rooms-script.js';
import { selectCampusById } from './campus-picker.js';
import { STORAGE_KEY as TIME_FORMAT_KEY } from '../utils/time-format.js';
import { IS_STABLE_BUILD, USE_BETA_BACKEND_KEY } from '../config.js';

const TRANSITION_DURATION = 420;

const PREFERRED_CAMPUS_ENABLED_KEY = 'poliAule_preferredCampusEnabled';
const PREFERRED_CAMPUS_ID_KEY      = 'poliAule_preferredCampusId';
const REMEMBER_LAST_CAMPUS_KEY     = 'poliAule_rememberLastCampus';
const LAST_CAMPUS_ID_KEY           = 'poliAule_lastCampusId';
const HIDE_SUNDAYS_KEY             = 'poliAule_hideSundays';
export const SHOW_PARTIAL_KEY      = 'poliAule_showPartial';
export const INTERVAL_HOURS_KEY    = 'poliAule_intervalHours';
export const DEFAULT_TAB_KEY       = 'poliAule_defaultTab';
export const LAST_TAB_KEY          = 'poliAule_lastTab';
export const AUTO_SEARCH_KEY       = 'poliAule_autoSearch';
export const LIVE_SEARCH_KEY       = 'poliAule_liveSearch';

// Returns the tab container ID to show on startup
export function getStartupTabId() {
  const mode = localStorage.getItem(DEFAULT_TAB_KEY) ?? 'available';
  if (mode === 'last') {
    return localStorage.getItem(LAST_TAB_KEY) ?? 'available-classrooms-container';
  }
  if (mode === 'search') return 'search-classrooms-container';
  return 'available-classrooms-container';
}

// ── State ─────────────────────────────────────────────────────────────────────

let isAnimating = false;
let isOpen = false;
let overlay = null;

// Module-level refs set by initSettings()
let triggerEl = null;
let popupEl = null;
let positionIndicatorFn = null;
let positionTimeFmtIndicatorFn = null;
let positionDefaultTabIndicatorFn = null;
let refreshCampusSelectFn = null; // set by buildCampusSection, called on every open

// ── Geometry helpers ──────────────────────────────────────────────────────────

function getPopupTarget() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(400, vw - 32);

  // Measure natural content height at the target width
  popupEl.style.width = w + 'px';
  popupEl.style.height = 'auto';
  const naturalH = popupEl.scrollHeight;
  popupEl.style.height = ''; // applyGeometry sets the final value immediately after

  const h = Math.min(naturalH, vh - 120);
  return {
    left: (vw - w) / 2,
    top: (vh - h) / 2,
    width: w,
    height: h,
    borderRadius: '22px',
  };
}

function applyGeometry(el, { left, top, width, height, borderRadius }) {
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.width = width + 'px';
  el.style.height = height + 'px';
  el.style.borderRadius = borderRadius;
}

function onTransitionEnd(el, cb) {
  const fallback = setTimeout(cb, TRANSITION_DURATION + 50);
  const handler = e => {
    if (e.propertyName !== 'transform') return;
    clearTimeout(fallback);
    el.removeEventListener('transitionend', handler);
    cb();
  };
  el.addEventListener('transitionend', handler);
}

// ── Scroll lock ───────────────────────────────────────────────────────────────

function preventScroll(e) {
  const inner = e.target.closest('.settings-popup__inner');
  // Only hand off to native scroll when the inner actually overflows —
  // otherwise overscroll-behavior: contain has no scroll context to contain
  // and the event would fall through to the page behind.
  if (inner && inner.scrollHeight > inner.clientHeight) return;
  e.preventDefault();
}

function lockScroll() {
  window.addEventListener('wheel', preventScroll, { passive: false });
  window.addEventListener('touchmove', preventScroll, { passive: false });
}

function unlockScroll() {
  window.removeEventListener('wheel', preventScroll);
  window.removeEventListener('touchmove', preventScroll);
}

// ── Overlay ───────────────────────────────────────────────────────────────────

function getOverlay() {
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.addEventListener('click', closeSettings);
    overlay.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    overlay.addEventListener('wheel', e => e.preventDefault(), { passive: false });
    document.body.appendChild(overlay);
  }
  return overlay;
}

function removeOverlay() {
  if (!overlay) return;
  overlay.addEventListener('transitionend', () => {
    overlay?.remove();
    overlay = null;
  }, { once: true });
}

// ── Open / close ──────────────────────────────────────────────────────────────

function openSettings() {
  if (isAnimating || isOpen) return;
  isAnimating = true;

  lockScroll();

  const rect = triggerEl.getBoundingClientRect();

  popupEl.style.transition = 'none';
  popupEl.style.display = 'flex'; // must be visible before getPopupTarget() measures scrollHeight

  const target = getPopupTarget(); // measures scrollHeight — needs display:flex

  // Place popup at its final position/size instantly — only transform animates
  applyGeometry(popupEl, target);
  popupEl.style.boxShadow = 'var(--shadow)';

  // Start with the popup visually sitting on the button:
  // translate its center to the button's center, then scale each axis independently
  // so the popup exactly matches the button's dimensions (preserving its circle shape).
  const scaleX = rect.width  / target.width;
  const scaleY = rect.height / target.height;
  const tx = (rect.left + rect.width  / 2) - (target.left + target.width  / 2);
  const ty = (rect.top  + rect.height / 2) - (target.top  + target.height / 2);
  popupEl.style.transformOrigin = '50% 50%';
  popupEl.style.transform       = `translate(${tx}px, ${ty}px) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`;
  popupEl.style.borderRadius    = '50%';

  triggerEl.classList.add('settings-btn--morphing');

  popupEl.getBoundingClientRect(); // force reflow
  positionIndicatorFn?.(false);            // snap lang indicator before morph animation starts
  positionTimeFmtIndicatorFn?.(false);     // snap time format indicator before morph animation starts
  positionDefaultTabIndicatorFn?.(false);  // snap default tab indicator before morph animation starts
  refreshCampusSelectFn?.();            // re-populate campus select now that data may be loaded
  popupEl.style.transition = '';

  requestAnimationFrame(() => {
    popupEl.style.transform    = 'translate(0px, 0px) scale(1)';
    popupEl.style.borderRadius = '22px';
    popupEl.style.boxShadow    = 'var(--tp-shadow-lg)';
    popupEl.classList.add('settings-popup--open');
    getOverlay().classList.add('settings-overlay--active');
  });

  onTransitionEnd(popupEl, () => {
    popupEl.style.transform       = '';
    popupEl.style.transformOrigin = '';
    isAnimating = false;
    isOpen = true;
  });
}

function closeSettings() {
  if (isAnimating || !isOpen) return;
  isAnimating = true;

  const rect      = triggerEl.getBoundingClientRect();
  const popupRect = popupEl.getBoundingClientRect();

  // Translate the popup's center to the button's center, then scale each axis
  // independently so the popup's final visual size exactly matches the button's
  // dimensions — ensuring a circle, not a vertical oval on tall popups.
  const scaleX = rect.width  / popupRect.width;
  const scaleY = rect.height / popupRect.height;
  const tx = (rect.left + rect.width  / 2) - (popupRect.left + popupRect.width  / 2);
  const ty = (rect.top  + rect.height / 2) - (popupRect.top  + popupRect.height / 2);

  popupEl.classList.remove('settings-popup--open');
  getOverlay().classList.remove('settings-overlay--active');
  removeOverlay();

  requestAnimationFrame(() => {
    popupEl.style.transformOrigin = '50% 50%';
    popupEl.style.transform    = `translate(${tx}px, ${ty}px) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`;
    popupEl.style.borderRadius = '50%';
    popupEl.style.boxShadow    = 'var(--shadow)';
  });

  onTransitionEnd(popupEl, () => {
    popupEl.style.display         = 'none';
    popupEl.style.transform       = '';
    popupEl.style.transformOrigin = '';
    popupEl.style.borderRadius    = '';
    triggerEl.classList.remove('settings-btn--morphing');
    isOpen = false;
    isAnimating = false;
    unlockScroll();
  });
}

// Toggle entry point for the keyboard shortcut (Ctrl/Cmd + ,). openSettings and
// closeSettings both no-op mid-animation, so a rapid double-press is harmless.
export function toggleSettings() {
  if (isOpen) closeSettings();
  else openSettings();
}

// ── Startup campus restorers ──────────────────────────────────────────────────

// Called from script.js after setupCampusPicker() to apply the saved preferred campus.
export function applyPreferredCampusIfEnabled() {
  if (localStorage.getItem(PREFERRED_CAMPUS_ENABLED_KEY) !== 'true') return;
  const id = localStorage.getItem(PREFERRED_CAMPUS_ID_KEY);
  if (id) selectCampusById(id);
}

// Called from script.js after setupCampusPicker() to restore the last used campus.
export function applyRememberLastCampusIfEnabled() {
  if (localStorage.getItem(REMEMBER_LAST_CAMPUS_KEY) !== 'true') return;
  const id = localStorage.getItem(LAST_CAMPUS_ID_KEY);
  if (id) selectCampusById(id);
}

// ── Toggle helpers ────────────────────────────────────────────────────────────

function buildStepper(value, min, max, format, onChange) {
  let current = Math.max(min, Math.min(max, value));

  const el = document.createElement('div');
  el.className = 'settings-stepper';

  const minusBtn = document.createElement('button');
  minusBtn.type = 'button';
  minusBtn.className = 'settings-stepper__btn';
  minusBtn.innerHTML = '<span class="material-symbols-outlined">remove</span>';

  const valueEl = document.createElement('span');
  valueEl.className = 'settings-stepper__value';

  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'settings-stepper__btn';
  plusBtn.innerHTML = '<span class="material-symbols-outlined">add</span>';

  function refresh() {
    valueEl.textContent = format(current);
    minusBtn.disabled = current <= min;
    plusBtn.disabled = current >= max;
  }

  minusBtn.addEventListener('click', () => {
    if (current <= min) return;
    current--;
    refresh();
    haptics.trigger(defaultPatterns.light);
    onChange(current);
  });

  plusBtn.addEventListener('click', () => {
    if (current >= max) return;
    current++;
    refresh();
    haptics.trigger(defaultPatterns.light);
    onChange(current);
  });

  refresh();
  el.appendChild(minusBtn);
  el.appendChild(valueEl);
  el.appendChild(plusBtn);
  return el;
}

function buildToggle(isOn) {
  const btn = document.createElement('button');
  btn.className = 'settings-toggle' + (isOn ? ' on' : '');
  btn.setAttribute('role', 'switch');
  btn.setAttribute('aria-checked', String(isOn));
  const thumb = document.createElement('span');
  thumb.className = 'settings-toggle__thumb';
  btn.appendChild(thumb);
  return btn;
}

function setToggleState(btn, isOn) {
  btn.classList.toggle('on', isOn);
  btn.setAttribute('aria-checked', String(isOn));
}

// ── Campus section ────────────────────────────────────────────────────────────

function buildCampusSection() {
  // First-load default: enable "Remember last used" and pre-select Leonardo
  if (
    localStorage.getItem(PREFERRED_CAMPUS_ENABLED_KEY) === null &&
    localStorage.getItem(REMEMBER_LAST_CAMPUS_KEY) === null
  ) {
    localStorage.setItem(REMEMBER_LAST_CAMPUS_KEY, 'true');
    localStorage.setItem(LAST_CAMPUS_ID_KEY, 'MIA01');
  }

  const section = document.createElement('div');
  section.className = 'settings-section';

  // ── Section header
  section.innerHTML = `
    <div class="settings-section__header">
      <div class="settings-section__icon-badge">
        <span class="material-symbols-outlined">location_on</span>
      </div>
      <span class="settings-section__header-label" data-campus-label></span>
    </div>
  `;
  const headerLabel = section.querySelector('[data-campus-label]');

  const group = document.createElement('div');
  group.className = 'settings-group';
  section.appendChild(group);

  // ── Row 1: Preferred Campus toggle
  const preferredRow = document.createElement('div');
  preferredRow.className = 'settings-row';

  const preferredIconTitle = document.createElement('div');
  preferredIconTitle.className = 'settings-row__icon-title-container';
  preferredIconTitle.innerHTML = `
    <div class="settings-row__icon-badge" style="--badge-color: #FF9500">
      <span class="material-symbols-outlined">school</span>
    </div>
    <div class="settings-row__label-group">
      <span class="settings-row__label" data-preferred-label></span>
      <span class="settings-row__sublabel" data-preferred-sublabel></span>
    </div>
  `;
  const preferredLabel    = preferredIconTitle.querySelector('[data-preferred-label]');
  const preferredSublabel = preferredIconTitle.querySelector('[data-preferred-sublabel]');

  let preferredEnabled = localStorage.getItem(PREFERRED_CAMPUS_ENABLED_KEY) === 'true';
  const preferredToggle = buildToggle(preferredEnabled);
  preferredRow.appendChild(preferredIconTitle);
  preferredRow.appendChild(preferredToggle);
  group.appendChild(preferredRow);

  // ── Row 2: Campus select (conditionally shown)
  const pickerRow = document.createElement('div');
  pickerRow.className = 'settings-row settings-row--campus-picker';
  const campusSelect = document.createElement('select');
  campusSelect.className = 'settings-campus-select';

  function populateCampusSelect() {
    campusSelect.innerHTML = '';
    const campuses = classroomsData[0]?.campuses?.filter(c => c.buildings.length > 0) ?? [];
    if (campuses.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = t('settings.noCampusData');
      campusSelect.appendChild(opt);
      campusSelect.disabled = true;
    } else {
      campusSelect.disabled = false;
      campuses.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        campusSelect.appendChild(opt);
      });
      const saved = localStorage.getItem(PREFERRED_CAMPUS_ID_KEY);
      if (saved && campusSelect.querySelector(`option[value="${saved}"]`)) {
        campusSelect.value = saved;
      }
    }
  }

  pickerRow.appendChild(campusSelect);

  function showPickerRow(show) {
    if (show) {
      if (!pickerRow.parentElement) {
        group.insertBefore(pickerRow, rememberLastRow);
      }
    } else {
      pickerRow.remove();
    }
  }

  campusSelect.addEventListener('change', () => {
    localStorage.setItem(PREFERRED_CAMPUS_ID_KEY, campusSelect.value);
  });

  preferredToggle.addEventListener('click', () => {
    preferredEnabled = !preferredEnabled;
    localStorage.setItem(PREFERRED_CAMPUS_ENABLED_KEY, String(preferredEnabled));
    setToggleState(preferredToggle, preferredEnabled);
    if (preferredEnabled) {
      if (rememberLastEnabled) {
        rememberLastEnabled = false;
        localStorage.setItem(REMEMBER_LAST_CAMPUS_KEY, 'false');
        setToggleState(rememberLastToggle, false);
      }
      populateCampusSelect();
    }
    showPickerRow(preferredEnabled);
    haptics.trigger(defaultPatterns.light);
  });

  // ── Row 3: Remember Last Used toggle
  const rememberLastRow = document.createElement('div');
  rememberLastRow.className = 'settings-row';

  const rememberLastIconTitle = document.createElement('div');
  rememberLastIconTitle.className = 'settings-row__icon-title-container';
  rememberLastIconTitle.innerHTML = `
    <div class="settings-row__icon-badge" style="--badge-color: #34C759">
      <span class="material-symbols-outlined">history</span>
    </div>
    <div class="settings-row__label-group">
      <span class="settings-row__label" data-rememberlast-label></span>
      <span class="settings-row__sublabel" data-rememberlast-sublabel></span>
    </div>
  `;
  const rememberLastLabel    = rememberLastIconTitle.querySelector('[data-rememberlast-label]');
  const rememberLastSublabel = rememberLastIconTitle.querySelector('[data-rememberlast-sublabel]');

  let rememberLastEnabled = localStorage.getItem(REMEMBER_LAST_CAMPUS_KEY) === 'true';
  const rememberLastToggle = buildToggle(rememberLastEnabled);

  rememberLastRow.appendChild(rememberLastIconTitle);
  rememberLastRow.appendChild(rememberLastToggle);
  group.appendChild(rememberLastRow);

  rememberLastToggle.addEventListener('click', () => {
    rememberLastEnabled = !rememberLastEnabled;
    localStorage.setItem(REMEMBER_LAST_CAMPUS_KEY, String(rememberLastEnabled));
    setToggleState(rememberLastToggle, rememberLastEnabled);
    if (rememberLastEnabled && preferredEnabled) {
      preferredEnabled = false;
      localStorage.setItem(PREFERRED_CAMPUS_ENABLED_KEY, 'false');
      setToggleState(preferredToggle, false);
      showPickerRow(false);
    }
    haptics.trigger(defaultPatterns.light);
  });

  // Save last used campus whenever the campus selection changes
  document.addEventListener('campuschange', (e) => {
    if (rememberLastEnabled) {
      localStorage.setItem(LAST_CAMPUS_ID_KEY, e.detail.id);
    }
  });

  // Show picker row if already enabled
  if (preferredEnabled) {
    populateCampusSelect();
    showPickerRow(true);
  }

  // Retranslate all text nodes in this section
  function retranslate() {
    headerLabel.textContent        = t('settings.sectionCampus');
    animateI18nElement(headerLabel);
    preferredLabel.textContent     = t('settings.preferredCampus');
    animateI18nElement(preferredLabel);
    preferredSublabel.textContent  = t('settings.preferredCampusDesc');
    animateI18nElement(preferredSublabel);
    rememberLastLabel.textContent  = t('settings.rememberLastCampus');
    animateI18nElement(rememberLastLabel);
    rememberLastSublabel.textContent = t('settings.rememberLastCampusDesc');
    animateI18nElement(rememberLastSublabel);
    if (preferredEnabled && campusSelect.disabled && campusSelect.options[0]) {
      campusSelect.options[0].textContent = t('settings.noCampusData');
    }
  }

  retranslate();

  // Called each time the popup opens so the select is populated with live data
  function refreshIfNeeded() {
    if (preferredEnabled) populateCampusSelect();
  }

  return { sectionEl: section, retranslate, refreshIfNeeded };
}

// ── Popup content ─────────────────────────────────────────────────────────────

function buildPopup() {
  const popup = document.createElement('div');
  popup.className = 'settings-popup';
  popup.style.display = 'none';
  popup.innerHTML = `
    <div class="settings-popup__inner">
      <div class="settings-popup__title-row">
        <h2 class="settings-popup__title">${t('settings.title')}</h2>
        <button class="settings-close-btn" aria-label="Close settings">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>

      <div class="settings-section">
        <div class="settings-section__header">
          <div class="settings-section__icon-badge">
            <span class="material-symbols-outlined">translate</span>
          </div>
          <span class="settings-section__header-label">${t('settings.language')}</span>
        </div>
        <div class="settings-group">
          <div class="settings-row">
            <div class="settings-row__icon-title-container">
              <div class="settings-row__icon-badge" style="--badge-color: #007AFF">
                <span class="material-symbols-outlined">language</span>
              </div>
              <div class="settings-row__label-group">
                <span class="settings-row__label" data-i18n="settings.language">${t('settings.language')}</span>
                <span class="settings-row__sublabel" data-i18n="settings.languageDesc">${t('settings.languageDesc')}</span>
              </div>
            </div>
            <div class="settings-lang-toggle">
              <div class="settings-lang-indicator"></div>
              <button class="settings-lang-btn${getLocale() === 'en' ? ' active' : ''}" data-lang="en">
                <span class="settings-lang-btn__flag">🇬🇧</span>
                <span class="settings-lang-btn__name">English</span>
              </button>
              <button class="settings-lang-btn${getLocale() === 'it' ? ' active' : ''}" data-lang="it">
                <span class="settings-lang-btn__flag">🇮🇹</span>
                <span class="settings-lang-btn__name">Italiano</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section__header">
          <div class="settings-section__icon-badge">
            <span class="material-symbols-outlined">calendar_today</span>
          </div>
          <span class="settings-section__header-label" data-timefmt-section-header>${t('settings.sectionDateTime')}</span>
        </div>
        <div class="settings-group">
          <div class="settings-row">
            <div class="settings-row__icon-title-container">
              <div class="settings-row__icon-badge" style="--badge-color: #FF9500">
                <span class="material-symbols-outlined">schedule</span>
              </div>
              <div class="settings-row__label-group">
                <span class="settings-row__label" data-i18n="settings.timeFormat">${t('settings.timeFormat')}</span>
                <span class="settings-row__sublabel" data-i18n="settings.timeFormatDesc">${t('settings.timeFormatDesc')}</span>
              </div>
            </div>
            <div class="settings-lang-toggle" data-timefmt-toggle>
              <div class="settings-lang-indicator"></div>
              <button class="settings-lang-btn" data-timefmt="system">
                <span class="settings-lang-btn__name" data-i18n="settings.timeFormat.system">${t('settings.timeFormat.system')}</span>
              </button>
              <button class="settings-lang-btn" data-timefmt="12">
                <span class="settings-lang-btn__name" data-i18n="settings.timeFormat.12h">${t('settings.timeFormat.12h')}</span>
              </button>
              <button class="settings-lang-btn" data-timefmt="24">
                <span class="settings-lang-btn__name" data-i18n="settings.timeFormat.24h">${t('settings.timeFormat.24h')}</span>
              </button>
            </div>
          </div>
          <div class="settings-row" data-hide-sundays-row>
            <div class="settings-row__icon-title-container">
              <div class="settings-row__icon-badge" style="--badge-color: #FF3B30">
                <span class="material-symbols-outlined">event_busy</span>
              </div>
              <div class="settings-row__label-group">
                <span class="settings-row__label" data-i18n="settings.hideSundays">${t('settings.hideSundays')}</span>
                <span class="settings-row__sublabel" data-i18n="settings.hideSundaysDesc">${t('settings.hideSundaysDesc')}</span>
              </div>
            </div>
          </div>
          <div class="settings-row" data-interval-hours-row>
            <div class="settings-row__icon-title-container">
              <div class="settings-row__icon-badge" style="--badge-color: #007AFF">
                <span class="material-symbols-outlined">timelapse</span>
              </div>
              <div class="settings-row__label-group">
                <span class="settings-row__label" data-i18n="settings.intervalHours">${t('settings.intervalHours')}</span>
                <span class="settings-row__sublabel" data-i18n="settings.intervalHoursDesc">${t('settings.intervalHoursDesc')}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section__header">
          <div class="settings-section__icon-badge">
            <span class="material-symbols-outlined">search</span>
          </div>
          <span class="settings-section__header-label" data-i18n="settings.sectionResults">${t('settings.sectionResults')}</span>
        </div>
        <div class="settings-group">
          <div class="settings-row" data-show-partial-row>
            <div class="settings-row__icon-title-container">
              <div class="settings-row__icon-badge" style="--badge-color: #34C759">
                <span class="material-symbols-outlined">filter_alt</span>
              </div>
              <div class="settings-row__label-group">
                <span class="settings-row__label" data-i18n="settings.showPartial">${t('settings.showPartial')}</span>
                <span class="settings-row__sublabel" data-i18n="settings.showPartialDesc">${t('settings.showPartialDesc')}</span>
              </div>
            </div>
          </div>
          <div class="settings-row" data-auto-search-row>
            <div class="settings-row__icon-title-container">
              <div class="settings-row__icon-badge" style="--badge-color: #007AFF">
                <span class="material-symbols-outlined">bolt</span>
              </div>
              <div class="settings-row__label-group">
                <span class="settings-row__label" data-i18n="settings.autoSearch">${t('settings.autoSearch')}</span>
                <span class="settings-row__sublabel" data-i18n="settings.autoSearchDesc">${t('settings.autoSearchDesc')}</span>
              </div>
            </div>
          </div>
          <div class="settings-row" data-live-search-row>
            <div class="settings-row__icon-title-container">
              <div class="settings-row__icon-badge" style="--badge-color: #FF2D55">
                <span class="material-symbols-outlined">sync</span>
              </div>
              <div class="settings-row__label-group">
                <span class="settings-row__label" data-i18n="settings.liveSearch">${t('settings.liveSearch')}</span>
                <span class="settings-row__sublabel" data-i18n="settings.liveSearchDesc">${t('settings.liveSearchDesc')}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section__header">
          <div class="settings-section__icon-badge">
            <span class="material-symbols-outlined">tab</span>
          </div>
          <span class="settings-section__header-label" data-defaulttab-section-header>${t('settings.sectionNavigation')}</span>
        </div>
        <div class="settings-group">
          <div class="settings-row">
            <div class="settings-row__icon-title-container">
              <div class="settings-row__icon-badge" style="--badge-color: #5856D6">
                <span class="material-symbols-outlined">tab</span>
              </div>
              <div class="settings-row__label-group">
                <span class="settings-row__label" data-i18n="settings.defaultTab">${t('settings.defaultTab')}</span>
                <span class="settings-row__sublabel" data-i18n="settings.defaultTab.desc">${t('settings.defaultTab.desc')}</span>
              </div>
            </div>
            <div class="settings-lang-toggle" data-defaulttab-toggle>
              <div class="settings-lang-indicator"></div>
              <button class="settings-lang-btn" data-defaulttab="available">
                <span class="settings-seg-icon material-symbols-outlined">event_available</span>
                <span class="settings-lang-btn__name" data-i18n="settings.defaultTab.available">${t('settings.defaultTab.available')}</span>
              </button>
              <button class="settings-lang-btn" data-defaulttab="search">
                <span class="settings-seg-icon material-symbols-outlined">search</span>
                <span class="settings-lang-btn__name" data-i18n="settings.defaultTab.search">${t('settings.defaultTab.search')}</span>
              </button>
              <div class="settings-seg-separator"></div>
              <button class="settings-lang-btn" data-defaulttab="last">
                <span class="settings-seg-icon material-symbols-outlined">history</span>
                <span class="settings-lang-btn__name" data-i18n="settings.defaultTab.last">${t('settings.defaultTab.last')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      ${IS_STABLE_BUILD ? '' : `
      <div class="settings-section">
        <div class="settings-section__header">
          <div class="settings-section__icon-badge">
            <span class="material-symbols-outlined">dns</span>
          </div>
          <span class="settings-section__header-label" data-i18n="settings.sectionBackend">${t('settings.sectionBackend')}</span>
        </div>
        <div class="settings-group">
          <div class="settings-row" data-use-beta-backend-row>
            <div class="settings-row__icon-title-container">
              <div class="settings-row__icon-badge" style="--badge-color: #5856D6">
                <span class="material-symbols-outlined">science</span>
              </div>
              <div class="settings-row__label-group">
                <span class="settings-row__label" data-i18n="settings.useBetaBackend">${t('settings.useBetaBackend')}</span>
                <span class="settings-row__sublabel" data-i18n="settings.useBetaBackendDesc">${t('settings.useBetaBackendDesc')}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      `}

    </div>
  `;

  popup.querySelector('.settings-close-btn').addEventListener('click', () => closeSettings());

  // Append campus section
  const inner = popup.querySelector('.settings-popup__inner');
  const { sectionEl: campusSectionEl, retranslate: retranslateCampus, refreshIfNeeded } = buildCampusSection();
  refreshCampusSelectFn = refreshIfNeeded;
  inner.appendChild(campusSectionEl);

  // Wire language buttons and sliding indicator
  const toggle = popup.querySelector('.settings-lang-toggle');
  const indicator = toggle.querySelector('.settings-lang-indicator');

  function positionIndicator(animate) {
    const activeBtn = toggle.querySelector('.settings-lang-btn.active');
    if (!activeBtn) return;
    if (!animate) indicator.style.transition = 'none';
    indicator.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
    indicator.style.width = `${activeBtn.offsetWidth}px`;
    indicator.style.height = `${activeBtn.offsetHeight}px`;
    if (!animate) {
      indicator.getBoundingClientRect(); // force reflow
      indicator.style.transition = '';
    }
  }

  popup.querySelectorAll('.settings-lang-btn[data-lang]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const lang = btn.dataset.lang;
      if (lang === getLocale()) return;
      await setLocale(lang);
      haptics.trigger(defaultPatterns.light);
      updateLangButtons(popup, positionIndicator);
    });
  });

  // Expose so openSettings() can snap after first display
  positionIndicatorFn = positionIndicator;

  // Wire time format buttons and sliding indicator
  const timeFmtToggle = popup.querySelector('[data-timefmt-toggle]');
  const timeFmtIndicator = timeFmtToggle.querySelector('.settings-lang-indicator');
  const savedTimeFmt = localStorage.getItem(TIME_FORMAT_KEY) ?? 'system';
  timeFmtToggle.querySelector(`[data-timefmt="${savedTimeFmt}"]`)?.classList.add('active');

  function positionTimeFmtIndicator(animate) {
    const activeBtn = timeFmtToggle.querySelector('.settings-lang-btn.active');
    if (!activeBtn) return;
    if (!animate) timeFmtIndicator.style.transition = 'none';
    timeFmtIndicator.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
    timeFmtIndicator.style.width = `${activeBtn.offsetWidth}px`;
    timeFmtIndicator.style.height = `${activeBtn.offsetHeight}px`;
    if (!animate) {
      timeFmtIndicator.getBoundingClientRect(); // force reflow
      timeFmtIndicator.style.transition = '';
    }
  }

  timeFmtToggle.querySelectorAll('.settings-lang-btn[data-timefmt]').forEach(btn => {
    btn.addEventListener('click', () => {
      const fmt = btn.dataset.timefmt;
      if (timeFmtToggle.querySelector('.settings-lang-btn.active') === btn) return;
      localStorage.setItem(TIME_FORMAT_KEY, fmt);
      timeFmtToggle.querySelectorAll('.settings-lang-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      positionTimeFmtIndicator(true);
      haptics.trigger(defaultPatterns.light);
      window.dispatchEvent(new CustomEvent('timeformatchange'));
    });
  });

  positionTimeFmtIndicatorFn = positionTimeFmtIndicator;

  // Wire Hide Sundays toggle
  const hideSundaysRow = popup.querySelector('[data-hide-sundays-row]');
  const hideSundaysToggle = buildToggle(localStorage.getItem(HIDE_SUNDAYS_KEY) === 'true');
  hideSundaysRow.appendChild(hideSundaysToggle);
  hideSundaysToggle.addEventListener('click', () => {
    const isOn = !hideSundaysToggle.classList.contains('on');
    setToggleState(hideSundaysToggle, isOn);
    localStorage.setItem(HIDE_SUNDAYS_KEY, String(isOn));
    haptics.trigger(defaultPatterns.light);
    window.dispatchEvent(new CustomEvent('hidesundayschange', { detail: { hidden: isOn } }));
  });

  // Wire Interval Hours stepper
  const intervalHoursRow = popup.querySelector('[data-interval-hours-row]');
  const savedHours = parseInt(localStorage.getItem(INTERVAL_HOURS_KEY), 10) || 2;
  const intervalStepper = buildStepper(savedHours, 1, 12, v => `${v}h`, v => {
    localStorage.setItem(INTERVAL_HOURS_KEY, String(v));
  });
  intervalHoursRow.appendChild(intervalStepper);

  // Wire Show Partially Free toggle (default: true)
  const showPartialRow = popup.querySelector('[data-show-partial-row]');
  const showPartialSaved = localStorage.getItem(SHOW_PARTIAL_KEY);
  const showPartialToggle = buildToggle(showPartialSaved === null ? true : showPartialSaved === 'true');
  showPartialRow.appendChild(showPartialToggle);
  showPartialToggle.addEventListener('click', () => {
    const isOn = !showPartialToggle.classList.contains('on');
    setToggleState(showPartialToggle, isOn);
    localStorage.setItem(SHOW_PARTIAL_KEY, String(isOn));
    haptics.trigger(defaultPatterns.light);
  });

  // Wire Auto-Search on Load toggle (default: true)
  const autoSearchRow = popup.querySelector('[data-auto-search-row]');
  const autoSearchSaved = localStorage.getItem(AUTO_SEARCH_KEY);
  const autoSearchOn = autoSearchSaved === null ? true : autoSearchSaved === 'true';
  const autoSearchToggle = buildToggle(autoSearchOn);
  autoSearchRow.appendChild(autoSearchToggle);

  const autoSearchWarning = document.createElement('div');
  autoSearchWarning.className = 'settings-warning' + (autoSearchOn ? '' : ' settings-warning--hidden');
  autoSearchWarning.innerHTML = `
    <span class="material-symbols-outlined settings-warning__icon">warning</span>
    <span class="settings-warning__text" data-i18n="settings.autoSearchWarning">${t('settings.autoSearchWarning')}</span>
  `;
  autoSearchRow.insertAdjacentElement('afterend', autoSearchWarning);

  autoSearchToggle.addEventListener('click', () => {
    const isOn = !autoSearchToggle.classList.contains('on');
    setToggleState(autoSearchToggle, isOn);
    localStorage.setItem(AUTO_SEARCH_KEY, String(isOn));
    autoSearchWarning.classList.toggle('settings-warning--hidden', !isOn);
    haptics.trigger(defaultPatterns.light);
  });

  // Wire Live Search toggle (default: true)
  const liveSearchRow = popup.querySelector('[data-live-search-row]');
  const liveSearchSaved = localStorage.getItem(LIVE_SEARCH_KEY);
  const liveSearchOn = liveSearchSaved === null ? true : liveSearchSaved === 'true';
  const liveSearchToggle = buildToggle(liveSearchOn);
  liveSearchRow.appendChild(liveSearchToggle);

  const liveSearchWarning = document.createElement('div');
  liveSearchWarning.className = 'settings-warning' + (liveSearchOn ? '' : ' settings-warning--hidden');
  liveSearchWarning.innerHTML = `
    <span class="material-symbols-outlined settings-warning__icon">warning</span>
    <span class="settings-warning__text" data-i18n="settings.liveSearchWarning">${t('settings.liveSearchWarning')}</span>
  `;
  liveSearchRow.insertAdjacentElement('afterend', liveSearchWarning);

  liveSearchToggle.addEventListener('click', () => {
    const isOn = !liveSearchToggle.classList.contains('on');
    setToggleState(liveSearchToggle, isOn);
    localStorage.setItem(LIVE_SEARCH_KEY, String(isOn));
    liveSearchWarning.classList.toggle('settings-warning--hidden', !isOn);
    haptics.trigger(defaultPatterns.light);
  });

  // Wire Default Tab 3-way toggle
  const defaultTabToggle = popup.querySelector('[data-defaulttab-toggle]');
  const defaultTabIndicator = defaultTabToggle.querySelector('.settings-lang-indicator');
  const savedDefaultTab = localStorage.getItem(DEFAULT_TAB_KEY) ?? 'available';
  defaultTabToggle.querySelector(`[data-defaulttab="${savedDefaultTab}"]`)?.classList.add('active');

  function positionDefaultTabIndicator(animate) {
    const activeBtn = defaultTabToggle.querySelector('.settings-lang-btn.active');
    if (!activeBtn) return;
    if (!animate) defaultTabIndicator.style.transition = 'none';
    defaultTabIndicator.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
    defaultTabIndicator.style.width = `${activeBtn.offsetWidth}px`;
    defaultTabIndicator.style.height = `${activeBtn.offsetHeight}px`;
    if (!animate) {
      defaultTabIndicator.getBoundingClientRect();
      defaultTabIndicator.style.transition = '';
    }
  }

  defaultTabToggle.querySelectorAll('.settings-lang-btn[data-defaulttab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.defaulttab;
      if (defaultTabToggle.querySelector('.settings-lang-btn.active') === btn) return;
      localStorage.setItem(DEFAULT_TAB_KEY, val);
      defaultTabToggle.querySelectorAll('.settings-lang-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      positionDefaultTabIndicator(true);
      haptics.trigger(defaultPatterns.light);
    });
  });

  positionDefaultTabIndicatorFn = positionDefaultTabIndicator;

  // Wire Use Beta Backend toggle (non-stable builds only, default: true)
  const useBetaBackendRow = popup.querySelector('[data-use-beta-backend-row]');
  if (useBetaBackendRow) {
    const useBetaBackendSaved = localStorage.getItem(USE_BETA_BACKEND_KEY);
    const useBetaBackendOn = useBetaBackendSaved === null ? true : useBetaBackendSaved === 'true';
    const useBetaBackendToggle = buildToggle(useBetaBackendOn);
    useBetaBackendRow.appendChild(useBetaBackendToggle);
    useBetaBackendToggle.addEventListener('click', () => {
      const isOn = !useBetaBackendToggle.classList.contains('on');
      setToggleState(useBetaBackendToggle, isOn);
      localStorage.setItem(USE_BETA_BACKEND_KEY, String(isOn));
      haptics.trigger(defaultPatterns.light);
    });
  }

  return { popup, positionIndicator, positionTimeFmtIndicator, positionDefaultTabIndicator, retranslateCampus };
}

function updateLangButtons(popup, positionIndicator) {
  popup.querySelectorAll('.settings-lang-btn[data-lang]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === getLocale());
  });
  positionIndicator?.(true);
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initSettings() {
  triggerEl = document.getElementById('settings-btn');
  if (!triggerEl) return;

  const { popup, positionIndicator, positionTimeFmtIndicator, positionDefaultTabIndicator, retranslateCampus } = buildPopup();
  popupEl = popup;
  document.body.appendChild(popupEl);

  triggerEl.addEventListener('click', () => {
    haptics.trigger(defaultPatterns.light);
    openSettings();
  });

  // Keep title and section headers in sync when the language changes
  const titleEl = popupEl.querySelector('.settings-popup__title');
  const sectionHeaderLabelEl = popupEl.querySelector('.settings-section__header-label');
  const timeFmtHeaderLabelEl = popupEl.querySelector('[data-timefmt-section-header]');
  const defaultTabHeaderLabelEl = popupEl.querySelector('[data-defaulttab-section-header]');

  onLanguageSwitch(() => {
    titleEl.textContent = t('settings.title');
    animateI18nElement(titleEl);
    sectionHeaderLabelEl.textContent = t('settings.language');
    animateI18nElement(sectionHeaderLabelEl);
    if (timeFmtHeaderLabelEl) {
      timeFmtHeaderLabelEl.textContent = t('settings.sectionDateTime');
      animateI18nElement(timeFmtHeaderLabelEl);
    }
    if (defaultTabHeaderLabelEl) {
      defaultTabHeaderLabelEl.textContent = t('settings.sectionNavigation');
      animateI18nElement(defaultTabHeaderLabelEl);
    }
    popupEl.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.dataset.i18n);
    });
    updateLangButtons(popupEl, positionIndicator);
    positionTimeFmtIndicator?.(false);
    positionDefaultTabIndicator?.(false);
    retranslateCampus();
  });

  // Escape closes the popup
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSettings();
  });

  // Keep popup centred on resize while open
  window.addEventListener('resize', () => {
    if (!isOpen || isAnimating) return;
    popupEl.style.transition = 'none';
    applyGeometry(popupEl, getPopupTarget());
    popupEl.getBoundingClientRect();
    popupEl.style.transition = '';
  });
}
