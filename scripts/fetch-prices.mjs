#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENDPOINT =
  'https://openapi.rakuten.co.jp/engine/api/Travel/VacantHotelSearch/20170426';
const DELAY_MS = Number(process.env.RAKUTEN_DELAY_MS || 1500);
const REFERER =
  process.env.RAKUTEN_REFERER || 'https://meia-owo.github.io/k-yado-gihu/';

const appId = process.env.RAKUTEN_APPLICATION_ID;
const accessKey = process.env.RAKUTEN_ACCESS_KEY;
if (!appId || !accessKey) {
  console.error('RAKUTEN_APPLICATION_ID / RAKUTEN_ACCESS_KEY が必要です');
  process.exit(1);
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function todayJst() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function parseArgs(argv) {
  const out = {
    checkin: process.env.CHECKIN || '',
    checkout: process.env.CHECKOUT || '',
    zone: process.env.ZONE || 'all',
    nights: Number(process.env.NIGHTS || 0),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--checkin') out.checkin = argv[++i];
    else if (a === '--checkout') out.checkout = argv[++i];
    else if (a === '--zone') out.zone = argv[++i];
    else if (a === '--nights') out.nights = Number(argv[++i]);
  }
  if (!out.checkin) out.checkin = addDays(todayJst(), 1);
  if (!out.checkout) {
    const n = out.nights > 0 ? out.nights : 1;
    out.checkout = addDays(out.checkin, n);
  }
  return out;
}
function extractChargesAndUrl(obj, charges = [], urls = []) {
  if (Array.isArray(obj)) obj.forEach((item) => extractChargesAndUrl(item, charges, urls));
  else if (obj && typeof obj === 'object') {
    if (obj.dailyCharge) charges.push(obj.dailyCharge);
    if (obj.reserveUrl) urls.push(obj.reserveUrl);
    Object.values(obj).forEach((v) => extractChargesAndUrl(v, charges, urls));
  }
  return { charges, urls };
}
async function curlJson(url) {
  const { stdout } = await execFileAsync(
    'curl',
    [
      '-sS',
      '-w',
      '\n__HTTP__:%{http_code}',
      '-H',
      `Referer: ${REFERER}`,
      '-H',
      'Origin: https://meia-owo.github.io',
      '-H',
      'Accept: application/json,text/plain,*/*',
      '-H',
      'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      url,
    ],
    { maxBuffer: 5 * 1024 * 1024 }
  );
  const marker = '\n__HTTP__:';
  const idx = stdout.lastIndexOf(marker);
  const body = idx >= 0 ? stdout.slice(0, idx) : stdout;
  const status = idx >= 0 ? Number(stdout.slice(idx + marker.length)) : 0;
  let data = null;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    data = null;
  }
  return { status, data };
}
async function fetchOneNight(hotelNo, dateStr, retriesLeft = 2) {
  if (!hotelNo) return { available: false, error: 'hotelNo不明' };
  const params = new URLSearchParams({
    applicationId: appId,
    accessKey,
    format: 'json',
    hotelNo: String(hotelNo),
    checkinDate: dateStr,
    checkoutDate: addDays(dateStr, 1),
    adultNum: '1',
    responseType: 'small',
  });
  const { status, data } = await curlJson(`${ENDPOINT}?${params}`);
  if (status === 404) return { available: false };
  if (status === 429) {
    if (retriesLeft > 0) {
      await sleep(3000);
      return fetchOneNight(hotelNo, dateStr, retriesLeft - 1);
    }
    return { available: false, error: 'HTTP429' };
  }
  if (status !== 200) {
    return {
      available: false,
      error: `HTTP${status}: ${data?.error_description || data?.error || data?.errors?.errorMessage || ''}`,
    };
  }
  if (data?.error) {
    if (data.error === 'not_found') return { available: false };
    return { available: false, error: data.error_description || data.error };
  }
  const { charges, urls } = extractChargesAndUrl(data);
  let cheapest = null;
  for (const c of charges) {
    const total = c.total ?? c.rakutenCharge;
    if (total != null && (cheapest === null || total < cheapest)) cheapest = total;
  }
  if (cheapest === null) return { available: false };
  return { available: true, price: cheapest, reserveUrl: urls[0] || null };
}
function nightsBetween(checkin, checkout) {
  const a = new Date(checkin + 'T00:00:00Z');
  const b = new Date(checkout + 'T00:00:00Z');
  return Math.max(1, Math.round((b - a) / 86400000));
}
async function main() {
  const { checkin, checkout, zone } = parseArgs(process.argv);
  const hotels = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'hotels.json'), 'utf8')
  ).filter((h) => (zone === 'all' || !zone ? true : String(h.zone) === String(zone)));
  const nightCount = nightsBetween(checkin, checkout);
  const dates = Array.from({ length: nightCount }, (_, i) => addDays(checkin, i));
  console.log(JSON.stringify({ checkin, checkout, zone, hotels: hotels.length, dates }));
  const results = [];
  for (const hotel of hotels) {
    const nights = [];
    let sum = 0;
    let allOk = true;
    for (const d of dates) {
      const r = await fetchOneNight(hotel.hotelNo, d);
      nights.push({ date: d, ...r });
      if (r.available && r.price != null) sum += r.price;
      else allOk = false;
      await sleep(DELAY_MS);
    }
    results.push({
      id: hotel.id,
      name: hotel.name,
      area: hotel.area,
      zone: hotel.zone,
      hotelNo: hotel.hotelNo,
      rakutenUrl: hotel.rakutenUrl,
      nights,
      total: allOk ? sum : null,
      availableAllNights: allOk,
    });
  }
  results.sort((a, b) => {
    if (a.total == null && b.total == null) return 0;
    if (a.total == null) return 1;
    if (b.total == null) return -1;
    return a.total - b.total;
  });
  const payload = {
    generatedAt: new Date().toISOString(),
    timezone: 'Asia/Tokyo',
    checkin,
    checkout,
    zone,
    adultNum: 1,
    count: results.length,
    availableCount: results.filter((r) => r.availableAllNights).length,
    results,
  };
  fs.writeFileSync(path.join(ROOT, 'data', 'latest.json'), JSON.stringify(payload, null, 2));
  console.log(
    `wrote latest.json available ${payload.availableCount}/${payload.count}; cheapest=${results.find((r) => r.total != null)?.name || 'none'} ${results.find((r) => r.total != null)?.total ?? '-'}`
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
