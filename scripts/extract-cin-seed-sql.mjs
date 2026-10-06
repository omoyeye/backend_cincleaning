/**
 * Parse `cin (db)/cin.sql` (HeidiSQL-style) and write `src/seed/cinDumpData.ts`
 * with full INSERT statements (including multi-line VALUES ending in `);`).
 *
 * Also extracts any `data:image/...;base64,...` blobs (SQL-quoted or JSON-escaped
 * inside column text), writes them under `uploads/seed/`, and replaces each with
 * `/uploads/seed/<hash>.<ext>` so the seed module stays small.
 *
 * Run: node scripts/extract-cin-seed-sql.mjs
 * npm:  npm run db:extract:cin
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'cin (db)', 'cin.sql');
const outFile = path.join(root, 'src', 'seed', 'cinDumpData.ts');
const uploadDir = path.join(root, 'uploads', 'seed');

const TABLES = [
  'blog_posts',
  'business_settings',
  'discounts',
  'email_templates',
  'extra_services',
  'gallery_items',
  'services',
  'sms_templates',
];

const MIME_TO_EXT = { jpeg: 'jpg', jpg: 'jpg', png: 'png', gif: 'gif', webp: 'webp' };

function insertPrefix(table) {
  return 'INSERT INTO `' + table + '`';
}

function tableFromLine(line) {
  for (const t of TABLES) {
    if (line.startsWith(insertPrefix(t))) return t;
  }
  return null;
}

function isStatementEnd(line) {
  return /\);\s*$/.test(line.trimEnd());
}

/** @type {number} */
let imageExtractCount = 0;

function saveBase64ToSeedUploads(base64Data, mimeType) {
  const ext = MIME_TO_EXT[mimeType] || mimeType;
  const hash = crypto.createHash('sha1').update(base64Data.slice(0, 400)).digest('hex').slice(0, 10);
  const filename = `${hash}.${ext}`;
  const filePath = path.join(uploadDir, filename);
  const publicPath = `/uploads/seed/${filename}`;
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    console.log(`  image: wrote uploads/seed/${filename} (~${Math.round((base64Data.length * 3) / 4 / 1024)} KB)`);
  }
  imageExtractCount++;
  return publicPath;
}

/**
 * Replace all base64 data-URIs in a SQL statement string.
 * (A) SQL single-quoted: 'data:image/TYPE;base64,...'  (char before `d` is `'`)
 * (B) JSON in SQL text:   "...":"data:image/TYPE;base64,..."  (char before `d` is `"`; base64 has no `"`)
 * (C) Escaped JSON in SQL: \"...\":\"data:...\"  (char before `d` is `\"`; closing is \")
 */
function replaceBase64InSqlString(sqlStr) {
  const MARKER = 'data:image/';
  let result = '';
  let pos = 0;

  while (pos < sqlStr.length) {
    const start = sqlStr.indexOf(MARKER, pos);
    if (start === -1) {
      result += sqlStr.slice(pos);
      break;
    }

    result += sqlStr.slice(pos, start);

    const afterMarker = start + MARKER.length;
    const semicolon = sqlStr.indexOf(';base64,', afterMarker);
    if (semicolon === -1) {
      result += sqlStr.slice(start, start + MARKER.length);
      pos = start + MARKER.length;
      continue;
    }
    const mimeType = sqlStr.slice(afterMarker, semicolon);
    const dataStart = semicolon + ';base64,'.length;

    const prev = start >= 1 ? sqlStr[start - 1] : '';
    const prev2 = start >= 2 ? sqlStr[start - 2] : '';

    let dataEnd;

    if (prev === '"' && prev2 === '\\') {
      dataEnd = sqlStr.indexOf('\\"', dataStart);
      if (dataEnd === -1) dataEnd = sqlStr.length;
    } else if (prev === '"') {
      dataEnd = sqlStr.indexOf('"', dataStart);
      if (dataEnd === -1) dataEnd = sqlStr.length;
    } else if (prev === "'") {
      dataEnd = dataStart;
      while (dataEnd < sqlStr.length) {
        const q = sqlStr.indexOf("'", dataEnd);
        if (q === -1) {
          dataEnd = sqlStr.length;
          break;
        }
        if (sqlStr[q + 1] === "'") {
          dataEnd = q + 2;
          continue;
        }
        dataEnd = q;
        break;
      }
    } else {
      dataEnd = dataStart;
      while (dataEnd < sqlStr.length) {
        const q = sqlStr.indexOf("'", dataEnd);
        if (q === -1) {
          dataEnd = sqlStr.length;
          break;
        }
        if (sqlStr[q + 1] === "'") {
          dataEnd = q + 2;
          continue;
        }
        dataEnd = q;
        break;
      }
    }

    const base64Data = sqlStr.slice(dataStart, dataEnd);
    const publicPath = saveBase64ToSeedUploads(base64Data, mimeType);
    result += publicPath;
    /** Keep closing quote(s) in the stream — next `slice(pos, start)` copies them. */
    pos = dataEnd;
  }

  return result;
}

function stripBase64FromStatements(statements) {
  imageExtractCount = 0;
  fs.mkdirSync(uploadDir, { recursive: true });
  const out = {};
  for (const t of TABLES) {
    out[t] = (statements[t] || []).map((stmt) => replaceBase64InSqlString(stmt));
  }
  if (imageExtractCount > 0) {
    console.log(`Extracted ${imageExtractCount} base64 image(s) → uploads/seed/`);
  } else {
    console.log('No base64 images found in extracted statements.');
  }
  return out;
}

function main() {
  if (!fs.existsSync(src)) {
    console.error('Missing:', src);
    process.exit(1);
  }

  /** @type {Record<string, string[]>} */
  const statements = Object.fromEntries(TABLES.map((t) => [t, []]));

  /** @type {{ table: string; lines: string[] } | null} */
  let capture = null;

  function flush() {
    if (!capture) return;
    const sql = capture.lines.join('\n').trim();
    if (sql) statements[capture.table].push(sql);
    capture = null;
  }

  const rs = fs.createReadStream(src, { encoding: 'utf8' });
  let buf = '';

  rs.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

      if (capture) {
        capture.lines.push(line);
        if (isStatementEnd(line)) flush();
        continue;
      }

      const t = tableFromLine(line);
      if (t) {
        capture = { table: t, lines: [line] };
        if (isStatementEnd(line)) flush();
      }
    }
  });

  rs.on('end', () => {
    if (buf.length) {
      const line = buf.endsWith('\r') ? buf.slice(0, -1) : buf;
      if (capture) {
        capture.lines.push(line);
        if (isStatementEnd(line)) flush();
        else flush();
      } else {
        const t = tableFromLine(line);
        if (t) {
          capture = { table: t, lines: [line] };
          flush();
        }
      }
    } else if (capture) flush();

    const cleaned = stripBase64FromStatements(statements);
    const json = JSON.stringify(cleaned);
    const file =
      '/** Generated by `node scripts/extract-cin-seed-sql.mjs` from `cin (db)/cin.sql`. Base64 images are written to `uploads/seed/` and replaced with `/uploads/seed/...` paths. Do not edit by hand. */\n\n' +
      'export type CinDumpInsertStatements = Record<string, string[]>;\n\n' +
      'export const cinDumpInsertStatements: CinDumpInsertStatements = ' +
      json +
      ';\n';
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, file, 'utf8');
    console.log('Wrote', outFile);
    console.log(
      Object.fromEntries(Object.entries(cleaned).map(([k, v]) => [k, v.length])),
    );
  });

  rs.on('error', (e) => {
    console.error(e);
    process.exit(1);
  });
}

main();
