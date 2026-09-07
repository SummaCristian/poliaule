import { getApiBase } from './config.js';

// ---------- DATA ----------

// Data fetched from the API will be stored here,
// one entry per day inside the array, starting with 0 = today.
export let classroomsData = [];

// Day of the week to skip. If one of the next 7 days is a
// day listed here, skip to the next day.
// This mirrors what happens in the backend.
export const SKIP_DAYS = [0] // Sunday

// ----------  FETCHING LOGIC ----------

// Extracts the identifier used to key openingHours.buildings/campus_defaults
// from a building's name (e.g. "32.1" -> "32", "B12" -> "B12", "16B" -> "16B").
const BUILDING_ID_RE = /^([a-z]*\d+[a-z]?)/i;

// Mirrors scripts/fetch.py's _building_hours_key(), so both sides resolve
// the same building to the same opening-hours.json entry.
function buildingHoursKey(building) {
  const match = BUILDING_ID_RE.exec(String(building.name ?? ''));
  return (match ? match[1] : String(building.name ?? '')).toUpperCase();
}

// Resolves a building's opening hours: explicit match > campus default > global default.
// Mirrors scripts/fetch.py's resolve_building_hours().
function resolveBuildingHours(building, campusId, openingHours) {
  const key = buildingHoursKey(building);
  if (openingHours.buildings[key]) return openingHours.buildings[key];
  if (openingHours.campus_defaults[campusId]) return openingHours.campus_defaults[campusId];
  return openingHours.default_hours;
}

// Fetches the classrooms data from the server and
// stores it in classroomsData.
export async function fetchClassroomsData() {
  try {
    const apiBase = getApiBase();
    const listRes = await fetch(`${apiBase}/v1/occupations`);
    if (!listRes.ok) throw new Error(`Failed to load occupancy list: ${listRes.status}`);
    const { dates } = await listRes.json();

    const [results, openingHours] = await Promise.all([
      Promise.allSettled(
        dates.map(date => {
          const isoDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
          return fetch(`${apiBase}/v1/occupations/${isoDate}`)
            .then(res => {
              if (!res.ok) throw new Error(`Failed to load ${date}: ${res.status}`);
              return res.json();
            });
        })
      ).then(settled => settled.filter(r => r.status === 'fulfilled').map(r => r.value)),
      fetch(`${apiBase}/v1/opening-hours`)
        .then(res => {
          if (!res.ok) throw new Error(`Failed to load opening hours: ${res.status}`);
          return res.json();
        })
        .catch(error => {
          // Non-fatal: fall through with openingHours = null so classroomsData
          // still loads (and gets used) even if opening hours can't be fetched.
          console.error('Error fetching opening hours data:', error);
          return null;
        }),
    ]);

    if (openingHours) {
      for (const day of results) {
        for (const campus of day.campuses) {
          for (const building of campus.buildings) {
            building.hours = resolveBuildingHours(building, campus.id, openingHours);
          }
        }
      }
    }

    classroomsData.splice(0, classroomsData.length, ...results);
    console.log('All data loaded:', classroomsData);
  } catch (error) {
    console.error('Error fetching classrooms data:', error);
  }
}

// ---------- LOGIC ----------

// Returns a list of available classrooms for the 
// given campus, date and time range.
// The query is perfomed on the data previously fetched and 
// stored in classroomsData.
// 
// Classrooms are returned together with a start and end time,
// which represent the time range in which the classroom is available.
// This allows to define 'partial availability', which is 
// useful to return relevant data, 
// especially when full availability is not possible.
export function findAvailableClassrooms(campusId, date, fromTime, toTime) {
  const formattedDate = formatDateYYYYMMDD(new Date(date));

  // Find the day's data
  const dayData = classroomsData.find(day => day.date === formattedDate);
  if (!dayData) {
    console.warn(`No data found for date ${formattedDate}`);
    return [];
  }

  // Find the campus
  const campusData = dayData.campuses.find(c => c.id === campusId);
  if (!campusData) {
    console.warn(`No data found for campus ${campusId} on date ${date}`);
    return [];
  }

  const results = [];

  for (const building of campusData.buildings) {
    const availableRooms = [];

    for (const classroom of building.classrooms) {
      const freeSlots = getFreeSlots(classroom.occupancy, fromTime, toTime);
      if (freeSlots.length > 0) {
        const isFree = freeSlots.length === 1
          && freeSlots[0].start === fromTime
          && freeSlots[0].end === toTime;
        availableRooms.push({
          id: classroom.id,
          name: classroom.name,
          status: isFree ? 'free' : 'partially-free',
          features: classroom.features ?? [],
          occupancy: classroom.occupancy ?? [],
          slots: freeSlots,
          idfoto: classroom.idfoto ?? null,
        });
      }
    }

    const STATUS_ORDER = { 'free': 0, 'partially-free': 1, 'not-free': 2 };
    availableRooms.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

    if (availableRooms.length > 0) {
      results.push({
        building: building,
        rooms: availableRooms,
      });
    }
  }

  return results;
}

// ---------- HELPERS ----------

// Formats Date objects in the format used by the API (YYYYMMDD)
function formatDateYYYYMMDD(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

// Returns the free time slots within [fromTime, toTime]
// given an array of occupancy slots from the JSON.
function getFreeSlots(occupancy, fromTime, toTime) {
  const freeSlots = [];
  let cursor = fromTime;

  // Sort occupancy just in case it isn't already
  const sorted = [...occupancy]
    .map(s => ({ start: s.inizio, end: s.fine }))
    .sort((a, b) => a.start.localeCompare(b.start));

  for (const slot of sorted) {
    if (slot.end <= cursor) continue;      // slot entirely before our window
    if (slot.start >= toTime) break;       // slot entirely after our window

    if (slot.start > cursor) {
      // free gap before this occupied slot
      freeSlots.push({ start: cursor, end: slot.start });
    }
    cursor = slot.end > cursor ? slot.end : cursor;
  }

  // free gap after the last occupied slot
  if (cursor < toTime) {
    freeSlots.push({ start: cursor, end: toTime });
  }

  return freeSlots;
}

/**
 * Given a classroom's occupancy slots and a reference instant (Date), returns
 * the availability status relative to that instant.
 * Possible return values: 'free', 'occupied', 'free-soon', 'occupied-soon'.
 */
export function computeClassroomStatus(occupancy, refDate) {
  const slots = occupancy ?? [];
  const currentTime = `${String(refDate.getHours()).padStart(2, '0')}:${String(refDate.getMinutes()).padStart(2, '0')}`;

  const isOccupiedNow = slots.some(slot => currentTime >= slot.inizio && currentTime < slot.fine);

  const thirtyMinsLater = new Date(refDate.getTime() + 30 * 60 * 1000);
  const thirtyMinsLaterTime = `${String(thirtyMinsLater.getHours()).padStart(2, '0')}:${String(thirtyMinsLater.getMinutes()).padStart(2, '0')}`;

  if (isOccupiedNow) {
    // Check if it will be free within 30 mins
    const currentSlot = slots.find(slot => currentTime >= slot.inizio && currentTime < slot.fine);
    // If current slot ends within 30 mins AND no other slot starts before that 30 min window ends
    if (currentSlot.fine < thirtyMinsLaterTime) {
      const nextOccupancy = slots.some(slot => slot.inizio >= currentSlot.fine && slot.inizio < thirtyMinsLaterTime);
      if (!nextOccupancy) {
        return 'free-soon';
      }
    }
    return 'occupied';
  } else {
    // Currently free. Check if it will be occupied within 30 mins.
    const nextOccupancy = slots.some(slot => slot.inizio > currentTime && slot.inizio < thirtyMinsLaterTime);
    if (nextOccupancy) {
      return 'occupied-soon';
    }
    return 'free';
  }
}

/**
 * Returns the current availability status of a classroom relative to NOW.
 * Possible return values: 'free', 'occupied', 'free-soon', 'occupied-soon', or null if no data.
 */
export function getClassroomStatusNow(classroomId) {
  if (!classroomsData || classroomsData.length === 0) return null;

  const now = new Date();
  const dateKey = formatDateYYYYMMDD(now);

  // Find today's data
  const dayData = classroomsData.find(day => day.date === dateKey);
  if (!dayData) return null;

  let classroom = null;
  outer: for (const campus of dayData.campuses) {
    for (const building of campus.buildings) {
      classroom = building.classrooms.find(r => String(r.id) === String(classroomId));
      if (classroom) break outer;
    }
  }

  if (!classroom) return null;

  return computeClassroomStatus(classroom.occupancy ?? [], now);
}

/**
 * Builds the data for the "zoom out" building overview: every building in the
 * given campus on the given date, each with a per-status classroom count.
 *
 * The status is computed relative to an instant: NOW when `date` is today,
 * otherwise `date` at `refTime` ("HH:MM", the selected query start) so
 * "free soon" / "occupied soon" still mean something on a future day.
 *
 * Returns [{ building, counts: {free, 'free-soon', 'occupied-soon', occupied} }]
 * in the campus's building order.
 */
export function getCampusBuildingsOverview(campusId, date, refTime) {
  const formattedDate = formatDateYYYYMMDD(new Date(date));
  const dayData = classroomsData.find(day => day.date === formattedDate);
  if (!dayData) return [];

  const campusData = dayData.campuses.find(c => c.id === campusId);
  if (!campusData) return [];

  const now = new Date();
  const isToday = formattedDate === formatDateYYYYMMDD(now);
  let refDate;
  if (isToday) {
    refDate = now;
  } else {
    const [h, m] = String(refTime ?? '08:00').split(':').map(Number);
    refDate = new Date(date);
    refDate.setHours(h || 0, m || 0, 0, 0);
  }

  return campusData.buildings.map(building => {
    const counts = { 'free': 0, 'free-soon': 0, 'occupied-soon': 0, 'occupied': 0 };
    for (const room of building.classrooms ?? []) {
      counts[computeClassroomStatus(room.occupancy ?? [], refDate)]++;
    }
    return { building, counts };
  });
}