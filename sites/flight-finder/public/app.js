// Flight Finder frontend. Talks only to this site's own /api endpoints; the
// SerpAPI key stays on the server.

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const form = $('#search-form');
const resultsEl = $('#results');
const formError = $('#form-error');
const submitButton = $('#submit');
const STORAGE_KEY = 'flight-finder:form';
const NEARBY_KM = 160;

const state = {
  mode: 'explore',
  airports: [],
  byCode: new Map(),
  config: { currencies: ['EUR'], defaultCurrency: 'EUR', maxWindowDays: { explore: 62, route: 7 } },
  explore: null,
  busy: false,
};

// ---------- small helpers ----------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child !== undefined && child !== null && child !== false) node.append(child);
  }
  return node;
}

function localIso(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const formatDate = (iso) => (iso ? dateFormat.format(new Date(`${iso}T00:00:00Z`)) : '');

function formatDates(depart, returnDate) {
  if (!returnDate) return formatDate(depart);
  const nights = daysBetween(depart, returnDate);
  return `${formatDate(depart)} → ${formatDate(returnDate)} · ${nights} night${nights === 1 ? '' : 's'}`;
}

function formatPrice(value, currency) {
  if (typeof value !== 'number') return '–';
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

function formatDuration(minutes) {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

// "Antwerp International Airport (Deurne)" -> "Antwerp"; falls back to the city.
const shortName = (airport) =>
  airport.name
    .replace(/\(.*?\)/g, '')
    .replace(/\b(International|Intl\.?|Regional|Airport|Airfield|Aerodrome)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || airport.city;

const stopsText = (stops) =>
  stops === 0 ? 'Nonstop' : typeof stops === 'number' ? `${stops} stop${stops > 1 ? 's' : ''}` : '';

const normalizeText = (text) =>
  String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function distanceKm(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

const storage = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  },
  save(value) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      // Private windows can refuse storage; remembering the form is only a convenience.
    }
  },
};

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  let body;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  if (!res.ok) throw new Error(body.error || `The server answered with HTTP ${res.status}.`);
  return body;
}

// ---------- airports ----------

async function loadAirports() {
  const rows = await getJson('airports.json');
  state.airports = rows.map(([code, name, city, country, large, lat, lon]) => ({
    code,
    name,
    city: city || name,
    country,
    large: large === 1,
    lat,
    lon,
    searchText: normalizeText(`${city} ${name} ${country}`),
  }));
  state.byCode = new Map(state.airports.map((a) => [a.code, a]));
}

function searchAirports(text, exclude) {
  const query = normalizeText(text).trim();
  if (!query) return [];
  const upper = query.toUpperCase();
  const scored = [];

  for (const airport of state.airports) {
    if (exclude.includes(airport.code)) continue;
    let score;
    if (airport.code === upper) score = 0;
    else if (query.length <= 3 && airport.code.startsWith(upper)) score = 2;
    else if (normalizeText(airport.city).startsWith(query)) score = 1;
    else if (airport.searchText.split(/[\s,()-]+/).some((word) => word.startsWith(query))) score = 3;
    else if (query.length > 2 && airport.searchText.includes(query)) score = 4;
    else continue;
    scored.push([score - (airport.large ? 0.5 : 0), airport]);
  }

  return scored
    .sort((a, b) => a[0] - b[0])
    .slice(0, 8)
    .map(([, airport]) => airport);
}

function nearbyAirports(code, exclude) {
  const origin = state.byCode.get(code);
  if (!origin) return [];
  return state.airports
    .filter((a) => !exclude.includes(a.code))
    .map((a) => ({ airport: a, km: distanceKm(origin, a) }))
    .filter((x) => x.km <= NEARBY_KM)
    .sort((a, b) => a.km - b.km)
    .slice(0, 5);
}

function createAirportPicker(root, { max = 7, onChange } = {}) {
  const input = $('input', root);
  const chipsEl = $('.chips', root);
  const list = $('.suggestions', root);
  const placeholder = input.placeholder;
  let codes = [];
  let matches = [];
  let active = -1;

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function renderList() {
    if (!matches.length) return close();
    list.replaceChildren(
      ...matches.map((airport, i) =>
        el(
          'li',
          {
            id: `${list.id}-${i}`,
            role: 'option',
            'aria-selected': String(i === active),
            onmousedown: (event) => {
              event.preventDefault();
              add(airport.code);
            },
          },
          [
            el('span', { className: 'code', text: airport.code }),
            el('span', {}, [
              el('span', { text: airport.name }),
              el('span', { className: 'where', text: ` · ${airport.city}, ${airport.country}` }),
            ]),
          ],
        ),
      ),
    );
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function render() {
    chipsEl.replaceChildren(
      ...codes.map((code) => {
        const airport = state.byCode.get(code);
        return el('li', { className: 'chip', title: airport ? `${airport.name}, ${airport.country}` : code }, [
          code,
          airport ? el('small', { text: airport.city }) : null,
          el('button', {
            type: 'button',
            'aria-label': `Remove ${code}`,
            text: '×',
            onclick: () => remove(code),
          }),
        ]);
      }),
    );
    input.placeholder = codes.length ? (codes.length < max ? 'Add another airport' : '') : placeholder;
    input.disabled = codes.length >= max;
    onChange?.(codes);
  }

  function add(code) {
    const clean = code.toUpperCase();
    if (/^[A-Z]{3}$/.test(clean) && !codes.includes(clean) && codes.length < max) codes = [...codes, clean];
    input.value = '';
    matches = [];
    close();
    render();
    if (!input.disabled) input.focus();
  }

  function remove(code) {
    codes = codes.filter((c) => c !== code);
    render();
    input.focus();
  }

  root.addEventListener('click', (event) => {
    if (event.target === root || event.target === chipsEl) input.focus();
  });

  input.addEventListener('input', () => {
    matches = searchAirports(input.value, codes);
    active = matches.length ? 0 : -1;
    renderList();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!matches.length) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + matches.length) % matches.length;
      renderList();
    } else if (event.key === 'Enter') {
      const typed = input.value.trim();
      if (!typed) return; // let the form submit
      event.preventDefault();
      if (active >= 0 && matches[active]) add(matches[active].code);
      else if (/^[a-z]{3}$/i.test(typed)) add(typed);
    } else if (event.key === 'Escape') {
      close();
    } else if (event.key === 'Backspace' && !input.value && codes.length) {
      remove(codes[codes.length - 1]);
    }
  });

  input.addEventListener('blur', close);

  return {
    get codes() {
      return codes;
    },
    set(next) {
      codes = [...new Set((next || []).map((c) => c.toUpperCase()))].filter((c) => /^[A-Z]{3}$/.test(c)).slice(0, max);
      render();
    },
    add,
  };
}

const fromPicker = createAirportPicker($('.airport-picker[data-name="from"]'), { onChange: renderNearby });
const toPicker = createAirportPicker($('.airport-picker[data-name="to"]'));

function renderNearby(codes) {
  const nearbyEl = $('#nearby');
  const nearby = codes.length && codes.length < 7 ? nearbyAirports(codes[0], codes) : [];
  nearbyEl.hidden = !nearby.length;
  nearbyEl.replaceChildren(
    el('span', { text: 'Also search nearby:' }),
    ...nearby.map(({ airport, km }) =>
      el('button', {
        type: 'button',
        className: 'chip-button',
        title: `${airport.name} (${Math.round(km)} km away)`,
        text: `+ ${airport.code} ${shortName(airport)}`,
        onclick: () => fromPicker.add(airport.code),
      }),
    ),
  );
}

// ---------- form state ----------

const field = (name) => form.elements[name];
const radioValue = (name) => $(`input[name="${name}"]:checked`, form).value;
const setRadio = (name, value) => {
  const input = $(`input[name="${name}"][value="${value}"]`, form);
  if (input) input.checked = true;
};

function updateVisibility() {
  const active = new Set([state.mode, radioValue('trip'), radioValue('dateMode')]);
  for (const node of $$('[data-show]', form)) {
    node.hidden = !node.dataset.show.split(' ').every((condition) => active.has(condition));
  }
  for (const tab of $$('[role="tab"]', form))
    tab.setAttribute('aria-selected', String(tab.dataset.mode === state.mode));
  submitButton.textContent = state.mode === 'explore' ? 'Find cheapest destinations' : 'Search flights';
  updateCost();
}

function windowDays() {
  const start = field('windowStart').value;
  const end = field('windowEnd').value;
  return start && end ? daysBetween(start, end) + 1 : 0;
}

function updateCost() {
  let text = 'Uses 1 search. Repeating the same search within a few hours is free.';
  if (state.mode === 'route' && radioValue('dateMode') === 'window') {
    const days = windowDays();
    if (days > 1) text = `Uses up to ${days} searches, one per departure day. Repeat searches are free.`;
  }
  $('#cost').textContent = text;
}

function setWindow(start, end) {
  field('windowStart').value = start;
  field('windowEnd').value = end;
  updateCost();
}

function applyPreset(preset) {
  const today = localIso();
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const nextMonday = addDays(today, (8 - weekday) % 7 || 7);
  if (preset === 'weekend') {
    const friday = addDays(today, (5 - weekday + 7) % 7 || 7);
    setWindow(friday, addDays(friday, 2));
  } else if (preset === 'next-week') {
    setWindow(nextMonday, addDays(nextMonday, 6));
  } else if (preset === 'week-after') {
    setWindow(addDays(nextMonday, 7), addDays(nextMonday, 13));
  } else if (preset === 'next-30') {
    setWindow(addDays(today, 1), addDays(today, 30));
  }
}

function setMode(mode) {
  state.mode = mode;
  // A route search costs one search per day, so keep its window within the limit.
  const max = state.config.maxWindowDays[mode];
  if (windowDays() > max) field('windowEnd').value = addDays(field('windowStart').value, max - 1);
  updateVisibility();
}

function readForm() {
  return {
    mode: state.mode,
    from: fromPicker.codes,
    to: toPicker.codes,
    trip: radioValue('trip'),
    dateMode: radioValue('dateMode'),
    depart: field('depart').value,
    return: field('return').value,
    windowStart: field('windowStart').value,
    windowEnd: field('windowEnd').value,
    nightsMin: field('nightsMin').value,
    nightsMax: field('nightsMax').value,
    stops: field('stops').value,
    maxPrice: field('maxPrice').value,
    adults: field('adults').value,
    currency: field('currency').value,
  };
}

function applyForm(values) {
  const today = localIso();
  const future = (iso) => iso && iso >= today;
  if (values.from) fromPicker.set(values.from);
  if (values.to) toPicker.set(values.to);
  setRadio('trip', values.trip || 'oneway');
  setRadio('dateMode', values.dateMode || 'window');
  field('depart').value = future(values.depart) ? values.depart : addDays(today, 14);
  field('return').value =
    future(values.return) && values.return >= field('depart').value ? values.return : addDays(field('depart').value, 7);
  if (future(values.windowStart) && future(values.windowEnd)) setWindow(values.windowStart, values.windowEnd);
  else applyPreset('next-week');
  for (const name of ['nightsMin', 'nightsMax', 'stops', 'maxPrice', 'adults']) {
    if (values[name] !== undefined) field(name).value = values[name];
  }
  if (values.currency && state.config.currencies.includes(values.currency)) field('currency').value = values.currency;
  setMode(values.mode === 'route' ? 'route' : 'explore');
}

function buildQuery(values) {
  const max = state.config.maxWindowDays[values.mode];
  const params = new URLSearchParams();

  if (!values.from.length) throw new Error('Choose at least one airport to fly from.');
  params.set('from', values.from.join(','));
  if (values.mode === 'route') {
    if (!values.to.length) throw new Error('Choose where you want to fly to.');
    params.set('to', values.to.join(','));
  }
  params.set('trip', values.trip);

  if (values.dateMode === 'exact') {
    if (!values.depart) throw new Error('Choose a departure date.');
    params.set('depart', values.depart);
    if (values.trip === 'return') {
      if (!values.return) throw new Error('Choose a return date.');
      if (values.return < values.depart) throw new Error('The return date is before the departure date.');
      params.set('return', values.return);
    }
  } else {
    if (!values.windowStart || !values.windowEnd) throw new Error('Choose the first and last possible departure day.');
    const days = daysBetween(values.windowStart, values.windowEnd) + 1;
    if (days < 1) throw new Error('The last departure day is before the first one.');
    if (days > max) {
      throw new Error(
        values.mode === 'route'
          ? `A route search can cover at most ${max} days, because each day uses one search.`
          : `The departure window can be at most ${max} days.`,
      );
    }
    params.set('depart', values.windowStart);
    params.set('departEnd', values.windowEnd);
    if (values.trip === 'return') {
      params.set('nightsMin', values.nightsMin || '3');
      if (values.mode === 'explore') params.set('nightsMax', values.nightsMax || '7');
    }
  }

  if (values.stops && values.stops !== '0') params.set('stops', values.stops);
  if (values.maxPrice) params.set('maxPrice', values.maxPrice);
  if (values.adults && values.adults !== '1') params.set('adults', values.adults);
  params.set('currency', values.currency);
  return params;
}

// ---------- searching ----------

function setBusy(busy) {
  state.busy = busy;
  submitButton.disabled = busy;
  for (const button of $$('.see-flights', resultsEl)) button.disabled = busy;
}

function showMessage(text, { loading = false, error = false } = {}) {
  resultsEl.replaceChildren(
    el('div', { className: `card message${error ? ' error' : ''}` }, [
      loading ? el('div', { className: 'spinner', 'aria-hidden': 'true' }) : null,
      el('p', { text }),
    ]),
  );
}

async function runSearch() {
  if (state.busy) return;
  formError.hidden = true;

  const values = readForm();
  let params;
  try {
    params = buildQuery(values);
  } catch (err) {
    formError.textContent = err.message;
    formError.hidden = false;
    return;
  }
  storage.save(values);

  const mode = values.mode;
  const days = mode === 'route' && params.has('departEnd') ? windowDays() : 1;
  setBusy(true);
  showMessage(days > 1 ? `Checking ${days} departure days…` : 'Searching for the cheapest flights…', { loading: true });
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const data = await getJson(`api/${mode}?${params}`);
    if (mode === 'explore') renderExplore(data);
    else renderRoute(data);
  } catch (err) {
    showMessage(err.message, { error: true });
  } finally {
    setBusy(false);
    refreshQuota();
  }
}

function usageText(searchesUsed) {
  if (!searchesUsed) return 'Loaded from cache, no searches used.';
  return `Used ${searchesUsed} search${searchesUsed === 1 ? '' : 'es'}.`;
}

function windowText(query) {
  if (!query.departEnd) return formatDates(query.depart, query.return);
  const range = `Leaving ${formatDate(query.depart)} – ${formatDate(query.departEnd)}`;
  if (query.trip !== 'return') return `${range}, one way`;
  const nights = query.nightsMin === query.nightsMax ? query.nightsMin : `${query.nightsMin}–${query.nightsMax}`;
  return `${range}, staying ${nights} nights`;
}

// ---------- explore results ----------

function renderExplore(data) {
  state.explore = { ...data, sort: 'price', nonstop: false, country: '', showVia: false };
  const { query, destinations } = data;

  if (!destinations.length) {
    showMessage('No flights found for these dates. Try a wider window, other dates or a nearby airport.');
    return;
  }

  const countries = [...new Set(destinations.map((d) => d.country).filter(Boolean))].sort();
  const hasVia = destinations.some((d) => d.via);
  const hasDiscounts = destinations.some((d) => d.discountPercent);
  const onChange = (key) => (event) => {
    state.explore[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    renderDestinationList();
  };

  const head = el('div', { className: 'results-head' }, [
    el('div', {}, [
      el('h2', { text: `Cheapest from ${query.from.split(',').join(', ')}` }),
      el('p', { text: `${windowText(query)} · ${usageText(data.searchesUsed)}` }),
    ]),
    el('div', { className: 'toolbar' }, [
      el('label', {}, [
        'Sort',
        el('select', { onchange: onChange('sort') }, [
          el('option', { value: 'price', text: 'Cheapest first' }),
          hasDiscounts ? el('option', { value: 'discount', text: 'Biggest discount' }) : null,
          el('option', { value: 'duration', text: 'Shortest flight' }),
          el('option', { value: 'name', text: 'Name' }),
        ]),
      ]),
      countries.length > 1
        ? el('select', { 'aria-label': 'Country', onchange: onChange('country') }, [
            el('option', { value: '', text: 'All countries' }),
            ...countries.map((c) => el('option', { value: c, text: c })),
          ])
        : null,
      el('label', {}, [el('input', { type: 'checkbox', onchange: onChange('nonstop') }), 'Nonstop only']),
      hasVia
        ? el('label', { title: 'Places such as national parks, reached through a nearby airport' }, [
            el('input', { type: 'checkbox', onchange: onChange('showVia') }),
            'Include nearby places',
          ])
        : null,
    ]),
  ]);

  resultsEl.replaceChildren(head, el('div', { className: 'destinations', id: 'destination-list' }));
  renderDestinationList();
}

function renderDestinationList() {
  const { query, destinations, sort, nonstop, country, showVia } = state.explore;
  const sorters = {
    price: (a, b) => a.price - b.price,
    discount: (a, b) => (b.discountPercent || 0) - (a.discountPercent || 0) || a.price - b.price,
    duration: (a, b) => (a.durationMinutes || Infinity) - (b.durationMinutes || Infinity),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  const list = destinations
    .filter((d) => (!nonstop || d.stops === 0) && (!country || d.country === country) && (showVia || !d.via))
    .sort(sorters[sort]);

  const container = $('#destination-list');
  container.replaceChildren(
    ...(list.length
      ? list.map((d) => destinationCard(d, query))
      : [el('p', { className: 'message', text: 'Nothing matches these filters.' })]),
  );
}

function destinationCard(d, query) {
  const card = $('#destination-card').content.firstElementChild.cloneNode(true);
  const img = $('img', card);
  if (d.thumbnail) {
    img.src = d.thumbnail;
    img.addEventListener('error', () => img.remove());
  } else {
    img.remove();
  }

  $('.destination-name', card).textContent = d.name;
  $('.destination-country', card).textContent = [d.country, d.airport].filter(Boolean).join(' · ');
  $('.price', card).textContent = formatPrice(d.price, query.currency);

  if (d.discountPercent >= 5) {
    const discount = $('.discount', card);
    discount.textContent = `${d.discountPercent}% below usual`;
    if (d.averagePrice) discount.title = `Usually about ${formatPrice(d.averagePrice, query.currency)}`;
    discount.hidden = false;
  }

  $('.destination-dates', card).textContent = formatDates(d.departDate, d.returnDate);

  const multipleOrigins = query.from.includes(',');
  $('.destination-meta', card).textContent = [
    multipleOrigins && d.fromAirport ? `From ${d.fromAirport}` : null,
    stopsText(d.stops),
    formatDuration(d.durationMinutes),
    d.airline,
  ]
    .filter(Boolean)
    .join(' · ');

  const note = d.via
    ? `Fly to ${d.via.city} (${d.airport})${d.via.driveMinutes ? `, then about ${formatDuration(d.via.driveMinutes)} by car` : ''}.`
    : d.description;
  if (note) {
    const noteEl = $('.destination-note', card);
    noteEl.textContent = note;
    noteEl.hidden = false;
  }

  const seeFlights = $('.see-flights', card);
  seeFlights.disabled = state.busy;
  seeFlights.title = 'Shows every flight on this day (uses 1 search)';
  seeFlights.addEventListener('click', () =>
    openRoute({
      from: d.fromAirport ? [d.fromAirport] : query.from.split(','),
      to: [d.airport],
      trip: query.trip,
      depart: d.departDate,
      return: d.returnDate,
    }),
  );

  const link = $('.external', card);
  if (d.googleUrl) link.href = d.googleUrl;
  else link.remove();
  return card;
}

function openRoute({ from, to, trip, depart, return: returnDate }) {
  fromPicker.set(from);
  toPicker.set(to);
  setRadio('trip', returnDate ? 'return' : trip);
  setRadio('dateMode', 'exact');
  field('depart').value = depart;
  if (returnDate) field('return').value = returnDate;
  setMode('route');
  runSearch();
}

// ---------- route results ----------

function renderRoute(data) {
  const { query, days } = data;
  const priced = days.filter((d) => typeof d.lowestPrice === 'number');
  const cheapest = priced.reduce((best, d) => (!best || d.lowestPrice < best.lowestPrice ? d : best), null);
  let selected = cheapest || days[0];

  const head = el('div', { className: 'results-head' }, [
    el('div', {}, [
      el('h2', { text: `${query.from.split(',').join('/')} → ${query.to.split(',').join('/')}` }),
      el('p', { text: `${windowText(query)} · ${usageText(data.searchesUsed)}` }),
    ]),
  ]);

  const dayStrip =
    days.length > 1
      ? el(
          'div',
          { className: 'days', role: 'group', 'aria-label': 'Departure days' },
          days.map((day) =>
            el(
              'button',
              {
                type: 'button',
                className: `day${day === cheapest ? ' cheapest' : ''}`,
                'aria-pressed': String(day === selected),
                disabled: !day.flights.length,
                title: day.error || undefined,
                onclick: () => {
                  selected = day;
                  for (const button of $$('.day', dayStrip)) button.setAttribute('aria-pressed', 'false');
                  dayStrip.children[days.indexOf(day)].setAttribute('aria-pressed', 'true');
                  panel.replaceChildren(...dayPanel(day, query));
                },
              },
              [
                el('span', { className: 'day-date', text: formatDate(day.date) }),
                el('span', {
                  className: 'day-price',
                  text: day.error ? 'Error' : formatPrice(day.lowestPrice, query.currency),
                }),
                day === cheapest ? el('span', { className: 'day-tag', text: 'Cheapest' }) : null,
              ],
            ),
          ),
        )
      : null;

  const panel = el('div', {}, dayPanel(selected, query));
  resultsEl.replaceChildren(...[head, dayStrip, panel].filter(Boolean));
}

function dayPanel(day, query) {
  if (day.error) return [el('div', { className: 'card message error', text: day.error })];

  const nodes = [];
  const heading = formatDates(day.date, day.returnDate);
  if (day.insights?.level) {
    const range = day.insights.typicalRange;
    const usual =
      Array.isArray(range) && range.length === 2
        ? ` Usually ${formatPrice(range[0], query.currency)}–${formatPrice(range[1], query.currency)}.`
        : '';
    nodes.push(
      el('p', {
        className: `insight ${day.insights.level}`,
        text: `${heading}: prices are ${day.insights.level} for this route right now.${usual}`,
      }),
    );
  }

  if (!day.flights.length) {
    nodes.push(el('div', { className: 'card message', text: `No flights found for ${heading}.` }));
    return nodes;
  }

  nodes.push(
    el(
      'ol',
      { className: 'flights' },
      day.flights.map((f) => flightRow(f, query)),
    ),
  );
  if (day.googleUrl) {
    nodes.push(
      el('p', { className: 'results-foot' }, [
        el('a', {
          className: 'external',
          href: day.googleUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: 'Open this search in Google Flights',
        }),
      ]),
    );
  }
  return nodes;
}

function timeOf(stamp) {
  return stamp ? stamp.slice(11, 16) : '';
}

function flightRow(flight, query) {
  const first = flight.legs[0];
  const last = flight.legs[flight.legs.length - 1];
  const departed = first?.from.time;
  const arrived = last?.to.time;
  const dayShift = departed && arrived ? daysBetween(departed.slice(0, 10), arrived.slice(0, 10)) : 0;

  const layovers = flight.layovers.length
    ? `via ${flight.layovers.map((l) => `${l.code} (${formatDuration(l.durationMinutes)})`).join(', ')}`
    : null;

  return el('li', { className: 'flight card' }, [
    flight.airlineLogo
      ? el('img', { className: 'flight-logo', src: flight.airlineLogo, alt: '', referrerpolicy: 'no-referrer' })
      : el('span'),
    el('div', {}, [
      el('p', { className: 'flight-times' }, [
        departed && arrived ? `${timeOf(departed)} – ${timeOf(arrived)}` : '',
        dayShift > 0 ? el('sup', { text: `+${dayShift}` }) : null,
      ]),
      el('p', {
        className: 'flight-sub',
        text: [
          first && last ? `${first.from.code} → ${last.to.code}` : null,
          formatDuration(flight.durationMinutes),
          stopsText(flight.stops),
          layovers,
          flight.airlines.join(', '),
        ]
          .filter(Boolean)
          .join(' · '),
      }),
      el('details', { className: 'flight-legs' }, [
        el('summary', { text: 'Flight details' }),
        el(
          'ol',
          {},
          flight.legs.map((leg) =>
            el('li', {
              text: [
                leg.flightNumber,
                `${leg.from.code} ${timeOf(leg.from.time)} → ${leg.to.code} ${timeOf(leg.to.time)}`,
                formatDuration(leg.durationMinutes),
                leg.airplane,
                leg.oftenDelayed ? 'often delayed 30+ min' : null,
              ]
                .filter(Boolean)
                .join(' · '),
            }),
          ),
        ),
      ]),
    ]),
    el('div', {}, [
      el('p', { className: 'price', text: formatPrice(flight.price, query.currency) }),
      query.trip === 'return' ? el('p', { className: 'flight-price-note', text: 'round trip' }) : null,
    ]),
  ]);
}

// ---------- quota ----------

async function refreshQuota() {
  const quotaEl = $('#quota');
  try {
    const quota = await getJson('api/quota');
    if (typeof quota.searchesLeft !== 'number') return;
    quotaEl.textContent = `${quota.searchesLeft} of ${quota.searchesPerMonth} searches left this month`;
    quotaEl.classList.toggle('low', quota.searchesLeft < 25);
    quotaEl.hidden = false;
  } catch {
    quotaEl.hidden = true;
  }
}

// ---------- start ----------

async function init() {
  updateVisibility();
  for (const tab of $$('[role="tab"]', form)) tab.addEventListener('click', () => setMode(tab.dataset.mode));
  for (const radio of $$('input[type="radio"]', form)) radio.addEventListener('change', updateVisibility);
  for (const button of $$('[data-preset]', form))
    button.addEventListener('click', () => applyPreset(button.dataset.preset));
  field('windowStart').addEventListener('change', updateCost);
  field('windowEnd').addEventListener('change', updateCost);
  field('depart').addEventListener('change', () => {
    if (field('return').value < field('depart').value) field('return').value = addDays(field('depart').value, 7);
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch();
  });

  const today = localIso();
  for (const name of ['depart', 'return', 'windowStart', 'windowEnd']) field(name).min = today;

  try {
    state.config = await getJson('api/config');
  } catch {
    // Fall back to the built-in defaults; the search itself will report a broken server.
  }
  field('currency').replaceChildren(...state.config.currencies.map((c) => el('option', { value: c, text: c })));
  field('currency').value = state.config.defaultCurrency;

  try {
    await loadAirports();
  } catch {
    // Without the list, typed three-letter codes still work.
  }

  const saved = storage.load();
  applyForm({ from: ['AMS'], ...saved });
  refreshQuota();
}

init();
