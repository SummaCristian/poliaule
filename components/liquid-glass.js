// Liquid-glass press / swipe-deform + "lit" hover, shared by every glass
// surface that opts in with the `liquid-glass` class.
//
// Hold a glass element and drag: it stretches toward the pointer with an
// elastic (rubber-band) falloff, squashing on the perpendicular axis like a
// blob of viscous glass. Release and it springs back with an overshoot. A
// drag past the threshold is a gesture, not a press — the click on release is
// swallowed so the control's action doesn't fire.
//
// Motion is written to the independent `translate` and `scale` CSS properties
// (NOT `transform`), so it composes with any `transform` the element already
// uses — the back button's `translateY(-50%)` centring, the search FAB's
// activation-pop spring, the popover's open/close scale. The easing, the
// snap-down and the lit hover state live in liquid-glass.css; JS only tracks
// the pointer, since CSS can't.
//
// Light-DOM elements are handled by one delegated listener, so controls added
// later (e.g. the per-building section headers) need no extra wiring — just
// the class. Shadow-DOM controls call attachLiquidGlass() on themselves and
// carry the matching CSS in their own sheet (see campus-picker.css).

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

// How hard the element scales down the instant it's touched (before any drag).
const PRESS_SCALE = 0.94;
// Pointer travel (px) before we treat the gesture as a drag rather than a tap.
// Below this a release still fires the control's click; above it the click is
// swallowed as a deform gesture. 3px was under a real finger's tap jitter, so
// ordinary taps on big surfaces (the building name pills) were being eaten.
const DRAG_THRESHOLD = 8;

function beginPress(el, e) {
  // Ignore secondary mouse buttons; let real clicks/taps through untouched.
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (el.disabled || el._lgActive) return;
  el._lgActive = true;

  // Cancel a still-pending "settle" from a previous release on this element.
  if (el._lgSettleTimer) { clearTimeout(el._lgSettleTimer); el._lgSettleTimer = 0; }

  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;

  el.classList.remove('lg-settling');
  el.classList.add('lg-pressing');
  el.style.scale = String(PRESS_SCALE);

  // Capture so pointermove/up keep coming even if the pointer leaves the box.
  try { el.setPointerCapture(e.pointerId); } catch { /* not fatal */ }

  const onMove = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;

    if (!dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragging = true;
      el.classList.replace('lg-pressing', 'lg-dragging');
    }

    // Reduced motion: keep the snap-down feedback, skip the stretch entirely.
    if (reduce.matches) return;

    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;

    // Elastic falloff — the element chases the pointer less and less the
    // further it's pulled, so it never runs away from its slot.
    const give = 16 * Math.log1p(dist / 16);
    const shift = give * 0.7;

    // Stretch along the drag axis, squash on the other. Capped so it stays a
    // glass panel and not a puddle.
    const s = Math.min(give / 240, 0.16);
    const sx = PRESS_SCALE * (1 + s * Math.abs(ux) - s * 0.45 * Math.abs(uy));
    const sy = PRESS_SCALE * (1 + s * Math.abs(uy) - s * 0.45 * Math.abs(ux));

    el.style.translate = `${(ux * shift).toFixed(2)}px ${(uy * shift).toFixed(2)}px`;
    el.style.scale = `${sx.toFixed(4)} ${sy.toFixed(4)}`;
  };

  const onEnd = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onEnd);
    el.removeEventListener('pointercancel', onEnd);
    try { el.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    el._lgActive = false;

    // A drag is a deform gesture, not a press: swallow the click that a
    // release-over-the-element would otherwise fire. A plain tap never sets
    // `dragging`, so it's untouched.
    if (dragging) {
      const swallow = (clickEv) => {
        clickEv.stopImmediatePropagation();
        clickEv.preventDefault();
      };
      el.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 0);
    }

    // Clear the inline values and state classes: `translate`/`scale` fall back
    // to the CSS (0 / 1, or the hover value if still hovered) and the spring
    // transition carries the element home. `.lg-settling` keeps the raised
    // z-index (see liquid-glass.css) until that spring-back has finished, so a
    // still-deformed element never drops behind what it was overlapping.
    el.classList.remove('lg-pressing', 'lg-dragging');
    el.classList.add('lg-settling');
    el.style.translate = '';
    el.style.scale = '';

    const settleS = parseFloat(
      getComputedStyle(el).getPropertyValue('--press-out-dur')) || 0.5;
    el._lgSettleTimer = setTimeout(() => {
      el._lgSettleTimer = 0;
      el.classList.remove('lg-settling');
    }, settleS * 1000 + 60);
  };

  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onEnd);
  el.addEventListener('pointercancel', onEnd);
}

// Opt a shadow-DOM element in explicitly (delegation can't see across the
// shadow boundary). Safe to call more than once.
//
// `opts.from` — a selector: only a pointerdown that lands inside a matching
//   descendant starts the deform (e.g. a panel that deforms only when grabbed
//   by its title bar, so its scrollable / draggable body is left alone).
// `opts.exclude` — the inverse: a pointerdown inside a matching descendant is
//   ignored.
// The light-DOM delegated path reads the same two as `data-lg-from` /
// `data-lg-exclude` attributes.
export function attachLiquidGlass(el, opts = {}) {
  if (!el || el._liquidGlassBound) return;
  el._liquidGlassBound = true;
  el.classList.add('liquid-glass');
  const { from, exclude } = opts;
  el.addEventListener('pointerdown', (e) => {
    if (from && !e.target.closest(from)) return;
    if (exclude && e.target.closest(exclude)) return;
    beginPress(el, e);
  });
}

// Interactive elements that can sit *inside* a glass surface (a link in a
// popover). A press that starts on one of those is theirs, not the panel's.
const INNER_CONTROL = 'a, button, input, select, textarea, [role="button"]';

let delegated = false;

// One delegated pointerdown for every light-DOM `.liquid-glass` element,
// present or future. A press that starts on an interactive child (a link in a
// popover) is left to that child.
export function initLiquidGlass() {
  if (delegated) return;
  delegated = true;
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest?.('.liquid-glass');
    if (!el) return;
    const inner = e.target.closest(INNER_CONTROL);
    if (inner && inner !== el && el.contains(inner)) return;
    // Same `from` / `exclude` gating as attachLiquidGlass(), via attributes.
    const from = el.dataset?.lgFrom;
    if (from && !e.target.closest(from)) return;
    const exclude = el.dataset?.lgExclude;
    if (exclude && e.target.closest(exclude)) return;
    beginPress(el, e);
  });
}
