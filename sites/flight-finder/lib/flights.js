// Turns search-form input into SerpAPI requests and SerpAPI responses into the
// small, flat objects the frontend renders.
//
// Engines used:
//   google_travel_explore - cheapest destinations from an airport on exact dates
//   google_flights_deals  - cheapest destinations from an airport within a date window
//   google_flights        - flights on one route for one date

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'CAD', 'AUD'];

// A route search costs one SerpAPI search per departure day, so its window is kept short.
export const MAX_WINDOW_DAYS = { explore: 62, route: 7 };

const MAX_DAYS_AHEAD = 330;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AIRPORTS_RE = /^[A-Z]{3}(,[A-Z]{3}){0,6}$/;
const NO_RESULTS_RE = /hasn't returned any results|no results/i;

const badRequest = (message) => new HttpError(400, message);

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

function parseAirports(value, label) {
  const codes = String(value || '')
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!AIRPORTS_RE.test(codes)) {
    throw badRequest(`${label}: enter 1 to 7 three-letter airport codes, for example AMS or AMS,EIN.`);
  }
  return codes;
}

function parseDate(value, label) {
  if (!DATE_RE.test(value || '')) throw badRequest(`${label} must be a date (YYYY-MM-DD).`);
  if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw badRequest(`${label} is not a valid date.`);
  }
  return value;
}

function parseInteger(value, label, min, max, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

function parseChoice(value, label, choices, fallback) {
  if (value === undefined || value === '') return fallback;
  if (!choices.includes(value)) throw badRequest(`${label} must be one of: ${choices.join(', ')}.`);
  return value;
}

/**
 * Validates the query string of /api/explore or /api/route.
 * @param {URLSearchParams} query
 * @param {'explore' | 'route'} mode
 */
export function parseSearch(query, mode, { today = todayIso(), defaultCurrency = 'EUR' } = {}) {
  const get = (key) => {
    const value = query.get(key);
    return value === null ? undefined : value.trim();
  };

  const q = {
    from: parseAirports(get('from'), 'From'),
    to: mode === 'route' ? parseAirports(get('to'), 'To') : undefined,
    trip: parseChoice(get('trip'), 'Trip', ['oneway', 'return'], 'oneway'),
    depart: parseDate(get('depart'), 'Departure date'),
    departEnd: undefined,
    return: undefined,
    nightsMin: undefined,
    nightsMax: undefined,
    stops: parseInteger(get('stops'), 'Stops', 0, 3, 0),
    maxPrice: parseInteger(get('maxPrice'), 'Max price', 1, 100000, undefined),
    adults: parseInteger(get('adults'), 'Adults', 1, 9, 1),
    currency: parseChoice(get('currency'), 'Currency', CURRENCIES, defaultCurrency),
  };

  if (mode === 'route' && q.from === q.to) throw badRequest('From and To are the same.');

  // Allow "yesterday" so a visitor a few time zones behind UTC can still pick their today.
  if (q.depart < addDays(today, -1)) throw badRequest('Departure date is in the past.');
  if (q.depart > addDays(today, MAX_DAYS_AHEAD)) {
    throw badRequest(`Flights can only be searched up to ${MAX_DAYS_AHEAD} days ahead.`);
  }

  const departEnd = get('departEnd');
  if (departEnd && departEnd !== q.depart) {
    q.departEnd = parseDate(departEnd, 'Latest departure date');
    const windowDays = daysBetween(q.depart, q.departEnd) + 1;
    if (windowDays < 1) throw badRequest('Latest departure date is before the first departure date.');
    if (windowDays > MAX_WINDOW_DAYS[mode]) {
      throw badRequest(
        mode === 'route'
          ? `A route search covers at most ${MAX_WINDOW_DAYS.route} days (each day costs one search).`
          : `The departure window can be at most ${MAX_WINDOW_DAYS.explore} days.`,
      );
    }
  }

  if (q.trip === 'return') {
    if (!q.departEnd) {
      q.return = parseDate(get('return'), 'Return date');
      if (q.return < q.depart) throw badRequest('Return date is before the departure date.');
    } else {
      q.nightsMin = parseInteger(get('nightsMin'), 'Minimum nights', 1, 30, 3);
      q.nightsMax = mode === 'route' ? q.nightsMin : parseInteger(get('nightsMax'), 'Maximum nights', 1, 30, 7);
      if (q.nightsMax < q.nightsMin) throw badRequest('Maximum nights is lower than minimum nights.');
    }
  }

  return q;
}

function commonParams(q, locale) {
  return {
    departure_id: q.from,
    type: q.trip === 'return' ? 1 : 2,
    currency: q.currency,
    gl: locale.gl,
    hl: locale.hl,
    // Defaults are left out so equivalent searches share a cache entry.
    adults: q.adults > 1 ? q.adults : undefined,
    stops: q.stops || undefined,
    max_price: q.maxPrice,
  };
}

/** One SerpAPI request that lists the cheapest destinations from q.from. */
export function exploreRequest(q, locale) {
  if (!q.departEnd) {
    return {
      engine: 'google_travel_explore',
      ...commonParams(q, locale),
      outbound_date: q.depart,
      return_date: q.return,
    };
  }
  return {
    engine: 'google_flights_deals',
    ...commonParams(q, locale),
    outbound_date: `${q.depart},${q.departEnd}`,
    trip_length: q.trip === 'return' ? `${q.nightsMin},${q.nightsMax}` : undefined,
  };
}

/** One google_flights request per departure day in the window. */
export function routeRequests(q, locale) {
  const days = q.departEnd ? daysBetween(q.depart, q.departEnd) + 1 : 1;
  return Array.from({ length: days }, (_, i) => {
    const outbound = addDays(q.depart, i);
    let returnDate;
    if (q.trip === 'return') returnDate = q.departEnd ? addDays(outbound, q.nightsMin) : q.return;
    return {
      engine: 'google_flights',
      ...commonParams(q, locale),
      arrival_id: q.to,
      outbound_date: outbound,
      return_date: returnDate,
      sort_by: 2, // cheapest first
    };
  });
}

/** Google Flights accepts a plain-language query, which is the simplest stable deep link. */
export function googleFlightsSearchUrl({ from, to, depart, returnDate, currency }) {
  const text = `Flights from ${from} to ${to} on ${depart}` + (returnDate ? ` through ${returnDate}` : ' one way');
  const url = new URL('https://www.google.com/travel/flights');
  url.searchParams.set('q', text);
  if (currency) url.searchParams.set('curr', currency);
  return url.toString();
}

function httpsUrl(value) {
  return typeof value === 'string' && value.startsWith('https://') ? value : undefined;
}

/** Normalizes google_travel_explore and google_flights_deals responses. */
export function normalizeDestinations(engine, data, q) {
  const items = engine === 'google_flights_deals' ? data.deals || [] : data.destinations || [];

  return items
    .map((item) => {
      if (engine === 'google_flights_deals') {
        // Current responses use outbound_date/return_date; older ones used start_date/end_date.
        const departDate = item.outbound_date || item.start_date;
        return {
          name: item.name,
          country: item.country,
          airport: item.arrival_airport_code,
          fromAirport: item.departure_airport_code,
          via: undefined,
          price: item.price,
          averagePrice: item.average_price,
          discountPercent: item.discount_percentage,
          departDate,
          returnDate: item.return_date || item.end_date,
          stops: item.stops,
          durationMinutes: item.flight_duration,
          airline: item.airline,
          thumbnail: httpsUrl(item.thumbnail),
          description: item.highlights || item.description,
          googleUrl: httpsUrl(item.flight_link),
        };
      }

      const airport = item.destination_airport || {};
      const departDate = item.start_date || q.depart;
      const returnDate = item.end_date || q.return;
      return {
        name: item.name,
        country: item.country,
        airport: airport.code,
        fromAirport: undefined,
        // Places such as national parks are reached through a nearby airport city.
        via: airport.location ? { city: airport.location, driveMinutes: item.car_duration } : undefined,
        price: item.flight_price,
        averagePrice: undefined,
        discountPercent: undefined,
        departDate,
        returnDate,
        stops: item.number_of_stops,
        durationMinutes: item.flight_duration,
        airline: item.airline,
        thumbnail: httpsUrl(item.thumbnail),
        description: undefined,
        googleUrl:
          airport.code &&
          googleFlightsSearchUrl({
            from: q.from,
            to: airport.code,
            depart: departDate,
            returnDate,
            currency: q.currency,
          }),
      };
    })
    .filter((d) => typeof d.price === 'number' && d.airport)
    .sort((a, b) => a.price - b.price);
}

function normalizeItinerary(option) {
  const legs = (option.flights || []).map((f) => ({
    from: { code: f.departure_airport?.id, name: f.departure_airport?.name, time: f.departure_airport?.time },
    to: { code: f.arrival_airport?.id, name: f.arrival_airport?.name, time: f.arrival_airport?.time },
    durationMinutes: f.duration,
    airline: f.airline,
    flightNumber: f.flight_number,
    airplane: f.airplane,
    overnight: Boolean(f.overnight),
    oftenDelayed: Boolean(f.often_delayed_by_over_30_min),
  }));

  return {
    price: option.price,
    type: option.type,
    durationMinutes: option.total_duration,
    stops: Math.max(legs.length - 1, 0),
    airlines: [...new Set(legs.map((l) => l.airline).filter(Boolean))],
    airlineLogo: httpsUrl(option.airline_logo),
    legs,
    layovers: (option.layovers || []).map((l) => ({
      code: l.id,
      name: l.name,
      durationMinutes: l.duration,
      overnight: Boolean(l.overnight),
    })),
  };
}

/** Normalizes one google_flights response (one route, one departure day). */
export function normalizeFlights(data) {
  const flights = [...(data.best_flights || []), ...(data.other_flights || [])]
    .map(normalizeItinerary)
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  const insights = data.price_insights;

  return {
    flights,
    lowestPrice: flights.find((f) => typeof f.price === 'number')?.price,
    insights: insights && {
      lowestPrice: insights.lowest_price,
      level: insights.price_level,
      typicalRange: insights.typical_price_range,
    },
    googleUrl: httpsUrl(data.search_metadata?.google_flights_url),
  };
}

/**
 * Runs one SerpAPI search. Responses are cached, and a search that is already
 * cached costs nothing.
 */
export async function serpSearch(params, { apiKey, cache, beforeLiveSearch, fetchImpl = fetch }) {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => [k, String(v)])
    .sort(([a], [b]) => a.localeCompare(b));
  const cacheKey = JSON.stringify(entries);

  const cached = await cache.get(cacheKey);
  if (cached) return { data: cached, cached: true };

  beforeLiveSearch?.();

  const url = new URL('https://serpapi.com/search.json');
  for (const [k, v] of entries) url.searchParams.set(k, v);
  url.searchParams.set('api_key', apiKey);

  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
  } catch (err) {
    // Never echo the URL: it contains the API key.
    const reason = err.name === 'TimeoutError' ? 'timed out' : err.cause?.code || err.name;
    throw new HttpError(502, `Could not reach SerpAPI (${reason}).`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new HttpError(502, `SerpAPI returned an unreadable response (HTTP ${res.status}).`);
  }

  if (data.error && !NO_RESULTS_RE.test(data.error)) {
    throw new HttpError(res.status === 429 ? 429 : 502, `SerpAPI: ${data.error}`);
  }

  await cache.set(cacheKey, data);
  return { data, cached: false };
}

/** Maps over items with at most `limit` promises in flight. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
