/**
 * Persistência local de registros de embalagem (localStorage).
 */
import { STORAGE_KEYS } from './config.js';

export function phoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

export function formatPhoneBR(value) {
  let d = phoneDigits(value).slice(0, 11);
  if (d.length === 0) return '';
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  }
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export function waLink(phone, name) {
  let d = phoneDigits(phone);
  if (d.startsWith('55') && d.length >= 12) {
    /* already with country */
  } else if (d.length >= 10 && d.length <= 11) {
    d = '55' + d;
  }
  const text = encodeURIComponent(
    `Olá ${name || ''}, aqui é da Carol Guerreiro Importado.`
  );
  return `https://wa.me/${d}?text=${text}`;
}

/** Peso total em gramas a partir de kg + g */
export function weightToGrams(kg, g) {
  const k = Math.max(0, Number(kg) || 0);
  const grams = Math.min(999, Math.max(0, Math.floor(Number(g) || 0)));
  return Math.round(k * 1000) + grams;
}

export function gramsToKgG(totalGrams) {
  const t = Math.max(0, Math.floor(Number(totalGrams) || 0));
  return { kg: Math.floor(t / 1000), g: t % 1000 };
}

export function formatWeight(totalGrams) {
  const { kg, g } = gramsToKgG(totalGrams);
  if (kg === 0 && g === 0) return '0 g';
  if (kg === 0) return `${g} g`;
  if (g === 0) return `${kg} kg`;
  return `${kg} kg ${g} g`;
}

export function formatMeasures(r) {
  const L = Number(r.measureL);
  const W = Number(r.measureW);
  const H = Number(r.measureH);
  const parts = [];
  if (!Number.isNaN(L)) parts.push(`${L}`);
  if (!Number.isNaN(W)) parts.push(`${W}`);
  if (!Number.isNaN(H)) parts.push(`${H}`);
  if (!parts.length) return '—';
  return parts.join(' × ') + ' cm';
}

export function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || crypto.randomUUID());
  let weightGrams = raw.weightGrams;
  if (weightGrams == null) {
    weightGrams = weightToGrams(raw.weightKg, raw.weightG);
  }
  weightGrams = Math.max(0, Math.floor(Number(weightGrams) || 0));
  const now = new Date().toISOString();
  return {
    id,
    clientName: String(raw.clientName || '').trim(),
    phone: formatPhoneBR(raw.phone || ''),
    measureL: Number(raw.measureL) || 0,
    measureW: Number(raw.measureW) || 0,
    measureH: Number(raw.measureH) || 0,
    weightGrams,
    notes: String(raw.notes || '').trim(),
    createdBy: String(raw.createdBy || '').trim(),
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
    photoCount: Number(raw.photoCount) || 0,
  };
}

export function loadRecords() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.records);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(normalizeRecord).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveRecords(records) {
  const cleaned = (records || []).map(normalizeRecord).filter(Boolean);
  localStorage.setItem(STORAGE_KEYS.records, JSON.stringify(cleaned));
  return cleaned;
}

export function searchRecords(records, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return records.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const qd = phoneDigits(q);
  return records
    .filter((r) => {
      const name = (r.clientName || '').toLowerCase();
      const phone = phoneDigits(r.phone);
      if (name.includes(q)) return true;
      if (qd && phone.includes(qd)) return true;
      return false;
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function formatDateBR(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function getEffectivePin(defaultPin) {
  try {
    const ov = localStorage.getItem(STORAGE_KEYS.pinOverride);
    if (ov != null && String(ov).length > 0) return String(ov);
  } catch (_) {}
  return String(defaultPin);
}

export function setPinOverride(pin) {
  localStorage.setItem(STORAGE_KEYS.pinOverride, String(pin));
}

export function clearPinOverride() {
  localStorage.removeItem(STORAGE_KEYS.pinOverride);
}

export function isSessionUnlocked() {
  try {
    return sessionStorage.getItem(STORAGE_KEYS.sessionUnlock) === '1';
  } catch {
    return false;
  }
}

export function setSessionUnlocked(yes) {
  try {
    if (yes) sessionStorage.setItem(STORAGE_KEYS.sessionUnlock, '1');
    else sessionStorage.removeItem(STORAGE_KEYS.sessionUnlock);
  } catch (_) {}
}

export function getSavedNickname() {
  try {
    return localStorage.getItem(STORAGE_KEYS.nickname) || '';
  } catch {
    return '';
  }
}

export function setSavedNickname(name) {
  try {
    localStorage.setItem(STORAGE_KEYS.nickname, String(name || '').trim());
  } catch (_) {}
}
