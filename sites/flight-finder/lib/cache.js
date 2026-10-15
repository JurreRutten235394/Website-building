// Small time-limited cache kept in memory and mirrored to disk, so restarting
// the server does not throw away searches that were already paid for.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function createCache({ dir, ttlMs }) {
  const memory = new Map();
  const fileFor = (key) => path.join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  const fresh = (entry) => entry && Date.now() - entry.savedAt < ttlMs;

  return {
    async get(key) {
      let entry = memory.get(key);
      if (!entry && dir) {
        try {
          entry = JSON.parse(await readFile(fileFor(key), 'utf8'));
          memory.set(key, entry);
        } catch {
          // Missing or unreadable cache files are treated as a miss.
        }
      }
      if (fresh(entry)) return entry.value;
      memory.delete(key);
      return undefined;
    },

    async set(key, value) {
      const entry = { savedAt: Date.now(), value };
      memory.set(key, entry);
      if (!dir) return;
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(fileFor(key), JSON.stringify(entry));
      } catch (err) {
        console.warn(`Could not write cache file: ${err.message}`);
      }
    },
  };
}
