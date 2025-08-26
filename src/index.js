import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

// Utilidad: abrir Chromium, ejecutar una función y cerrar
async function withPage(fn, { width = 1440, height = 900 } = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

// 0) Health
app.get('/v1/health', (req, res) => {
  res.json({ ok: true });
});


// 1) Screenshot de una URL (devuelve PNG en base64)
app.post('/v1/screenshot', async (req, res) => {
  const { url, fullPage = true } = req.body || {};
  if (!url) return res.status(400).json({ code: 'bad_request', message: 'url requerida' });
  try {
    const result = await withPage(async (page) => {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (!resp || !resp.ok()) throw new Error(`No se pudo cargar la URL`);
      const title = await page.title();
      const png = await page.screenshot({ fullPage });
      const b64 = png.toString('base64');
      return { title, image_base64: b64 };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ code: 'screenshot_failed', message: String(e?.message || e) });
  }
});

// 2) Analyze básico: tipografías y imágenes estiradas por CSS
app.post('/v1/analyze', async (req, res) => {
  const { target } = req.body || {};
  if (!target?.value) return res.status(400).json({ code: 'bad_request', message: 'target.value requerido' });
  try {
    const out = await withPage(async (page) => {
      const resp = await page.goto(target.value, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (!resp || !resp.ok()) throw new Error(`No se pudo cargar la URL`);

      // Tipografías (primera familia declarada)
      const fonts = await page.evaluate(() => {
        const normalize = (s) => (s ? s.split(',')[0].trim().replace(/^['"]|['"]$/g, '').toLowerCase() : null);
        const set = new Set();
        for (const el of document.querySelectorAll('*')) {
          const fam = normalize(getComputedStyle(el).fontFamily);
          if (fam) set.add(fam);
        }
        return Array.from(set);
      });

      // Imágenes distorsionadas (aspect ratio render vs original)
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

      // Resultado simple
      const maxFamilies = 3;
      const findings = [];
      if (fonts.length > maxFamilies) {
        findings.push({
          id: 'B1',
          title: 'Demasiadas familias tipográficas',
          severity: 'medium',
          evidence: { families: fonts, total: fonts.length, recomendado: `≤ ${maxFamilies}` }
        });
      }
      for (const d of distorted) {
        findings.push({
          id: 'A1',
          title: 'Imagen posiblemente distorsionada',
          severity: 'high',
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
        meta: { url: target.value, fontsDetected: fonts, distortedImages: distorted.length }
      };
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ code: 'analyze_failed', message: String(e?.message || e) });
  }
});

// Arranque
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`BrandGuardian (Playwright) listening on :${port}`));
