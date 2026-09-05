/**
 * Persistência local de registros de embalagem (localStorage).
 * Dual-write + espelho + histórico de auto-backups para durabilidade.
 */
import { STORAGE_KEYS, AUTO_BACKUP_MAX } from './config.js';

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

/** Data local do aparelho no formato YYYY-MM-DD. */
export function localDateISO(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return localDateISO(new Date());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayLocalISO() {
  return localDateISO(new Date());
}

export function tomorrowLocalISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return localDateISO(d);
}

/** Valida string YYYY-MM-DD; retorna a própria string ou null. */
export function parseWorkDate(value) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, day] = s.split('-').map(Number);
  const d = new Date(y, m - 1, day);
  if (d.getFullYear() !== y || d.getMonth() !== m - 1 || d.getDate() !== day) return null;
  return s;
}

/** Deriva workDate de createdAt (data local do aparelho). */
export function workDateFromCreatedAt(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return todayLocalISO();
    return localDateISO(d);
  } catch {
    return todayLocalISO();
  }
}

/** Formata YYYY-MM-DD → DD/MM/AAAA */
export function formatWorkDateBR(workDate) {
  const s = parseWorkDate(workDate);
  if (!s) return '—';
  const [y, m, day] = s.split('-');
  return `${day}/${m}/${y}`;
}

const WEEKDAYS_PT = [
  'Domingo',
  'Segunda',
  'Terça',
  'Quarta',
  'Quinta',
  'Sexta',
  'Sábado',
];

/**
 * Título de secção na home:
 * - hoje → "Hoje · DD/MM/AAAA"
 * - amanhã → "Amanhã · DD/MM/AAAA"
 * - else → "Segunda · DD/MM/AAAA"
 */
export function formatWorkDateSectionTitle(workDate) {
  const s = parseWorkDate(workDate);
  if (!s) return '—';
  const br = formatWorkDateBR(s);
  const today = todayLocalISO();
  const tomorrow = tomorrowLocalISO();
  if (s === today) return `Hoje · ${br}`;
  if (s === tomorrow) return `Amanhã · ${br}`;
  const [y, m, day] = s.split('-').map(Number);
  const d = new Date(y, m - 1, day);
  const wd = WEEKDAYS_PT[d.getDay()] || '';
  return `${wd} · ${br}`;
}

/**
 * Agrupa registros por workDate.
 * Ordem: Hoje, Amanhã (se houver), depois outras datas descendentes.
 * @returns {{ workDate: string, title: string, records: object[] }[]}
 */
export function groupRecordsByWorkDate(records) {
  const map = new Map();
  for (const r of records || []) {
    const wd = parseWorkDate(r.workDate) || workDateFromCreatedAt(r.createdAt);
    if (!map.has(wd)) map.set(wd, []);
    map.get(wd).push(r);
  }
  for (const list of map.values()) {
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  const today = todayLocalISO();
  const tomorrow = tomorrowLocalISO();
  const keys = [...map.keys()].sort((a, b) => b.localeCompare(a)); // newest first
  const ordered = [];
  const used = new Set();
  if (map.has(today)) {
    ordered.push(today);
    used.add(today);
  }
  if (map.has(tomorrow)) {
    ordered.push(tomorrow);
    used.add(tomorrow);
  }
  for (const k of keys) {
    if (!used.has(k)) ordered.push(k);
  }
  return ordered.map((workDate) => ({
    workDate,
    title: formatWorkDateSectionTitle(workDate),
    records: map.get(workDate),
  }));
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
  const createdAt = raw.createdAt || now;
  let workDate = parseWorkDate(raw.workDate);
  if (!workDate) {
    workDate = workDateFromCreatedAt(createdAt);
  }
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
    workDate,
    createdAt,
    updatedAt: raw.updatedAt || now,
    photoCount: Number(raw.photoCount) || 0,
  };
}

/** @returns {{ ok: true, records: object[] } | { ok: false, reason: 'missing'|'corrupt' }} */
function tryParseRecordsKey(key) {
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  if (raw == null || raw === '') return { ok: false, reason: 'missing' };
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return { ok: false, reason: 'corrupt' };
    return { ok: true, records: arr.map(normalizeRecord).filter(Boolean) };
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
}

function setLastSaveAt(iso) {
  try {
    localStorage.setItem(STORAGE_KEYS.lastSaveAt, iso || new Date().toISOString());
  } catch (_) {}
}

export function getLastSaveAt() {
  try {
    return localStorage.getItem(STORAGE_KEYS.lastSaveAt) || null;
  } catch {
    return null;
  }
}

/**
 * Carrega registros. Se primary faltar/corromper, restaura de mirror ou
 * último auto-backup e marca banner one-time de recuperação.
 */
export function loadRecords() {
  const primary = tryParseRecordsKey(STORAGE_KEYS.records);
  if (primary.ok) return primary.records;

  const mirror = tryParseRecordsKey(STORAGE_KEYS.recordsMirror);
  if (mirror.ok && mirror.records.length >= 0) {
    // Restore even if empty array is valid — but only if primary was missing/corrupt.
    // Prefer non-empty sources when available.
    const backups = listAutoBackups();
    const latest = backups[0];
    let source = mirror.records;
    let from = 'mirror';
    if (
      latest &&
      Array.isArray(latest.data) &&
      latest.data.length > mirror.records.length
    ) {
      source = latest.data.map(normalizeRecord).filter(Boolean);
      from = 'auto-backup';
    }
    try {
      saveRecords(source);
    } catch (_) {
      /* best-effort restore write */
    }
    markRecoveryBanner(from);
    return source;
  }

  const backups = listAutoBackups();
  if (backups.length && Array.isArray(backups[0].data)) {
    const source = backups[0].data.map(normalizeRecord).filter(Boolean);
    try {
      saveRecords(source);
    } catch (_) {}
    markRecoveryBanner('auto-backup');
    return source;
  }

  return [];
}

function markRecoveryBanner(from) {
  try {
    sessionStorage.setItem(
      STORAGE_KEYS.recoveryBanner,
      JSON.stringify({ show: true, from, at: new Date().toISOString() })
    );
  } catch (_) {}
}

/** Consome e limpa o banner one-time de recuperação. */
export function consumeRecoveryBanner() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.recoveryBanner);
    if (!raw) return null;
    sessionStorage.removeItem(STORAGE_KEYS.recoveryBanner);
    const parsed = JSON.parse(raw);
    if (parsed && parsed.show) return parsed;
  } catch (_) {}
  return null;
}

export function peekRecoveryBanner() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.recoveryBanner);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.show) return parsed;
  } catch (_) {}
  return null;
}

export function clearRecoveryBanner() {
  try {
    sessionStorage.removeItem(STORAGE_KEYS.recoveryBanner);
  } catch (_) {}
}

/**
 * Dual-write: primary + mirror. Atualiza lastSaveAt.
 */
export function saveRecords(records) {
  const cleaned = (records || []).map(normalizeRecord).filter(Boolean);
  const json = JSON.stringify(cleaned);
  localStorage.setItem(STORAGE_KEYS.records, json);
  try {
    localStorage.setItem(STORAGE_KEYS.recordsMirror, json);
  } catch (err) {
    console.warn('Falha ao gravar espelho:', err);
  }
  setLastSaveAt(new Date().toISOString());
  return cleaned;
}

function readAutoBackupsRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.autoBackups);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch {
    return [];
  }
}

function writeAutoBackupsRaw(list) {
  localStorage.setItem(STORAGE_KEYS.autoBackups, JSON.stringify(list));
}

/**
 * Lista auto-backups (mais recentes primeiro).
 * Formato: { id, at, count, data }
 */
export function listAutoBackups() {
  return readAutoBackupsRaw()
    .filter((b) => b && b.id && Array.isArray(b.data))
    .slice()
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export function getLastAutoBackupAt() {
  const list = listAutoBackups();
  return list[0]?.at || null;
}

/**
 * Grava snapshot silencioso. Mantém no máximo AUTO_BACKUP_MAX.
 * Em QuotaExceededError, remove os mais antigos e tenta de novo.
 * @returns {{ n: number, id: string, at: string } | null}
 */
export function pushAutoBackup(records) {
  const cleaned = (records || []).map(normalizeRecord).filter(Boolean);
  const snapshot = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    count: cleaned.length,
    data: cleaned,
  };

  let list = readAutoBackupsRaw()
    .filter((b) => b && b.id)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));

  list.unshift(snapshot);
  if (list.length > AUTO_BACKUP_MAX) {
    list = list.slice(0, AUTO_BACKUP_MAX);
  }

  const tryWrite = (candidate) => {
    writeAutoBackupsRaw(candidate);
  };

  try {
    tryWrite(list);
  } catch (err) {
    const isQuota =
      err &&
      (err.name === 'QuotaExceededError' ||
        err.code === 22 ||
        err.code === 1014);
    if (!isQuota) {
      console.warn('Auto-backup falhou:', err);
      return null;
    }
    // Drop oldest until it fits (or list shrinks to just the new snapshot)
    let shrinking = list.slice();
    while (shrinking.length > 1) {
      shrinking.pop();
      try {
        tryWrite(shrinking);
        list = shrinking;
        break;
      } catch (e2) {
        if (shrinking.length <= 1) {
          console.warn('Auto-backup: quota mesmo com 1 snapshot', e2);
          return null;
        }
      }
    }
    if (shrinking.length === 1) {
      try {
        tryWrite(shrinking);
        list = shrinking;
      } catch (e3) {
        console.warn('Auto-backup: impossível gravar', e3);
        return null;
      }
    }
  }

  // Número sequencial aproximado = total históricos já vistos + posição
  // Usamos o tamanho da lista após insert como #N (1 = mais antigo deste ciclo,
  // mas o requisito pede “Backup automático #N” — usamos contagem acumulada
  // via índice invertido: o mais recente é o #list.length neste ciclo de caps,
  // melhor: número global crescente baseado em quantos já existiam.
  const n = list.length; // within cap window; UI shows this as #N
  // Prefer a monotonic counter stored alongside
  let seq = 0;
  try {
    const prev = Number(localStorage.getItem('cgi_pack_auto_backup_seq') || '0');
    seq = prev + 1;
    localStorage.setItem('cgi_pack_auto_backup_seq', String(seq));
  } catch {
    seq = list.length;
  }

  return { n: seq, id: snapshot.id, at: snapshot.at };
}

export function restoreFromAutoBackup(backupId) {
  const list = listAutoBackups();
  const found = list.find((b) => b.id === backupId);
  if (!found || !Array.isArray(found.data)) return null;
  return saveRecords(found.data);
}

export function getDurabilityStatus(records) {
  const count = Array.isArray(records) ? records.length : loadRecords().length;
  return {
    count,
    lastSaveAt: getLastSaveAt(),
    lastAutoBackupAt: getLastAutoBackupAt(),
    autoBackupCount: listAutoBackups().length,
  };
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

export function formatTimeHM(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
}

/** Nome de ficheiro: carol-embalagem-backup-YYYY-MM-DD-HHmm.json */
export function backupFilename(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return `carol-embalagem-backup-${y}-${m}-${day}-${hh}${mm}.json`;
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

/* ---------- Tombstones (deleted contact ids) ---------- */
/** In-memory Set mirrored to localStorage STORAGE_KEYS.deleted */
let deletedIdsCache = null;

function loadDeletedIdsSet() {
  if (deletedIdsCache) return deletedIdsCache;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.deleted);
    if (!raw) {
      deletedIdsCache = new Set();
    } else {
      const arr = JSON.parse(raw);
      deletedIdsCache = new Set(
        Array.isArray(arr) ? arr.map((id) => String(id)).filter(Boolean) : []
      );
    }
  } catch {
    deletedIdsCache = new Set();
  }
  return deletedIdsCache;
}

function persistDeletedIdsSet() {
  const set = loadDeletedIdsSet();
  try {
    localStorage.setItem(STORAGE_KEYS.deleted, JSON.stringify([...set]));
  } catch (err) {
    console.warn('Falha ao gravar tombstones:', err);
  }
}

/** @returns {Set<string>} */
export function getDeletedIds() {
  return loadDeletedIdsSet();
}

export function isTombstoned(id) {
  if (!id) return false;
  return loadDeletedIdsSet().has(String(id));
}

export function addTombstone(id) {
  if (!id) return false;
  const set = loadDeletedIdsSet();
  const key = String(id);
  if (set.has(key)) return false;
  set.add(key);
  persistDeletedIdsSet();
  return true;
}

/** Merge remote excluded ids into local tombstones. @returns {number} newly added */
export function absorbTombstoneIds(ids) {
  let n = 0;
  for (const id of ids || []) {
    if (addTombstone(id)) n += 1;
  }
  return n;
}

export function listTombstoneIds() {
  return [...loadDeletedIdsSet()];
}
