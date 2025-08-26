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
   Navegador “modo humano”
   ========================= */
async function withPage(fn, { width = 1366, height = 768 } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport: { width, height },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'es-CL',
    deviceScaleFactor: 1,
    hasTouch: false,
  });

  // Ocultar bandera de automation
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  await context.setExtraHTTPHeaders({
    'Accept-Language': 'es-CL,es;q=0.9,en;q=0.8',
    'Upgrade-Insecure-Requests': '1',
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
  // 1) Intento “completo”
  try {
    const r1 = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    if (r1 && r1.ok()) return r1;
  } catch (_) { /* ignore */ }

  // 2) Intento “rápido”
  const r2 = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!r2 || !r2.ok()) {
    throw new Error(`No se pudo cargar la URL (status=${r2?.status() ?? 'desconocido'})`);
  }
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
  const {
    url,
    fullPage = false,
    type = 'jpeg',          // jpeg por defecto (más liviano para el GPT)
    quality = 60,           // calidad media
    width = 1280,
    height = 1000,
  } = req.body || {};

  if (!url) return res.status(400).json({ code: 'bad_request', message: 'url requerida' });

  try {
    const result = await withPage(async (page) => {
      await page.setViewportSize({ width, height });
      const resp = await safeGoto(page, url);
      const title = await page.title();
      const buf = await page.screenshot({ fullPage, type, quality });
      return {
        title,
        image_base64: buf.toString('base64'),
        meta: { type, quality, fullPage, width, height, status: resp.status() }
      };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ code: 'screenshot_failed', message: String(e?.message || e) });
  }
});

/* ===========================================================
   2) Analyze: DOM básico + fallback automático a screenshot
   =========================================================== */
app.post('/v1/analyze', async (req, res) => {
  const { target } = req.body || {};
  if (!target?.value) return res.status(400).json({ code: 'bad_request', message: 'target.value requerido' });

  try {
    const out = await withPage(async (page) => {
      const resp = await safeGoto(page, target.value);

      // --- Tipografías (primera familia declarada normalizada)
      const fonts = await page.evaluate(() => {
        const normalize = (s) => (s ? s.split(',')[0].trim().replace(/^['"]|['"]$/g, '').toLowerCase() : null);
        const set = new Set();
        for (const el of document.querySelectorAll('*')) {
          const fam = normalize(getComputedStyle(el).fontFamily);
          if (fam) set.add(fam);
        }
        return Array.from(set);
      });

      // --- Imágenes distorsionadas (proporción render vs natural)
      const distorted = await page.evaluate(() => {
        const THRESHOLD = 0.03; // 3%
        const OUT = [];
        for (const img of document.images) {
          const nw = img.naturalWidth, nh = img.naturalHeight, cw = img.clientWidth, ch = img.clientHeight;
          if (!nw || !nh || !cw || !ch) continue;
          const natAR = nw / nh, rendAR = cw / ch;
          const delta = Math.abs(rendAR - natAR) / natAR;
          if (delta > THRESHOLD) {
            OUT.push({
              src: img.currentSrc || img.src,
              naturalAR: Number(natAR.toFixed(3)),
              renderAR: Number(rendAR.toFixed(3)),
              deltaPct: Number((delta * 100).toFixed(1))
            });
          }
        }
        return OUT;
      });

      // --- Scoring y hallazgos
      const maxFamilies = 3;
      const findings = [];
      if (fonts.length > maxFamilies) {
        findings.push({
          id: 'B1',
          title: 'Demasiadas familias tipográficas',
          severity: 'medium',
          explanation: 'Usar demasiadas familias daña la coherencia de marca.',
          evidence: { families: fonts, total: fonts.length, recomendado: `≤ ${maxFamilies}` }
        });
      }
      for (const d of distorted) {
        findings.push({
          id: 'A1',
          title: 'Imagen posiblemente distorsionada',
          severity: 'high',
          explanation: 'La proporción de la imagen en pantalla difiere de su proporción original.',
          evidence: d
        });
      }

      return {
        score: Math.max(50, 100 - distorted.length * 10 - Math.max(0, fonts.length - maxFamilies) * 5),
        byCategory: {
          typography: fonts.length > maxFamilies ? 70 : 95,
          logos: distorted.length ? 65 : 95
        },
        findings,
        meta: { url: target.value, status: resp.status(), fontsDetected: fonts, distortedImages: distorted.length }
      };
    });

    res.json(out);

  } catch (e) {
    // Fallback: si el DOM fue bloqueado, intenta screenshot para dar evidencia visual
    try {
      const fallback = await withPage(async (page) => {
        await safeGoto(page, target.value);
        const buf = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 60 });
        return buf.toString('base64');
      });
      return res.status(502).json({
        code: 'analyze_blocked',
        message: `La página bloqueó el análisis DOM (${String(e?.message || e)}). Se adjunta mini-captura para auditoría visual.`,
        screenshot_base64: fallback
      });
    } catch (e2) {
      return res.status(500).json({ code: 'analyze_failed', message: String(e2?.message || e2) });
    }
  }
});

/* ===============
   Arranque
   =============== */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`BrandGuardian (Playwright) listening on :${port}`));
