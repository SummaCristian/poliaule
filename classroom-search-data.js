import { getClassroomStatusNow, classroomsData as occupancyDays } from './available-rooms-script.js';
import { buildCardForClassroom } from './components/classroom-list.js';
import { getApiBase } from './config.js';

// Static classroom directory (campus → buildings → classrooms) plus the text /
// occupation search that runs against it. The search UI itself lives in the
// search overlay (components/search-overlay.js); this module owns the data, the
// indexes, and the result-card builders it drives.

export let classroomsData = null;
let searchIndex = null;

export const SEARCH_MAX_RESULTS = 40;

// ---------- DATA ----------

async function loadData() {
  if (classroomsData) return;
  const res = await fetch(`${getApiBase()}/v1/classrooms`);
  classroomsData = await res.json();
}

// Loads the static classroom directory. Blocks the splash — it's what the page
// shell (campus picker, classroom detail, favourites) is built from.
export async function ensureClassroomDirectory() {
  await loadData();
}

// `ensureSearchData()` is idempotent and safe to call before the search overlay
// has been opened for the first time.
export async function ensureSearchData() {
  await loadData();
  if (!searchIndex) searchIndex = buildSearchIndex();
}

export function runClassroomSearch(query) {
  if (!classroomsData) return { visible: [], total: 0, capped: false };
  if (!searchIndex) searchIndex = buildSearchIndex();
  const q = query.trim().toLowerCase();
  const qDotted = q.replace(/\s+/g, '.');
  const results = searchIndex.filter(room =>
    room.name.toLowerCase().includes(q) ||
    room.name.toLowerCase().includes(qDotted) ||
    room.buildingName.toLowerCase().includes(q) ||
    (room.buildingAltName && room.buildingAltName.toLowerCase().includes(q)) ||
    room.campusName.toLowerCase().includes(q)
  );
  const capped = results.length > SEARCH_MAX_RESULTS;
  return { visible: capped ? results.slice(0, SEARCH_MAX_RESULTS) : results, total: results.length, capped };
}

// Results span multiple campuses, so fold the campus name into the building
// line (the card only has room for one line of building/location context).
export function buildSearchResultCard(room, query = '') {
  return buildClassroomCard(room, {
    name: room.buildingName,
    altName: [room.buildingAltName, room.campusName].filter(Boolean).join(' · '),
  }, query.trim());
}

function buildSearchIndex() {
  const index = [];
  for (const campus of classroomsData) {
    for (const building of campus.buildings) {
      for (const room of building.classrooms) {
        index.push({ ...room, buildingName: building.name, buildingAltName: building.altName, campusName: campus.name });
      }
    }
  }
  return index;
}

// Classroom cards reuse the exact card built for the Available tab
// (components/classroom-list.js).
function buildClassroomCard(room, building, query = '') {
  const status = getClassroomStatusNow(room.id);
  return buildCardForClassroom({ ...room, status }, building, null, null, false, null, query, true);
}

// ---------- OCCUPATION (lesson / exam) SEARCH ----------
//
// Searches the loaded occupancy data (available-rooms-script.js, up to 7 days)
// for slots whose course name, code, section, professors, or raw string match
// the query. Identical events (same course/code/professors, recurring across
// days and rooms) are folded into one group with a list of sessions.

export const OCC_MAX_GROUPS = 24;
const OCC_MAX_SESSIONS = 6;

let occIndex = null;
let occIndexDayCount = -1;

export function hasOccupationData() {
  return occupancyDays.length > 0;
}

// Occupancy JSON stores the day as "YYYYMMDD"; normalise to ISO so Date() and
// Intl can parse it.
function isoDate(d) {
  const s = String(d ?? '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

function buildOccupationIndex() {
  const rows = [];
  for (const day of occupancyDays) {
    const date = isoDate(day.date);
    for (const campus of day.campuses ?? []) {
      for (const building of campus.buildings ?? []) {
        for (const room of building.classrooms ?? []) {
          for (const slot of room.occupancy ?? []) {
            if (!slot.inizio || !slot.fine) continue;
            const professors = Array.isArray(slot.professors) ? slot.professors : [];
            const title = slot.course ?? slot.raw ?? slot.name ?? '';
            rows.push({
              date,
              inizio: slot.inizio,
              fine: slot.fine,
              category: slot.category ?? null,
              isExam: slot.category === 'EXAM',
              title,
              code: slot.code ?? null,
              section: slot.section ?? null,
              professors,
              roomId: room.id,
              roomName: room.name,
              buildingName: building.name,
              buildingAltName: building.altName,
              campusName: campus.name,
              haystack: [
                title,
                slot.code != null ? String(slot.code) : '',
                slot.section ?? '',
                professors.join(' '),
                slot.raw ?? '',
                slot.name ?? '',
              ].join('  ').toLowerCase(),
            });
          }
        }
      }
    }
  }
  return rows;
}

function ensureOccIndex() {
  if (!occIndex || occIndexDayCount !== occupancyDays.length) {
    occIndex = buildOccupationIndex();
    occIndexDayCount = occupancyDays.length;
  }
}

export function runOccupationSearch(query) {
  ensureOccIndex();
  const q = query.trim().toLowerCase();
  if (!q || occIndex.length === 0) return { groups: [], total: 0, capped: false, maxSessions: OCC_MAX_SESSIONS };

  // Codes are stored as ints, so a leading zero the user typed ("061182") is
  // gone from the haystack ("61182") — match on both.
  const qAlt = q.replace(/^0+/, '');
  const matched = occIndex.filter(r =>
    r.haystack.includes(q) || (qAlt && qAlt !== q && r.haystack.includes(qAlt)));

  const groups = new Map();
  for (const r of matched) {
    const key = [r.category, r.code, r.title, r.section, r.professors.join(',')].join('|').toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = {
        title: r.title, code: r.code, section: r.section,
        professors: r.professors, isExam: r.isExam, sessions: [],
      };
      groups.set(key, g);
    }
    g.sessions.push({
      date: r.date, inizio: r.inizio, fine: r.fine,
      roomId: r.roomId, roomName: r.roomName,
      buildingName: r.buildingName, buildingAltName: r.buildingAltName, campusName: r.campusName,
    });
  }

  const list = [...groups.values()];
  for (const g of list) {
    g.sessions.sort((a, b) => (a.date + a.inizio).localeCompare(b.date + b.inizio));
    g.sessionCount = g.sessions.length;
  }
  list.sort((a, b) =>
    (a.sessions[0].date + a.sessions[0].inizio).localeCompare(b.sessions[0].date + b.sessions[0].inizio));

  const capped = list.length > OCC_MAX_GROUPS;
  return {
    groups: capped ? list.slice(0, OCC_MAX_GROUPS) : list,
    total: list.length,
    capped,
    maxSessions: OCC_MAX_SESSIONS,
  };
}
