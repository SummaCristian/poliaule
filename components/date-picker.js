import { getLocale } from '../i18n.js';
import { haptics } from './haptics.js';
import { classroomsData } from '../available-rooms-script.js';
import { createPillSelector } from './pill-selector.js';

// Sets the allowed dates into the date picker,
// and populates the custom UI and the hidden select with the available dates.
//
// getPreferInitialDate is a getter (not a plain value) because the caller
// (script.js) computes the "prefer tomorrow after 20:15" date in
// setupTimePickers, which can still be running when this function's deferred
// auto-select callback fires — reading it live avoids a stale-capture bug.
export function setupDatePicker(getPreferInitialDate = () => null) {
  const datePicker = document.getElementById('date-picker');
  const availableDates = classroomsData.map(day => day.date);
  const toInputFormat = d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const formatLocal = d => [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-');

  // --- Populate the date picker UI ---
  const container = document.querySelector('.date-picker-container');

  // Derive single-letter day names from the current locale (Sun=0 … Sat=6).
  const dayFormatter = new Intl.DateTimeFormat(getLocale(), { weekday: 'narrow' });
  const DAY_NAMES = Array.from({ length: 7 }, (_, i) =>
    dayFormatter.format(new Date(2000, 0, 2 + i)) // Jan 2 2000 = Sunday
  );

  // Clear any hardcoded elements, keep only the indicator
  container.querySelectorAll('.date-element-container').forEach(el => el.remove());

  // Generate every day from min to max, including skipped ones
  const allDates = [];
  const parseLocalFromKey = key => {
    const [y, m, d] = [key.slice(0, 4), key.slice(4, 6), key.slice(6, 8)].map(Number);
    return new Date(y, m - 1, d);
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dataStart = parseLocalFromKey(availableDates.at(0));
  const cursor = today < dataStart ? today : dataStart;
  const end = parseLocalFromKey(availableDates.at(-1));

  while (cursor <= end) {
    allDates.push(formatLocal(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  allDates.forEach((dateStr, index) => {
    const date = new Date(dateStr);
    const dayOfWeek = DAY_NAMES[date.getDay()];
    const dayNumber = date.getDate();
    const isSunday = date.getDay() === 0;
    const isSkipped = !availableDates.includes(dateStr.replace(/-/g, ''));

    // Only add valid dates to the hidden select
    if (!isSkipped) {
      datePicker.insertAdjacentHTML('beforeend',
        `<option value="${dateStr}">${dateStr}</option>`
      );
    }

    // Add the visual element regardless, dimming skipped days
    const el = document.createElement('div');
    el.className = `date-element-container${isSkipped ? ' date-skipped' : ''}`;
    el.dataset.date = dateStr;
    el.dataset.index = index;
    el.innerHTML = `
      <span class="date-day-of-week ${isSunday ? 'date-sunday' : ''}">${dayOfWeek}</span>
      <span class="date-number">${dayNumber}</span>
    `;
    container.appendChild(el);
  });

  // --- Indicator logic (drag/spring physics ported from bottom-nav.js's
  // tab pill — see pill-selector.js) ---
  const elements = container.querySelectorAll('.date-element-container');

  const pillSelector = createPillSelector(container, {
    onSelect(el, { silent = false } = {}) {
      // Only fire `change` on a real date change — re-committing the current
      // day (e.g. the deferred re-anchor when the <date-chip-picker> popup
      // opens) shouldn't retrigger the results search.
      const changed = datePicker.value !== el.dataset.date;
      datePicker.value = el.dataset.date;
      if (changed) datePicker.dispatchEvent(new Event('change', { bubbles: true }));

      // Haptic feedback (skipped for programmatic/silent placement, e.g. the
      // deferred re-anchor when the wrapping <date-chip-picker> popup opens)
      if (silent || !changed) return;
      haptics.trigger([
        { duration: 30 },
        { delay: 60, duration: 40, intensity: 1 },
      ]);
    },
  });

  // When this picker lives inside <date-chip-picker>, its cells have zero size
  // while the popup is closed, so the initial auto-select below can't place the
  // sliding indicator. Re-anchor it from the committed <select> value once the
  // cells actually have a layout (the popup open triggers the ResizeObserver
  // wired in repositionAll).
  function reanchorFromValue() {
    if (pillSelector.activeElement) return;
    const cells = [...container.querySelectorAll('.date-element-container')];
    // Bail while the picker has no layout (e.g. inside a closed
    // <date-chip-picker> popup) — otherwise selectElement() falls through to
    // its index===-1 path and re-fires onSelect (→ a spurious `change` and a
    // results-grid redraw) every time the popup is hidden.
    if (!cells.some(e => e.offsetWidth > 0)) return;
    const el = cells.find(
      e => e.dataset.date === datePicker.value && !e.classList.contains('date-skipped')
    );
    if (el) pillSelector.selectElement(el, { silent: true, animate: false });
  }

  document.getElementById('today-indicator').addEventListener('click', () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayEl = container.querySelector(`.date-element-container[data-date="${todayStr}"]`);
    if (todayEl) pillSelector.selectElement(todayEl);
  });

  // Position the "Today" popover above the today cell
  function positionTodayIndicator() {
    const today = new Date();
    const todayStr = formatLocal(today);
    const todayEl = container.querySelector(`.date-element-container[data-date="${todayStr}"]`);
    const todayIndicator = document.getElementById('today-indicator');

    if (!todayEl) {
      todayIndicator.classList.add('hidden');
      return;
    }

    todayIndicator.classList.remove('hidden');

    // Use offsetTop/offsetLeft (layout values) instead of getBoundingClientRect()
    // so that CSS transform animations on ancestor elements (e.g. the tab appear
    // animation's scale(0.95)) don't skew the measurements.
    const cellCenterX = container.offsetLeft + todayEl.offsetLeft + todayEl.offsetWidth / 2;
    const topOffset = container.offsetTop - todayIndicator.offsetHeight - 8;

    todayIndicator.style.left = `${cellCenterX}px`;
    todayIndicator.style.top = `${topOffset}px`;
  }

  function repositionAll() {
    pillSelector.refresh();
    reanchorFromValue();
    positionTodayIndicator();
  }

  window.addEventListener('resize', repositionAll);
  new ResizeObserver(repositionAll).observe(container.closest('.date-picker'));

  // Belt-and-suspenders alongside the ResizeObserver above: while the
  // Available tab is hidden (content-visibility:hidden), any refresh() call
  // — e.g. the auto-select pass below, which can run in the background
  // while the user is still on the Campus tab — measures offsetTop/offsetLeft
  // against an unlaid-out subtree and bakes wrong coordinates into the
  // indicator's inline styles. ResizeObserver doesn't reliably fire when
  // content-visibility flips back to visible in every browser, so also
  // recompute explicitly once bottom-nav.js confirms this tab is visible.
  document.getElementById('available-classrooms-container')
    ?.addEventListener('tabvisible', repositionAll);

  // Apply initial hide-sundays state
  const hideSundaysContainer = container.closest('.date-picker');
  if (localStorage.getItem('poliAule_hideSundays') === 'true') {
    hideSundaysContainer.classList.add('date-picker--hide-sundays');
  }
  window.addEventListener('hidesundayschange', e => {
    hideSundaysContainer.classList.toggle('date-picker--hide-sundays', e.detail.hidden);
    repositionAll();
  });

  // Auto-select today if available, otherwise fall back to the first available date
  // Wait for fonts to load to ensure accurate element measurements
  document.fonts.ready.then(() => {
    requestAnimationFrame(() => {
      // Measure anchors only once fonts are loaded, same reasoning as the
      // auto-select below: font swap can shift cell widths/positions.
      pillSelector.refresh();

      // Auto-select preferred date (tomorrow when after 20:15) or first available
      const preferInitialDate = getPreferInitialDate();
      const preferred = preferInitialDate
        && [...elements].find(el => el.dataset.date === preferInitialDate && !el.classList.contains('date-skipped'));
      const firstAvailable = [...elements].find(el => !el.classList.contains('date-skipped'));
      if (preferred || firstAvailable) pillSelector.selectElement(preferred || firstAvailable, { animate: false });

      positionTodayIndicator();

      // Show the container now that dates are populated and positioned
      container.style.opacity = '1';
    });
  });
}
