// Transcribes and translates F1 team radio (from OpenF1) into Japanese with Gemini, one JSON file per session:
//   radio/<session_key>.json = { session_key, complete, updated, items: { "<clip file name>": { en, ja, note } } }
// Runs on GitHub Actions (see .github/workflows/radio.yml). Needs the GEMINI_API_KEY secret.
// Env: GEMINI_MODEL (optional), MAX_REQUESTS (Gemini calls per run, default 10), YEARS (default: this year and last year).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.log('GEMINI_API_KEY is not set; nothing to do.');
  process.exit(0);
}
const MAX_REQUESTS = Number(process.env.MAX_REQUESTS ?? 10);
const now = new Date();
const YEARS = (process.env.YEARS ?? `${now.getUTCFullYear()},${now.getUTCFullYear() - 1}`).split(',').map(Number);
const OUT = join(import.meta.dirname, '..', 'radio');
const BATCH = 8;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastOpenF1 = 0;
async function openf1(path) {
  // Stay well under OpenF1's free limit (3 requests/second, 30/minute).
  const wait = 2200 - (Date.now() - lastOpenF1);
  if (wait > 0) await sleep(wait);
  lastOpenF1 = Date.now();
  const res = await fetch(`https://api.openf1.org/v1/${path}`);
  if (res.status === 429) {
    await sleep(20_000);
    return openf1(path);
  }
  const json = await res.json().catch(() => []);
  return Array.isArray(json) ? json : [];
}

async function pickModel() {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': KEY } });
  const json = await res.json();
  const names = (json.models ?? []).filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((m) => m.name.replace('models/', ''));
  // Newest stable "flash" model (not lite, preview or experimental).
  const flash = names
    .filter((n) => /^gemini-\d+(\.\d+)?-flash$/.test(n))
    .sort((a, b) => parseFloat(b.slice(7)) - parseFloat(a.slice(7)));
  const model = flash[0] ?? names.find((n) => /flash/.test(n));
  if (!model) throw new Error(`No usable Gemini model: ${JSON.stringify(json).slice(0, 300)}`);
  return model;
}

const PROMPT = `These are Formula 1 team radio clips between a driver and their race engineer.
For each clip, return one JSON object: {"clip": <clip number>, "en": "<exact English transcript>", "ja": "<natural Japanese translation>", "note": "<one short Japanese sentence explaining F1 jargon or context, or empty string>"}.
Rules:
- Transcribe only what is actually said. Write [inaudible] for words you cannot make out. Never invent content.
- When it is clear who speaks, prefix parts with "Driver:" / "Engineer:" in English and "ドライバー：" / "エンジニア：" in Japanese.
- Write driver and team names in katakana in Japanese. Keep the tone of the original (excited, angry, calm).
Return a JSON array only.`;

let requests = 0;
let model = null;
let quotaHit = false;

async function translateBatch(clips, driverName) {
  model ??= await pickModel();
  const parts = [];
  for (const [i, c] of clips.entries()) {
    const audio = await fetch(c.recording_url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; BoxBoxJP-radio/1.0)' } });
    if (!audio.ok) {
      console.log(`  audio ${audio.status} for ${fileName(c.recording_url)}`);
      continue;
    }
    const buf = Buffer.from(await audio.arrayBuffer());
    parts.push({ text: `Clip ${i} — driver: ${driverName(c.driver_number)}` });
    parts.push({ inline_data: { mime_type: 'audio/mp3', data: buf.toString('base64') } });
  }
  if (parts.length === 0) return [];
  parts.push({ text: PROMPT });
  requests++;
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status !== 503 && res.status !== 500) break;
    await sleep(15_000 * (attempt + 1));
  }
  if (res.status === 429) {
    quotaHit = true;
    console.log('Gemini quota reached; stopping for this run.');
    return [];
  }
  const json = await res.json();
  console.log(`  Gemini ${res.status}, ${parts.length - 1} parts sent, finish=${json.candidates?.[0]?.finishReason ?? 'none'}, reply: ${JSON.stringify(json).slice(0, 400)}`);
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '[]';
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    console.log('Unparseable Gemini output, skipping batch:', text.slice(0, 200));
    return [];
  }
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => Number.isInteger(r.clip) && clips[r.clip] && typeof r.en === 'string' && typeof r.ja === 'string')
    .map((r) => ({ clip: clips[r.clip], en: r.en.trim(), ja: r.ja.trim(), note: typeof r.note === 'string' ? r.note.trim() : '' }));
}

const fileName = (url) => url.split('/').pop();

const sessions = [];
for (const y of YEARS) sessions.push(...(await openf1(`sessions?year=${y}`)));
const ended = sessions
  .filter((s) => !s.is_cancelled && Date.parse(s.date_end) + 30 * 60_000 < now.getTime())
  // Newest first; within a year, races and qualifying before practice.
  .sort((a, b) => b.date_start.localeCompare(a.date_start));

const index = existsSync(join(OUT, 'index.json')) ? JSON.parse(readFileSync(join(OUT, 'index.json'), 'utf8')) : { sessions: {} };
let changed = false;

for (const s of ended) {
  if (requests >= MAX_REQUESTS || quotaHit) break;
  const file = join(OUT, `${s.session_key}.json`);
  const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { session_key: s.session_key, complete: false, items: {} };
  if (data.complete) continue;
  const radio = await openf1(`team_radio?session_key=${s.session_key}`);
  const missing = radio.filter((r) => !data.items[fileName(r.recording_url)]);
  const settled = Date.parse(s.date_end) + 2 * 86_400_000 < now.getTime();
  if (!missing.length) {
    if (settled && !data.complete) {
      data.complete = true;
      writeFileSync(file, JSON.stringify(data));
      changed = true;
    }
    continue;
  }
  const drivers = await openf1(`drivers?session_key=${s.session_key}`);
  const driverName = (n) => {
    const d = drivers.find((x) => x.driver_number === n);
    return d ? `${d.full_name} (${d.team_name})` : `#${n}`;
  };
  console.log(`${s.session_key} ${s.location} ${s.session_name}: ${missing.length} clips to translate`);
  for (let i = 0; i < missing.length && requests < MAX_REQUESTS && !quotaHit; i += BATCH) {
    let rows = [];
    try {
      rows = await translateBatch(missing.slice(i, i + BATCH), driverName);
    } catch (e) {
      // A stalled or failed request must not lose the batches already saved: skip this one, it is retried next run.
      console.log(`  batch failed, skipping: ${e?.cause?.code ?? e?.message ?? e}`);
    }
    for (const r of rows) data.items[fileName(r.clip.recording_url)] = { en: r.en, ja: r.ja, ...(r.note ? { note: r.note } : {}) };
    if (rows.length) {
      data.updated = new Date().toISOString();
      writeFileSync(file, JSON.stringify(data));
      index.sessions[s.session_key] = { count: Object.keys(data.items).length, updated: data.updated };
      index.updated = data.updated;
      writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1));
      changed = true;
    }
    // Free tier: a few requests per minute.
    await sleep(7000);
  }
}

if (changed) {
  index.updated = new Date().toISOString();
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1));
}
console.log(`done: ${requests} Gemini requests${model ? ` (${model})` : ''}${quotaHit ? ', quota reached' : ''}`);
