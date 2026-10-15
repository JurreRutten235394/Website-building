// Builds public/airports.json from the public-domain OurAirports dataset.
//
//   node scripts/build-airports.js                 # download the latest CSVs
//   node scripts/build-airports.js airports.csv countries.csv   # use local copies
//
// Keeps large and medium airports that have scheduled service and an IATA code.
// Output rows: [iata, airport name, city, country name, isLargeAirport (1/0), latitude, longitude].

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://davidmegginson.github.io/ourairports-data';
const OUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'airports.json');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows;
  return body.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const round = (value) => Math.round(Number(value) * 100) / 100;

async function load(localPath, name) {
  if (localPath) return readFile(localPath, 'utf8');
  const res = await fetch(`${SOURCE}/${name}.csv`);
  if (!res.ok) throw new Error(`Download of ${name}.csv failed: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const [airportsPath, countriesPath] = process.argv.slice(2);
  const countries = new Map(parseCsv(await load(countriesPath, 'countries')).map((c) => [c.code, c.name]));
  const seen = new Set();

  const airports = parseCsv(await load(airportsPath, 'airports'))
    .filter(
      (a) =>
        (a.type === 'large_airport' || a.type === 'medium_airport') &&
        a.scheduled_service === 'yes' &&
        /^[A-Z]{3}$/.test(a.iata_code),
    )
    .map((a) => [
      a.iata_code,
      a.name,
      a.municipality,
      countries.get(a.iso_country) || a.iso_country,
      a.type === 'large_airport' ? 1 : 0,
      round(a.latitude_deg),
      round(a.longitude_deg),
    ])
    // Large airports first so they win both the de-duplication and the default ordering.
    .sort((a, b) => b[4] - a[4] || a[0].localeCompare(b[0]))
    .filter((a) => !seen.has(a[0]) && seen.add(a[0]));

  await writeFile(OUT_FILE, JSON.stringify(airports) + '\n');
  console.log(`Wrote ${airports.length} airports to ${path.relative(process.cwd(), OUT_FILE)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
