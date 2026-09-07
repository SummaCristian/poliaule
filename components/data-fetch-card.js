import { haptics, defaultPatterns } from './haptics.js';

// The header's data-fetch indicator button morphs into a glass card holding the
// freshness status + reload button, and back — the exact shell technique used
// by <campus-chip-picker> / <date-chip-picker> / time-picker.js: a fixed
// element whose box (top/left/width/height/border-radius) transitions between
// the trigger's rect and the card's resting rect, with the trigger hidden
// mid-morph and the inner content fading in once expanded.
//
// Unlike those pickers this one keeps the `liquid-glass` class on the expanded
// card, so the press / drag-deform gesture stays alive on the open state (the
// delegated listener in liquid-glass.js picks it up; the combined transition
// that lets the morph and the deform coexist lives in data-fetch-card.css,
// mirroring the `.popover.liquid-glass` rule).
//
// script.js keeps ownership of #data-fetch-indicator-popover-container's
// contents (setupDataFetchIndicatorText); this file only relocates that
// container into the morphing card and drives the open/close geometry.

const MORPH_MS = 420;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

class DataFetchCard {
  #trigger = null;
  #overlay = null;
  #popup = null;
  #inner = null;
  #isOpen = false;
  #isAnimating = false;
  #preventScroll = null;
  #scrollLocked = false;
  // Bumped on every open/close so deferred steps from a superseded transition
  // can detect they're stale and bail — otherwise a fast close→open tears the
  // freshly-opened card back down.
  #seq = 0;
  #cleanupTimer = 0;
  #morphCleanup = null;

  init() {
    if (this.#trigger) return; // already initialized

    this.#trigger = document.getElementById('data-fetch-btn');
    const container = document.getElementById('data-fetch-indicator-popover-container');
    if (!this.#trigger || !container) return;

    this.#trigger.setAttribute('aria-haspopup', 'dialog');
    this.#trigger.setAttribute('aria-expanded', 'false');

    // ── Overlay + morphing card shell ───────────────────────────────
    this.#overlay = document.createElement('div');
    this.#overlay.className = 'dfc-overlay';
    this.#overlay.hidden = true;

    this.#popup = document.createElement('div');
    this.#popup.className = 'dfc-popup liquid-glass';
    this.#popup.setAttribute('role', 'dialog');
    this.#popup.setAttribute('aria-modal', 'true');
    this.#popup.tabIndex = -1;
    this.#popup.innerHTML = `<div class="dfc-popup__inner"></div>`;
    this.#inner = this.#popup.querySelector('.dfc-popup__inner');

    // Move script.js's status container into the card. Appended to <body>, not
    // kept in the header: a position:fixed + backdrop-filter panel trapped in
    // the header's stacking context makes iOS Safari mispaint the safe-area
    // bars (same reason the pickers portal to the root).
    this.#inner.appendChild(container);
    document.body.appendChild(this.#overlay);
    document.body.appendChild(this.#popup);

    // ── Wiring ─────────────────────────────────────────────────────
    this.#trigger.addEventListener('click', () => this.#toggle());
    this.#overlay.addEventListener('click', () => this.#close());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.#close();
    });
    // The reload button is rebuilt by setupDataFetchIndicatorText each render;
    // close the card whenever a click inside it lands on that button.
    this.#inner.addEventListener('click', (e) => {
      if (e.target.closest('#reload-data-btn')) this.#close();
    });
    window.addEventListener('resize', () => {
      if (this.#isOpen && !this.#isAnimating) this.#applyGeometry(this.#panelTarget());
    });
  }

  // ── Geometry ──────────────────────────────────────────────────────
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

  // Final resting box — anchored to the trigger: the card's right edge aligns
  // with the trigger's right edge (the button sits at the top-right of the
  // header) and it grows downward from just below the trigger's top. Only
  // nudged inward to stay on-screen.
  #panelTarget() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const PAD = 8;
    const r = this.#trigger.getBoundingClientRect();
    const width = Math.min(20 * 16, vw - PAD * 2);

    const s = this.#popup.style;
    const prev = s.transition;
    s.transition = 'none';
    s.width = `${width}px`;
    s.height = 'auto';
    const height = Math.min(this.#inner.scrollHeight, vh - PAD * 2);
    s.transition = prev;

    const DROP = 8; // settles 0.5rem below the trigger
    const left = Math.max(PAD, Math.min(r.right - width, vw - width - PAD));
    const top = Math.max(PAD, Math.min(r.top + DROP, vh - height - PAD));
    return { left, top, width, height, borderRadius: '20px' };
  }

  #canMorph() {
    return !reduceMotion.matches;
  }

  // ── Open / close ──────────────────────────────────────────────────
  #toggle() {
    this.#isOpen ? this.#close() : this.#open();
  }

  #beginOp() {
    clearTimeout(this.#cleanupTimer);
    this.#cleanupTimer = 0;
    this.#clearMorphEnd();
    return ++this.#seq;
  }

  #open() {
    if (this.#isOpen) return;
    const seq = this.#beginOp();
    this.#isOpen = true;
    this.#isAnimating = true;
    this.#trigger.setAttribute('aria-expanded', 'true');
    haptics.trigger(defaultPatterns.light);
    this.#lockScroll();

    this.#popup.classList.remove('dfc-popup--closing');
    this.#trigger.classList.remove('dfc-content-hidden');

    this.#overlay.hidden = false;
    this.#popup.style.display = 'flex';
    this.#trigger.classList.add('dfc-anim');

    const target = this.#panelTarget();

    if (!this.#canMorph()) {
      this.#popup.style.transition = 'none';
      this.#applyGeometry(target);
      this.#overlay.classList.add('is-active');
      this.#popup.classList.add('dfc-popup--open');
      this.#isAnimating = false;
      this.#afterOpen();
      return;
    }

    // Snap onto the (now hidden) trigger, then transition to the card box.
    this.#popup.style.transition = 'none';
    this.#applyGeometry(this.#triggerBox());
    this.#popup.getBoundingClientRect();              // force reflow
    this.#popup.style.transition = '';

    requestAnimationFrame(() => {
      if (seq !== this.#seq) return;
      this.#overlay.classList.add('is-active');
      this.#popup.classList.add('dfc-popup--open');
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
    this.#popup.focus?.({ preventScroll: true });
  }

  #close() {
    if (!this.#isOpen) return;
    const seq = this.#beginOp();
    this.#isOpen = false;
    this.#isAnimating = true;
    this.#trigger.setAttribute('aria-expanded', 'false');

    this.#popup.classList.remove('dfc-popup--open');
    this.#overlay.classList.remove('is-active');

    const clear = () => {
      if (seq !== this.#seq) return;
      this.#popup.classList.remove('dfc-popup--closing');
      this.#popup.style.display = 'none';
      this.#popup.style.transition = '';
      ['left', 'top', 'width', 'height', 'borderRadius'].forEach(p => { this.#popup.style[p] = ''; });
      this.#overlay.hidden = true;
      this.#trigger.classList.remove('dfc-anim', 'dfc-content-hidden');
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
        // Hand the frame back to the button: swap the identical glass box
        // instantly, fade the button's indicator back in as the shell fades out.
        this.#trigger.classList.remove('dfc-anim');
        this.#trigger.classList.add('dfc-content-hidden');
        this.#popup.classList.add('dfc-popup--closing');
        this.#overlay.hidden = true;
        this.#unlockScroll();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (seq !== this.#seq) return;
          this.#trigger.classList.remove('dfc-content-hidden');
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

  // ── Scroll lock ───────────────────────────────────────────────────
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

const card = new DataFetchCard();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => card.init());
} else {
  card.init();
}
