import { getMapboxToken } from '../config.js';
import { classroomsData } from '../classroom-search-data.js';
import { t } from '../i18n.js';
import { escapeHtml } from '../utils/html.js';
import { haptics, defaultPatterns } from './haptics.js';

// Fullscreen Mapbox map that fills the Campus tab. The app chrome (header,
// footer, bottom-nav) floats above it — see components/campus-map.css, which
// also locks the page scroll while this tab is open so every drag / pinch /
// rotate goes to the map instead of the page behind it.
//
// Two zoom levels of markers, MapKit-style: campuses first, and tapping one
// flies in and swaps to that campus's building markers. Zooming back out past
// a threshold returns to the campus overview. Static for now — markers don't
// reflect live occupancy yet.

const MAPBOX_VERSION = '3.9.1';
const CONTAINER_ID = 'search-classrooms-container';

// Milano metro — 4 of 7 campuses and almost every classroom sit here; the
// others (Cremona, Lecco, Mantova) are a pan away and always keep their marker.
const INITIAL_CENTER = [9.195, 45.488];
const INITIAL_ZOOM = 11.3;
// A loose leash around Lombardy so a stray fling can't lose the map. Applied as
// a soft post-move clamp rather than the constructor's `maxBounds` — the latter
// silently caps the map's pitch (and blocks flyTo/setPitch from raising it), so
// with it set the 3D tilt never engages. See panBackInBounds().
const MAX_BOUNDS = [[8.3, 44.5], [11.6, 46.8]];
// Below this zoom we're "looking at the region" → show campuses, not buildings.
const CAMPUS_ZOOM = 12.3;
// Where a campus tap settles.
const CAMPUS_FLY_ZOOM = 15.5;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');

let started = false;
let map = null;
let mode = 'campus';   // 'campus' | 'buildings'
let markers = [];      // currently-rendered mapboxgl.Marker[]

export function initCampusMap() {
  const container = document.getElementById(CONTAINER_ID);
  if (!container) return;

  const onVisible = () => {
    if (!started) {
      started = true;
      boot(container).catch(err => {
        console.error('Campus map failed to load', err);
        showError(container);
      });
    } else if (map) {
      // Container may have resized (rotation, toolbar) while the tab was hidden.
      map.resize();
    }
  };

  container.addEventListener('tabvisible', onVisible);
  if (container.classList.contains('visible')) onVisible();
}

async function boot(container) {
  const token = await getMapboxToken();
  const mapboxgl = await loadMapboxGl();

  const el = document.createElement('div');
  el.className = 'campus-map';
  el.setAttribute('role', 'application');
  el.setAttribute('aria-label', t('tabs.campus'));
  container.appendChild(el);

  mapboxgl.accessToken = token;
  map = new mapboxgl.Map({
    container: el,
    style: 'mapbox://styles/mapbox/standard',
    center: INITIAL_CENTER,
    zoom: INITIAL_ZOOM,
    minZoom: 8.5,
    maxZoom: 18,
    pitch: 0,
    maxPitch: 70,
    pitchWithRotate: true,
    touchPitch: true,
    logoPosition: 'bottom-left',
  });

  map.addControl(new mapboxgl.NavigationControl({ showZoom: false, showCompass: true }), 'top-right');
  map.addControl(new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
  }), 'top-right');

  // Match the map's daylight to the app theme (Standard style only).
  map.on('style.load', applyLightPreset);
  darkScheme.addEventListener('change', applyLightPreset);

  map.on('load', () => {
    map.resize();
    showCampusMarkers(mapboxgl);
  });

  // Zoom back out past a campus → return to the campus overview.
  map.on('zoomend', () => {
    if (mode === 'buildings' && map.getZoom() < CAMPUS_ZOOM) {
      showCampusMarkers(mapboxgl);
      if (map.getPitch() > 0) map.easeTo({ pitch: 0, duration: reduceMotion.matches ? 0 : 600 });
    }
  });

  // Soft geographic leash: after any move, if the centre has drifted outside
  // Lombardy, ease it back. Doesn't touch pitch, unlike constructor maxBounds.
  map.on('moveend', panBackInBounds);

  // Keep the GL canvas glued to the panel through rotations / dynamic toolbars.
  new ResizeObserver(() => { if (map) map.resize(); }).observe(el);
}

let clampingBounds = false;
function panBackInBounds() {
  if (!map || clampingBounds) return;
  const [[w, s], [e, n]] = MAX_BOUNDS;
  const c = map.getCenter();
  const lng = Math.min(e, Math.max(w, c.lng));
  const lat = Math.min(n, Math.max(s, c.lat));
  if (lng === c.lng && lat === c.lat) return;
  clampingBounds = true;
  map.easeTo({ center: [lng, lat], duration: reduceMotion.matches ? 0 : 300 });
  map.once('moveend', () => { clampingBounds = false; });
}

function loadMapboxGl() {
  if (window.mapboxgl) return Promise.resolve(window.mapboxgl);

  const base = `https://api.mapbox.com/mapbox-gl-js/v${MAPBOX_VERSION}`;

  const css = new Promise(resolve => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${base}/mapbox-gl.css`;
    // Non-fatal if it fails — the map still renders, controls just sit slightly off.
    link.onload = resolve;
    link.onerror = resolve;
    document.head.appendChild(link);
  });

  const js = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${base}/mapbox-gl.js`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load mapbox-gl.js'));
    document.head.appendChild(script);
  });

  return Promise.all([css, js]).then(() => {
    if (!window.mapboxgl) throw new Error('mapbox-gl.js loaded but window.mapboxgl is missing');
    return window.mapboxgl;
  });
}

function applyLightPreset() {
  if (!map || !map.setConfigProperty) return;
  try {
    map.setConfigProperty('basemap', 'lightPreset', darkScheme.matches ? 'night' : 'day');
  } catch {
    /* style not ready or not the Standard style — ignore */
  }
}

function campuses() {
  return Array.isArray(classroomsData) ? classroomsData : [];
}

function clearMarkers() {
  markers.forEach(m => m.remove());
  markers = [];
}

function flyOpts(extra) {
  return { duration: reduceMotion.matches ? 0 : 1200, essential: true, ...extra };
}

function buildingLabel(b) {
  const alt = (b.altName || '').trim();
  return alt || `${t('building.prefix')} ${b.name}`;
}

function showCampusMarkers(mapboxgl) {
  clearMarkers();
  mode = 'campus';

  for (const campus of campuses()) {
    const { lat, long } = campus;
    if (typeof lat !== 'number' || typeof long !== 'number') continue;

    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'campus-marker';
    el.innerHTML = `<span class="campus-marker__dot"></span><span>${escapeHtml(campus.name)}</span>`;
    el.addEventListener('click', () => {
      haptics.trigger(defaultPatterns.light);
      showBuildingMarkers(mapboxgl, campus);
      map.flyTo(flyOpts({ center: [long, lat], zoom: CAMPUS_FLY_ZOOM, pitch: 55 }));
    });

    markers.push(
      new mapboxgl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([long, lat])
        .addTo(map)
    );
  }
}

function showBuildingMarkers(mapboxgl, campus) {
  clearMarkers();
  mode = 'buildings';

  for (const b of campus.buildings || []) {
    const { lat, long } = b;
    if (typeof lat !== 'number' || typeof long !== 'number') continue;

    const label = buildingLabel(b);

    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'campus-marker campus-marker--building';
    el.innerHTML = `<span class="campus-marker__dot"></span><span>${escapeHtml(label)}</span>`;

    const popup = new mapboxgl.Popup({ offset: 18, closeButton: false }).setHTML(
      `<div class="campus-popup__title">${escapeHtml(label)}</div>` +
      (b.address ? `<div class="campus-popup__addr">${escapeHtml(b.address)}</div>` : '')
    );

    markers.push(
      new mapboxgl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([long, lat])
        .setPopup(popup)
        .addTo(map)
    );
  }
}

function showError(container) {
  const el = document.createElement('div');
  el.className = 'campus-map-error';
  el.textContent = t('campus.mapError');
  container.appendChild(el);
}
