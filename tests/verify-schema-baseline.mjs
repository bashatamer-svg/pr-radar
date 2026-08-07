// schema.sql must be able to rebuild a database this application can run on.
//
// It could not. pr_users, pr_audit, pr_alerts and pr_usage were created ad-hoc
// in production and never written down; pr_subscribers.whatsapp and
// pr_users.reset_requested_at arrived as migrations that were applied and never
// folded back in. The file was a partial record of an early version, which is
// worse than no file — it looks authoritative.
//
// The check below does NOT compare against a hand-maintained list, because that
// list drifts exactly the way schema.sql did. It reads what lib/db.js actually
// ASKS FOR — every `pr_*` table it touches and every column it names in a
// PostgREST select, filter or order — and requires schema.sql to define them.
// A new column used in code and not added here fails on the commit that adds it.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const schema = readFileSync(root + 'schema.sql', 'utf8');
const db = readFileSync(root + 'lib/db.js', 'utf8');

// ── what schema.sql defines ───────────────────────────────────────────────
const defined = new Map();   // table -> Set(column)
for (const m of schema.matchAll(/create table if not exists (pr_\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const cols = new Set();
  for (const line of m[2].split('\n')) {
    const c = line.trim().match(/^(\w+)\s+\S/);
    // Skip table-level constraint lines (unique (...), check (...), …).
    if (c && !/^(unique|check|primary|foreign|constraint)$/i.test(c[1])) cols.add(c[1]);
  }
  defined.set(m[1], cols);
}
// Columns added by an `alter table … add column` in the same file count too.
for (const m of schema.matchAll(/alter table (pr_\w+) add column if not exists (\w+)/g)) {
  if (!defined.has(m[1])) defined.set(m[1], new Set());
  defined.get(m[1]).add(m[2]);
}

// ── what lib/db.js asks for ───────────────────────────────────────────────
// Every rest() path is a PostgREST query string: `pr_items?select=a,b&c=eq.x`.
const usedTables = new Set();
const usedColumns = new Map();   // table -> Set(column)
const note = (t, c) => {
  if (!usedColumns.has(t)) usedColumns.set(t, new Set());
  if (c) usedColumns.get(t).add(c);
};
for (const m of db.matchAll(/`(pr_\w+)(\?[^`]*)?`/g)) {
  const table = m[1];
  usedTables.add(table);
  note(table, null);
  const qs = m[2] || '';
  for (const sel of qs.matchAll(/select=([\w,]+)/g)) {
    for (const c of sel[1].split(',')) if (c) note(table, c);
  }
  // Filters and ordering name columns too: `&email=eq.x`, `&order=id.asc`,
  // `&author=is.null`. These are the ones a select-only scan would miss.
  for (const f of qs.matchAll(/[?&](\w+)=(?:eq|neq|gt|gte|lt|lte|is|in|not|like|ilike)\./g)) note(table, f[1]);
  for (const o of qs.matchAll(/order=(\w+)\./g)) note(table, o[1]);
}

// ── 1. every table the code touches is defined ────────────────────────────
for (const t of [...usedTables].sort()) {
  assert.ok(defined.has(t) || schema.includes(`alter table ${t}`),
    `schema.sql does not define ${t}, which lib/db.js queries — the file cannot rebuild a working database`);
}
// And the four that were the actual drift, named explicitly so a regression
// reads as the specific bug it is rather than a generic miss.
for (const t of ['pr_users', 'pr_audit', 'pr_alerts', 'pr_usage']) {
  assert.ok(defined.has(t), `${t} is in schema.sql (it was created ad-hoc in production and missing from this file)`);
}

// ── 2. every column the code names is defined ─────────────────────────────
// PostgREST reserved words and embedded resources are not columns.
const NOT_COLUMNS = new Set(['select', 'order', 'limit', 'offset', 'and', 'or', 'on_conflict', 'columns']);
const missing = [];
for (const [t, cols] of [...usedColumns].sort()) {
  const have = defined.get(t);
  if (!have) continue;                       // table-level miss already reported
  for (const c of cols) {
    if (NOT_COLUMNS.has(c)) continue;
    if (!have.has(c)) missing.push(`${t}.${c}`);
  }
}
assert.deepStrictEqual(missing, [],
  `lib/db.js reads columns schema.sql does not define: ${missing.join(', ')}`);

// The two migration-added columns specifically — both applied in production,
// both previously absent here.
assert.ok(defined.get('pr_subscribers').has('whatsapp'), 'pr_subscribers.whatsapp is folded in');
assert.ok(defined.get('pr_users').has('reset_requested_at'), 'pr_users.reset_requested_at is folded in');

// ── 3. the properties that make it safe to APPLY ──────────────────────────
{
  // Idempotent: it is a baseline someone will run against a database that
  // already has most of it.
  const creates = [...schema.matchAll(/create table (if not exists )?/g)];
  assert.ok(creates.every((c) => c[1]), 'every create table is `if not exists`');
  for (const m of schema.matchAll(/create index (if not exists )?/g)) {
    assert.ok(m[1], 'every create index is `if not exists`');
  }
  for (const m of schema.matchAll(/alter table \w+ add column (if not exists )?/g)) {
    assert.ok(m[1], 'every add column is `if not exists`');
  }

  // SHARED PROJECT. Another application's radar_* tables live in the same
  // Postgres database. This file must be safe to run there, which means it may
  // not name one — in any statement, at all.
  for (const line of schema.split('\n')) {
    if (line.trim().startsWith('--')) continue;
    assert.ok(!/\bradar_\w+/.test(line), `schema.sql must never reference a radar_* object: ${line.trim()}`);
  }
  // And nothing destructive: a baseline that can drop is a baseline someone
  // eventually runs against production by mistake.
  for (const bad of [/\bdrop\s+table\b/i, /\bdrop\s+column\b/i, /\btruncate\b/i, /\bdelete\s+from\b/i, /\bdrop\s+database\b/i]) {
    assert.ok(!bad.test(schema.replace(/^\s*--.*$/gm, '')), `schema.sql contains a destructive statement (${bad})`);
  }

  // RLS on, no policies, for every table — the whole access model. A table
  // added without this line is readable by the anon key.
  for (const t of defined.keys()) {
    assert.ok(new RegExp(`alter table\\s+${t}\\s+enable row level security`).test(schema),
      `${t} must enable row level security — RLS-on/no-policies is how only the service-role key gets rows`);
  }
  assert.ok(!/create policy/i.test(schema), 'and NO policy is created — a policy would grant the anon role rows');
}

console.log(`SCHEMA-BASELINE OK — ${defined.size} pr_* tables defined, every table and column lib/db.js queries is present (including the four created ad-hoc in production and the two migration columns), idempotent, RLS-on with no policies, no radar_* reference and nothing destructive`);
