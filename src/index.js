import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

/* =========================
   Auth (opcional para GPT Actions)
   - Si defines API_KEY en Railway, exige Authorization: Bearer <API_KEY>
   - Si NO defines API_KEY, no bloquea nada.
   ========================= */
const API_KEY = process.env.API_KEY || null;
app.use((req, res, next) => {
  if (!API_KEY) return next();
  const header = req.get('Authorization') || '';
  if (header === `Bearer ${API_KEY}`) return next();
  return res.status(401).json({ code: 'unauthorized', message: 'Missing/invalid bearer token' });
});

/* =========================
   Navegador “modo humano”
   ========================= */
async function withPage(fn, { width = 1366, height = 768 } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ],
  });

  const context = await browser.newContext({
    viewport: { width, height },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'es-CL',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/* =========================
   Navegar con reintento
   ========================= */
async function safeGoto(page, url) {
  try {
    const r1 = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    if (r1 && r1.ok()) return r1;
  } catch (_) {}
  const r2 = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!r2 || !r2.ok()) throw new Error(`No se pudo cargar la URL`);
  return r2;
}

/* ===============
   0) Health
   =============== */
app.get('/v1/health', (_req, res) => {
  res.json({ ok: true });
});

/* ==========================================
   1) Screenshot (JPEG liviano por defecto)
   ========================================== */
app.post('/v1/screenshot', async (req, res) => {
  const { url, fullPage = false, type = 'jpeg', quality = 60 } = req.body || {};
  if (!url) return res.status(400).json({ code: 'bad_request', message: 'url requerida' });

  try {
    const result = await withPage(async (page) => {
      const resp = await safeGoto(page, url);
      const title = await page.title();
      const buf = await page.screenshot({ fullPage, type, quality });
      return {
        title,
        image_base64: buf.toString('base64'),
        meta: { type, quality, fullPage, status: resp.status() }
      };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ code: 'screenshot_failed', message: String(e?.message || e) });
  }
});

/* ===========================================================
   2) Analyze: tipografías e imágenes distorsionadas
   =========================================================== */
app.post('/v1/analyze', async (req, res) => {
  const { target } = req.body || {};
  if (!target?.value) return res.status(400).json({ code: 'bad_request', message: 'target.value requerido' });

  try {
    const out = await withPage(async (page) => {
      const resp = await safeGoto(page, target.value);

      const fonts = await page.evaluate(() => {
        const normalize = (s) => (s ? s.split(',')[0].trim().replace(/^['"]|['"]$/g, '').toLowerCase() : null);
        const set = new Set();
        for (const el of document.querySelectorAll('*')) {
          const fam = normalize(getComputedStyle(el).fontFamily);
          if (fam) set.add(fam);
        }
        return Array.from(set);
      });

      const distorted = await page.evaluate(() => {
        const THRESHOLD = 0.03;
        const OUT = [];
        for (const img of document.images) {
          const nw = img.naturalWidth, nh = img.naturalHeight, cw = img.clientWidth, ch = img.clientHeight;
          if (!nw || !nh || !cw || !ch) continue;
          const natAR = nw / nh, rendAR = cw / ch;
          const delta = Math.abs(rendAR - natAR) / natAR;
          if (delta > THRESHOLD) {
            OUT.push({ src: img.currentSrc || img.src, deltaPct: (delta * 100).toFixed(1) });
          }
        }
        return OUT;
      });

      const maxFamilies = 3;
      const findings = [];
      if (fonts.length > maxFamilies) {
        findings.push({ id: 'B1', title: 'Demasiadas familias tipográficas', severity: 'medium' });
      }
      for (const d of distorted) {
        findings.push({ id: 'A1', title: 'Imagen posiblemente distorsionada', severity: 'high', evidence: d });
      }

      return {
        score: Math.max(50, 100 - distorted.length * 10 - Math.max(0, fonts.length - maxFamilies) * 5),
        findings,
        meta: { url: target.value, fontsDetected: fonts, distortedImages: distorted.length }
      };
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ code: 'analyze_failed', message: String(e?.message || e) });
  }
});

/* ===============
   Arranque
   =============== */
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () =>
  console.log(`BrandGuard (Playwright) listening on 0.0.0.0:${port}`)
);
