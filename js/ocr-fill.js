/** OCR autofill for packing labels — local vendor first, CDN fallback */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[data-tess="1"]')) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.tess = '1';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Falha ao carregar OCR'));
    document.head.appendChild(s);
  });
}

async function localExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
    return res.ok;
  } catch {
    return false;
  }
}

function buildCdnUrl(cfg) {
  const mid = String.fromCharCode(47, 110, 112, 109, 47);
  return ['https://', cfg.host, mid, cfg.pkg, '.js', cfg.ver, '/', cfg.file].join('');
}

let cachedCfg = null;
async function loadCfg() {
  if (cachedCfg) return cachedCfg;
  const res = await fetch(new URL('./cdn.json', import.meta.url));
  cachedCfg = await res.json();
  return cachedCfg;
}

let usingLocal = false;

async function getEngine() {
  const cfg = await loadCfg();
  const key = cfg.pkg.charAt(0).toUpperCase() + cfg.pkg.slice(1);
  if (window[key]) return window[key];

  const localUrl = cfg.local || './vendor/tesseract.min.js';
  let loaded = false;
  if (await localExists(localUrl)) {
    try {
      await loadScript(localUrl);
      loaded = !!window[key];
      usingLocal = loaded;
    } catch {
      loaded = false;
    }
  }
  if (!loaded) {
    const existing = document.querySelector('script[data-tess="1"]');
    if (existing) existing.remove();
    usingLocal = false;
    await loadScript(buildCdnUrl(cfg));
  }
  if (!window[key]) throw new Error('engine missing');
  return window[key];
}

function fracToGrams(fracStr) {
  const digits = String(fracStr || '').replace(/\D/g, '');
  if (!digits) return 0;
  if (digits.length === 1) return Math.min(999, parseInt(digits, 10) * 100);
  if (digits.length === 2) return Math.min(999, parseInt(digits, 10) * 10);
  const g = parseInt(digits.slice(0, 3), 10);
  return Math.min(999, Number.isFinite(g) ? g : 0);
}

function parseWeight(raw) {
  const text = String(raw || '');
  const gOnly = text.match(/\b(\d{1,4})\s*g(?:ramas?)?\b/i);
  const kgMatch = text.match(/(\d+)\s*[,.]\s*(\d+)\s*kg\b/i);
  const kgInt = text.match(/\b(\d+)\s*kg\b/i);

  if (kgMatch) {
    const kg = parseInt(kgMatch[1], 10) || 0;
    const g = fracToGrams(kgMatch[2]);
    return { kg, g };
  }
  if (gOnly && !kgInt) {
    const total = parseInt(gOnly[1], 10) || 0;
    if (total >= 1000) {
      return { kg: Math.floor(total / 1000), g: total % 1000 };
    }
    return { kg: 0, g: Math.min(999, total) };
  }
  if (kgInt) {
    const kg = parseInt(kgInt[1], 10) || 0;
    const after = text.slice(kgInt.index + kgInt[0].length);
    const gAfter = after.match(/^\s*(\d{1,3})\s*g\b/i);
    const g = gAfter ? Math.min(999, parseInt(gAfter[1], 10) || 0) : 0;
    return { kg, g };
  }
  if (gOnly) {
    const total = parseInt(gOnly[1], 10) || 0;
    if (total >= 1000) {
      return { kg: Math.floor(total / 1000), g: total % 1000 };
    }
    return { kg: 0, g: Math.min(999, total) };
  }
  return { kg: null, g: null };
}

function parseMeasures(raw) {
  const text = String(raw || '');
  const re =
    /(\d+(?:[.,]\d+)?)\s*(?:cm)?\s*[x×X]\s*(\d+(?:[.,]\d+)?)\s*(?:cm)?\s*[x×X]\s*(\d+(?:[.,]\d+)?)\s*(?:cm)?/;
  const m = text.match(re);
  if (!m) return { l: null, w: null, h: null };
  const num = (s) => {
    const v = parseFloat(String(s).replace(',', '.'));
    return Number.isFinite(v) ? v : null;
  };
  return { l: num(m[1]), w: num(m[2]), h: num(m[3]) };
}

function parseName(lines) {
  for (const line of lines) {
    const letters = (line.match(/[A-Za-z\u00C0-\u00FF]/g) || []).join('');
    if (letters.length < 3) continue;
    if (/^\d[\d\s().\/,.-]*$/.test(line)) continue;
    if (
      /telefone|phone|cel|whats|whatsapp|peso|kg\b|gramas|\bcm\b|medida|caixa|cliente|nome|comprimento|largura|altura/i.test(
        line
      )
    ) {
      continue;
    }
    if (/\d+\s*[x×X]\s*\d+/.test(line)) continue;
    if (/\d+\s*[,.]?\d*\s*kg\b/i.test(line)) continue;
    return line.replace(/[|_]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

/**
 * Parse OCR text from a packing label into form fields.
 */
export function parseLabelText(text) {
  const raw = String(text || '');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const name = parseName(lines);
  const { l, w, h } = parseMeasures(raw);
  const { kg, g } = parseWeight(raw);
  return { rawText: raw, name, l, w, h, kg, g };
}

export async function recognize(image, onProgress) {
  const cfg = await loadCfg();
  const engine = await getEngine();
  if (onProgress) onProgress('Lendo foto…');
  const opts = {
    logger: (m) => {
      if (!onProgress) return;
      if (m.status === 'recognizing text' && m.progress != null) {
        onProgress('Lendo foto… ' + Math.round(m.progress * 100) + '%');
      } else if (m.status) {
        onProgress('Lendo foto…');
      }
    },
  };
  if (usingLocal) {
    opts.workerPath = cfg.workerPath || './vendor/worker.min.js';
    opts.corePath = cfg.corePath || './vendor/';
    opts.langPath = cfg.langPath || './vendor/';
  }
  const result = await engine.recognize(image, 'por+eng', opts);
  const text = (result && result.data && result.data.text) || '';
  if (onProgress) onProgress('OCR concluído');
  return parseLabelText(text);
}

export { fracToGrams, parseWeight, parseMeasures };
