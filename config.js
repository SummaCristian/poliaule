// Stable (poliaule.com) always talks to the stable API — no override possible.
// Every other origin (beta.poliaule.com, localhost, etc.) can toggle between
// the beta and stable API via the "Use Beta Backend" setting (default: on).

export const STABLE_API_BASE = 'https://api.poliaule.com';
export const BETA_API_BASE = 'https://api-beta.poliaule.com';

const STABLE_HOSTNAMES = new Set(['poliaule.com', 'www.poliaule.com']);

export const IS_STABLE_BUILD = STABLE_HOSTNAMES.has(location.hostname);

export const USE_BETA_BACKEND_KEY = 'poliAule_useBetaBackend';

export function getApiBase() {
  if (IS_STABLE_BUILD) return STABLE_API_BASE;
  const saved = localStorage.getItem(USE_BETA_BACKEND_KEY);
  const useBeta = saved === null ? true : saved === 'true';
  return useBeta ? BETA_API_BASE : STABLE_API_BASE;
}

// Mapbox GL JS access token for the Campus tab map.
//
// Not committed: the frontend fetches it from the API (`GET /v1/config`, backed
// by the worker's MAPBOX_TOKEN secret) so the token never lands in this public
// repo. It is a URL-restricted public (`pk.`) token — safe in the browser, just
// not in git. Fetched once and memoised; a failed fetch isn't cached.
let _mapboxTokenPromise = null;

export function getMapboxToken() {
  if (!_mapboxTokenPromise) {
    _mapboxTokenPromise = fetch(`${getApiBase()}/v1/config`)
      .then(res => {
        if (!res.ok) throw new Error(`/v1/config responded ${res.status}`);
        return res.json();
      })
      .then(cfg => {
        if (!cfg?.mapboxToken) throw new Error('/v1/config returned no mapboxToken');
        return cfg.mapboxToken;
      })
      .catch(err => {
        _mapboxTokenPromise = null; // don't cache the failure — allow a retry
        throw err;
      });
  }
  return _mapboxTokenPromise;
}
