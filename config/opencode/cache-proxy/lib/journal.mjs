// lib/journal.mjs
// Append-only JSONL journal, one file per month. Callers pass explicit fields only: no bodies, no keys.
import fs from 'node:fs';
import path from 'node:path';

export function createJournal(dir, now = () => Date.now()) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    // Best effort: recreates a removed directory and never throws into the request path.
    write(record) {
      const ts = new Date(now()).toISOString();
      const file = path.join(dir, `requests-${ts.slice(0, 7)}.jsonl`);
      const line = `${JSON.stringify({ ts, ...record })}\n`;
      try {
        fs.appendFileSync(file, line);
      } catch {
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.appendFileSync(file, line);
        } catch (err) {
          console.error(`cache-proxy: journal write failed: ${err.message}`);
        }
      }
    },
  };
}

export function short(value, max = 300) {
  const text = value instanceof Error ? value.message : String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
