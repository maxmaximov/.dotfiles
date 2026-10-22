// lib/journal.mjs
// Append-only JSONL journal, one file per month. Callers pass explicit fields only: no bodies, no keys.
import fs from 'node:fs';
import path from 'node:path';

export function createJournal(dir, now = () => Date.now()) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    write(record) {
      const ts = new Date(now()).toISOString();
      fs.appendFileSync(path.join(dir, `requests-${ts.slice(0, 7)}.jsonl`), `${JSON.stringify({ ts, ...record })}\n`);
    },
  };
}

export function short(value, max = 300) {
  const text = value instanceof Error ? value.message : String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
