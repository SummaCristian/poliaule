import { t } from '../i18n.js';
import { escapeHtml } from '../utils/html.js';
import { haptics, defaultPatterns } from './haptics.js';
import { getCampusBuildingsOverview } from '../available-rooms-script.js';

// The "zoom out" building overview.
//
// Tapping a building's name pill in the Available results doesn't open a
// separate screen — the results container itself zooms out and becomes a grid
// of glass building cards, one per building in the selected campus, each
// showing how many of its classrooms are free / free soon / occupied soon /
// occupied right now.
//
// The motion is one camera zoom, the way iOS Calendar goes month ⇄ year:
// two layers (the results list and the building grid) sit in the same clipped
// frame and are scaled TOGETHER about one shared anchor — the tapped building's
// section in the list and its card in the grid. The list shrinks until the
// section lands exactly on the card while the grid, starting blown up by the
// inverse factor around that same card, settles to rest; the two cross-fade on
// the way. Zooming back in is the exact mirror. Nothing else moves: every other
// card is just part of the grid layer converging on its slot.
//
// Layout never jumps because the scroll position is only ever changed in the
// same frame as a layout change that cancels it out on screen (see #swapIn).

const DUR = 520;
// Critically damped spring (no overshoot), sampled into keyframes. ω·T is
// how "settled" it is at the end: 7.6 ≈ 99.6 % — equivalent to an Apple
// spring with response ≈ 0.43 s. The zoom covers most of its distance in the
// first third and spends the rest easing to a stop.
const SPRING_WT = 7.6;
const spring = (() => {
  const end = 1 - (1 + SPRING_WT) * Math.exp(-SPRING_WT);
  return (p) => (1 - (1 + SPRING_WT * p) * Math.exp(-SPRING_WT * p)) / end;
})();
const smooth = (x, a, b) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
// Sideways bulge of the zoom's path, as a fraction of the distance travelled.
// The anchor lifts slightly off the straight line and settles back, so the
// move reads as a swoop rather than a slide.
const ARC = 0.08;
const KEYFRAMES = 60;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const STATUS_META = [
  { key: 'free',          i18n: 'status.free',         cls: 'free' },
  { key: 'free-soon',     i18n: 'status.freeSoon',     cls: 'free-soon' },
  { key: 'occupied-soon', i18n: 'status.occupiedSoon', cls: 'occupied-soon' },
  { key: 'occupied',      i18n: 'status.occupied',     cls: 'occupied' },
];

const LAYER_PROPS = ['position', 'insetInline', 'top', 'zIndex', 'transformOrigin', 'willChange', 'opacity', 'pointerEvents'];
function clearLayer(el) {
  if (!el) return;
  for (const p of LAYER_PROPS) el.style[p] = '';
}

// Where a scrollable area's "top" is on screen, and how to scroll it, for the
// two places the results live: in the page (mobile / tablet) or inside the
// self-scrolling results panel (desktop ≥1100px). "visibleTop" is the client-y
// a stuck building header parks at — i.e. where a section's top should sit to
// read as "scrolled to this building".
function scrollerFor(container, stickyTop) {
  const selfScrolls = /auto|scroll/.test(getComputedStyle(container).overflowY);
  if (selfScrolls) {
    return {
      visibleTop: () => container.getBoundingClientRect().top + container.clientTop + stickyTop,
      visibleBottom: () => container.getBoundingClientRect().top + container.clientTop + container.clientHeight,
      scrollBy: (dy) => container.scrollBy({ top: dy, behavior: 'instant' }),
      contentHeight: () => container.scrollHeight,
    };
  }
  return {
    visibleTop: () => stickyTop,
    visibleBottom: () => window.innerHeight,
    // The page has `scroll-behavior: smooth` — every scroll here has to be
    // explicitly instant or it turns into a visible glide.
    scrollBy: (dy) => window.scrollBy({ top: dy, behavior: 'instant' }),
    contentHeight: () => document.documentElement.scrollHeight,
  };
}

class BuildingOverview {
  #isOpen = false;
  #phase = 'idle';     // 'idle' | 'opening' | 'open' | 'closing'
  #ctx = null;
  #container = null;   // #available-classrooms-results
  #filterRow = null;
  #list = null;        // ul.list-outer-container (moved into #stage while open)
  #stage = null;       // .bo-stage — the clipped frame holding list + grid
  #grid = null;
  #scroller = null;
  #sourceName = null;
  #pendingNavName = null;
  #listTop0 = 0;       // the list's client top when we opened (what × restores)
  #anims = [];
  #onKey = null;

  // ── Public ────────────────────────────────────────────────────────

  // Call on pointer-down on a name pill: promotes the list to its own
  // compositor layer so its first rasterisation happens during the press,
  // not on the zoom's first frame. Undone if no open() follows.
  prewarm(sourceSection) {
    if (this.#phase !== 'idle') return;
    const container = sourceSection?.closest('#available-classrooms-results');
    const list = container?.querySelector('.list-outer-container');
    if (!container || !list) return;
    // Scoping the sections here too (open() repeats it, idempotently) means
    // the sections that are forced to render get laid out and rasterised
    // during the press as well, instead of on the zoom's first frame.
    this.#container = container;
    this.#list = list;
    this.#scroller = scrollerFor(container, this.#stickyTop(sourceSection));
    this.#scopeSections(sourceSection);
    list.style.willChange = 'transform';
    clearTimeout(this.#prewarmTimer);
    this.#prewarmTimer = setTimeout(() => {
      if (this.#phase === 'idle') { this.#unscopeSections(); list.style.willChange = ''; }
    }, 1500);
  }
  #prewarmTimer = 0;

  // Same idea for the way back: on pointer-down on a building card or the ×,
  // the parked list is shown again at (near) zero opacity under the grid so
  // the browser lays it out and rasterises it during the press. Re-showing a
  // display:none list on the zoom's first frame was the last remaining hitch
  // (profiled: 50–70 ms). Not fully 0 — an invisible layer is skipped, not
  // rasterised.
  prewarmClose(targetName = this.#sourceName) {
    if (this.#phase !== 'open') return;
    const list = this.#list;
    list.style.display = '';
    list.style.opacity = '0.01';
    list.style.zIndex = '1';
    // It's invisible but it's still there: it must never catch the tap that
    // is about to land on the card (that would open a classroom instead).
    list.style.pointerEvents = 'none';
    list.style.willChange = 'transform';
    // Off the pointer event — the forced layout here is what jitters the tap.
    cancelAnimationFrame(this.#prewarmRaf);
    this.#prewarmRaf = requestAnimationFrame(() => {
      if (this.#phase === 'open') this.#scopeSections(this.#sectionFor(targetName));
    });
    clearTimeout(this.#prewarmTimer);
    this.#prewarmTimer = setTimeout(() => {
      if (this.#phase === 'open') { list.style.display = 'none'; list.style.opacity = ''; this.#unscopeSections(); }
    }, 1500);
  }
  #prewarmRaf = 0;

  open({ campusId, date, from, to, results, sourceSection, buildingName }) {
    if (this.#phase !== 'idle') return;
    const container = sourceSection?.closest('#available-classrooms-results');
    const list = container?.querySelector('.list-outer-container');
    if (!container || !list) return;

    this.#phase = 'opening';
    this.#isOpen = true;
    this.#ctx = { campusId, date, from, to, results };
    this.#container = container;
    this.#list = list;
    this.#filterRow = container.querySelector('.results-filter-row');
    this.#sourceName = buildingName;
    this.#scroller = scrollerFor(container, this.#stickyTop(sourceSection));
    haptics.trigger(defaultPatterns.light);

    this.#onKey = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this.#onKey);

    // Decide which sections take part BEFORE measuring anything: forcing a
    // never-rendered section to render swaps its placeholder size for its
    // real one and shifts everything below it.
    this.#scopeSections(sourceSection);

    // Measure the anchor and the list's place on screen BEFORE touching the DOM.
    const visibleTop = this.#scroller.visibleTop();
    const from_ = this.#anchorRect(sourceSection, visibleTop);
    this.#listTop0 = list.getBoundingClientRect().top;
    this.#openViewport = this.#viewportKey();
    const docHeight0 = this.#scroller.contentHeight();

    // A dedicated stage — a positioned, clipped frame we fully control — takes
    // the list's place. The results container's own (sticky, grid-placed,
    // self-scrolling) rules are never touched. `overflow: clip`, not hidden:
    // hidden would make the stage a scroll container and the list's sticky
    // building headers would snap out of their stuck spots the moment the
    // list moves in.
    const stage = document.createElement('div');
    stage.className = 'bo-stage';
    container.insertBefore(stage, list);
    stage.appendChild(list);
    this.#stage = stage;

    this.#grid = this.#buildGrid();
    stage.appendChild(this.#grid);
    if (this.#filterRow) this.#filterRow.hidden = true;
    container.classList.add('bo-active', 'bo-animating');

    // Keep the frame at least a screen tall while the overview is up, so the
    // scroller always has enough room to park the frame at the top.
    stage.style.minHeight = `${this.#scroller.visibleBottom() - visibleTop}px`;

    // Grid in flow (it sizes the stage), list re-parked on top of where it was.
    // Then scroll the grid so the building we're zooming out of lands where its
    // section was on screen — not pinned to the grid's top. Without this, a tap
    // from the bottom of a scrolled list flings the grid up to its first card
    // and the zoom chases a target far from where you're looking.
    //
    // But only within what the grid can actually cover: #swapIn has parked the
    // grid's top at the visible top, so a downward shift is capped so the grid's
    // bottom never rises above the visible bottom (a short grid doesn't move at
    // all). Scrolling further would only reveal the stage padding below the
    // grid, and that padding is dropped once the zoom settles — which would
    // then clamp the scroll and jump the grid down.
    const anchorTop = from_?.top ?? visibleTop;
    this.#swapIn(this.#grid, this.#list, this.#listTop0, () => {
      const card = this.#cardFor(buildingName);
      if (!card) return;
      const want = card.getBoundingClientRect().top - anchorTop;
      const viewportH = this.#scroller.visibleBottom() - this.#scroller.visibleTop();
      const maxDown = Math.max(0, this.#grid.getBoundingClientRect().height - viewportH);
      this.#scroller.scrollBy(want < 0 ? want : Math.min(want, maxDown));
    }, docHeight0);

    const heroCard = this.#cardFor(buildingName);
    const to_ = heroCard?.getBoundingClientRect();

    if (reduceMotion.matches || !to_) {
      this.#settleOpen();
      return;
    }

    const fromRect = from_ ?? this.#stageVisibleRect(visibleTop);
    this.#zoom({ outgoing: this.#list, incoming: this.#grid, from: fromRect, to: to_ })
      .then((done) => { if (done) this.#settleOpen(); });
  }

  close() {
    if (this.#phase === 'opening') return this.#reverseOpen();
    if (this.#phase !== 'open') return;
    this.#phase = 'closing';
    this.#isOpen = false;
    clearTimeout(this.#prewarmTimer);
    cancelAnimationFrame(this.#prewarmRaf);
    document.removeEventListener('keydown', this.#onKey);
    this.#onKey = null;
    haptics.trigger(defaultPatterns.light);

    const targetName = this.#pendingNavName || this.#sourceName;
    const { list, grid } = { list: this.#list, grid: this.#grid };
    const container = this.#container;
    const docHeight0 = this.#scroller.contentHeight();

    container.classList.add('bo-animating');
    if (this.#filterRow) this.#filterRow.hidden = false;
    this.#stage.style.minHeight = '';

    // The card we're zooming into, where it is on screen right now.
    const heroCard = this.#cardFor(targetName);
    const from_ = heroCard?.getBoundingClientRect();
    const gridTop0 = grid.getBoundingClientRect().top;
    const section = this.#sectionFor(targetName);

    list.style.display = '';
    clearLayer(list);

    // Everything about where things go is measured NOW, not at open: the
    // window may have been resized in between, which can even swap the
    // scroller (page ⇄ panel at the 1100px breakpoint) and its sticky offset.
    // The list has to be rendered for the sticky `top` to resolve to px.
    this.#scroller = scrollerFor(container, this.#stickyTop(section ?? list.querySelector('.building-section')));
    const visibleTop = this.#scroller.visibleTop();
    this.#scopeSections(section); // before measuring — see open()

    // Navigating means the user picked a different building than the one they
    // opened from; ×, Esc or the same building just put things back as they
    // were — unless the viewport changed meanwhile, in which case "where we
    // were" no longer exists and we navigate to the source building instead.
    // Either way the list goes back into flow NOW, the scroller is moved to
    // the destination (the browser clamps it if the list's tail is too short
    // — the zoom then simply targets wherever the section really lands), and
    // the grid is re-parked so nothing appears to move.
    const resized = this.#viewportKey() !== this.#openViewport;
    const navigating = !!section && (targetName !== this.#sourceName || resized);
    const settle = () => {
      if (navigating) {
        this.#scroller.scrollBy(section.getBoundingClientRect().top - visibleTop);
      } else {
        this.#scroller.scrollBy(list.getBoundingClientRect().top - this.#listTop0);
      }
    };
    this.#swapIn(list, grid, gridTop0, settle, docHeight0);

    // No section to land on (hidden by the partial-free filter): zoom into
    // the top of the list instead of cutting.
    const to_ = this.#anchorRect(section, visibleTop) ?? this.#stageVisibleRect(visibleTop);

    if (reduceMotion.matches || !from_) {
      this.#teardown();
      return;
    }

    this.#zoom({ outgoing: grid, incoming: list, from: from_, to: to_ })
      .then((done) => { if (done) this.#teardown(); });
  }

  // Instant teardown — used when the results are re-rendered underneath us.
  reset() {
    if (this.#phase === 'idle') return;
    this.#cancelAnims();
    if (this.#onKey) document.removeEventListener('keydown', this.#onKey);
    this.#onKey = null;
    this.#teardown();
  }

  // ── Motion ────────────────────────────────────────────────────────

  // Puts `incoming` into the flow of the stage (so it defines the stage's
  // height), lets `settle` move the scroller, then parks `outgoing` as an
  // absolute layer at exactly the client-y it had before (`outgoingTop0`).
  // Everything happens before the next paint, so on screen the outgoing layer
  // hasn't moved and the scroll change is invisible — the incoming layer is
  // the only thing that "appears", and the zoom animates it in.
  #swapIn(incoming, outgoing, outgoingTop0, settle = () => {}, heightBefore = 0) {
    const stage = this.#stage;
    clearLayer(incoming);
    incoming.style.position = 'relative';
    incoming.style.zIndex = '2';

    outgoing.style.position = 'absolute';
    outgoing.style.insetInline = '0';
    outgoing.style.zIndex = '1';

    // If the swap made the scroller shorter (e.g. a tall list becoming a short
    // grid while parked at the very bottom of the page), the scrollBy calls
    // below would be clamped and both layers would lurch. Pad the shortfall
    // onto the stage so the scroll position is preserved; #settleOpen /
    // #teardown release it once nothing is animating.
    if (heightBefore) {
      const deficit = heightBefore - this.#scroller.contentHeight();
      if (deficit > 0) {
        const cur = parseFloat(stage.style.minHeight) || 0;
        stage.style.minHeight = `${cur + deficit}px`;
      }
    }

    // Default: bring the frame's top to the visible top.
    this.#scroller.scrollBy(stage.getBoundingClientRect().top - this.#scroller.visibleTop());
    settle();

    outgoing.style.top = `${outgoingTop0 - stage.getBoundingClientRect().top}px`;
  }

  // Scales `outgoing` so that rect `from` lands on rect `to`, while `incoming`
  // starts blown up by the inverse so that `to` sits on `from`, then settles.
  // One shared anchor, one shared easing — it reads as a single camera move.
  // Resolves true when it ran to completion, false if cancelled/reversed.
  #zoom({ outgoing, incoming, from, to }) {
    const k = to.width / from.width;
    const outRect = outgoing.getBoundingClientRect();
    const inRect = incoming.getBoundingClientRect();
    const stageRect = this.#stage.getBoundingClientRect();

    outgoing.style.transformOrigin = `${from.left - outRect.left}px ${from.top - outRect.top}px`;
    incoming.style.transformOrigin = `${to.left - inRect.left}px ${to.top - inRect.top}px`;
    outgoing.style.willChange = 'transform, opacity';
    incoming.style.willChange = 'transform, opacity';

    // The path the shared anchor travels: straight line from → to, bowed
    // sideways by ARC. The bow always lifts upward; for a (near-)vertical move
    // it bows toward the stage's centre line (judged from the narrower rect,
    // the card — a section spans the full width and has no side). Defined from
    // the pair of rects only, so the zoom back travels the exact same curve.
    const dx = to.left - from.left;
    const dy = to.top - from.top;
    const len = Math.hypot(dx, dy);
    let nx = 0, ny = 0;
    if (len > 1) {
      nx = -dy / len; ny = dx / len;
      // Within ~9° of vertical, the true perpendicular is almost horizontal and
      // its sign swings on sub-pixel noise in dx — one run bows left, the next
      // bows right. Snap those to the deterministic centre-line bow instead.
      if (Math.abs(ny) < 0.15) {
        const narrow = from.width < to.width ? from : to;
        const mid = narrow.left + narrow.width / 2;
        nx = mid <= stageRect.left + stageRect.width / 2 ? 1 : -1;
        ny = 0;
      } else if (ny > 0) {
        nx = -nx; ny = -ny;
      }
    }
    const bulge = ARC * len;

    // Both layers are sampled from the same spring progress `s`, and the scale
    // is interpolated geometrically (k^s), so the anchor rects coincide at
    // every frame and the magnification changes at a steady perceived rate —
    // a linear blend of the scale factor reads as a lurch then a crawl.
    const outFrames = [];
    const inFrames = [];
    for (let i = 0; i < KEYFRAMES; i++) {
      const p = i / (KEYFRAMES - 1);
      const s = spring(p);
      const arc = bulge * Math.sin(Math.PI * s);
      const ax = from.left + dx * s + nx * arc; // anchor's top-left right now
      const ay = from.top + dy * s + ny * arc;
      outFrames.push({
        offset: p,
        transform: `translate(${ax - from.left}px, ${ay - from.top}px) scale(${k ** s})`,
        // Stays put through the first stretch (you see it shrink / grow),
        // then dissolves into the incoming layer well before it settles.
        opacity: 1 - smooth(s, 0.35, 0.9),
      });
      inFrames.push({
        offset: p,
        transform: `translate(${ax - to.left}px, ${ay - to.top}px) scale(${k ** (s - 1)})`,
        opacity: smooth(s, 0.05, 0.65),
      });
    }

    const opts = { duration: DUR, easing: 'linear', fill: 'both' };
    const anims = [outgoing.animate(outFrames, opts), incoming.animate(inFrames, opts)];
    this.#anims = anims;

    // Resolves true only if we're still in the phase that started this zoom;
    // a reversed open finishes its (reversed) animations too, but by then the
    // phase has moved on and the caller must not settle.
    const phase = this.#phase;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      Promise.all(anims.map(a => a.finished)).then(
        () => finish(this.#phase === phase),
        () => finish(false),
      );
      // Backstop: iOS Safari sometimes never resolves `.finished` for a
      // composited animation, which would strand the view mid-morph (class,
      // clip and phase never cleaned up). Settle on our own clock if so.
      setTimeout(() => finish(this.#phase === phase), DUR + 150);
    });
  }

  // Tapped the card / × while still zooming out: run the same animations
  // backwards and undo, so the motion just turns around mid-flight instead of
  // finishing and then playing a second one.
  #reverseOpen() {
    if (!this.#anims.length) return;
    this.#phase = 'closing';
    this.#isOpen = false;
    document.removeEventListener('keydown', this.#onKey);
    this.#onKey = null;
    haptics.trigger(defaultPatterns.light);

    const anims = this.#anims;
    anims.forEach(a => a.reverse());

    // `reverse()` plays the opacity keyframes backwards too, but the zoom's
    // cross-fade is sampled against the spring's progress, which front-loads
    // itself — run backwards it bunches into the final moments, so the grid we
    // are leaving stays fully opaque almost the whole way and then snaps. Drive
    // the opacity ourselves with a plain linear cross-fade over the time that's
    // actually left (a reversed animation runs from `currentTime` back to 0).
    const left = Math.max(120, anims[0].currentTime ?? DUR);
    const fade = { duration: left, easing: 'linear', fill: 'both' };
    this.#anims.push(
      this.#grid.animate(
        [{ opacity: getComputedStyle(this.#grid).opacity }, { opacity: 0 }], fade),
      this.#list.animate(
        [{ opacity: getComputedStyle(this.#list).opacity }, { opacity: 1 }], fade),
    );

    Promise.all(anims.map(a => a.finished)).then(() => {
      // Both layers are back at rest; put the list back into flow and cancel
      // the scroll shift that #swapIn made on open, all before the next paint.
      const listTop = this.#list.getBoundingClientRect().top;
      this.#teardown({ restoreListTop: listTop });
    }, () => {});
  }

  #cancelAnims() {
    this.#anims.forEach(a => a.cancel());
    this.#anims = [];
  }

  // ── State ─────────────────────────────────────────────────────────
  // Only the sections that can pass through the frame during the zoom get
  // painted (and have their cards' content-visibility forced on, so they
  // don't pop in blank a frame late); everything further from the anchor
  // section than the frame can reach at the smallest scale is hidden. The
  // list runs to thousands of pixels — this is most of the raster work.
  //
  // Must run before any measurement: a section that has never been rendered
  // sits at its content-visibility placeholder size, and forcing it to
  // render can change its height and shift everything below. Geometry is
  // list-relative (no transforms are applied at this point), so it holds
  // whatever the scroll position. The smallest scale isn't known yet when
  // opening (the grid doesn't exist), so a conservative estimate is used.
  #scopeSections(anchorSection) {
    const list = this.#list;
    const listTop = list.getBoundingClientRect().top;
    const reach = (this.#scroller.visibleBottom() - this.#scroller.visibleTop()) / 0.4 * 1.1;
    let lo, hi;
    if (anchorSection) {
      const a = anchorSection.getBoundingClientRect();
      lo = a.top - listTop - reach;
      hi = a.bottom - listTop + reach;
    } else {
      const v = this.#scroller.visibleTop() - listTop;
      lo = v - reach;
      hi = v + reach;
    }
    for (const sec of list.children) {
      const r = sec.getBoundingClientRect();
      const on = r.bottom - listTop >= lo && r.top - listTop <= hi;
      sec.classList.toggle('bo-onstage', on);
      sec.classList.toggle('bo-offstage', !on);
    }
  }

  #unscopeSections() {
    for (const sec of this.#list?.children ?? []) sec.classList.remove('bo-onstage', 'bo-offstage');
  }

  #settleOpen() {
    this.#cancelAnims();
    this.#unscopeSections();
    this.#list.style.display = 'none';
    clearLayer(this.#grid);
    this.#grid.style.position = 'relative';
    this.#grid.style.zIndex = '2'; // above the parked list, always

    // Drop the anti-clamp padding #swapIn may have added for the zoom, back to
    // the plain one-screen minimum — keeping the grid where it sits on screen
    // as the scroller shrinks (the browser clamps it up if the grid is short).
    const gridTop = this.#grid.getBoundingClientRect().top;
    this.#stage.style.minHeight =
      `${this.#scroller.visibleBottom() - this.#scroller.visibleTop()}px`;
    this.#scroller.scrollBy(this.#grid.getBoundingClientRect().top - gridTop);

    this.#container.classList.remove('bo-animating');
    this.#phase = 'open';
  }

  #teardown({ restoreListTop = null } = {}) {
    this.#cancelAnims();
    // Ease the classroom cards' tight morph shadow back to the resting one as
    // #unscopeSections drops .bo-onstage, rather than snapping it in.
    this.#container?.classList.add('bo-shadow-restore');
    this.#unscopeSections();
    const { list, stage, container, grid } = {
      list: this.#list, stage: this.#stage, container: this.#container, grid: this.#grid,
    };
    if (container) setTimeout(() => container.classList.remove('bo-shadow-restore'), 450);

    // Where the list sits on screen right now — used to hold it still across
    // the stage removal when the caller didn't ask for a specific target.
    // Dropping the (possibly padded, grid-tall) stage for the list's natural
    // height shrinks the scroller and would otherwise clamp the scroll.
    const listTopNow = list?.getBoundingClientRect().top ?? null;

    if (list) {
      list.style.display = '';
      clearLayer(list);
      if (stage?.parentNode === container) container.insertBefore(list, stage);
    }
    grid?.remove();
    stage?.remove();
    if (this.#filterRow) this.#filterRow.hidden = false;
    container?.classList.remove('bo-active', 'bo-animating');

    const target = restoreListTop ?? listTopNow;
    if (target != null && list && this.#scroller) {
      this.#scroller.scrollBy(list.getBoundingClientRect().top - target);
    }

    this.#stage = null;
    this.#grid = null;
    this.#scroller = null;
    this.#pendingNavName = null;
    this.#isOpen = false;
    this.#phase = 'idle';
  }

  // ── Geometry ──────────────────────────────────────────────────────

  // The rect a building's section occupies on screen, cropped to what's
  // actually visible: when its header is stuck the section itself starts
  // above the fold, and what should shrink into the card is the part you're
  // looking at — with the stuck pill landing on the card's title.
  #anchorRect(section, visibleTop) {
    if (!section) return null;
    const r = section.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null; // hidden (partial-free filter)
    const top = Math.max(r.top, visibleTop);
    return { left: r.left, top, width: r.width, height: Math.max(1, r.bottom - top) };
  }

  #openViewport = '';
  #viewportKey() {
    return `${window.innerWidth}x${window.innerHeight}:${this.#container?.clientWidth ?? 0}`;
  }

  // The part of the stage that's on screen (its top starts at visibleTop once
  // #swapIn has parked it there) — the generic anchor when there's no section.
  #stageVisibleRect(visibleTop) {
    const r = this.#stage.getBoundingClientRect();
    const top = Math.max(r.top, visibleTop);
    return { left: r.left, top, width: r.width, height: Math.max(1, r.bottom - top) };
  }

  // Client-y a stuck building header parks at (the used `top` of the sticky
  // header — header height + picker bar + margins, or 1rem inside the panel
  // on desktop).
  #stickyTop(section) {
    const header = section?.querySelector('.building-section-header');
    const px = header ? parseFloat(getComputedStyle(header).top) : NaN;
    return Number.isFinite(px) ? px : 80;
  }

  #sectionFor(name) {
    return this.#list?.querySelector(
      `.building-section[data-building-name="${CSS.escape(name)}"]`
    ) ?? null;
  }

  #cardFor(name) {
    return this.#grid?.querySelector(`.bo-card[data-building-name="${CSS.escape(name)}"]`) ?? null;
  }

  // ── Grid / cards ──────────────────────────────────────────────────
  #buildGrid() {
    const { campusId, date, from, results } = this.#ctx;

    const active = new Set(
      (results ?? [])
        .filter(r => r.rooms.some(rm => rm.status === 'free' || rm.status === 'partially-free'))
        .map(r => r.building.name)
    );

    const grid = document.createElement('div');
    grid.className = 'bo-grid';

    const bar = document.createElement('div');
    bar.className = 'bo-topbar';
    bar.innerHTML = `
      <h3 class="bo-title">${escapeHtml(t('overview.title'))}</h3>
      <button class="bo-close liquid-glass" type="button" aria-label="${escapeHtml(t('overview.close'))}">
        <span class="material-symbols-outlined">close</span>
      </button>
    `;
    const closeBtn = bar.querySelector('.bo-close');
    closeBtn.addEventListener('pointerdown', () => this.prewarmClose());
    closeBtn.addEventListener('click', () => this.close());
    grid.appendChild(bar);

    for (const { building, counts } of getCampusBuildingsOverview(campusId, date, from)) {
      grid.appendChild(this.#buildCard(building, counts, active.has(building.name)));
    }
    return grid;
  }

  #buildCard(building, counts, isActive) {
    const total = STATUS_META.reduce((n, s) => n + (counts[s.key] || 0), 0);

    const card = document.createElement('div');
    card.className = 'bo-card' + (isActive ? '' : ' bo-card--inactive');
    card.dataset.buildingName = building.name;

    const countsHtml = STATUS_META.map(s => {
      const n = counts[s.key] || 0;
      return `<span class="bo-count ${s.cls}${n === 0 ? ' is-zero' : ''}">
                <b>${n}</b><span class="bo-count-label">${escapeHtml(t(s.i18n))}</span>
              </span>`;
    }).join('');

    card.innerHTML = `
      <div class="bo-card-body">
        <div class="bo-card-head">
          <span class="bo-card-name">${escapeHtml(t('building.prefix'))} ${escapeHtml(building.name)}</span>
          ${building.altName ? `<span class="bo-card-alt">${escapeHtml(building.altName)}</span>` : ''}
          <span class="bo-card-total secondary">${escapeHtml(t('overview.subtitle').replace('{n}', total))}</span>
        </div>
        <div class="bo-card-counts">${countsHtml}</div>
      </div>
    `;

    if (isActive) {
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `${t('building.prefix')} ${building.name}`);
      const go = () => { this.#pendingNavName = building.name; this.close(); };
      // Navigate on pointerup, not click. prewarmClose reveals the parked list
      // and forces layout on it during pointerdown; on iOS Safari that jitters
      // the gesture enough that the synthetic click never arrives, so the first
      // tap only played the :active scale. pointerup is a real event and always
      // fires. click stays for keyboard / assistive-tech; close() is idempotent.
      let downAt = null;
      card.addEventListener('pointerdown', (e) => {
        downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
        this.prewarmClose(building.name);
      });
      card.addEventListener('pointerup', (e) => {
        if (!downAt) return;
        const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
        const held = performance.now() - downAt.t;
        downAt = null;
        if (moved <= 12 && held < 700) go();
      });
      card.addEventListener('pointercancel', () => { downAt = null; });
      card.addEventListener('click', go);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    }
    return card;
  }
}

export const buildingOverview = new BuildingOverview();
