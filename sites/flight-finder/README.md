# Flight Finder

A small website for finding cheap flights. Prices come from Google Flights through [SerpAPI](https://serpapi.com).

- **Cheapest from my airport**: pick one or more departure airports and a date or date range, such as next week. You get every destination sorted by price, with dates, stops, flight time and how far below the usual price it is.
- **Specific route**: pick From and To and check up to 7 departure days. A price strip shows which day is cheapest, with every flight for that day underneath.

Other features:

- Autocomplete for about 3,200 airports, plus nearby-airport suggestions (for example Eindhoven, Rotterdam, Weeze or Brussels when you start from Amsterdam).
- One-way or return trips. For a date range you can set the stay length in nights.
- Filters for stops, maximum price, number of adults and currency.
- A "See flights" button on every destination and links that open the same search in Google Flights.

## Running it

You need Node.js 20 or newer. There is nothing to `npm install`.

```bash
cd sites/flight-finder
cp .env.example .env      # then put your SerpAPI key in .env
npm start                 # opens on http://127.0.0.1:3000
```

`npm run dev` restarts the server whenever you change a file. `npm test` runs the unit tests.

## How searches are counted

The free SerpAPI plan has 250 searches a month. The header shows how many you have left.

| What you do                                     | Searches used |
| ----------------------------------------------- | ------------- |
| Cheapest from my airport, exact date or a range | 1             |
| Specific route, one day                         | 1             |
| Specific route, a range of N days               | N (max 7)     |
| "See flights" on a destination                  | 1             |
| Repeating a search within `CACHE_HOURS`         | 0             |

Results are cached on disk in `.cache/`, so restarting the server keeps them. `DAILY_SEARCH_LIMIT` (default 50) stops a busy day from using up the whole month.

## Settings (`.env`)

| Variable             | Default              | Meaning                                                    |
| -------------------- | -------------------- | ---------------------------------------------------------- |
| `SERPAPI_API_KEY`    | required             | Your SerpAPI key. It stays on the server.                  |
| `HOST` / `PORT`      | `127.0.0.1` / `3000` | Where to listen. Use `HOST=0.0.0.0` on a server.           |
| `SERPAPI_GL`         | `nl`                 | Country Google prices for.                                 |
| `SERPAPI_HL`         | `en`                 | Language of place names.                                   |
| `DEFAULT_CURRENCY`   | `EUR`                | Currency selected when the page opens.                     |
| `CACHE_HOURS`        | `3`                  | How long a search result is reused.                        |
| `DAILY_SEARCH_LIMIT` | `50`                 | Live searches allowed per day (`0` = no limit).            |
| `BASIC_AUTH`         | empty                | `user:password` to put a login in front of the whole site. |

## Putting it online

Any host that runs Node works (Render, Railway, Fly.io, a VPS). Use `npm start` as the start command, then set `SERPAPI_API_KEY`, `HOST=0.0.0.0` and `BASIC_AUTH` in the host's environment settings. Without `BASIC_AUTH`, anyone who finds the URL can use up your searches.

## How it works

```
browser ──/api/explore, /api/route──▶ server.js ──▶ SerpAPI ──▶ Google Flights
   ▲                                     │
   └──────── normalized JSON ◀───────────┘ (cached in .cache/)
```

| SerpAPI engine          | Used for                                         |
| ----------------------- | ------------------------------------------------ |
| `google_travel_explore` | Cheapest destinations for exact dates            |
| `google_flights_deals`  | Cheapest destinations for a departure date range |
| `google_flights`        | Every flight on one route for one day            |

- `server.js`: HTTP server, static files, API routes, login and the daily limit.
- `lib/flights.js`: input checks, SerpAPI requests and turning responses into simple objects.
- `lib/cache.js`: memory and disk cache.
- `public/`: the website itself (plain HTML, CSS and JavaScript, no build step).
- `scripts/build-airports.js`: rebuilds `public/airports.json` from the public-domain [OurAirports](https://ourairports.com/data/) data (`npm run build:airports`).
