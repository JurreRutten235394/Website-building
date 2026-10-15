import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCache } from '../lib/cache.js';
import {
  HttpError,
  exploreRequest,
  normalizeDestinations,
  normalizeFlights,
  parseSearch,
  routeRequests,
  serpSearch,
} from '../lib/flights.js';

const TODAY = '2026-10-15';
const LOCALE = { gl: 'nl', hl: 'en' };
const parse = (query, mode = 'explore') => parseSearch(new URLSearchParams(query), mode, { today: TODAY });

describe('parseSearch', () => {
  it('accepts a one-way date range from several airports', () => {
    const q = parse('from=ams, ein&depart=2026-11-02&departEnd=2026-11-08');
    assert.equal(q.from, 'AMS,EIN');
    assert.equal(q.trip, 'oneway');
    assert.equal(q.departEnd, '2026-11-08');
    assert.equal(q.currency, 'EUR');
  });

  it('treats a range that starts and ends on the same day as an exact date', () => {
    assert.equal(parse('from=AMS&depart=2026-11-02&departEnd=2026-11-02').departEnd, undefined);
  });

  it('rejects bad input with a 400', () => {
    const cases = [
      'from=AMSTERDAM&depart=2026-11-02',
      'from=AMS&depart=2026-02-30',
      'from=AMS&depart=2026-10-01',
      'from=AMS&depart=2026-11-02&departEnd=2026-10-30',
      'from=AMS&depart=2026-11-02&trip=return',
      'from=AMS&depart=2026-11-02&trip=return&return=2026-11-01',
      'from=AMS&depart=2026-11-02&currency=XYZ',
      'from=AMS&depart=2026-11-02&stops=7',
    ];
    for (const query of cases) {
      assert.throws(
        () => parse(query),
        (err) => err instanceof HttpError && err.status === 400,
        query,
      );
    }
  });

  it('limits route searches to a week because each day costs a search', () => {
    assert.throws(() => parse('from=AMS&to=BCN&depart=2026-11-01&departEnd=2026-11-08', 'route'), /at most 7 days/);
    assert.equal(parse('from=AMS&to=BCN&depart=2026-11-01&departEnd=2026-11-07', 'route').departEnd, '2026-11-07');
  });

  it('defaults stay length for return trips over a range', () => {
    const q = parse('from=AMS&trip=return&depart=2026-11-02&departEnd=2026-11-08');
    assert.deepEqual([q.nightsMin, q.nightsMax], [3, 7]);
  });
});

describe('request building', () => {
  it('uses Travel Explore for exact dates', () => {
    const params = exploreRequest(parse('from=AMS&trip=return&depart=2026-11-05&return=2026-11-09'), LOCALE);
    assert.equal(params.engine, 'google_travel_explore');
    assert.equal(params.type, 1);
    assert.equal(params.outbound_date, '2026-11-05');
    assert.equal(params.return_date, '2026-11-09');
    assert.equal(params.adults, undefined);
  });

  it('uses Flights Deals with a date window and trip length for ranges', () => {
    const query = 'from=AMS&trip=return&depart=2026-11-02&departEnd=2026-11-08&nightsMin=3&nightsMax=4&stops=1';
    const params = exploreRequest(parse(query), LOCALE);
    assert.equal(params.engine, 'google_flights_deals');
    assert.equal(params.outbound_date, '2026-11-02,2026-11-08');
    assert.equal(params.trip_length, '3,4');
    assert.equal(params.stops, 1);
  });

  it('makes one Google Flights request per departure day', () => {
    const q = parse('from=AMS&to=BCN&trip=return&depart=2026-11-04&departEnd=2026-11-06&nightsMin=2', 'route');
    const requests = routeRequests(q, LOCALE);
    assert.deepEqual(
      requests.map((r) => [r.outbound_date, r.return_date]),
      [
        ['2026-11-04', '2026-11-06'],
        ['2026-11-05', '2026-11-07'],
        ['2026-11-06', '2026-11-08'],
      ],
    );
    assert.ok(requests.every((r) => r.engine === 'google_flights' && r.arrival_id === 'BCN' && r.sort_by === 2));
  });
});

describe('normalizing responses', () => {
  it('reads deals, drops unpriced ones and sorts by price', () => {
    const q = parse('from=AMS&trip=return&depart=2026-11-02&departEnd=2026-11-08');
    const data = {
      deals: [
        { name: 'Bari', country: 'Italy', price: 86, arrival_airport_code: 'BRI', outbound_date: '2026-11-03' },
        { name: 'Nowhere', country: 'X', arrival_airport_code: 'NOP' },
        {
          name: 'Dublin',
          country: 'Ireland',
          price: 45,
          average_price: 49,
          discount_percentage: 8,
          arrival_airport_code: 'DUB',
          departure_airport_code: 'AMS',
          outbound_date: '2026-11-06',
          return_date: '2026-11-09',
          thumbnail: 'javascript:alert(1)',
          flight_link: 'https://www.google.com/travel/flights?tfs=abc',
        },
      ],
    };
    const result = normalizeDestinations('google_flights_deals', data, q);
    assert.deepEqual(
      result.map((d) => d.name),
      ['Dublin', 'Bari'],
    );
    assert.equal(result[0].returnDate, '2026-11-09');
    assert.equal(result[0].discountPercent, 8);
    assert.equal(result[0].thumbnail, undefined, 'non-https URLs are dropped');
    assert.equal(result[0].googleUrl, 'https://www.google.com/travel/flights?tfs=abc');
  });

  it('reads Travel Explore destinations, including places reached via another airport', () => {
    const q = parse('from=AMS&depart=2026-11-05');
    const data = {
      destinations: [
        {
          name: 'Galway',
          country: 'Ireland',
          flight_price: 63,
          car_duration: 150,
          start_date: '2026-11-05',
          destination_airport: { code: 'DUB', location: 'Dublin' },
        },
        { name: 'Marseille', country: 'France', destination_airport: { code: 'MRS' } },
      ],
    };
    const [galway, ...rest] = normalizeDestinations('google_travel_explore', data, q);
    assert.equal(rest.length, 0);
    assert.deepEqual(galway.via, { city: 'Dublin', driveMinutes: 150 });
    assert.match(galway.googleUrl, /^https:\/\/www\.google\.com\/travel\/flights\?q=Flights\+from\+AMS\+to\+DUB/);
  });

  it('merges best and other flights and keeps price insights', () => {
    const leg = (from, to, dep, arr) => ({
      departure_airport: { id: from, time: dep },
      arrival_airport: { id: to, time: arr },
      airline: 'Transavia',
      flight_number: 'HV 1',
    });
    const data = {
      best_flights: [
        { price: 131, total_duration: 140, flights: [leg('AMS', 'BCN', '2026-11-05 07:00', '2026-11-05 09:20')] },
      ],
      other_flights: [
        {
          price: 122,
          total_duration: 300,
          flights: [
            leg('AMS', 'MUC', '2026-11-05 06:00', '2026-11-05 07:20'),
            leg('MUC', 'BCN', '2026-11-05 09:00', '2026-11-05 11:00'),
          ],
          layovers: [{ id: 'MUC', name: 'Munich', duration: 100 }],
        },
      ],
      price_insights: { lowest_price: 122, price_level: 'high', typical_price_range: [70, 105] },
      search_metadata: { google_flights_url: 'https://www.google.com/travel/flights?hl=en' },
    };
    const result = normalizeFlights(data);
    assert.deepEqual(
      result.flights.map((f) => [f.price, f.stops]),
      [
        [122, 1],
        [131, 0],
      ],
    );
    assert.equal(result.lowestPrice, 122);
    assert.deepEqual(result.insights, { lowestPrice: 122, level: 'high', typicalRange: [70, 105] });
    assert.equal(result.flights[0].layovers[0].code, 'MUC');
  });
});

describe('serpSearch', () => {
  const fakeFetch = (body, status = 200) => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { status, json: async () => body };
    };
    return { calls, fetchImpl };
  };

  it('caches by search parameters only and reuses the cached result', async () => {
    const cache = createCache({ ttlMs: 60000 });
    const { calls, fetchImpl } = fakeFetch({ deals: [] });
    const options = { apiKey: 'secret', cache, fetchImpl };

    const first = await serpSearch({ engine: 'google_flights_deals', departure_id: 'AMS', stops: undefined }, options);
    const second = await serpSearch({ departure_id: 'AMS', engine: 'google_flights_deals' }, options);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].searchParams.get('api_key'), 'secret');
    assert.equal(calls[0].searchParams.has('stops'), false);
  });

  it('treats "no results" as an empty answer but reports other errors without the key', async () => {
    const cache = createCache({ ttlMs: 60000 });
    const empty = fakeFetch({ error: "Google Flights hasn't returned any results for this query." });
    const { data } = await serpSearch({ engine: 'google_flights' }, { apiKey: 'k', cache, fetchImpl: empty.fetchImpl });
    assert.equal(normalizeFlights(data).flights.length, 0);

    const broken = fakeFetch({ error: 'Invalid API key.' }, 401);
    await assert.rejects(
      serpSearch({ engine: 'google_travel_explore' }, { apiKey: 'top-secret', cache, fetchImpl: broken.fetchImpl }),
      (err) => err instanceof HttpError && err.status === 502 && !err.message.includes('top-secret'),
    );
  });

  it('checks the daily budget only before live searches', async () => {
    const cache = createCache({ ttlMs: 60000 });
    let live = 0;
    const options = { apiKey: 'k', cache, fetchImpl: fakeFetch({}).fetchImpl, beforeLiveSearch: () => live++ };
    await serpSearch({ engine: 'google_flights', outbound_date: '2026-11-05' }, options);
    await serpSearch({ engine: 'google_flights', outbound_date: '2026-11-05' }, options);
    assert.equal(live, 1);
  });
});
