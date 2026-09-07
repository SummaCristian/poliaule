import { haptics, defaultPatterns } from './haptics.js';
import { t, onLanguageSwitch } from '../i18n.js';
import { createTimeFormatter } from '../utils/time-format.js';

// <time-range-chip-picker> is a thin wrapper around the drag-based time range
// slider (components/time-range-slider.js), which stays completely untouched.
//
// Collapsed, the component is a glass pill built one-to-one like
// <campus-chip-picker> / <date-chip-picker>: a HugeIcons clock glyph, a stacked
// label/value box ("TIME" over "9:15 – 11:15"), and a chevron. Tapped, the pill
// morphs into a popup holding the untouched slider — same shell technique as
// campus-picker.js / date-chip-picker.js: a fixed element whose box
// (top/left/width/height/border-radius) transitions between the trigger's rect
// and the panel's.
//
// The two native <input type="time"> fields (#from-time-picker / #to-time-picker)
// stay direct children of this element so they remain submittable fields inside
// the <form>; only the visual .trs-wrapper is relocated into the body-level
// popup — the sticky picker bar is a stacking context, and a position:fixed +
// backdrop-filter panel trapped inside one makes iOS Safari paint the bottom
// safe-area toolbar opaque and leave it stuck. Same escape as the date picker.

const MORPH_MS = 420;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

export class TimeRangeChipPicker extends HTMLElement {
  #container = null;       // .time-pickers-container (holds the native inputs)
  #fromInput = null;
  #toInput = null;
  #trigger = null;
  #overlay = null;
  #popup = null;
  #inner = null;
  #valueFromEl = null;
  #valueToEl = null;
  #slider = null;          // the .trs-wrapper element, set via setSlider()
  #isOpen = false;
  #isAnimating = false;
  #docked = false;         // inline-expanded in the desktop column (no popup)
  #preventScroll = null;
  #scrollLocked = false;
  // Bumped on every open/close so deferred callbacks from a superseded
  // transition can detect they're stale and bail.
  #seq = 0;
  #cleanupTimer = 0;
  #morphCleanup = null;

  connectedCallback() {
    if (this.#trigger) return; // already initialized (re-parenting, etc.)

    this.#container = this.querySelector('.time-pickers-container');
    this.#fromInput = this.querySelector('#from-time-picker');
    this.#toInput = this.querySelector('#to-time-picker');
    if (!this.#container) return;

    // ── Collapsed pill ────────────────────────────────────────────────
    this.#trigger = document.createElement('button');
    this.#trigger.type = 'button';
    this.#trigger.className = 'trc-trigger liquid-glass';
    this.#trigger.setAttribute('aria-haspopup', 'dialog');
    this.#trigger.setAttribute('aria-expanded', 'false');
    this.#trigger.innerHTML = `
      <i class="hgi-stroke hgi-clock-01 trc-trigger__icon" aria-hidden="true"></i>
      <span class="trc-trigger__box">
        <span class="trc-trigger__label" data-i18n="timepicker.timeLabel">${t('timepicker.timeLabel')}</span>
        <span class="trc-trigger__skeleton" aria-hidden="true"></span>
        <span class="trc-trigger__value">
          <span class="trc-trigger__value-from"></span>
          <span class="trc-trigger__value-sep" aria-hidden="true">–</span>
          <span class="trc-trigger__value-to"></span>
        </span>
      </span>
      <i class="hgi-stroke hgi-arrow-down-01 trc-trigger__chevron" aria-hidden="true"></i>
    `;
    this.#valueFromEl = this.#trigger.querySelector('.trc-trigger__value-from');
    this.#valueToEl = this.#trigger.querySelector('.trc-trigger__value-to');

    // ── Overlay + morphing popup shell ───────────────────────────────
    this.#overlay = document.createElement('div');
    this.#overlay.className = 'trc-overlay';
    this.#overlay.hidden = true;

    this.#popup = document.createElement('div');
    // `liquid-glass` keeps the press / drag-deform gesture alive on the open
    // panel; `data-lg-exclude` confines the grab zone to the panel chrome
    // (title + padding) so the slider's bar, handles and Now badge inside still
    // track the pointer freely — same split as the date picker's scrubber.
    this.#popup.className = 'trc-popup liquid-glass';
    this.#popup.dataset.lgExclude = '.trs-bar-wrapper';
    this.#popup.setAttribute('role', 'dialog');
    this.#popup.setAttribute('aria-modal', 'true');
    this.#popup.tabIndex = -1;
    this.#popup.setAttribute('aria-label', t('timepicker.timeLabel'));
    this.#popup.innerHTML = `<div class="trc-popup__inner"></div>`;
    this.#inner = this.#popup.querySelector('.trc-popup__inner');

    // Assemble — mirror <date-chip-picker>:
    //  - the native <input> fields stay inside this element (inside the <form>);
    //    .time-pickers-container is kept as their hidden holder.
    //  - the overlay + morphing popup are appended to <body>.
    this.insertBefore(this.#trigger, this.#container);
    document.body.appendChild(this.#overlay);
    document.body.appendChild(this.#popup);

    // ── Wiring ──────────────────────────────────────────────────────
    this.#trigger.addEventListener('click', () => this.#toggle());
    this.#overlay.addEventListener('click', () => this.#close());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.#close();
    });
    this.#fromInput?.addEventListener('input', () => this.#renderValue());
    this.#toInput?.addEventListener('input', () => this.#renderValue());
    window.addEventListener('timeformatchange', () => this.#renderValue());
    onLanguageSwitch(() => this.retranslate());
    window.addEventListener('resize', () => {
      if (this.#docked) { this.#slider?._render?.(); return; }
      if (this.#isOpen && !this.#isAnimating) {
        this.#applyGeometry(this.#panelTarget());
        this.#slider?._render?.();
      }
    });

    this.#renderValue();
  }

  // ── Docked (inline-expanded) mode ───────────────────────────────────
  // On desktop the picker isn't a pill that morphs into a body-level popup;
  // the same glass panel sits directly in the form column. picker-dock.js
  // toggles this from a ResizeObserver on the container. Instant swap, no morph.
  setDocked(on) {
    on = !!on;
    if (on === this.#docked) return;
    this.#docked = on;

    if (on) {
      if (this.#isOpen) this.#forceClose();
      this.#trigger.hidden = true;
      this.#overlay.hidden = true;
      this.#popup.classList.remove('trc-popup--closing');
      this.#popup.classList.add('trc-popup--docked', 'trc-popup--open');
      ['left', 'top', 'width', 'height', 'borderRadius', 'transition'].forEach(
        p => { this.#popup.style[p] = ''; }
      );
      this.#popup.style.display = 'flex';
      this.appendChild(this.#popup);
      // The slider had no layout while display:none — give it real dimensions.
      this.#slider?._render?.();
      requestAnimationFrame(() => this.#slider?._render?.());
    } else {
      this.#popup.classList.remove('trc-popup--docked', 'trc-popup--open');
      this.#popup.style.display = 'none';
      ['left', 'top', 'width', 'height', 'borderRadius', 'transition'].forEach(
        p => { this.#popup.style[p] = ''; }
      );
      document.body.appendChild(this.#popup);
      this.#trigger.hidden = false;
    }
  }

  // Synchronous, motion-free teardown of an open popup (used when docking mid-open).
  #forceClose() {
    this.#beginOp();
    this.#isOpen = false;
    this.#isAnimating = false;
    this.#trigger.setAttribute('aria-expanded', 'false');
    this.#popup.classList.remove('trc-popup--open', 'trc-popup--closing');
    this.#overlay.classList.remove('is-active');
    this.#popup.style.display = 'none';
    this.#popup.style.transition = '';
    ['left', 'top', 'width', 'height', 'borderRadius'].forEach(p => { this.#popup.style[p] = ''; });
    this.#overlay.hidden = true;
    this.classList.remove('trc-anim', 'trc-content-hidden');
    this.#unlockScroll();
  }

  // Called by initTimeRangeSlider() once the .trs-wrapper is built, to relocate
  // it into this component's popup and keep a handle for on-open re-rendering.
  setSlider(wrapper) {
    this.#slider = wrapper;
    if (this.#inner && wrapper) this.#inner.appendChild(wrapper);
    this.removeAttribute('data-loading');
    this.#renderValue();
    if (this.#docked) requestAnimationFrame(() => wrapper?._render?.());
  }

  // The mount point initTimeRangeSlider() should append the slider into when
  // this component is present (falls back to .time-pickers-container otherwise).
  getMountPoint() {
    return this.#inner;
  }

  #formatTime(val) {
    if (!val || !/^\d{2}:\d{2}$/.test(val)) return '--:--';
    const [h, m] = val.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return createTimeFormatter({ hour: 'numeric', minute: '2-digit' }).format(d);
  }

  #renderValue() {
    if (!this.#valueFromEl) return;
    this.#valueFromEl.textContent = this.#formatTime(this.#fromInput?.value);
    this.#valueToEl.textContent = this.#formatTime(this.#toInput?.value);
  }

  // Re-apply locale-dependent text: the popup aria-label, the pill label, the
  // slider's own title, and the formatted time values.
  retranslate() {
    if (!this.#trigger) return;
    this.#popup.setAttribute('aria-label', t('timepicker.timeLabel'));
    const labelEl = this.#trigger.querySelector('.trc-trigger__label');
    if (labelEl) labelEl.textContent = t('timepicker.timeLabel');
    const titleText = this.#popup.querySelector('.trs-title-text');
    if (titleText) titleText.textContent = t('timepicker.timeLabel');
    this.#renderValue();
  }

  // ── Geometry ────────────────────────────────────────────────────────
  #applyGeometry({ left, top, width, height, borderRadius }) {
    const s = this.#popup.style;
    s.left = `${left}px`;
    s.top = `${top}px`;
    s.width = `${width}px`;
    s.height = `${height}px`;
    s.borderRadius = borderRadius;
  }

  #triggerBox() {
    const r = this.#trigger.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, borderRadius: '999px' };
  }

  // Final resting box — anchored locally to the trigger, same as
  // <date-chip-picker>: top edge just below the trigger's top, left edge aligned
  // with the trigger's left, each nudged inward to stay on-screen.
  #panelTarget() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const PAD = 8;
    const r = this.#trigger.getBoundingClientRect();
    const width = Math.min(26 * 16, vw - PAD * 2);

    const s = this.#popup.style;
    const prev = s.transition;
    s.transition = 'none';
    s.width = `${width}px`;
    s.height = 'auto';
    const height = Math.min(this.#inner.scrollHeight, vh - PAD * 2);
    s.transition = prev;

    const DROP = 8; // expanded panel settles 0.5rem below the trigger
    const left = Math.max(PAD, Math.min(r.left, vw - width - PAD));
    const top = Math.max(PAD, Math.min(r.top + DROP, vh - height - PAD));
    return { left, top, width, height, borderRadius: '22px' };
  }

  #canMorph() {
    return !reduceMotion.matches;
  }

  // ── Open / close ────────────────────────────────────────────────────
  #toggle() {
    if (this.#docked) return;
    this.#isOpen ? this.#close() : this.#open();
  }

  #beginOp() {
    clearTimeout(this.#cleanupTimer);
    this.#cleanupTimer = 0;
    this.#clearMorphEnd();
    return ++this.#seq;
  }

  #open() {
    if (this.#isOpen || this.#docked) return;
    const seq = this.#beginOp();
    this.#isOpen = true;
    this.#isAnimating = true;
    this.#trigger.setAttribute('aria-expanded', 'true');
    haptics.trigger(defaultPatterns.light);
    this.#lockScroll();

    this.#popup.classList.remove('trc-popup--closing');
    this.classList.remove('trc-content-hidden');

    this.#overlay.hidden = false;
    this.#popup.style.display = 'flex';
    this.classList.add('trc-anim');

    const target = this.#panelTarget();

    if (!this.#canMorph()) {
      this.#popup.style.transition = 'none';
      this.#applyGeometry(target);
      this.#overlay.classList.add('is-active');
      this.#popup.classList.add('trc-popup--open');
      this.#isAnimating = false;
      this.#afterOpen();
      return;
    }

    // Snap onto the (now hidden) trigger, then transition to the panel box.
    this.#popup.style.transition = 'none';
    this.#applyGeometry(this.#triggerBox());
    this.#popup.getBoundingClientRect();              // force reflow
    this.#popup.style.transition = '';

    requestAnimationFrame(() => {
      if (seq !== this.#seq) return;
      this.#overlay.classList.add('is-active');
      this.#popup.classList.add('trc-popup--open');
      this.#applyGeometry(target);
      this.#slider?._render?.();
      this.#onMorphEnd(() => {
        if (seq !== this.#seq) return;
        this.#isAnimating = false;
        this.#afterOpen();
      });
    });
  }

  #afterOpen() {
    if (!this.#isOpen) return;
    // The slider was inside a display:none popup until now; give it real
    // layout dimensions to render the bar, ticks and now-indicator against.
    this.#slider?._render?.();
    this.#popup.focus?.({ preventScroll: true });
  }

  #close() {
    if (!this.#isOpen) return;
    const seq = this.#beginOp();
    this.#isOpen = false;
    this.#isAnimating = true;
    this.#trigger.setAttribute('aria-expanded', 'false');

    this.#popup.classList.remove('trc-popup--open');
    this.#overlay.classList.remove('is-active');

    const clear = () => {
      if (seq !== this.#seq) return;
      this.#popup.classList.remove('trc-popup--closing');
      this.#popup.style.display = 'none';
      this.#popup.style.transition = '';
      ['left', 'top', 'width', 'height', 'borderRadius'].forEach(p => { this.#popup.style[p] = ''; });
      this.#overlay.hidden = true;
      this.classList.remove('trc-anim', 'trc-content-hidden');
      this.#unlockScroll();
    };

    if (!this.#canMorph()) {
      this.#isAnimating = false;
      clear();
      return;
    }

    this.#popup.style.transition = '';
    requestAnimationFrame(() => {
      if (seq !== this.#seq) return;
      this.#applyGeometry(this.#triggerBox());
      this.#onMorphEnd(() => {
        if (seq !== this.#seq) return;
        this.#isAnimating = false;
        // Hand the frame back to the pill: swap the identical glass box
        // instantly, fade the pill's contents in as the shell fades out.
        this.classList.remove('trc-anim');
        this.classList.add('trc-content-hidden');
        this.#popup.classList.add('trc-popup--closing');
        this.#overlay.hidden = true;
        this.#unlockScroll();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (seq !== this.#seq) return;
          this.classList.remove('trc-content-hidden');
        }));
        this.#cleanupTimer = setTimeout(clear, 240);
      });
    });
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

  // ── Scroll lock ─────────────────────────────────────────────────────
  #lockScroll() {
    if (this.#scrollLocked) return;
    this.#scrollLocked = true;
    this.#preventScroll = (e) => {
      if (this.#inner.contains(e.target) && this.#inner.scrollHeight > this.#inner.clientHeight) return;
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
}

customElements.define('time-range-chip-picker', TimeRangeChipPicker);
