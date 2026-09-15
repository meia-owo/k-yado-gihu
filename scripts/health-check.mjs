#!/usr/bin/env node
/**
 * 宿マスター健康チェック（VacantHotelSearch）
 * Node fetch は Referer を送れないので curl 経由。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VACANT =
  'https://openapi.rakuten.co.jp/engine/api/Travel/VacantHotelSearch/20170426';
const DELAY_MS = Number(process.env.RAKUTEN_DELAY_MS || 1100);
const REFERER =
  process.env.RAKUTEN_REFERER || 'https://meia-owo.github.io/k-yado-gihu/';

const appId = process.env.RAKUTEN_APPLICATION_ID;
const accessKey = process.env.RAKUTEN_ACCESS_KEY;
if (!appId || !accessKey) {
  console.error('missing secrets');
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
function extractField(obj, key) {
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const f = extractField(item, key);
      if (f != null) return f;
    }
    return null;
  }
  if (obj && typeof obj === 'object') {
    if (obj[key] != null) return obj[key];
    for (const v of Object.values(obj)) {
      const f = extractField(v, key);
      if (f != null) return f;
    }
  }
  return null;
}
function extractCharges(obj, charges = []) {
  if (Array.isArray(obj)) obj.forEach((i) => extractCharges(i, charges));
  else if (obj && typeof obj === 'object') {
    if (obj.dailyCharge) charges.push(obj.dailyCharge);
    Object.values(obj).forEach((v) => extractCharges(v, charges));
  }
  return charges;
}
function nameLooseMatch(a, b) {
  if (!a || !b) return false;
  const norm = (s) =>
    String(s)
      .replace(/\s/g, '')
      .replace(/[・･\-ー＿]/g, '')
      .replace(/\//g, '')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
        String.fromCharCode(c.charCodeAt(0) - 0xfee0)
      )
      .toLowerCase();
  return norm(a).includes(norm(b)) || norm(b).includes(norm(a));
}

async function curlJson(url) {
  const { stdout, stderr } = await execFileAsync(
    'curl',
    [
      '-sS',
      '-w',
      '\n__HTTP__:%{http_code}',
      '-H', `Referer: ${REFERER}`,
      '-H', 'Origin: https://meia-owo.github.io',
      '-H', 'Accept: application/json,text/plain,*/*',
      '-H', 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
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
  return { status, data, raw: body, stderr };
}

async function vacantOne(hotelNo, dateStr, retries = 2) {
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
  const { status, data } = await curlJson(`${VACANT}?${params}`);
  if (status === 404) return { available: false, status: 404 };
  if (status === 429) {
    if (retries > 0) {
      await sleep(3000);
      return vacantOne(hotelNo, dateStr, retries - 1);
    }
    return { available: false, error: 'HTTP429', status: 429 };
  }
  if (status !== 200) {
    return {
      available: false,
      status,
      error:
        data?.error ||
        data?.errors?.errorMessage ||
        `HTTP${status}`,
    };
  }
  if (data?.error) {
    if (data.error === 'not_found') return { available: false, status: 200, notFound: true };
    return { available: false, error: data.error_description || data.error };
  }
  const liveName = extractField(data, 'hotelName');
  const charges = extractCharges(data);
  let cheapest = null;
  for (const c of charges) {
    const total = c.total ?? c.rakutenCharge;
    if (total != null && (cheapest === null || total < cheapest)) cheapest = total;
  }
  if (cheapest == null) return { available: false, liveName, status: 200 };
  return { available: true, price: cheapest, liveName, status: 200 };
}

async function main() {
  const base = process.env.CHECKIN || addDays(todayJst(), 7);
  const sampleDates = [base, addDays(base, 3)];
  const hotels = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'hotels.json'), 'utf8')
  );
  console.log(`health-check ${hotels.length} hotels dates=${sampleDates.join(',')}`);

  const rows = [];
  for (const h of hotels) {
    const nights = [];
    let liveName = null;
    let hardError = null;
    for (const d of sampleDates) {
      const r = await vacantOne(h.hotelNo, d);
      nights.push({ date: d, ...r });
      if (r.liveName) liveName = r.liveName;
      if (r.error && r.status !== 404 && r.status !== 429) hardError = r.error;
      await sleep(DELAY_MS);
    }
    const availableNights = nights.filter((n) => n.available);
    const prices = availableNights.map((n) => n.price).filter((p) => p != null);
    const minPrice = prices.length ? Math.min(...prices) : null;
    const avgPrice =
      prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;

    const flags = [];
    if (hardError) flags.push(`APIエラー:${hardError}`);
    if (!availableNights.length) flags.push('サンプル全日で空室なし');
    if (liveName && !nameLooseMatch(h.name, liveName)) flags.push('施設名不一致');
    if (minPrice != null && minPrice >= 30000) flags.push('高額(1泊3万円以上)');

    const removeCandidate = flags.some(
      (f) => f.startsWith('施設名不一致') || f.startsWith('APIエラー')
    );
    const reviewCandidate = flags.length > 0;

    rows.push({
      id: h.id,
      name: h.name,
      hotelNo: h.hotelNo,
      zone: h.zone,
      category: h.category,
      rakutenUrl: h.rakutenUrl,
      liveName,
      availableCount: availableNights.length,
      sampleCount: sampleDates.length,
      minPrice,
      avgPrice,
      flags,
      removeCandidate,
      reviewCandidate,
    });

    console.log(
      `${String(h.id).padStart(2)} ${(h.name || '').slice(0, 22).padEnd(22)} ` +
        `avail=${availableNights.length}/${sampleDates.length} ` +
        `¥${minPrice ?? '-'} ${flags.join('|') || 'ok'}`
    );
  }

  const priced = rows.map((r) => r.minPrice).filter((p) => p != null).sort((a, b) => a - b);
  const median =
    priced.length === 0
      ? null
      : priced.length % 2
        ? priced[(priced.length - 1) / 2]
        : Math.round((priced[priced.length / 2 - 1] + priced[priced.length / 2]) / 2);

  if (median != null) {
    for (const r of rows) {
      if (r.minPrice != null && r.minPrice > median * 3) {
        if (!r.flags.includes('異常高(中央値×3超)')) {
          r.flags.push('異常高(中央値×3超)');
          r.reviewCandidate = true;
        }
      }
    }
  }

  const remove = rows.filter((r) => r.removeCandidate);
  const review = rows.filter((r) => r.reviewCandidate && !r.removeCandidate);
  const healthy = rows.filter((r) => !r.reviewCandidate);

  const report = {
    generatedAt: new Date().toISOString(),
    sampleDates,
    medianPrice: median,
    summary: {
      total: rows.length,
      healthy: healthy.length,
      review: review.length,
      remove: remove.length,
      anyAvailability: rows.filter((r) => r.availableCount > 0).length,
    },
    removeCandidates: remove,
    reviewCandidates: review,
    healthy,
  };

  fs.writeFileSync(
    path.join(ROOT, 'data', 'cleanup-candidates.json'),
    JSON.stringify(report, null, 2)
  );
  const md = [
    `# 宿マスター クリーニング候補`,
    ``,
    `生成: ${report.generatedAt}`,
    `サンプル日: ${sampleDates.join(', ')}`,
    `中央値(最安): ${median ?? '-'}円`,
    ``,
    `## サマリ`,
    `- 全体: ${report.summary.total}`,
    `- 問題なし: ${report.summary.healthy}`,
    `- 要確認: ${report.summary.review}`,
    `- 削除候補: ${report.summary.remove}`,
    `- どれか空いてた: ${report.summary.anyAvailability}`,
    ``,
    `## 削除候補`,
    ...(remove.length
      ? remove.map((r) => `- **${r.name}** (No.${r.hotelNo}) … ${r.flags.join(' / ')}`)
      : ['- なし']),
    ``,
    `## 要確認（空室なし・高額など）`,
    ...(review.length
      ? review.map(
          (r) =>
            `- **${r.name}** … avail ${r.availableCount}/${r.sampleCount}, ¥${r.minPrice ?? '-'} … ${r.flags.join(' / ')}`
        )
      : ['- なし']),
    ``,
    `## 問題なし`,
    ...(healthy.length
      ? healthy.map((r) => `- ${r.name} … ¥${r.minPrice ?? '-'}`)
      : ['- なし']),
    ``,
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, 'data', 'cleanup-candidates.md'), md);
  console.log(JSON.stringify(report.summary));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
