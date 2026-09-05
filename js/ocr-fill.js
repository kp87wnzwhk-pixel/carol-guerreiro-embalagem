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

/** Normalize OCR digit confusions in number contexts: O→0, l/I→1 */
function fixOcrDigits(s) {
  return String(s || '')
    .replace(/[Oo]/g, '0')
    .replace(/[lI|]/g, '1');
}

function fracToGrams(fracStr) {
  const digits = String(fracStr || '').replace(/\D/g, '');
  if (!digits) return 0;
  if (digits.length === 1) return Math.min(999, parseInt(digits, 10) * 100);
  if (digits.length === 2) return Math.min(999, parseInt(digits, 10) * 10);
  // 3+ digits: take first 3 as grams (pad already exact for 3)
  const g = parseInt(digits.slice(0, 3), 10);
  return Math.min(999, Number.isFinite(g) ? g : 0);
}

/** Fraction digits as grams: pad/truncate to 3 (3.075→75g, 3.600→600g, 3.5→500g) */
function fractionDigitsToGrams(fracStr) {
  let digits = String(fracStr || '').replace(/\D/g, '');
  if (!digits) return 0;
  if (digits.length === 1) digits = digits + '00';
  else if (digits.length === 2) digits = digits + '0';
  else digits = digits.slice(0, 3);
  const g = parseInt(digits, 10);
  return Math.min(999, Number.isFinite(g) ? g : 0);
}

const UNIT_KG = '(?:kg|kq|k9|kgs)';
const UNIT_G = '(?:g|gr|gramas?)';

/**
 * Parse weight from OCR text.
 * Handles: "Kg 3.075", "KG 3.600", "2,705" alone, "1,240 kg", "1240g", OCR kg→kq/k9.
 */
function parseWeight(raw) {
  const text = String(raw || '');

  // Unit BEFORE number: Kg 3.075 / KG 3.600 / kg 3,075
  const kgBeforeDec = text.match(
    new RegExp(`\\b${UNIT_KG}\\s*(\\d+)\\s*[,.]\\s*(\\d+)\\b`, 'i')
  );
  if (kgBeforeDec) {
    const kg = parseInt(kgBeforeDec[1], 10) || 0;
    const g = fractionDigitsToGrams(kgBeforeDec[2]);
    return { kg, g };
  }
  const kgBeforeInt = text.match(new RegExp(`\\b${UNIT_KG}\\s*(\\d+)\\b`, 'i'));
  if (kgBeforeInt) {
    return { kg: parseInt(kgBeforeInt[1], 10) || 0, g: 0 };
  }

  // Weight alone on a line: 2,705 or 2.705 (1–2 int digits + exactly 3 frac = kg+g)
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const alone = line.match(/^\s*(\d{1,2})[,.](\d{3})\s*$/);
    if (alone) {
      return {
        kg: parseInt(alone[1], 10) || 0,
        g: Math.min(999, parseInt(alone[2], 10) || 0),
      };
    }
  }

  // Number THEN unit: 1,240 kg / 1.240kg / 0,5 kg
  const kgAfterDec = text.match(
    new RegExp(`(\\d+)\\s*[,.]\\s*(\\d+)\\s*${UNIT_KG}\\b`, 'i')
  );
  if (kgAfterDec) {
    const kg = parseInt(kgAfterDec[1], 10) || 0;
    const g = fractionDigitsToGrams(kgAfterDec[2]);
    return { kg, g };
  }

  const kgIntRe = new RegExp(`\\b(\\d+)\\s*${UNIT_KG}\\b`, 'i');
  const gOnlyRe = new RegExp(`\\b(\\d{1,4})\\s*${UNIT_G}\\b`, 'i');
  const kgInt = text.match(kgIntRe);
  const gOnly = text.match(gOnlyRe);

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
    const gAfter = after.match(new RegExp(`^\\s*(\\d{1,3})\\s*${UNIT_G}\\b`, 'i'));
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

function inMeasureRange(n) {
  return Number.isFinite(n) && n >= 1 && n <= 200;
}

function parseThreeNums(a, b, c) {
  const num = (s) => {
    const fixed = fixOcrDigits(String(s).replace(',', '.'));
    const v = parseFloat(fixed);
    return Number.isFinite(v) ? v : null;
  };
  const l = num(a);
  const w = num(b);
  const h = num(c);
  if (!inMeasureRange(l) || !inMeasureRange(w) || !inMeasureRange(h)) {
    return { l: null, w: null, h: null };
  }
  return { l, w, h };
}

/**
 * Parse L×W×H: 10x10x10, 15 X 10 X 06 (leading zero → 6), dashes/slashes, spaced ints.
 */
function parseMeasures(raw) {
  const text = String(raw || '');

  const labeled = text.match(
    /(?:C|Comp(?:rimento)?)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(?:cm)?\s*(?:L|Larg(?:ura)?)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(?:cm)?\s*(?:A|Alt(?:ura)?)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(?:cm)?/i
  );
  if (labeled) {
    const r = parseThreeNums(labeled[1], labeled[2], labeled[3]);
    if (r.l != null) return r;
  }

  // 10x10x10, 15 X 10 X 06 (allow leading zeros via parseFloat → 6)
  const xSep = text.match(
    /(\d+(?:[.,]\d+)?)\s*(?:cm)?\s*[x×X]\s*(\d+(?:[.,]\d+)?)\s*(?:cm)?\s*[x×X]\s*(\d+(?:[.,]\d+)?)\s*(?:cm)?/
  );
  if (xSep) {
    const r = parseThreeNums(xSep[1], xSep[2], xSep[3]);
    if (r.l != null) return r;
  }

  const dashSlash = text.match(
    /(\d+(?:[.,]\d+)?)\s*(?:cm)?\s*[-/]\s*(\d+(?:[.,]\d+)?)\s*(?:cm)?\s*[-/]\s*(\d+(?:[.,]\d+)?)\s*(?:cm)?/
  );
  if (dashSlash) {
    const r = parseThreeNums(dashSlash[1], dashSlash[2], dashSlash[3]);
    if (r.l != null) return r;
  }

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const spaced = line.match(
      /(?:^|[^\d.])(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:[^\d.]|$)/
    );
    if (spaced) {
      const r = parseThreeNums(spaced[1], spaced[2], spaced[3]);
      if (r.l != null) return r;
    }
  }

  const fixed = fixOcrDigits(text);
  if (fixed !== text) {
    const again = fixed.match(
      /(\d+(?:[.,]\d+)?)\s*(?:cm)?\s*[x×X]\s*(\d+(?:[.,]\d+)?)\s*(?:cm)?\s*[x×X]\s*(\d+(?:[.,]\d+)?)/
    );
    if (again) {
      const r = parseThreeNums(again[1], again[2], again[3]);
      if (r.l != null) return r;
    }
  }

  return { l: null, w: null, h: null };
}

/**
 * Brazilian mobile: (DD) 9XXXX-XXXX or variants → digits string / formatted later.
 */
function parsePhone(raw) {
  const text = String(raw || '');
  // (41) 9838-6262, (15) 98107-4752, (21) 97214-8504
  const m = text.match(
    /\(?\s*(\d{2})\s*\)?\s*(\d{4,5})\s*[-.\s]?\s*(\d{4})\b/
  );
  if (!m) return '';
  const ddd = m[1];
  const p1 = m[2];
  const p2 = m[3];
  const digits = ddd + p1 + p2;
  if (digits.length < 10 || digits.length > 11) return '';
  // Prefer mobile (9 digits after DDD) or landline 8
  return digits;
}

const VOWELS = /[AEIOUÁÉÍÓÚÂÊÔÃÕÀaeiouáéíóúâêôãõà]/g;

function stripNameLabel(line) {
  return String(line || '')
    .replace(/^(?:nome|cliente|destinat[aá]rio|comprador)\s*[:\-–]\s*/i, '')
    .replace(/[|_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAllCapsShortCode(line, letters) {
  const words = line.trim().split(/\s+/).filter(Boolean);
  const allCaps = letters === letters.toUpperCase() && /[A-ZÀ-Ý]/.test(letters);
  return allCaps && words.length <= 2 && letters.length <= 8;
}

function mostlyConsonantNoise(letters) {
  if (letters.length < 3) return true;
  const upper = letters.toUpperCase();
  const vowelCount = (upper.match(VOWELS) || []).length;
  if (vowelCount === 0) return true;
  const ratio = vowelCount / upper.length;
  // OCR garbage like "PREF EC" — keep real names (Ligia, Roberto)
  return ratio < 0.15 && upper.length <= 10;
}

function looksSkuOrBarcode(line, letters) {
  if (/^\d[\d\s().\/,.-]*$/.test(line)) return true;
  if (/\bpref\b/i.test(line)) return true;
  if (/^(?:sku|cod(?:igo)?|ref|ean|upc)\b/i.test(line)) return true;
  const digits = (line.match(/\d/g) || []).length;
  if (digits >= 8 && letters.length <= 4) return true;
  return false;
}

function isSkipNameLine(line) {
  if (/locker|arm[aá]rio|\bn[ºo°]\b|\bnr\b/i.test(line)) return true;
  if (/telefone|phone|cel|whats|whatsapp|peso|\bkg\b|\bkq\b|gramas|\bcm\b|medida|caixa|comprimento|largura|altura|endere[cç]o|\bcep\b|volume/i.test(line)) {
    return true;
  }
  // Phone-looking line
  if (/\(?\s*\d{2}\s*\)?\s*\d{4,5}/.test(line)) return true;
  return false;
}

function scoreNameLine(rawLine) {
  const line = stripNameLabel(rawLine);
  if (!line) return { score: 0, name: '' };

  const letters = (line.match(/[A-Za-z\u00C0-\u00FF]/g) || []).join('');
  const words = line.split(/\s+/).filter(Boolean);
  const letterWords = words.filter((w) => /^[A-Za-z\u00C0-\u00FF]/.test(w));

  if (letters.length < 3) return { score: 0, name: line };
  if (looksSkuOrBarcode(line, letters)) return { score: 0, name: line };
  if (isSkipNameLine(line)) return { score: 0, name: line };
  if (/\d+\s*[x×X\-\/]\s*\d+/.test(line)) return { score: 0, name: line };
  if (new RegExp(`\\d+\\s*[,.]?\\d*\\s*${UNIT_KG}\\b`, 'i').test(line)) {
    return { score: 0, name: line };
  }
  if (new RegExp(`\\b${UNIT_KG}\\s*\\d`, 'i').test(line)) {
    return { score: 0, name: line };
  }
  if (isAllCapsShortCode(line, letters)) return { score: 5, name: line };
  if (mostlyConsonantNoise(letters)) return { score: 8, name: line };

  let score = 10;
  if (letterWords.length >= 2 && letters.length >= 6) score += 40;
  else if (letterWords.length >= 2) score += 25;
  else if (letterWords.length === 1 && letters.length >= 4) score += 35; // Ligia, Roberto
  else if (letters.length >= 6) score += 15;
  else score += 5;

  if (letters.length >= 10) score += 10;
  if (letters.length >= 16) score += 5;

  const hasLower = /[a-z\u00E0-\u00FF]/.test(line);
  const hasUpper = /[A-Z\u00C0-\u00DD]/.test(line);
  if (hasLower && hasUpper) score += 12;
  else if (hasLower) score += 8;
  else if (letterWords.length === 1 && letters.length >= 4) score += 10; // single capitalized name

  const digits = (line.match(/\d/g) || []).length;
  if (digits > 0) score -= digits * 3;

  const cleaned = line.replace(/^(?:nome|cliente)\s+/i, '').trim() || line;
  return { score: Math.max(0, score), name: cleaned };
}

const NAME_SCORE_MIN = 30;

function parseName(lines) {
  let best = { score: 0, name: '' };
  for (const line of lines) {
    const cand = scoreNameLine(line);
    if (cand.score > best.score) best = cand;
  }
  if (best.score < NAME_SCORE_MIN) {
    return { name: '', nameScore: best.score, nameRejected: best.name || '' };
  }
  return { name: best.name, nameScore: best.score, nameRejected: '' };
}

/**
 * Parse OCR text from a packing label into form fields.
 * Always exports rawText.
 */
export function parseLabelText(text) {
  const raw = String(text || '');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const { name, nameScore, nameRejected } = parseName(lines);
  const { l, w, h } = parseMeasures(raw);
  const { kg, g } = parseWeight(raw);
  const phone = parsePhone(raw);
  return { rawText: raw, name, nameScore, nameRejected, phone, l, w, h, kg, g };
}

/**
 * Draw image to canvas: max width 1600, grayscale + contrast boost.
 * Returns a PNG Blob for Tesseract.
 */
export async function preprocessImage(blobOrFile) {
  const blob = blobOrFile;
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Falha ao carregar imagem'));
      el.src = url;
    });
    const maxW = 1600;
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error('Imagem inválida');
    if (w > maxW) {
      h = Math.round((h * maxW) / w);
      w = maxW;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const d = imageData.data;
    const contrast = 1.45;
    const intercept = 128 * (1 - contrast);
    for (let i = 0; i < d.length; i += 4) {
      let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      g = contrast * g + intercept;
      if (g < 0) g = 0;
      else if (g > 255) g = 255;
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(imageData, 0, 0);
    const out = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
        'image/png'
      );
    });
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function isParsedEmpty(parsed) {
  return (
    !parsed.name &&
    !parsed.phone &&
    parsed.l == null &&
    parsed.w == null &&
    parsed.h == null &&
    parsed.kg == null &&
    parsed.g == null
  );
}

async function runRecognize(engine, image, lang, opts, onProgress) {
  const result = await engine.recognize(image, lang, {
    ...opts,
    logger: (m) => {
      if (!onProgress) return;
      if (m.status === 'recognizing text' && m.progress != null) {
        onProgress('Lendo foto… ' + Math.round(m.progress * 100) + '%');
      } else if (m.status) {
        onProgress('Lendo foto…');
      }
    },
  });
  return (result && result.data && result.data.text) || '';
}

export async function recognize(image, onProgress) {
  const cfg = await loadCfg();
  const engine = await getEngine();
  if (onProgress) onProgress('Preparando imagem…');

  let prepared = image;
  try {
    prepared = await preprocessImage(image);
  } catch (err) {
    console.warn('preprocess failed, using original', err);
    prepared = image;
  }

  const opts = {};
  if (usingLocal) {
    opts.workerPath = cfg.workerPath || './vendor/worker.min.js';
    opts.corePath = cfg.corePath || './vendor/';
    opts.langPath = cfg.langPath || './vendor/';
  }
  opts.tessedit_pageseg_mode = '6';
  opts.preserve_interword_spaces = '1';

  if (onProgress) onProgress('Lendo foto…');
  let text = await runRecognize(engine, prepared, 'por', opts, onProgress);
  let parsed = parseLabelText(text);

  if (isParsedEmpty(parsed)) {
    if (onProgress) onProgress('Tentando outro idioma…');
    text = await runRecognize(engine, prepared, 'eng', opts, onProgress);
    parsed = parseLabelText(text);
  }

  if (!parsed.rawText) parsed.rawText = text || '';
  if (onProgress) onProgress('OCR concluído');
  return parsed;
}

export {
  fracToGrams,
  fractionDigitsToGrams,
  parseWeight,
  parseMeasures,
  parseName,
  parsePhone,
  scoreNameLine,
  NAME_SCORE_MIN,
  fixOcrDigits,
};
