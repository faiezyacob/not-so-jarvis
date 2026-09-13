/* ============================================
   JARVIS — Weather Service
   Server-side weather lookups (Open-Meteo) for
   the chat context. The browser still owns the
   dashboard weather widget; it reports its
   geolocation here (POST /api/weather/location)
   so the assistant can answer weather questions
   with live data. No API key required.
   ============================================ */

const configManager = require('../server/config-manager');

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_TTL_MS = 10 * 60 * 1000;

// WMO weather interpretation codes (subset matching the dashboard widget).
const WMO_CODES = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Freezing drizzle',
    57: 'Heavy freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Light showers',
    81: 'Moderate showers',
    82: 'Violent showers',
    85: 'Light snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with hail',
    99: 'Severe thunderstorm'
};

// Gate: only inject weather context when the message is actually about the
// weather, so unrelated turns stay lean.
const WEATHER_QUERY_RE = /\b(weather|forecast|temperature|temp|humid|humidity|wind|windy|rain|raining|rainy|snow|snowing|snowy|sunny|cloudy|overcast|foggy|fog|storm|thunderstorm|drizzle|climate|umbrella|degrees|how (hot|cold) is it|outside)\b/i;

// Cached Open-Meteo snapshot keyed by rounded coordinates.
let cache = { key: null, at: 0, data: null };

function isWeatherQuery(message) {
    return WEATHER_QUERY_RE.test(String(message || ''));
}

function round(value, places = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const factor = Math.pow(10, places);
    return Math.round(n * factor) / factor;
}

function getLocation() {
    const stored = configManager.getWeather();
    const lat = Number(stored.lat);
    const lon = Number(stored.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon, label: typeof stored.label === 'string' ? stored.label : '' };
}

function setLocation(input) {
    return configManager.setWeather({
        lat: input && input.lat,
        lon: input && input.lon,
        label: input && input.label
    });
}

/**
 * Fetch the current weather for the stored (or supplied) coordinates.
 * Cached for CACHE_TTL_MS; on failure returns the last good snapshot, if any.
 * @returns {Promise<object|null>}
 */
async function fetchCurrent(coords) {
    const loc = coords || getLocation();
    if (!loc) return null;

    const key = loc.lat.toFixed(4) + ',' + loc.lon.toFixed(4);
    if (cache.data && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
        return cache.data;
    }

    const url = OPEN_METEO_URL
        + '?latitude=' + loc.lat
        + '&longitude=' + loc.lon
        + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day'
        + '&timezone=auto';

    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return cache.data;

        const body = await res.json();
        const c = body.current || {};
        const data = {
            label: loc.label || body.timezone || (loc.lat.toFixed(2) + ', ' + loc.lon.toFixed(2)),
            timezone: body.timezone || null,
            description: WMO_CODES[c.weather_code] || 'Unknown conditions',
            isDay: c.is_day === 1,
            temperature: round(c.temperature_2m, 1),
            apparent: round(c.apparent_temperature, 1),
            humidity: round(c.relative_humidity_2m),
            wind: round(c.wind_speed_10m, 1),
            observedAt: c.time || new Date().toISOString()
        };
        cache = { key, at: Date.now(), data };
        return data;
    } catch {
        return cache.data;
    }
}

function formatWeather(data) {
    if (!data) return '';
    const lines = ['Current weather for ' + data.label + ':'];
    lines.push('- Conditions: ' + data.description);
    if (data.temperature != null) {
        lines.push('- Temperature: ' + data.temperature + '\u00B0C'
            + (data.apparent != null ? ' (feels like ' + data.apparent + '\u00B0C)' : ''));
    }
    if (data.humidity != null) lines.push('- Humidity: ' + data.humidity + '%');
    if (data.wind != null) lines.push('- Wind: ' + data.wind + ' km/h');
    if (data.observedAt) lines.push('- Observed: ' + data.observedAt);
    return lines.join('\n');
}

/**
 * Build the system-context block for a user message, or '' when the message
 * isn't weather-related. Never throws.
 * @returns {Promise<string>}
 */
async function buildWeatherContext(message) {
    if (!isWeatherQuery(message)) return '';

    const loc = getLocation();
    if (!loc) {
        return 'The user asked about the weather, but their location is not known. '
            + 'Live weather is unavailable — tell them to allow location access on the '
            + 'dashboard weather widget. Do not invent a forecast.';
    }

    const data = await fetchCurrent(loc);
    if (!data) {
        return 'The user asked about the weather, but the live lookup failed. '
            + 'Tell them weather data is temporarily unavailable; do not invent a forecast.';
    }

    return 'Live weather snapshot (Open-Meteo):\n' + formatWeather(data);
}

module.exports = {
    isWeatherQuery,
    getLocation,
    setLocation,
    fetchCurrent,
    formatWeather,
    buildWeatherContext,
    WMO_CODES,
    WEATHER_QUERY_RE
};
