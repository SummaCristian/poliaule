// Bottom pill nav — ported from the DormMate case-study's spring pill tab bar
// (Portfolio/projects/university/DormMate/dormmate_script.js), swapped from a
// sticky-top bar over a single scrolling page to a fixed-bottom bar that drives
// this app's existing show/hide tab-content panels.
//
// Per the Figma reference, "Search" is visually split off from the
// Available/Campus pair: Available+Campus share one sliding/draggable pill,
// Search is a separate standalone circular button (tap-only, own lift spring).

import { haptics, defaultPatterns } from './haptics.js';
import { t, onLanguageSwitch } from '../i18n.js';
import { DEFAULT_TAB_KEY, LAST_TAB_KEY, getStartupTabId } from './settings.js';
import { Spring, onSpringFrame } from '../utils/spring.js';
import { openSearchOverlay } from './search-overlay.js';

const GROUP_TABS = [
  { target: 'available-classrooms-container', icon: 'hgi-calendar-03', labelKey: 'tabs.available' },
  { target: 'search-classrooms-container', icon: 'hgi-university', labelKey: 'tabs.campus' },
];

const TAP_SCALE = 1.3;
const RAIL_GIVE = 11;         // elastic px the pill can be pulled past the end anchors
const CROSS_GIVE = 5;         // elastic px the pill can be pulled off its rail
const STRETCH_GAIN = 0.9;     // pill speed (px/ms) → inertia deform ratio
const STRETCH_MAX = 0.26;
const CONTAINER_FOLLOW = 0.09;    // fraction of the drag the whole bar trails by
const CONTAINER_GIVE = 5;         // px cap along the rail
const CONTAINER_GIVE_CROSS = 4;   // px cap across it

// Asymptotic rubber-band (approaches ±give, never past it) — same falloff as
// the swipe-deform in liquid-glass.js.
const rubber = (x, give) => (x * give) / (give + Math.abs(x));

// Desktop swaps the bar from a horizontal bottom bar to a vertical rail
// pinned top-left (see bottom-nav.css's matching breakpoint) — all the pill
// sliding/morphing math below is written generically against a "main axis"
// (x + width when horizontal, y + height when vertical) and a fixed "cross
// axis" (the bar's own thickness), so it works unchanged in both.
const desktopMQ = matchMedia('(min-width: 600px)');
const isVertical = () => desktopMQ.matches;

onSpringFrame(render);

/* --- DOM ------------------------------------------------------ */
const wrapper = document.getElementById('bn-wrapper');
const group = document.getElementById('bn-group');
const bar = document.getElementById('bn-bar');
const barItems = document.getElementById('bn-bar-items');
const pill = document.getElementById('bn-pill');
const pillHit = document.getElementById('bn-pill-hit');
const activeRow = document.getElementById('bn-active-row');
const searchBtn = document.getElementById('bn-search-btn');
const contentContainers = document.querySelectorAll('.tab-content');

function tabLabel(tab) { return t(tab.labelKey); }

GROUP_TABS.forEach((tab, i) => {
  const btn = document.createElement('button');
  btn.className = 'bn-tab-item';
  btn.dataset.target = tab.target;
  btn.setAttribute('role', 'tab');
  btn.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
  btn.setAttribute('aria-controls', tab.target);
  btn.innerHTML = `
    <span class="bn-tab-content">
      <i class="hgi-stroke ${tab.icon}"></i>
      <span class="bn-tab-label" data-i18n="${tab.labelKey}">${tabLabel(tab)}</span>
    </span>`;
  btn.addEventListener('click', () => { if (i !== groupIndex) animateGroupTap(i); });
  barItems.appendChild(btn);

  const active = document.createElement('span');
  active.className = 'bn-tab-content bn-tab-active';
  active.innerHTML = `
    <i class="hgi-stroke ${tab.icon}"></i>
    <span class="bn-tab-label" data-i18n="${tab.labelKey}">${tabLabel(tab)}</span>`;
  activeRow.appendChild(active);
});

searchBtn.querySelector('.bn-tab-label').textContent = t('tabs.search');
searchBtn.addEventListener('click', () => animateSearchTap());

onLanguageSwitch(() => {
  bar.querySelectorAll('.bn-tab-label').forEach((el, i) => { el.textContent = tabLabel(GROUP_TABS[i]); });
  activeRow.querySelectorAll('.bn-tab-label').forEach((el, i) => { el.textContent = tabLabel(GROUP_TABS[i]); });
  searchBtn.querySelector('.bn-tab-label').textContent = t('tabs.search');
});

/* --- State + layout -------------------------------------------- */
// Tabs hug their own content (icon + label), so unlike a uniform grid the
// pill has to slide AND resize between anchors of different widths — each
// anchor below is the pill's {x, w} for sitting exactly on top of one tab.
let groupIndex = 0;
let didInit = false;
let itemsW = 0, itemsH = 0, pillCross = 0;
let anchors = [];

const pillPos = new Spring(0);
const pillMain = new Spring(0);
const crossOff = new Spring(0); // off-rail offset, springs back to 0 on release
const containerOff = new Spring(0);      // whole-bar trail along the rail
const containerCross = new Spring(0);    // ...and across it (soft springs, they lag fast scrolls)
const scale = new Spring(1);
const searchScale = new Spring(1);

// Per-frame pill velocity → the inertia deform in render() (smoothed
// frame-to-frame so it eases rather than jitters).
let lastRenderT = performance.now();
let lastMainVal = 0, lastCrossVal = 0, smoothStretch = 0;

function measureAnchors() {
  const itemsRect = barItems.getBoundingClientRect();
  const vertical = isVertical();
  // The pill is exactly as large as the item it sits on — the only inset
  // gap comes from the bar's own padding, already excluded from itemsRect.
  return Array.from(barItems.querySelectorAll('.bn-tab-item')).map(el => {
    const r = el.getBoundingClientRect();
    return vertical
      ? { pos: r.top - itemsRect.top, size: r.height }
      : { pos: r.left - itemsRect.left, size: r.width };
  });
}

// Linear interpolation of the pill's main-axis size between the two anchors
// bracketing pos, so it morphs smoothly while sliding/dragging between
// differently-sized tabs. clampedPos intentionally ignores overshoot past
// the first/last anchor so the size just holds steady there.
function sizeForPos(pos) {
  const n = anchors.length;
  const clampedPos = Math.max(anchors[0].pos, Math.min(anchors[n - 1].pos, pos));
  for (let i = 0; i < n - 1; i++) {
    const a = anchors[i], b = anchors[i + 1];
    if (clampedPos >= a.pos && clampedPos <= b.pos) {
      const f = (clampedPos - a.pos) / (b.pos - a.pos);
      return a.size + f * (b.size - a.size);
    }
  }
  return anchors[n - 1].size;
}

function layout() {
  const vertical = isVertical();
  const barRect = bar.getBoundingClientRect();
  const wrapRect = group.getBoundingClientRect();
  const itemsRect = barItems.getBoundingClientRect();
  itemsW = itemsRect.width;
  itemsH = itemsRect.height;
  pillCross = vertical ? itemsW : itemsH;

  const left = itemsRect.left - wrapRect.left;
  const top = itemsRect.top - wrapRect.top;
  for (const el of [pill, pillHit]) {
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    if (vertical) {
      el.style.width = itemsW + 'px';
      el.style.height = '';
    } else {
      el.style.height = itemsH + 'px';
      el.style.width = '';
    }
  }
  if (vertical) {
    activeRow.style.height = itemsH + 'px';
    activeRow.style.width = '';
  } else {
    activeRow.style.width = itemsW + 'px';
    activeRow.style.height = '';
  }

  // The search button is always a circle matching the bar's own thickness
  // (cross axis) — its height on mobile, its width on the desktop rail.
  const diameter = vertical ? barRect.width : barRect.height;
  searchBtn.style.height = diameter + 'px';
  searchBtn.style.width = diameter + 'px';

  anchors = measureAnchors();
  const a = anchors[groupIndex];
  if (!didInit) {
    pillPos.set(a.pos); pillMain.set(a.size); didInit = true;
  } else {
    pillPos.to(a.pos, { stiffness: 1000, damping: 100 });
    pillMain.to(a.size, { stiffness: 1000, damping: 100 });
  }
  updateMask();
}
new ResizeObserver(layout).observe(bar);
addEventListener('resize', layout);
// Crossing the breakpoint changes what pillPos/pillMain's stored numbers
// mean (x/width vs y/height) — force the next layout() to snap instead of
// spring-animating from a now-meaningless stale value.
desktopMQ.addEventListener('change', () => { didInit = false; });

// Cuts a pill-shaped hole out of the gray icon/label layer, matching the
// green pill's position/size exactly, so it doesn't show through the
// pill's translucent background.
function updateMask(scMain = scale.value, scCross = scale.value) {
  if (!itemsW || !itemsH) return;
  const vertical = isVertical();
  const mainVal = pillMain.value * scMain;
  const crossVal = pillCross * scCross;
  const w = vertical ? crossVal : mainVal;
  const h = vertical ? mainVal : crossVal;
  const r = Math.min(w, h) / 2;
  const cx = (vertical ? itemsW / 2 : pillPos.value + pillMain.value / 2) + (vertical ? crossOff.value : 0);
  const cy = (vertical ? pillPos.value + pillMain.value / 2 : itemsH / 2) + (vertical ? 0 : crossOff.value);
  const x = cx - w / 2;
  const y = cy - h / 2;
  const d = `M0 0H${itemsW}V${itemsH}H0Z ` +
    `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
  const clip = `path(evenodd, "${d}")`;
  barItems.style.clipPath = clip;
  barItems.style.webkitClipPath = clip;
}

function render() {
  const vertical = isVertical();

  // Per-frame pill velocity → inertia squash-and-stretch while it's lifted:
  // faster travel deforms it more, stretched along the direction of motion
  // and squashed across it. Smoothed so it eases; zeroed when not lifted.
  const nowT = performance.now();
  const gap = nowT - lastRenderT;
  lastRenderT = nowT;
  // The shared RAF loop pauses when idle; skip the velocity calc on the first
  // frame after it restarts rather than dividing a stale delta.
  if (gap > 100 || gap <= 0) {
    lastMainVal = pillPos.value;
    lastCrossVal = crossOff.value;
    smoothStretch = 0;
  }
  const dt = Math.min(Math.max(gap, 1), 64);
  const vMain = (pillPos.value - lastMainVal) / dt;
  const vCross = (crossOff.value - lastCrossVal) / dt;
  lastMainVal = pillPos.value;
  lastCrossVal = crossOff.value;

  const lifted = scale.value > 1.001;
  const speed = Math.hypot(vMain, vCross);
  const targetStretch = lifted ? Math.min(speed * STRETCH_GAIN, STRETCH_MAX) : 0;
  smoothStretch = lifted ? smoothStretch + (targetStretch - smoothStretch) * 0.3 : 0;
  const um = speed > 1e-3 ? Math.abs(vMain) / speed : 1;
  const uc = speed > 1e-3 ? Math.abs(vCross) / speed : 0;
  const stMain = smoothStretch * um;
  const stCross = smoothStretch * uc;
  const s = scale.value;
  const scMain = s * (1 + stMain - 0.5 * stCross);
  const scCross = s * (1 + stCross - 0.5 * stMain);

  const size = pillMain.value;
  if (vertical) {
    pill.style.height = size + 'px';
    pillHit.style.height = size + 'px';
  } else {
    pill.style.width = size + 'px';
    pillHit.style.width = size + 'px';
  }
  const tMain = vertical ? 'translateY' : 'translateX';
  const tCross = vertical ? 'translateX' : 'translateY';
  const scaleStr = vertical
    ? `scale(${scCross}, ${scMain})`
    : `scale(${scMain}, ${scCross})`;
  const posStr = `${tMain}(${pillPos.value}px) ${tCross}(${crossOff.value}px)`;
  pill.style.transform = `${posStr} ${scaleStr}`;
  pillHit.style.transform = posStr;
  // Full glass look only while actually lifted (mid tap or drag spring);
  // flat color at rest. Checking scale.value directly (rather than
  // scale.resting) also covers reduced-motion, where to() snaps the value
  // straight to its target instead of animating toward it.
  pill.classList.toggle('bn-pill--lifted', lifted);
  activeRow.style.transform = vertical
    ? `translateY(${-pillPos.value}px) translateX(${-crossOff.value}px)`
    : `translateX(${-pillPos.value}px) translateY(${-crossOff.value}px)`;
  // The whole bar (pill + chrome together) trails the drag a touch, on both axes.
  const cMain = containerOff.value, cCross = containerCross.value;
  const cx = vertical ? cCross : cMain;
  const cy = vertical ? cMain : cCross;
  group.style.transform = (cx || cy) ? `translate(${cx}px, ${cy}px)` : '';
  searchBtn.style.transform = `scale(${searchScale.value})`;
  updateMask(scMain, scCross);
}

/* --- Tab-content switching (mirrors the old header tabbar's behavior) ------ */
function showContent(targetId) {
  contentContainers.forEach(container => {
    if (container.id === targetId) {
      requestAnimationFrame(() => {
        container.classList.add('visible');
        // content-visibility:hidden->visible doesn't reliably fire
        // ResizeObserver on descendants across browsers (e.g. Safari), so
        // anything that measured its own layout (offsetTop/offsetWidth)
        // while this tab was hidden — like the date picker's sliding
        // indicator — can be left with stale coordinates baked into inline
        // styles. Let listeners (date-picker.js) recompute now that this
        // subtree is actually laid out again.
        container.dispatchEvent(new CustomEvent('tabvisible', { bubbles: true }));
      });
    } else {
      container.classList.remove('visible');
    }
  });
}

function persist(targetId) {
  if (localStorage.getItem(DEFAULT_TAB_KEY) === 'last') {
    localStorage.setItem(LAST_TAB_KEY, targetId);
  }
}

function setGroupActive(i) {
  groupIndex = i;
  bar.querySelectorAll('.bn-tab-item').forEach((btn, j) => {
    btn.setAttribute('aria-selected', j === i ? 'true' : 'false');
  });

  const targetId = GROUP_TABS[i].target;
  showContent(targetId);
  window.scrollTo(0, 0);
  persist(targetId);
}

function animateGroupTap(i) {
  setGroupActive(i);
  haptics.trigger(defaultPatterns.light);

  const a = anchors[i];
  scale.to(TAP_SCALE, { stiffness: 500, damping: 25, mass: 0.5 });
  setTimeout(() => {
    pillPos.to(a.pos, { stiffness: 400, damping: 35, mass: 0.8 });
    pillMain.to(a.size, { stiffness: 400, damping: 35, mass: 0.8 });
  }, 50);
  setTimeout(() => scale.to(1, { stiffness: 350, damping: 30, mass: 0.8 }), 250);
}

function animateSearchTap() {
  haptics.trigger(defaultPatterns.light);
  openSearchOverlay();

  searchScale.to(TAP_SCALE, { stiffness: 500, damping: 25, mass: 0.5 });
  setTimeout(() => searchScale.to(1, { stiffness: 350, damping: 30, mass: 0.8 }), 250);
}

/* --- Programmatic tab activation (e.g. the building header's jump button) - */
export function activateGroupTab(target) {
  const i = GROUP_TABS.findIndex(tab => tab.target === target);
  if (i === -1 || i === groupIndex) return;
  animateGroupTap(i);
}

/* --- Drag (PanResponder → Pointer Events) ------------------------------- */
// Two ways in: grab the pill itself (relative — it moves by your drag delta),
// or press-and-hold on an unselected tab (absolute — the pill lifts and glides
// under your finger, then tracks it). A quick tap on a tab still just selects,
// via the button's own click handler.
const DRAG_OVERSHOOT = 8;
const HOLD_MS = 130;        // press-and-hold before an unselected tab grabs the pill
const ENGAGE_MOVE = 6;      // ...or this much finger travel, whichever comes first
let dragging = false, grabbed = false, absoluteDrag = false;
let startX = 0, startY = 0, grantTime = 0, dragOriginPos = 0, itemsOrigin = 0;
let holdTimer = 0, dragTab = null;
let samples = [];

// "Main" tracks whichever screen axis the bar currently slides along
// (x/horizontal on mobile, y/vertical on desktop); "cross" is the other one,
// used only to tell a tap from a drag.
const mainDelta = (e) => isVertical() ? e.clientY - startY : e.clientX - startX;
const crossDelta = (e) => isVertical() ? e.clientX - startX : e.clientY - startY;
const mainPos = (e) => isVertical() ? e.clientY : e.clientX;
const crossPos = (e) => isVertical() ? e.clientX : e.clientY;

const clampDragPos = (pos) => Math.max(anchors[0].pos - DRAG_OVERSHOOT,
  Math.min(anchors[anchors.length - 1].pos + DRAG_OVERSHOOT, pos));

// Live drag position: elastic past the first/last anchor instead of a hard
// stop, so the pill can be pulled a bit further along the rail.
const railDragPos = (raw) => {
  const lo = anchors[0].pos, hi = anchors[anchors.length - 1].pos;
  if (raw < lo) return lo + rubber(raw - lo, RAIL_GIVE);
  if (raw > hi) return hi + rubber(raw - hi, RAIL_GIVE);
  return raw;
};

// Pill's leading-edge position (anchor units) that puts its centre under the
// pointer — used for the absolute "come to my finger" drag.
const pillEdgeAtPointer = (e) => (mainPos(e) - itemsOrigin) - pillMain.value / 2;

// Commit to the drag: lift, and (for an absolute drag) glide the pill to the
// finger. Idempotent — the hold timer and an early move both call it.
function engage(e) {
  if (grabbed) return;
  grabbed = true;
  clearTimeout(holdTimer); holdTimer = 0;
  pillPos.stop(); pillMain.stop(); crossOff.stop();
  dragOriginPos = pillPos.value;
  scale.to(TAP_SCALE, { stiffness: 500, damping: 25, mass: 0.5 });
  if (absoluteDrag) {
    const raw = pillEdgeAtPointer(e);
    pillPos.to(railDragPos(raw), { stiffness: 700, damping: 42, mass: 0.55 });
    pillMain.to(sizeForPos(raw), { stiffness: 700, damping: 42, mass: 0.55 });
  }
}

function onDragStart(e) {
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  dragging = true;
  grabbed = false;
  absoluteDrag = el !== pillHit;
  dragTab = absoluteDrag ? el : null;
  startX = e.clientX; startY = e.clientY;
  grantTime = performance.now();
  samples = [{ main: mainPos(e), cross: crossPos(e), t: grantTime }];
  const r = barItems.getBoundingClientRect();
  itemsOrigin = isVertical() ? r.top : r.left;

  if (absoluteDrag) holdTimer = setTimeout(() => engage(e), HOLD_MS);
  else engage(e); // grabbing the pill itself: no wait
}

function onDragMove(e) {
  if (!dragging) return;
  const now = performance.now();
  samples.push({ main: mainPos(e), cross: crossPos(e), t: now });
  while (samples.length > 2 && now - samples[0].t > 100) samples.shift();

  if (!grabbed) {
    if (Math.hypot(mainDelta(e), crossDelta(e)) > ENGAGE_MOVE) engage(e);
    else return;
  }
  if (!absoluteDrag && now - grantTime < 50) return;

  const raw = absoluteDrag ? pillEdgeAtPointer(e) : dragOriginPos + mainDelta(e);
  pillPos.to(railDragPos(raw), { stiffness: 1000, damping: 70, mass: 0.5 });
  pillMain.to(sizeForPos(raw), { stiffness: 1000, damping: 70, mass: 0.5 });
  crossOff.to(rubber(crossDelta(e), CROSS_GIVE), { stiffness: 700, damping: 42, mass: 0.5 });
  containerOff.to(rubber(mainDelta(e) * CONTAINER_FOLLOW, CONTAINER_GIVE),
    { stiffness: 260, damping: 26, mass: 1 });
  containerCross.to(rubber(crossDelta(e) * CONTAINER_FOLLOW, CONTAINER_GIVE_CROSS),
    { stiffness: 260, damping: 26, mass: 1 });
}

function release(e, terminated) {
  if (!dragging) return;
  dragging = false;
  clearTimeout(holdTimer); holdTimer = 0;

  // Never engaged → it was a quick tap on a tab; let its click select it.
  if (!grabbed) { dragTab = null; return; }

  // We drove the pill, so suppress the tab button's click (whichever tab the
  // browser routes it to) — the selection is decided below.
  if (dragTab) {
    const swallow = (ev) => ev.stopImmediatePropagation();
    barItems.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => barItems.removeEventListener('click', swallow, { capture: true }), 0);
    dragTab = null;
  }

  crossOff.to(0, { stiffness: 480, damping: 26, mass: 0.6 });
  containerOff.to(0, { stiffness: 320, damping: 24, mass: 0.8 });
  containerCross.to(0, { stiffness: 320, damping: 24, mass: 0.8 });
  const dMain = mainDelta(e), dCross = crossDelta(e);

  // Cancelled, or a barely-moved grab of the pill itself → just settle back.
  if (terminated || (!absoluteDrag && Math.abs(dMain) < 8 && Math.abs(dCross) < 8)) {
    scale.to(1, { stiffness: 350, damping: 30, mass: 0.8 });
    const a = anchors[groupIndex];
    pillPos.to(a.pos, { stiffness: 400, damping: 38, mass: 0.8 });
    pillMain.to(a.size, { stiffness: 400, damping: 38, mass: 0.8 });
    return;
  }

  const a = samples[0], b = samples[samples.length - 1];
  const v = b.t > a.t ? (b.main - a.main) / (b.t - a.t) : 0;
  const from = absoluteDrag ? pillEdgeAtPointer(e) : dragOriginPos + dMain;
  const projectedPos = clampDragPos(from + v * 80);
  let nearest = 0, bestDist = Infinity;
  anchors.forEach((anchor, i) => {
    const d = Math.abs(projectedPos - anchor.pos);
    if (d < bestDist) { bestDist = d; nearest = i; }
  });
  const target = anchors[nearest];
  pillPos.to(target.pos, { stiffness: 400, damping: 38, mass: 0.8 });
  pillMain.to(target.size, { stiffness: 400, damping: 38, mass: 0.8 });
  setTimeout(() => scale.to(1, { stiffness: 350, damping: 30, mass: 0.8 }), 200);
  if (nearest !== groupIndex) {
    setGroupActive(nearest);
    haptics.trigger(defaultPatterns.light);
  }
}

function attachPillDrag(el) {
  el.addEventListener('pointerdown', onDragStart);
  el.addEventListener('pointermove', onDragMove);
  el.addEventListener('pointerup', (e) => release(e, false));
  el.addEventListener('pointercancel', (e) => release(e, true));
}
attachPillDrag(pillHit);
barItems.querySelectorAll('.bn-tab-item').forEach(attachPillDrag);

/* --- Keyboard (cycles within the Available/Campus group) ----------------- */
bar.addEventListener('keydown', (e) => {
  // Both axes' arrow keys work regardless of orientation, since either could
  // be plausible muscle memory depending on how the bar currently reads.
  const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
  const backward = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
  const next = forward ? 1 : backward ? -1 : 0;
  if (next) animateGroupTap(Math.max(0, Math.min(GROUP_TABS.length - 1, groupIndex + next)));
});

/* --- Startup ---------------------------------------------------- */
{
  const startupId = getStartupTabId();
  const startupIndex = GROUP_TABS.findIndex(tab => tab.target === startupId);
  groupIndex = startupIndex === -1 ? 0 : startupIndex;
  showContent(GROUP_TABS[groupIndex].target);
  bar.querySelectorAll('.bn-tab-item').forEach((btn, j) => {
    btn.setAttribute('aria-selected', j === groupIndex ? 'true' : 'false');
  });
}

function setNavSizeVars() {
  document.documentElement.style.setProperty('--bottom-nav-height', `${wrapper.offsetHeight}px`);
  document.documentElement.style.setProperty('--side-nav-width', `${wrapper.offsetWidth}px`);
}
new ResizeObserver(setNavSizeVars).observe(wrapper);
setNavSizeVars();

layout();
render();
