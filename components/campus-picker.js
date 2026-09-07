import {
  computePosition,
  flip,
  shift,
  offset,
} from "https://cdn.jsdelivr.net/npm/@floating-ui/dom@1/+esm";
import { haptics, defaultPatterns } from './haptics.js';
import { attachLiquidGlass } from './liquid-glass.js';
import { t } from '../i18n.js';

const STYLE_LINKS = `
  <link rel="stylesheet" href="https://cdn.hugeicons.com/font/hgi-stroke-rounded.css">
  <link rel="stylesheet" href="./components/campus-picker.css">
`;

// The trigger (pill + skeleton) lives in a shadow root on <campus-chip-picker>
// itself, inside the sticky picker bar.
const TRIGGER_TEMPLATE = document.createElement('template');
TRIGGER_TEMPLATE.innerHTML = `
  ${STYLE_LINKS}

  <select class="cp-native" tabindex="-1" aria-hidden="true"></select>

  <button type="button" class="campus-select" aria-haspopup="listbox"
          aria-expanded="false" aria-controls="cp-listbox">
    <i class="hgi-stroke hgi-university campus-select__icon" aria-hidden="true"></i>
    <span class="campus-select__box">
      <span class="campus-select__label"></span>
      <span class="campus-select__value"></span>
    </span>
    <i class="hgi-stroke hgi-arrow-down-01 campus-select__chevron" aria-hidden="true"></i>
  </button>

  <div class="campus-select-skeleton" aria-hidden="true"></div>
`;

// The overlay + morphing panel live in a SECOND shadow root, on a host element
// appended to <body>. That keeps the panel (a position:fixed + backdrop-filter
// element) out of the sticky picker bar's stacking context — nested inside one,
// iOS Safari repaints the bottom safe-area toolbar opaque and leaves it stuck —
// while preserving shadow-scoped styling. Same escape as the date picker's
// document.body.appendChild, just with encapsulation kept.
const PANEL_TEMPLATE = document.createElement('template');
PANEL_TEMPLATE.innerHTML = `
  ${STYLE_LINKS}

  <div class="cp-overlay" hidden></div>
  <div id="cp-listbox" class="cp-popup" role="listbox" tabindex="-1" aria-label="Campus">
    <div class="cp-popup__inner">
      <div class="cp-popup__title" aria-hidden="true">
        <i class="hgi-stroke hgi-university cp-popup__title-icon"></i>
        <span class="cp-popup__title-text"></span>
      </div>
    </div>
  </div>
`;

const TYPEAHEAD_RESET_MS = 500;
// Matches the app's other morphs (settings.js, time-picker.js).
const MORPH_MS = 420;
const MORPH_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// <campus-chip-picker> is a fully custom single-select listbox. A visually
// hidden native <select> in the shadow root stays the data model and the real
// form control — it's mirrored onto the light-DOM hidden <input name="campus">
// and is what fires the `change` event. The glass <button> trigger and the
// portaled listbox panel are the UI, driven off that <select>.
//
// Form-association can't reach into the shadow root, so the submittable field
// stays a hidden <input> in the light DOM (declared in index.html); the
// <select> value is mirrored onto it on every change.
export class CampusChipPicker extends HTMLElement {
  #select = null;
  #hiddenInput = null;
  #trigger = null;
  #popup = null;
  #valueEl = null;
  #labelEl = null;
  #rows = [];            // [{ id, el }] in visual order
  #activeIndex = -1;
  #inner = null;
  #titleEl = null;
  #overlay = null;
  #panelHost = null;     // <body>-level host element for the panel shadow root
  #panelRoot = null;     // its shadow root (holds #overlay + #popup)
  #isOpen = false;
  #isAnimating = false;
  #docked = false;         // inline-expanded in the desktop column (no popup)
  #scrollLocked = false;
  #preventScroll = null;
  #typeaheadBuffer = '';
  #typeaheadTimer = 0;
  #changeWired = false;
  // Bumped on every open/close so deferred steps from a superseded transition
  // (rAF callbacks, the awaited #panelTarget, morph-end handlers, the
  // post-close cleanup timer) can detect they're stale and bail — otherwise a
  // fast close→open tears the freshly-opened popup back down.
  #seq = 0;
  #cleanupTimer = 0;
  #morphCleanup = null;

  connectedCallback() {
    if (this.shadowRoot) return; // already initialized (re-parenting, etc.)

    // ── Trigger root (on this element, inside the sticky picker bar) ──────
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.appendChild(TRIGGER_TEMPLATE.content.cloneNode(true));

    this.#select = shadow.querySelector('.cp-native');
    this.#trigger = shadow.querySelector('.campus-select');
    this.#valueEl = shadow.querySelector('.campus-select__value');
    this.#labelEl = shadow.querySelector('.campus-select__label');
    this.#hiddenInput = this.querySelector('input[type="hidden"]');

    // ── Panel root (on a <body>-level host, outside every ancestor
    //    stacking context) ────────────────────────────────────────────────
    this.#panelHost = document.createElement('div');
    this.#panelHost.className = 'cp-panel-host';
    this.#panelRoot = this.#panelHost.attachShadow({ mode: 'open' });
    this.#panelRoot.appendChild(PANEL_TEMPLATE.content.cloneNode(true));
    document.body.appendChild(this.#panelHost);

    this.#popup = this.#panelRoot.querySelector('.cp-popup');
    this.#inner = this.#panelRoot.querySelector('.cp-popup__inner');
    this.#titleEl = this.#panelRoot.querySelector('.cp-popup__title-text');
    this.#overlay = this.#panelRoot.querySelector('.cp-overlay');

    attachLiquidGlass(this.#trigger);
    // Keep the press / drag-deform gesture alive on the open panel, but only
    // when grabbed by its title bar — the body is a scrollable list.
    attachLiquidGlass(this.#popup, { from: '.cp-popup__title' });
    this.#trigger.addEventListener('click', () => this.#toggle());
    this.#trigger.addEventListener('keydown', (e) => this.#onTriggerKeydown(e));
    this.#popup.addEventListener('keydown', (e) => this.#onKeydown(e));
    this.#popup.addEventListener('click', (e) => this.#onRowClick(e));
    this.#popup.addEventListener('pointermove', (e) => this.#onRowHover(e));
    // The pointer-driven active row must not stay lit once the cursor leaves
    // the list (or moves onto the title / a section label).
    this.#popup.addEventListener('pointerleave', () => this.#clearPointerActive());
    this.#overlay.addEventListener('click', () => this.#close());
  }

  disconnectedCallback() {
    this.#unlockScroll();
    // The panel host is deliberately left on <body> across a disconnect —
    // this element is only ever re-parented, never destroyed, and the
    // connectedCallback guard would skip re-creating it anyway.
  }

  // Programmatically selects a campus by ID. No-op if the ID isn't available.
  selectCampusById(id, _animate = true) {
    const select = this.#select;
    if (!select || !select.querySelector(`option[value="${CSS.escape(id)}"]`)) return;
    if (select.value === id) return;
    select.value = id;
    select.dispatchEvent(new Event('change'));
  }

  // Re-applies translations that live inside the shadow root (the "Other
  // cities" section header + the "CAMPUS" trigger label). Called on language
  // switch from script.js.
  retranslate() {
    if (this.#labelEl) this.#labelEl.textContent = t('tabs.campus');
    if (this.#titleEl) this.#titleEl.textContent = t('tabs.campus');

    const og = this.#select?.querySelector('optgroup[data-i18n]');
    if (og) og.label = t(og.dataset.i18n);

    const section = this.#popup?.querySelector('.cp-section[data-i18n]');
    if (section) {
      const lbl = section.querySelector('.cp-section-label');
      if (lbl) lbl.textContent = t(section.dataset.i18n);
    }
  }

  // Builds the option list from the static campus data, keeping only campuses
  // that actually have buildings.
  setup(staticData) {
    const select = this.#select;
    const hiddenInput = this.#hiddenInput;
    if (!select) return;

    // Set here rather than in connectedCallback: i18n isn't loaded that early.
    if (this.#labelEl) this.#labelEl.textContent = t('tabs.campus');
    if (this.#titleEl) this.#titleEl.textContent = t('tabs.campus');

    const available = staticData.filter(c => c.buildings.length > 0);

    // Group by city, then split: cities that contain a grouped campus (Milano:
    // Città Studi / Bovisa) get their own section; standalone single-campus
    // cities are collected under "Other cities".
    const byCity = new Map();
    for (const campus of available) {
      if (!byCity.has(campus.city)) byCity.set(campus.city, []);
      byCity.get(campus.city).push(campus);
    }

    const mainCities = [];
    const otherCampuses = [];
    for (const [city, list] of byCity) {
      if (list.some(c => c.group)) mainCities.push([city, list]);
      else otherCampuses.push(...list);
    }

    // ── Rebuild the hidden <select> and the custom listbox in one pass ──
    select.innerHTML = '';
    this.#inner.querySelectorAll('.cp-section').forEach(s => s.remove());
    this.#rows = [];

    const addSection = (labelText, i18nKey) => {
      const og = document.createElement('optgroup');
      og.label = labelText;
      if (i18nKey) og.dataset.i18n = i18nKey;
      select.appendChild(og);

      const section = document.createElement('div');
      section.className = 'cp-section';
      if (i18nKey) section.dataset.i18n = i18nKey;
      const lbl = document.createElement('div');
      lbl.className = 'cp-section-label';
      lbl.textContent = labelText;
      section.appendChild(lbl);
      this.#inner.appendChild(section);

      return { og, section };
    };

    const addCampus = (campus, og, section) => {
      const opt = document.createElement('option');
      opt.value = campus.id;
      opt.textContent = campus.name;
      og.appendChild(opt);

      const row = document.createElement('div');
      row.className = 'campus-option';
      row.setAttribute('role', 'option');
      row.id = `cp-opt-${campus.id}`;
      row.dataset.id = campus.id;
      row.setAttribute('aria-selected', 'false');

      const check = document.createElement('i');
      check.className = 'hgi-stroke hgi-tick-02 campus-option__check';
      check.setAttribute('aria-hidden', 'true');
      row.appendChild(check);

      const text = document.createElement('span');
      text.className = 'campus-option__text';

      const name = document.createElement('span');
      name.className = 'campus-option__name';
      name.textContent = campus.name;
      text.appendChild(name);

      if (campus.group) {
        const area = document.createElement('span');
        area.className = 'campus-option__area';
        area.textContent = campus.group;
        text.appendChild(area);
      }

      row.appendChild(text);
      section.appendChild(row);
      this.#rows.push({ id: campus.id, name: campus.name.toLowerCase(), el: row });
    };

    for (const [city, list] of mainCities) {
      const { og, section } = addSection(city, null);
      list.forEach(c => addCampus(c, og, section));
    }

    if (otherCampuses.length > 0) {
      const { og, section } = addSection(t('campus.otherLabel'), 'campus.otherLabel');
      otherCampuses.forEach(c => addCampus(c, og, section));
    }

    // Silent auto-select of the first campus, matching the old picker (no
    // `campuschange` event on initial population).
    if (select.options.length > 0) {
      select.selectedIndex = 0;
      hiddenInput.value = select.value;
    }
    this.#syncFromSelect();

    if (!this.#changeWired) {
      this.#changeWired = true;
      select.addEventListener('change', () => {
        hiddenInput.value = select.value;
        this.#syncFromSelect();
        document.dispatchEvent(new CustomEvent('campuschange', { detail: { id: select.value } }));
        haptics.trigger(defaultPatterns.light);
      });
    }
  }

  // ── Selection state ───────────────────────────────────────────────────

  // Mirrors the <select>'s current value onto the trigger label and the
  // listbox rows' aria-selected / active state.
  #syncFromSelect() {
    const value = this.#select.value;
    const selected = this.#select.selectedOptions[0];
    if (this.#valueEl) this.#valueEl.textContent = selected ? selected.textContent : '';

    this.#rows.forEach(({ id, el }, i) => {
      const isSel = id === value;
      el.setAttribute('aria-selected', isSel ? 'true' : 'false');
      if (isSel) this.#activeIndex = i;
    });
  }

  #commit(id) {
    if (this.#select.value !== id) {
      this.#select.value = id;
      this.#select.dispatchEvent(new Event('change'));
    }
    this.#close();
  }

  // ── Open / close — the glass pill morphs into the listbox panel and back,
  //    same technique as settings.js / time-picker.js: a fixed-position shell
  //    whose top/left/width/height/border-radius transition between the
  //    trigger's box and the panel's, with the trigger hidden (`.cp-anim`)
  //    and the inner content fading in once expanded. ──────────────────────

  #toggle() {
    if (this.#docked) return;
    this.#isOpen ? this.#close() : this.#open();
  }

  // ── Docked (inline-expanded) mode ───────────────────────────────────
  // Desktop: the listbox panel sits directly in the form column instead of
  // morphing out of the pill into a fixed popup. picker-dock.js toggles this.
  // The panel lives in a <body>-level shadow host (#panelHost); docking moves
  // that host into .picker-row (as a sibling of this element) and hides the pill.
  setDocked(on) {
    on = !!on;
    if (on === this.#docked) return;
    this.#docked = on;

    if (on) {
      if (this.#isOpen) this.#forceClose();
      this.#overlay.hidden = true;
      this.#popup.classList.remove('cp-popup--closing');
      this.#popup.classList.add('cp-popup--docked', 'cp-popup--open');
      ['left', 'top', 'width', 'height', 'borderRadius', 'transition'].forEach(
        p => { this.#popup.style[p] = ''; }
      );
      this.#popup.style.display = 'flex';
      this.#panelHost.classList.add('cp-panel-host--docked');
      this.parentElement?.insertBefore(this.#panelHost, this.nextSibling);
      this.style.display = 'none';
      this.#setActive(this.#activeIndex >= 0 ? this.#activeIndex : 0, { scroll: 'auto' });
    } else {
      this.#popup.classList.remove('cp-popup--docked', 'cp-popup--open');
      this.#popup.style.display = 'none';
      ['left', 'top', 'width', 'height', 'borderRadius', 'transition'].forEach(
        p => { this.#popup.style[p] = ''; }
      );
      this.#panelHost.classList.remove('cp-panel-host--docked');
      document.body.appendChild(this.#panelHost);
      this.style.display = '';
    }
  }

  #forceClose() {
    this.#beginOp();
    this.#isOpen = false;
    this.#isAnimating = false;
    this.#trigger.setAttribute('aria-expanded', 'false');
    this.#popup.classList.remove('cp-popup--open', 'cp-popup--closing');
    this.#overlay.classList.remove('is-active');
    this.#popup.style.display = 'none';
    this.#popup.style.transition = '';
    ['left', 'top', 'width', 'height', 'borderRadius'].forEach(p => { this.#popup.style[p] = ''; });
    this.#overlay.hidden = true;
    this.classList.remove('cp-anim', 'cp-content-hidden');
    this.#unlockScroll();
  }

  #applyGeometry({ left, top, width, height, borderRadius }) {
    const s = this.#popup.style;
    s.left = `${left}px`;
    s.top = `${top}px`;
    s.width = `${width}px`;
    s.height = `${height}px`;
    s.borderRadius = borderRadius;
  }

  // Invalidate every in-flight deferred step from the previous transition and
  // return this op's sequence id, which those steps re-check before running.
  #beginOp() {
    clearTimeout(this.#cleanupTimer);
    this.#cleanupTimer = 0;
    this.#clearMorphEnd();
    return ++this.#seq;
  }

  #onMorphEnd(cb) {
    this.#clearMorphEnd();
    const fallback = setTimeout(() => { this.#clearMorphEnd(); cb(); }, MORPH_MS + 60);
    const handler = (e) => {
      if (e.target !== this.#popup || e.propertyName !== 'height') return;
      this.#clearMorphEnd();
      cb();
    };
    this.#popup.addEventListener('transitionend', handler);
    this.#morphCleanup = () => {
      clearTimeout(fallback);
      this.#popup.removeEventListener('transitionend', handler);
      this.#morphCleanup = null;
    };
  }

  #clearMorphEnd() {
    this.#morphCleanup?.();
  }

  // Final resting box of the panel: full width, natural (capped) height,
  // top edge 0.5rem below the trigger's top so it reads as the pill growing
  // downward into the panel.
  async #panelTarget() {
    const s = this.#popup.style;
    s.transition = 'none';
    s.width = '';
    s.height = 'auto';
    const width = this.#popup.offsetWidth;
    // Grow to fit the whole list; only cap (→ scroll) when it can't fit the
    // viewport. `shift({ padding: 8 })` below keeps a full-height panel on
    // screen.
    const height = Math.min(this.#inner.scrollHeight, window.innerHeight - 16);
    s.height = `${height}px`;

    const { x, y } = await computePosition(this.#trigger, this.#popup, {
      strategy: 'fixed',
      placement: 'bottom-start',
      middleware: [
        offset(({ rects }) => 8 - rects.reference.height), // 0.5rem below the trigger's top
        flip({ padding: 8 }),
        shift({ padding: 8 }),
      ],
    });
    return { left: x, top: y, width, height, borderRadius: '16px' };
  }

  #triggerBox() {
    const r = this.#trigger.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, borderRadius: '999px' };
  }

  async #open() {
    if (this.#isOpen || this.#docked) return;
    const seq = this.#beginOp();
    this.#isOpen = true;
    this.#isAnimating = true;
    this.#trigger.setAttribute('aria-expanded', 'true');
    haptics.trigger(defaultPatterns.light);
    this.#lockScroll();

    // A close may have got as far as tagging the shell/pill for its handoff.
    this.#popup.classList.remove('cp-popup--closing');
    this.classList.remove('cp-content-hidden');

    this.#overlay.hidden = false;
    this.#popup.style.display = 'flex';
    this.classList.add('cp-anim');

    const target = await this.#panelTarget();
    if (seq !== this.#seq) return; // superseded while awaiting layout

    if (!this.#canMorph()) {
      this.#applyGeometry(target);
      this.#popup.style.transition = 'none';
      this.#overlay.classList.add('is-active');
      this.#popup.classList.add('cp-popup--open');
      this.#isAnimating = false;
      this.#afterOpen();
      return;
    }

    // Place at the final box instantly (transition off, set in #panelTarget)…
    this.#applyGeometry(target);
    // …then snap back onto the (now hidden) trigger.
    this.#applyGeometry(this.#triggerBox());
    this.#popup.getBoundingClientRect();               // force reflow
    this.#popup.style.transition = '';

    requestAnimationFrame(() => {
      if (seq !== this.#seq) return;
      this.#overlay.classList.add('is-active');
      this.#popup.classList.add('cp-popup--open');
      this.#applyGeometry(target);
      this.#onMorphEnd(() => {
        if (seq !== this.#seq) return;
        this.#isAnimating = false;
        this.#afterOpen();
      });
    });
  }

  #afterOpen() {
    if (!this.#isOpen) return;
    this.#setActive(this.#activeIndex >= 0 ? this.#activeIndex : 0, { scroll: 'auto' });
    this.#popup.focus({ preventScroll: true });
  }

  #close() {
    if (!this.#isOpen) return;
    const seq = this.#beginOp();
    this.#isOpen = false;
    this.#isAnimating = true;
    this.#trigger.setAttribute('aria-expanded', 'false');
    this.#clearTypeahead();

    const returnFocus = this.#panelRoot.activeElement === this.#popup
      || this.#popup.contains(this.#panelRoot.activeElement);

    this.#popup.classList.remove('cp-popup--open');
    this.#overlay.classList.remove('is-active');

    const clear = () => {
      if (seq !== this.#seq) return;
      this.#popup.classList.remove('cp-popup--closing');
      this.#popup.style.display = 'none';
      this.#popup.style.transition = '';
      ['left', 'top', 'width', 'height', 'borderRadius'].forEach(p => { this.#popup.style[p] = ''; });
      this.#overlay.hidden = true;
      this.classList.remove('cp-anim', 'cp-content-hidden');
      this.#unlockScroll();
    };

    if (!this.#canMorph()) {
      this.#isAnimating = false;
      clear();
      if (returnFocus) this.#trigger.focus({ preventScroll: true });
      return;
    }

    // A superseded open may have left transitions disabled — re-enable so the
    // return-morph always animates.
    this.#popup.style.transition = '';
    requestAnimationFrame(() => {
      if (seq !== this.#seq) return;
      this.#applyGeometry(this.#triggerBox());
      this.#onMorphEnd(() => {
        if (seq !== this.#seq) return;
        this.#isAnimating = false;
        // Hand the frame back to the pill: its glass box matches the collapsed
        // shell, so swap instantly, but fade the pill's contents (icon / label
        // / value / chevron) in while the shell cross-fades out.
        this.classList.remove('cp-anim');
        this.classList.add('cp-content-hidden');
        this.#popup.classList.add('cp-popup--closing');
        this.#overlay.hidden = true;
        this.#unlockScroll();
        if (returnFocus) this.#trigger.focus({ preventScroll: true });
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (seq !== this.#seq) return;
          this.classList.remove('cp-content-hidden');
        }));
        this.#cleanupTimer = setTimeout(clear, 240);
      });
    });
  }

  #canMorph() {
    return !reduceMotion.matches;
  }

  #lockScroll() {
    if (this.#scrollLocked) return;
    this.#scrollLocked = true;
    this.#preventScroll = (e) => {
      // e.target is retargeted to the panel host once the event reaches
      // window — use composedPath to see into the shadow tree.
      const overInner = e.composedPath().includes(this.#inner);
      if (overInner && this.#inner.scrollHeight > this.#inner.clientHeight) return;
      e.preventDefault();
    };
    window.addEventListener('wheel', this.#preventScroll, { passive: false });
    window.addEventListener('touchmove', this.#preventScroll, { passive: false });
  }

  #unlockScroll() {
    if (!this.#scrollLocked) return;
    this.#scrollLocked = false;
    window.removeEventListener('wheel', this.#preventScroll);
    window.removeEventListener('touchmove', this.#preventScroll);
    this.#preventScroll = null;
  }

  // ── Keyboard ──────────────────────────────────────────────────────────

  #onTriggerKeydown(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      // Let Enter/Space fall through to the native button click on keyup,
      // but ArrowDown/Up should open + move.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.#open();
      }
    }
  }

  #onKeydown(e) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.#moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.#moveActive(-1);
        break;
      case 'Home':
        e.preventDefault();
        this.#setActive(0);
        break;
      case 'End':
        e.preventDefault();
        this.#setActive(this.#rows.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (this.#rows[this.#activeIndex]) this.#commit(this.#rows[this.#activeIndex].id);
        break;
      case 'Escape':
        e.preventDefault();
        this.#close();
        break;
      case 'Tab':
        this.#close();
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          this.#typeahead(e.key);
        }
    }
  }

  #moveActive(delta) {
    const n = this.#rows.length;
    if (!n) return;
    const next = this.#activeIndex < 0
      ? (delta > 0 ? 0 : n - 1)
      : (this.#activeIndex + delta + n) % n;
    this.#setActive(next);
  }

  #setActive(index, { scroll = 'nearest' } = {}) {
    if (index < 0 || index >= this.#rows.length) return;
    this.#rows.forEach(({ el }, i) => el.classList.toggle('is-active', i === index));
    this.#activeIndex = index;
    const el = this.#rows[index].el;
    this.#popup.setAttribute('aria-activedescendant', el.id);
    if (scroll !== 'auto') el.scrollIntoView({ block: scroll });
  }

  #typeahead(char) {
    this.#typeaheadBuffer += char.toLowerCase();
    clearTimeout(this.#typeaheadTimer);
    this.#typeaheadTimer = setTimeout(() => this.#clearTypeahead(), TYPEAHEAD_RESET_MS);

    const match = this.#rows.findIndex(r => r.name.startsWith(this.#typeaheadBuffer));
    if (match >= 0) this.#setActive(match);
  }

  #clearTypeahead() {
    this.#typeaheadBuffer = '';
    clearTimeout(this.#typeaheadTimer);
  }

  // ── Pointer ───────────────────────────────────────────────────────────

  #onRowClick(e) {
    const row = e.target.closest('[role="option"]');
    if (row) this.#commit(row.dataset.id);
  }

  #onRowHover(e) {
    const row = e.target.closest('[role="option"]');
    if (!row) {
      // Pointer is inside the panel but not over a row (title, section label,
      // padding) — drop the hover highlight.
      this.#clearPointerActive();
      return;
    }
    const i = this.#rows.findIndex(r => r.el === row);
    if (i >= 0 && i !== this.#activeIndex) this.#setActive(i, { scroll: 'auto' });
  }

  // Clears the pointer-driven active row. Keyboard navigation re-establishes it
  // on the next arrow key; the committed selection keeps its own styling via
  // [aria-selected].
  #clearPointerActive() {
    const active = this.#rows.filter(({ el }) => el.classList.contains('is-active'));
    if (!active.length) return;
    active.forEach(({ el }) => el.classList.remove('is-active'));
    this.#activeIndex = this.#rows.findIndex(r => r.id === this.#select.value);
    this.#popup.removeAttribute('aria-activedescendant');
  }
}

customElements.define('campus-chip-picker', CampusChipPicker);

// Backward-compatible module-level API — existing call sites (script.js,
// settings.js) import these directly rather than holding an element
// reference, so keep the same exported shape and just delegate.
export function setupCampusPicker(staticData) {
  document.querySelector('campus-chip-picker')?.setup(staticData);
}

export function selectCampusById(id, animate = true) {
  document.querySelector('campus-chip-picker')?.selectCampusById(id, animate);
}
