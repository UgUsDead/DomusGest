/*
  Fix user names in the SQLite DB based on a CSV mapping (NIF;Nome...)
  - Reads CSV in Windows-1252/latin1 or UTF-8 automatically
  - Accepts ';' or ',' as delimiter
  - Updates users.nome for matching NIFs
  Usage:
    node backend/scripts/fix_names_from_csv.js "C:\\path\\to\\file.csv"
*/

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const dbPath = process.env.DB_PATH || path.resolve(__dirname, '../../data/domusgest.db');

function readCsvSmart(filePath) {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, { encoding: 'latin1' }); // works for CP-1252
  } catch (e1) {
    // ignore
  }
  if (!raw) {
    raw = fs.readFileSync(filePath, { encoding: 'utf8' });
  }
  // Normalize line endings
  raw = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const hdr = lines[0].replace(/^\uFEFF/, '');
  const delim = (hdr.split(';').length >= hdr.split(',').length) ? ';' : ',';
  const headers = hdr.split(delim).map(h => normalize(h));

  const rows = lines.slice(1).map(line => line.split(delim));
  return { headers, rows };
}

function normalize(s) {
  return String(s || '')
    .replace(/^\uFEFF/, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function toDigits(s) {
  return (String(s || '').match(/\d+/g) || []).join('');
}

function repairMojibake(str) {
  if (!str) return str;
  // Heuristic: try to reinterpret as if current string was decoded as latin1 but should be utf8
  try {
    const fixed = Buffer.from(str, 'latin1').toString('utf8');
    // Choose the version with fewer replacement chars or more non-ascii letters
    const score = (t) => (t.match(/[\uFFFD]/g) || []).length;
    return score(fixed) <= score(str) ? fixed : str;
  } catch {
    return str;
  }
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node backend/scripts/fix_names_from_csv.js "C:\\path\\to\\file.csv"');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error('CSV file not found:', filePath);
    process.exit(1);
  }

  const { headers, rows } = readCsvSmart(filePath);
  const idxNome = headers.indexOf('nome');
  const idxNif = headers.indexOf('nif');
  if (idxNome === -1 || idxNif === -1) {
    console.error('CSV must contain columns for Nome and NIF (case/accents insensitive).');
    process.exit(1);
  }

  const db = new sqlite3.Database(dbPath);

  let total = 0, updated = 0, missing = 0, skipped = 0;
  const updateP = (nome, nif) => new Promise((resolve) => {
    db.run('UPDATE users SET nome = ?, updated_at = CURRENT_TIMESTAMP WHERE nif = ?', [nome, nif], function(err) {
      if (err) {
        console.error('DB error for NIF', nif, err.message);
        return resolve(false);
      }
      resolve(this.changes > 0);
    });
  });

  for (const cols of rows) {
    total++;
    const rawNome = cols[idxNome] || '';
    const rawNif = cols[idxNif] || '';
    const nif = toDigits(rawNif);
    if (!nif) { skipped++; continue; }

    // Prefer repaired name; trim excessive spaces
    const nome = repairMojibake(String(rawNome)).replace(/\s+/g, ' ').trim();

    const ok = await updateP(nome, nif);
    if (ok) updated++; else missing++;
  }

  console.log(JSON.stringify({ success: true, total, updated, missing, skipped, dbPath }, null, 2));
  db.close();
}

main().catch(e => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
