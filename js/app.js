/**
 * Carol Guerreiro Importado — Embalagem (PWA mobile-first)
 */
import { TEAM_PIN, APP_NAME, SLOGAN } from './config.js';
import {
  loadRecords,
  saveRecords,
  searchRecords,
  formatPhoneBR,
  phoneDigits,
  waLink,
  weightToGrams,
  gramsToKgG,
  formatWeight,
  formatMeasures,
  formatDateBR,
  formatTimeHM,
  normalizeRecord,
  getEffectivePin,
  setPinOverride,
  isSessionUnlocked,
  setSessionUnlocked,
  getSavedNickname,
  setSavedNickname,
  pushAutoBackup,
  listAutoBackups,
  restoreFromAutoBackup,
  getDurabilityStatus,
  getLastSaveAt,
  peekRecoveryBanner,
  clearRecoveryBanner,
  backupFilename,
  todayLocalISO,
  tomorrowLocalISO,
  parseWorkDate,
  formatWorkDateBR,
  formatWorkDateSectionTitle,
  groupRecordsByWorkDate,
  isTombstoned,
  addTombstone,
  absorbTombstoneIds,
  getDeletedIds,
} from './storage.js';
import {
  addPhoto,
  listPhotosForRecord,
  deletePhoto,
  deleteAllPhotosForRecord,
  photoObjectURL,
  blobToDataURL,
  dataURLToBlob,
} from './db.js';
import {
  initSync,
  isSyncActive,
  getSyncStatus,
  syncUpsertRecord,
  syncDeleteRecord,
  syncPullAll,
  syncUploadPhoto,
  syncDeletePhoto,
  syncPullPhotos,
  compressUntilFit,
  buildPhotosInline,
  rawBase64ToBlob,
  PHOTO_INLINE_MAX,
  subscribeRecords,
  syncMarkExcluded,
  syncPullExcludedIds,
  subscribeExcluded,
} from './sync.js';
import {
  recognize as recognizeLabel,
  parseMeasures,
  parseWeight,
  NAME_SCORE_MIN,
} from './ocr-fill.js';

let records = [];
let objectUrls = [];
let pendingPhotoBlobs = []; // blobs ainda não gravados (formulário novo)
let currentView = 'pin'; // pin | home | form | detail | settings | backup

const REGISTRARS = ['Ancião Carlos 👑', 'Aprendiz Guilherme', 'Jessica'];

function normalizeCreatedBy(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (REGISTRARS.includes(s)) return s;
  const low = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (low.includes('jessica') || low.includes('jéssica') || low === 'jessica') return 'Jessica';
  if (low.includes('guilherme') || low.includes('aprendiz')) return 'Aprendiz Guilherme';
  if (low.includes('carlos') || low.includes('mestre') || low.includes('anciao') || low.includes('ancião')) return 'Ancião Carlos 👑';
  return '';
}

let editingId = null;
let saveInProgress = false;
let lastSaveStamp = 0; // debounce double-submit (ms)
let lastSaveFingerprint = '';
let detailId = null;
let searchQuery = '';
let dayFilter = 'all'; // 'all' | 'today' | 'tomorrow' — chips na home
let recoveryBanner = null; // one-time after boot recovery

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function revokeUrls() {
  for (const u of objectUrls) {
    try { URL.revokeObjectURL(u); } catch (_) {}
  }
  objectUrls = [];
}

function trackUrl(u) {
  objectUrls.push(u);
  return u;
}

function persistLocal() {
  records = saveRecords(records);
}

function getRecord(id) {
  return records.find((r) => r.id === id) || null;
}

function toast(msg, type = '', ms = 3200) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.remove('show');
  }, ms);
}

/** Race a promise against a timeout; rejects with { code: 'TIMEOUT' }. */
function withTimeout(promise, ms = 8000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('timeout');
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function downloadBlob(filename, blob) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Metadata-only backup (small) — records + photoCount, sem photosInline/base64. */
function buildMetadataPayload() {
  return {
    app: 'carol-guerreiro-embalagem',
    kind: 'metadata',
    exportedAt: new Date().toISOString(),
    recordCount: records.length,
    records: records.map((r) => {
      const { photosInline, ...rest } = r || {};
      void photosInline;
      return {
        ...rest,
        photoCount: Number(r.photoCount) || 0,
      };
    }),
  };
}

function downloadMetadataBackup() {
  const payload = buildMetadataPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  downloadBlob(backupFilename(new Date()), blob);
}

/**
 * Após create/edit bem-sucedido:
 * auto-backup silencioso + toast + download metadata JSON.
 */
function afterSuccessfulSave() {
  const result = pushAutoBackup(records);
  const n = result?.n ?? listAutoBackups().length;
  // Backup automático silencioso (localStorage + espelho + nuvem). Sem download popup.
  toast(`Salvo ✓ · Backup automático #${n}`, 'ok', 3500);
}

/* ---------- PIN ---------- */
function tryUnlock(pinInput) {
  const effective = getEffectivePin(TEAM_PIN);
  if (String(pinInput) === String(effective)) {
    setSessionUnlocked(true);
    return true;
  }
  return false;
}

function requireUnlock() {
  if (isSessionUnlocked()) return true;
  currentView = 'pin';
  render();
  return false;
}

/* ---------- Merge remote ---------- */
function attachInlineFromRemote(remoteList) {
  const inlineById = new Map();
  for (const r of remoteList || []) {
    if (r?.id && Array.isArray(r.photosInline) && r.photosInline.length) {
      inlineById.set(r.id, r.photosInline);
    }
  }
  for (const [id, photosInline] of inlineById) {
    const rec = records.find((x) => x.id === id);
    if (rec) rec.photosInline = photosInline;
  }
  return inlineById;
}

function mergeRemoteIntoLocal(remote) {
  if (!Array.isArray(remote)) return false;
  const map = new Map(records.map((r) => [r.id, r]));
  let changed = false;
  const resurrected = [];
  for (const r of remote) {
    const n = normalizeRecord(r);
    if (!n) continue;
    if (isTombstoned(n.id)) {
      // Não ressuscitar: remove local se presente; re-apaga remoto (best-effort)
      if (map.has(n.id)) {
        map.delete(n.id);
        changed = true;
      }
      resurrected.push(n.id);
      continue;
    }
    const local = map.get(n.id);
    if (!local || String(n.updatedAt) > String(local.updatedAt)) {
      map.set(n.id, n);
      changed = true;
    }
  }
  // Também remove locais tombstoned mesmo se não vierem no remote
  for (const id of [...map.keys()]) {
    if (isTombstoned(id)) {
      map.delete(id);
      changed = true;
    }
  }
  if (changed) {
    records = [...map.values()];
    persistLocal();
  }
  for (const id of resurrected) {
    syncDeleteRecord(id).catch(() => {});
  }
  // photosInline não vai ao localStorage (normalize); reanexa em memória e hidrata IDB
  const aliveRemote = (remote || []).filter((r) => r?.id && !isTombstoned(r.id));
  const inlineById = attachInlineFromRemote(aliveRemote);
  for (const [id, photosInline] of inlineById) {
    hydrateInlinePhotos({ id, photosInline }).catch((err) =>
      console.warn('hydrateInlinePhotos:', err)
    );
  }
  return changed;
}

async function maybePullRemote() {
  if (!isSyncActive()) return;
  try {
    // Tombstones remotos primeiro — evita ressuscitar na merge
    try {
      const excluded = await withTimeout(syncPullExcludedIds(), 8000);
      absorbTombstoneIds(excluded);
    } catch (err) {
      console.warn('Pull excluidos falhou:', err);
    }
    purgeLocalTombstoned();
    const remote = await syncPullAll();
    if (!remote) return;
    mergeRemoteIntoLocal(remote);
  } catch (err) {
    console.warn('Pull remoto falhou:', err);
  }
}

/** Remove registros locais cujo id está em tombstones. @returns {boolean} */
function purgeLocalTombstoned() {
  const before = records.length;
  records = records.filter((r) => r?.id && !isTombstoned(r.id));
  if (records.length !== before) {
    persistLocal();
    return true;
  }
  return false;
}

/**
 * Grava photosInline do documento Firestore no IndexedDB (skip ids existentes).
 */
async function hydrateInlinePhotos(record) {
  if (!record?.id || !Array.isArray(record.photosInline) || !record.photosInline.length) {
    return;
  }
  const local = await listPhotosForRecord(record.id);
  const localIds = new Set(local.map((p) => p.id));
  for (const p of record.photosInline) {
    if (!p?.id || !p?.dataBase64 || localIds.has(p.id)) continue;
    try {
      const blob = rawBase64ToBlob(p.dataBase64, p.mime || 'image/jpeg');
      await addPhoto(record.id, blob, {
        id: p.id,
        createdAt: p.createdAt,
        kind: p.kind || 'box',
        mime: p.mime || 'image/jpeg',
      });
      localIds.add(p.id);
    } catch (err) {
      console.warn('hydrateInlinePhotos item:', err);
    }
  }
}

/**
 * Puxa fotos remotas: 1) photosInline no registro 2) subcoleção/chunks (secundário).
 */
async function hydratePhotosForRecord(recordId) {
  if (!recordId) return [];
  const rec = getRecord(recordId);
  if (rec?.photosInline?.length) {
    await hydrateInlinePhotos(rec);
  }
  if (!isSyncActive()) return listPhotosForRecord(recordId);
  try {
    // Secondary: subcollection chunks (best-effort)
    try {
      const remote = await syncPullPhotos(recordId);
      if (remote.length) {
        const local = await listPhotosForRecord(recordId);
        const localIds = new Set(local.map((p) => p.id));
        for (const p of remote) {
          if (!p?.blob || localIds.has(p.id)) continue;
          await addPhoto(recordId, p.blob, {
            id: p.id,
            createdAt: p.createdAt,
            kind: p.kind,
            mime: p.mime || 'image/jpeg',
          });
          localIds.add(p.id);
        }
      }
    } catch (err) {
      console.warn('hydratePhotosForRecord chunks:', err);
    }
    return listPhotosForRecord(recordId);
  } catch (err) {
    console.warn('hydratePhotosForRecord:', err);
    return listPhotosForRecord(recordId);
  }
}

/** Decodifica photosInline direto para a galeria (blob URLs) sem esperar IDB. */
function galleryFromInline(photosInline) {
  if (!Array.isArray(photosInline) || !photosInline.length) return [];
  return photosInline
    .filter((p) => p?.dataBase64)
    .map((p) => {
      try {
        const blob = rawBase64ToBlob(p.dataBase64, p.mime || 'image/jpeg');
        return {
          id: p.id,
          blob,
          mime: p.mime || 'image/jpeg',
          createdAt: p.createdAt,
          kind: p.kind || 'box',
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Caminho principal: monta photosInline (máx 3) e faz upsert do registro.
 * Chunks ficam como tentativa secundária.
 * @returns {{ ok: boolean, count: number, message?: string }}
 */
async function upsertRecordWithInlinePhotos(rec) {
  if (!rec?.id) return { ok: false, count: 0, message: 'Registro inválido' };
  if (isTombstoned(rec.id)) {
    return { ok: false, count: 0, message: 'Contato excluído — não sincroniza' };
  }
  const localPhotos = await listPhotosForRecord(rec.id);
  const { inline, skipped } = await buildPhotosInline(localPhotos);
  const now = new Date().toISOString();
  rec.photoCount = localPhotos.length || inline.length;
  rec.updatedAt = now;
  records = records.map((r) => (r.id === rec.id ? { ...rec, photosInline: r.photosInline } : r));
  // Manter photosInline só em memória; localStorage via normalize/save limpa
  persistLocal();
  const mem = getRecord(rec.id);
  if (mem) {
    mem.photoCount = rec.photoCount;
    mem.updatedAt = now;
  }

  if (!isSyncActive()) {
    // Sem nuvem: guarda inline em memória para a UI local
    if (mem) mem.photosInline = inline;
    rec.photosInline = inline;
    return { ok: true, count: inline.length, message: 'Sync inativa — fotos só locais' };
  }
  try {
    // Enviar com photosInline no payload (updatedAt novo para os outros aparelhos puxarem)
    await syncUpsertRecord({
      ...rec,
      photosInline: inline,
      photoCount: rec.photoCount,
      updatedAt: now,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    console.warn('upsertRecordWithInlinePhotos:', err);
    // Não marcar photosInline como sincronizado — backfill automático pode tentar de novo
    return { ok: false, count: 0, message: msg };
  }

  // Sucesso: anexa inline em memória (espelha o remoto)
  rec.photosInline = inline;
  if (mem) {
    mem.photosInline = inline;
    mem.updatedAt = now;
  }

  // Secundário: chunks (não bloqueia sucesso)
  for (const p of localPhotos.slice(0, PHOTO_INLINE_MAX)) {
    try {
      await syncUploadPhoto(rec.id, p.id, p.blob, {
        createdAt: p.createdAt,
        kind: p.kind || 'box',
      });
    } catch (err) {
      console.warn('chunk secundário:', err);
    }
  }
  void skipped;
  return { ok: true, count: inline.length };
}

/* ---------- Auto photo cloud sync ---------- */
/** In-flight + once-per-session debounce por record id */
const autoPhotoUploadInFlight = new Map();
const autoPhotoUploadAttempted = new Set();

function inlinePhotoCount(rec) {
  return Array.isArray(rec?.photosInline) ? rec.photosInline.length : 0;
}

async function recordNeedsPhotoCloudUpload(recordId) {
  if (!recordId || !isSyncActive()) return false;
  if (isTombstoned(recordId)) return false;
  const rec = getRecord(recordId);
  if (!rec) return false;
  let localPhotos;
  try {
    localPhotos = await listPhotosForRecord(recordId);
  } catch {
    return false;
  }
  if (!localPhotos.length) return false;
  return localPhotos.length > inlinePhotoCount(rec);
}

/**
 * Pipeline automático: IDB → buildPhotosInline → syncUpsertRecord.
 * Debounce por id (in-flight + attempted nesta sessão).
 * @param {string} recordId
 * @param {{ toastProgress?: boolean, force?: boolean }} [opts]
 */
async function autoUploadPhotosForRecord(recordId, opts = {}) {
  const toastProgress = !!opts.toastProgress;
  const force = !!opts.force;
  if (!recordId || !isSyncActive()) return { ok: false, skipped: true };
  if (isTombstoned(recordId)) return { ok: false, skipped: true, reason: 'tombstoned' };

  if (autoPhotoUploadInFlight.has(recordId)) {
    return autoPhotoUploadInFlight.get(recordId);
  }
  if (!force && autoPhotoUploadAttempted.has(recordId)) {
    return { ok: true, skipped: true, count: 0 };
  }

  const run = (async () => {
    try {
      const needs = force ? true : await recordNeedsPhotoCloudUpload(recordId);
      if (!needs) return { ok: true, skipped: true, count: 0 };

      const rec = getRecord(recordId);
      if (!rec) return { ok: false, count: 0, message: 'Registro não encontrado' };

      const localPhotos = await listPhotosForRecord(recordId);
      if (!localPhotos.length) {
        return { ok: true, skipped: true, count: 0 };
      }

      autoPhotoUploadAttempted.add(recordId);
      if (toastProgress) toast('Enviando fotos…', '', 3500);

      const result = await upsertRecordWithInlinePhotos(rec);
      if (!result.ok) {
        // Permite nova tentativa automática mais tarde / botão manual
        autoPhotoUploadAttempted.delete(recordId);
        if (toastProgress) {
          toast(`Falha ao enviar fotos: ${result.message || 'erro'}`, 'err', 6000);
        }
        return result;
      }
      if (toastProgress && result.count > 0) {
        toast('Fotos sincronizadas', 'ok', 3500);
      } else if (toastProgress && result.count === 0 && localPhotos.length) {
        toast('Nenhuma foto coube após comprimir.', 'err', 5000);
      }
      return result;
    } catch (err) {
      autoPhotoUploadAttempted.delete(recordId);
      const msg = err?.message || String(err);
      console.warn('autoUploadPhotosForRecord:', err);
      if (toastProgress) toast(`Falha ao enviar fotos: ${msg}`, 'err', 6000);
      return { ok: false, count: 0, message: msg };
    } finally {
      autoPhotoUploadInFlight.delete(recordId);
    }
  })();

  autoPhotoUploadInFlight.set(recordId, run);
  return run;
}

/** Fila de backfill no boot: concorrência limitada (default 2). Sem toasts por item. */
async function queueBootPhotoBackfill(concurrency = 2) {
  if (!isSyncActive()) return;
  const candidates = [];
  for (const r of records) {
    if (!r?.id) continue;
    if (isTombstoned(r.id)) continue;
    if (autoPhotoUploadAttempted.has(r.id) || autoPhotoUploadInFlight.has(r.id)) continue;
    try {
      if (await recordNeedsPhotoCloudUpload(r.id)) candidates.push(r.id);
    } catch (_) {}
  }
  if (!candidates.length) return;

  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (idx < candidates.length) {
      const id = candidates[idx++];
      try {
        await autoUploadPhotosForRecord(id, { toastProgress: false });
      } catch (err) {
        console.warn('boot photo backfill:', id, err);
      }
    }
  });
  await Promise.all(workers);
}

let unsubRecords = null;
let unsubExcluded = null;

function applyExcludedIds(ids) {
  absorbTombstoneIds(ids);
  const purged = purgeLocalTombstoned();
  if (detailId && isTombstoned(detailId)) {
    detailId = null;
    if (currentView === 'detail') currentView = 'home';
  }
  if (editingId && isTombstoned(editingId)) {
    editingId = null;
  }
  return purged;
}

function startRealtimeSync() {
  if (unsubRecords) {
    try { unsubRecords(); } catch (_) {}
    unsubRecords = null;
  }
  if (unsubExcluded) {
    try { unsubExcluded(); } catch (_) {}
    unsubExcluded = null;
  }
  if (!isSyncActive()) return;
  unsubRecords = subscribeRecords((remote) => {
    const changed = mergeRemoteIntoLocal(remote);
    if (!changed) return;
    // Não interromper formulário no meio da edição
    if (currentView === 'form') return;
    if (currentView === 'detail' && detailId) {
      // Re-render + hydrate fotos do detalhe visível
      render();
      return;
    }
    if (currentView === 'home' || currentView === 'detail') {
      render();
    }
  });
  unsubExcluded = subscribeExcluded((ids) => {
    const changed = applyExcludedIds(ids);
    if (!changed) return;
    if (currentView === 'form') return;
    if (currentView === 'home' || currentView === 'detail') {
      render();
    }
  });
}

/* ---------- Render shell ---------- */
function render() {
  revokeUrls();
  const root = $('#app');
  if (!root) return;

  if (!isSessionUnlocked()) {
    currentView = 'pin';
    root.innerHTML = renderPin();
    bindPin();
    return;
  }

  switch (currentView) {
    case 'form':
      root.innerHTML = renderForm();
      bindForm();
      break;
    case 'detail':
      root.innerHTML = renderDetailShell();
      bindDetail();
      break;
    case 'settings':
      root.innerHTML = renderSettings();
      bindSettings();
      break;
    case 'backup':
      root.innerHTML = renderBackup();
      bindBackup();
      break;
    default:
      currentView = 'home';
      root.innerHTML = renderHome();
      bindHome();
      break;
  }
}

function headerHtml(opts = {}) {
  const { showBack = false, title = null, showSettings = false } = opts;
  return `
    <header class="app-header ${opts.compact ? 'compact' : ''}">
      <div class="header-bar">
        ${showBack ? `<button type="button" class="btn-icon" id="btn-back" aria-label="Voltar">←</button>` : '<span class="header-spacer"></span>'}
        <div class="header-center">
          ${!opts.compact ? `
            <div class="logo-wrap" aria-hidden="true">
              <img src="icons/logo.svg" alt="" class="logo" width="64" height="64" />
            </div>
            <h1 class="brand">${APP_NAME}</h1>
            <p class="slogan">${SLOGAN}</p>
          ` : `<h1 class="brand brand-sm">${title || 'Embalagem'}</h1>`}
        </div>
        ${showSettings ? `<button type="button" class="btn-icon" id="btn-settings" aria-label="Configurações">⚙</button>` : '<span class="header-spacer"></span>'}
      </div>
      ${opts.subtitle ? `<p class="screen-subtitle">${opts.subtitle}</p>` : ''}
      ${opts.statusLine ? `<p class="durability-status" id="home-save-status">${opts.statusLine}</p>` : ''}
    </header>
  `;
}

function homeStatusLine() {
  const last = getLastSaveAt();
  const hm = last ? formatTimeHM(last) : '—';
  return `${records.length} caixa${records.length === 1 ? '' : 's'} · último save ${hm}`;
}

/* ---------- PIN screen ---------- */
function renderPin() {
  return `
    <div class="screen pin-screen">
      ${headerHtml({})}
      <section class="card pin-card">
        <h2 class="card-title">Acesso da equipe</h2>
        <p class="hint">Digite o PIN para abrir o registro de embalagens.</p>
        <div class="form-row">
          <label for="pin-input">PIN</label>
          <input type="password" id="pin-input" inputmode="numeric" autocomplete="one-time-code"
            maxlength="12" placeholder="••••" />
        </div>
        <p class="hint err" id="pin-error" hidden></p>
        <button type="button" class="btn btn-primary btn-lg btn-block" id="btn-unlock">Entrar</button>
      </section>
    </div>
  `;
}

function bindPin() {
  const input = $('#pin-input');
  const err = $('#pin-error');
  const go = () => {
    const v = (input?.value || '').trim();
    if (!v) {
      err.hidden = false;
      err.textContent = 'Informe o PIN.';
      return;
    }
    if (tryUnlock(v)) {
      err.hidden = true;
      currentView = 'home';
      render();
      // Opcional: backfill após desbloquear
      queueBootPhotoBackfill(2).catch((e) => console.warn('photo backfill:', e));
      return;
    }
    if (input) input.value = '';
    err.hidden = false;
    err.textContent = 'PIN incorreto. Sem acesso aos dados.';
    input?.focus();
  };
  $('#btn-unlock')?.addEventListener('click', go);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      go();
    }
  });
  setTimeout(() => input?.focus(), 50);
}

/* ---------- Home ---------- */
function listItemHtml(r) {
  return `
      <div class="list-card" data-id="${r.id}">
        <button type="button" class="list-item" data-open-detail="${r.id}">
          <strong>${escapeHtml(r.clientName || 'Sem nome')}</strong>
          <span class="list-meta">${escapeHtml(r.phone || '')}</span>
          <span class="list-meta">${escapeHtml(formatMeasures(r))} · ${escapeHtml(formatWeight(r.weightGrams))}</span>
          <span class="list-meta muted">${escapeHtml(formatDateBR(r.createdAt))}</span>
        </button>
        <button type="button" class="btn btn-outline btn-sm list-edit-btn" data-edit-id="${r.id}" aria-label="Editar caixa">
          Editar
        </button>
      </div>`;
}

function openEditForm(id) {
  editingId = id;
  pendingPhotoBlobs = [];
  currentView = 'form';
  render();
  if (isSyncActive() && id) {
    hydratePhotosForRecord(id).then(() => {
      if (currentView === 'form' && editingId === id) refreshPhotoPreview();
    });
  }
}

function filteredHomeRecords() {
  let list = searchRecords(records, searchQuery);
  if (dayFilter === 'today') {
    const t = todayLocalISO();
    list = list.filter((r) => r.workDate === t);
  } else if (dayFilter === 'tomorrow') {
    const t = tomorrowLocalISO();
    list = list.filter((r) => r.workDate === t);
  }
  return list;
}

function renderGroupedListHtml(list) {
  if (!list.length) {
    return `<p class="empty-state">${
      searchQuery || dayFilter !== 'all'
        ? 'Nenhuma caixa encontrada.'
        : 'Nenhuma caixa embalada ainda. Toque em “Nova caixa”.'
    }</p>`;
  }
  const groups = groupRecordsByWorkDate(list);
  return groups
    .map((g) => {
      const count = g.records.length;
      const countLabel = `${count} caixa${count === 1 ? '' : 's'}`;
      return `
      <section class="day-section" data-work-date="${escapeAttr(g.workDate)}" id="day-${escapeAttr(g.workDate)}">
        <h2 class="day-section-title">
          <span>${escapeHtml(g.title)}</span>
          <span class="day-count">${escapeHtml(countLabel)}</span>
        </h2>
        ${g.records.map(listItemHtml).join('')}
      </section>`;
    })
    .join('');
}

function renderHome() {
  const list = filteredHomeRecords();
  const sync = getSyncStatus();
  const syncLabel =
    sync.mode === 'sync'
      ? 'Nuvem ligada · lista e fotos na mesma nuvem'
      : sync.message;
  const items = renderGroupedListHtml(list);

  const banner = recoveryBanner
    ? `<div class="recovery-banner" role="status" id="recovery-banner">
        Dados recuperados do backup automático
        <button type="button" class="banner-dismiss" id="btn-dismiss-recovery" aria-label="Fechar">✕</button>
      </div>`
    : '';

  const chip = (id, label) =>
    `<button type="button" class="day-chip${dayFilter === id ? ' active' : ''}" data-day-filter="${id}">${label}</button>`;

  return `
    <div class="screen home-screen">
      ${headerHtml({
        showSettings: true,
        subtitle: 'Registro de embalagem',
        statusLine: escapeHtml(homeStatusLine()),
      })}
      ${banner}
      <p class="sync-badge ${sync.mode}">${escapeHtml(syncLabel)}</p>
      <section class="card search-block">
        <label for="search-input" class="card-title">Buscar — nome ou telefone</label>
        <input type="search" id="search-input" placeholder="Ex: Maria, (21) 9…"
          value="${escapeAttr(searchQuery)}" autocomplete="off" />
        <div class="day-chips" role="group" aria-label="Filtrar por dia">
          ${chip('today', 'Hoje')}
          ${chip('tomorrow', 'Amanhã')}
          ${chip('all', 'Todas')}
        </div>
      </section>
      <section class="list-section" id="record-list" aria-live="polite">
        ${items}
      </section>
      <div class="fab-spacer"></div>
      <button type="button" class="fab" id="btn-nova" aria-label="Nova caixa">＋ Nova caixa</button>
      <footer class="app-footer">
        <button type="button" class="btn btn-outline btn-sm" id="btn-goto-backup">Backup</button>
        <span>${records.length} caixa(s)</span>
      </footer>
    </div>
  `;
}

function refreshHomeList() {
  const host = $('#record-list');
  if (!host) return;
  host.innerHTML = renderGroupedListHtml(filteredHomeRecords());
  bindListClicks();
}

function bindHome() {
  $('#btn-settings')?.addEventListener('click', () => {
    currentView = 'settings';
    render();
  });
  $('#btn-nova')?.addEventListener('click', () => {
    editingId = null;
    pendingPhotoBlobs = [];
    currentView = 'form';
    render();
  });
  $('#btn-goto-backup')?.addEventListener('click', () => {
    currentView = 'backup';
    render();
  });
  $('#btn-dismiss-recovery')?.addEventListener('click', () => {
    recoveryBanner = null;
    clearRecoveryBanner();
    const el = $('#recovery-banner');
    if (el) el.remove();
  });
  // One-time: clear session flag after first home paint with banner
  if (recoveryBanner) {
    clearRecoveryBanner();
  }
  $$('[data-day-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      dayFilter = btn.dataset.dayFilter || 'all';
      $$('[data-day-filter]').forEach((b) => {
        b.classList.toggle('active', b.dataset.dayFilter === dayFilter);
      });
      refreshHomeList();
      if (dayFilter === 'today' || dayFilter === 'tomorrow') {
        const target =
          dayFilter === 'today' ? todayLocalISO() : tomorrowLocalISO();
        const el = document.getElementById(`day-${target}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
  const search = $('#search-input');
  search?.addEventListener('input', () => {
    searchQuery = search.value;
    refreshHomeList();
  });
  bindListClicks();
}

function bindListClicks() {
  $$('[data-open-detail]').forEach((btn) => {
    btn.addEventListener('click', () => {
      detailId = btn.dataset.openDetail;
      currentView = 'detail';
      render();
    });
  });
  $$('[data-edit-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditForm(btn.dataset.editId);
    });
  });
}

/* ---------- Form ---------- */
function renderForm() {
  const r = editingId ? getRecord(editingId) : null;
  const { kg, g } = r ? gramsToKgG(r.weightGrams) : { kg: 0, g: 0 };
  const nick = normalizeCreatedBy(r?.createdBy || getSavedNickname());
  return `
    <div class="screen form-screen">
      ${headerHtml({ showBack: true, compact: true, title: r ? 'Editar caixa' : 'Nova caixa' })}
      <form class="card form-card" id="pack-form" novalidate>
        <div class="ocr-fill-block">
          <button type="button" class="btn btn-primary btn-lg btn-block" id="btn-ocr-fill">
            📷 Preencher por foto
          </button>
          <div class="btn-row ocr-pick-row" id="ocr-pick-row" hidden>
            <label class="btn btn-secondary file-btn">
              Câmera
              <input type="file" id="ocr-cam" accept="image/*" capture="environment" hidden />
            </label>
            <label class="btn btn-outline file-btn">
              Galeria
              <input type="file" id="ocr-gal" accept="image/*" hidden />
            </label>
          </div>
          <p class="hint ocr-status" id="ocr-status" role="status" hidden></p>
          <div class="ocr-confirm card" id="ocr-confirm" hidden></div>
        </div>
        <div class="form-row">
          <label for="f-name">Nome do cliente <span class="required">*</span></label>
          <input type="text" id="f-name" required autocomplete="name"
            value="${escapeAttr(r?.clientName || '')}" placeholder="Nome completo" />
        </div>
        <div class="form-row">
          <label for="f-phone">Telefone <span class="required">*</span></label>
          <input type="tel" id="f-phone" inputmode="tel" required autocomplete="tel"
            placeholder="(21) 99999-0000" value="${escapeAttr(r?.phone || '')}" />
        </div>
        <div class="form-row">
          <label for="f-work-date">Data da caixa</label>
          <input type="date" id="f-work-date" required
            value="${escapeAttr(r?.workDate || todayLocalISO())}" />
        </div>
        <fieldset class="measure-fieldset">
          <legend>Medidas da caixa (cm)</legend>
          <div class="measure-grid">
            <div class="form-row">
              <label for="f-l">Comprimento</label>
              <input type="number" id="f-l" inputmode="decimal" min="0" step="0.1"
                value="${r ? escapeAttr(String(r.measureL)) : ''}" placeholder="cm" />
            </div>
            <div class="form-row">
              <label for="f-w">Largura</label>
              <input type="number" id="f-w" inputmode="decimal" min="0" step="0.1"
                value="${r ? escapeAttr(String(r.measureW)) : ''}" placeholder="cm" />
            </div>
            <div class="form-row">
              <label for="f-h">Altura</label>
              <input type="number" id="f-h" inputmode="decimal" min="0" step="0.1"
                value="${r ? escapeAttr(String(r.measureH)) : ''}" placeholder="cm" />
            </div>
          </div>
        </fieldset>
        <fieldset class="weight-fieldset">
          <legend>Peso</legend>
          <div class="weight-grid">
            <div class="form-row">
              <label for="f-kg">Quilos (kg)</label>
              <input type="number" id="f-kg" inputmode="numeric" min="0" step="1"
                value="${escapeAttr(String(kg))}" />
            </div>
            <div class="form-row">
              <label for="f-g">Gramas (0–999)</label>
              <input type="number" id="f-g" inputmode="numeric" min="0" max="999" step="1"
                value="${escapeAttr(String(g))}" />
            </div>
          </div>
        </fieldset>
        <div class="form-row">
          <label for="f-notes">Observações <span class="optional">(opcional)</span></label>
          <textarea id="f-notes" rows="3" placeholder="Notas…">${escapeHtml(r?.notes || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="f-by">Quem registrou</label>
          <select id="f-by" required>
            <option value="" disabled ${!['Ancião Carlos 👑','Aprendiz Guilherme','Jessica'].includes(nick) ? 'selected' : ''}>Escolha quem registrou</option>
            <option value="Ancião Carlos 👑" ${nick === 'Ancião Carlos 👑' ? 'selected' : ''}>Ancião Carlos 👑</option>
            <option value="Aprendiz Guilherme" ${nick === 'Aprendiz Guilherme' ? 'selected' : ''}>Aprendiz Guilherme</option>
            <option value="Jessica" ${nick === 'Jessica' ? 'selected' : ''}>Jessica</option>
          </select>
        </div>
        <div class="form-row">
          <span class="card-title" style="margin-bottom:8px;display:block">Fotos</span>
          <div class="btn-row photo-actions">
            <label class="btn btn-secondary btn-lg file-btn">
              📷 Câmera
              <input type="file" id="f-camera" accept="image/*" capture="environment" hidden multiple />
            </label>
            <label class="btn btn-outline btn-lg file-btn">
              🖼 Galeria
              <input type="file" id="f-gallery" accept="image/*" hidden multiple />
            </label>
          </div>
          <div class="photo-preview" id="photo-preview"></div>
        </div>
        <p class="hint err" id="form-error" hidden></p>
        <div class="btn-row">
          <button type="button" class="btn btn-secondary btn-lg" id="btn-cancel-form">Cancelar</button>
          <button type="submit" class="btn btn-primary btn-lg" id="btn-save">Salvar</button>
        </div>
        ${editingId ? `
        <div class="form-delete-block" style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border, #e5e5e5)">
          <button type="button" class="btn btn-danger btn-lg btn-block" id="btn-delete-form">Excluir contato</button>
        </div>` : ''}
      </form>
    </div>
  `;
}

async function bindForm() {
  $('#btn-back')?.addEventListener('click', () => {
    pendingPhotoBlobs = [];
    if (editingId) {
      detailId = editingId;
      currentView = 'detail';
    } else {
      currentView = 'home';
    }
    render();
  });
  $('#btn-cancel-form')?.addEventListener('click', () => {
    $('#btn-back')?.click();
  });

  const phone = $('#f-phone');
  phone?.addEventListener('input', () => {
    const pos = phone.selectionStart;
    const before = phone.value.length;
    phone.value = formatPhoneBR(phone.value);
    const after = phone.value.length;
    try { phone.setSelectionRange(pos + (after - before), pos + (after - before)); } catch (_) {}
  });

  const gInput = $('#f-g');
  gInput?.addEventListener('input', () => {
    let v = Math.floor(Number(gInput.value) || 0);
    if (v > 999) gInput.value = '999';
    if (v < 0) gInput.value = '0';
  });

  $('#f-camera')?.addEventListener('change', (e) => onPhotosPicked(e));
  $('#f-gallery')?.addEventListener('change', (e) => onPhotosPicked(e));

  await refreshPhotoPreview();

  $('#pack-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveForm();
  });

  $('#btn-delete-form')?.addEventListener('click', async () => {
    if (!editingId) return;
    const rec = getRecord(editingId);
    const label = rec?.clientName || 'este contato';
    if (!confirm(`Excluir a caixa de ${label}? Esta ação não pode ser desfeita.`)) return;
    await deleteContactRecord(editingId);
  });

  bindOcrFill();
}

function bindOcrFill() {
  const pickRow = $('#ocr-pick-row');
  const statusEl = $('#ocr-status');
  const confirmEl = $('#ocr-confirm');
  const cam = $('#ocr-cam');
  const gal = $('#ocr-gal');

  $('#btn-ocr-fill')?.addEventListener('click', () => {
    if (!pickRow) return;
    pickRow.hidden = !pickRow.hidden;
  });

  const onPick = async (e) => {
    const file = e.target?.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (pickRow) pickRow.hidden = true;
    if (confirmEl) {
      confirmEl.hidden = true;
      confirmEl.innerHTML = '';
    }
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = 'Lendo foto…';
      statusEl.classList.remove('err', 'ok');
    }
    try {
      const parsed = await recognizeLabel(file, (msg) => {
        if (statusEl) statusEl.textContent = msg || 'Lendo foto…';
      });
      showOcrConfirm(parsed);
    } catch (err) {
      console.warn('OCR fail', err);
      if (statusEl) {
        statusEl.hidden = true;
      }
      toast('Não foi possível ler a foto. Preencha manualmente.', 'err');
    }
  };

  cam?.addEventListener('change', onPick);
  gal?.addEventListener('change', onPick);
}

function formatOcrMeasures(parsed) {
  if (parsed.l == null && parsed.w == null && parsed.h == null) return '—';
  const a = parsed.l != null ? parsed.l : '?';
  const b = parsed.w != null ? parsed.w : '?';
  const c = parsed.h != null ? parsed.h : '?';
  return `${a} × ${b} × ${c} cm`;
}

function formatOcrWeight(parsed) {
  if (parsed.kg == null && parsed.g == null) return '—';
  const kg = parsed.kg || 0;
  const g = parsed.g || 0;
  return `${kg} kg + ${g} g`;
}

function showOcrConfirm(parsed) {
  const statusEl = $('#ocr-status');
  const confirmEl = $('#ocr-confirm');

  const nameLow =
    !parsed.name &&
    (parsed.nameScore == null || parsed.nameScore < NAME_SCORE_MIN);
  if (nameLow && parsed.nameRejected) {
    toast('Nome não confiante — preencha na mão', 'err');
  } else if (!parsed.name && parsed.nameScore != null && parsed.nameScore < NAME_SCORE_MIN) {
    toast('Nome não confiante — preencha na mão', 'err');
  }

  const hasAny =
    parsed.name ||
    parsed.phone ||
    parsed.l != null ||
    parsed.w != null ||
    parsed.h != null ||
    parsed.kg != null ||
    parsed.g != null ||
    (parsed.rawText && String(parsed.rawText).trim());

  if (statusEl) {
    if (!hasAny) {
      statusEl.hidden = true;
      toast('OCR não encontrou dados. Preencha manualmente.', 'err');
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = 'Confira e edite os dados detectados:';
    statusEl.classList.remove('err');
    statusEl.classList.add('ok');
  }
  if (!confirmEl) return;

  const nameVal = escapeAttr(parsed.name || '');
  const phoneVal = escapeAttr(
    parsed.phone ? formatPhoneBR(parsed.phone) : ''
  );
  const lVal = parsed.l != null ? escapeAttr(String(parsed.l)) : '';
  const wVal = parsed.w != null ? escapeAttr(String(parsed.w)) : '';
  const hVal = parsed.h != null ? escapeAttr(String(parsed.h)) : '';
  const kgVal = parsed.kg != null ? escapeAttr(String(parsed.kg)) : '';
  const gVal = parsed.g != null ? escapeAttr(String(parsed.g)) : '';
  const raw = String(parsed.rawText || '').trim();
  const rawBlock = raw
    ? `<details class="ocr-raw">
        <summary>Ver texto lido</summary>
        <pre class="ocr-raw-text">${escapeHtml(raw)}</pre>
      </details>`
    : '';

  confirmEl.hidden = false;
  confirmEl.innerHTML = `
    <p class="ocr-confirm-title">Dados detectados</p>
    <div class="ocr-confirm-fields">
      <label class="ocr-field">
        <span>Nome</span>
        <input type="text" id="ocr-name" autocomplete="name" value="${nameVal}" placeholder="Nome do cliente" />
      </label>
      <label class="ocr-field">
        <span>Telefone</span>
        <input type="tel" id="ocr-phone" inputmode="tel" value="${phoneVal}" placeholder="(21) 99999-0000" />
      </label>
      <div class="ocr-field">
        <span>Medidas (cm)</span>
        <div class="ocr-measures-row">
          <input type="number" id="ocr-l" inputmode="decimal" min="0" step="any" placeholder="C" value="${lVal}" />
          <span class="ocr-x">×</span>
          <input type="number" id="ocr-w" inputmode="decimal" min="0" step="any" placeholder="L" value="${wVal}" />
          <span class="ocr-x">×</span>
          <input type="number" id="ocr-h" inputmode="decimal" min="0" step="any" placeholder="A" value="${hVal}" />
        </div>
        <input type="text" id="ocr-measures-combo" class="ocr-measures-combo" placeholder="ou 10x10x10" />
      </div>
      <div class="ocr-field">
        <span>Peso</span>
        <div class="ocr-weight-row">
          <input type="number" id="ocr-kg" inputmode="numeric" min="0" step="1" placeholder="kg" value="${kgVal}" />
          <span class="ocr-unit">kg</span>
          <input type="number" id="ocr-g" inputmode="numeric" min="0" max="999" step="1" placeholder="g" value="${gVal}" />
          <span class="ocr-unit">g</span>
        </div>
        <input type="text" id="ocr-weight-combo" class="ocr-weight-combo" placeholder="ou 3.075 / Kg 3.600" />
      </div>
    </div>
    ${rawBlock}
    <div class="btn-row">
      <button type="button" class="btn btn-secondary" id="ocr-cancel">Cancelar</button>
      <button type="button" class="btn btn-primary" id="ocr-apply">Usar estes dados</button>
    </div>
  `;

  const combo = $('#ocr-measures-combo');
  combo?.addEventListener('change', () => {
    const m = parseMeasures(combo.value || '');
    if (m.l != null) {
      const el = $('#ocr-l');
      if (el) el.value = String(m.l);
    }
    if (m.w != null) {
      const el = $('#ocr-w');
      if (el) el.value = String(m.w);
    }
    if (m.h != null) {
      const el = $('#ocr-h');
      if (el) el.value = String(m.h);
    }
  });
  combo?.addEventListener('input', () => {
    if (!/[x×X\-\/]/.test(combo.value || '')) return;
    const m = parseMeasures(combo.value || '');
    if (m.l == null) return;
    if ($('#ocr-l')) $('#ocr-l').value = String(m.l);
    if ($('#ocr-w')) $('#ocr-w').value = String(m.w);
    if ($('#ocr-h')) $('#ocr-h').value = String(m.h);
  });

  const wCombo = $('#ocr-weight-combo');
  const applyWeightCombo = () => {
    const w = parseWeight(wCombo.value || '');
    if (w.kg == null && w.g == null) return;
    if ($('#ocr-kg')) $('#ocr-kg').value = String(w.kg || 0);
    if ($('#ocr-g')) $('#ocr-g').value = String(w.g || 0);
  };
  wCombo?.addEventListener('change', applyWeightCombo);
  wCombo?.addEventListener('blur', applyWeightCombo);

  $('#ocr-phone')?.addEventListener('input', (e) => {
    const el = e.target;
    const pos = el.selectionStart;
    const before = el.value.length;
    el.value = formatPhoneBR(el.value);
    const after = el.value.length;
    try {
      el.setSelectionRange(pos + (after - before), pos + (after - before));
    } catch (_) {}
  });

  $('#ocr-cancel')?.addEventListener('click', () => {
    confirmEl.hidden = true;
    confirmEl.innerHTML = '';
    if (statusEl) statusEl.hidden = true;
  });
  $('#ocr-apply')?.addEventListener('click', () => {
    const fromUi = readOcrConfirmFields();
    applyOcrParsed(fromUi);
    confirmEl.hidden = true;
    confirmEl.innerHTML = '';
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = 'Campos preenchidos — revise e salve.';
      statusEl.classList.add('ok');
    }
    toast('Campos preenchidos pela foto', 'ok');
  });
}

function readOcrConfirmFields() {
  const numOrNull = (id) => {
    const v = ($(id)?.value || '').trim();
    if (v === '') return null;
    const n = parseFloat(v.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const intOrNull = (id) => {
    const v = ($(id)?.value || '').trim();
    if (v === '') return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  // Prefer combo fields if filled
  let l = numOrNull('#ocr-l');
  let w = numOrNull('#ocr-w');
  let h = numOrNull('#ocr-h');
  const combo = ($('#ocr-measures-combo')?.value || '').trim();
  if (combo) {
    const m = parseMeasures(combo);
    if (m.l != null) {
      l = m.l;
      w = m.w;
      h = m.h;
    }
  }
  let kg = intOrNull('#ocr-kg');
  let g = intOrNull('#ocr-g');
  const wCombo = ($('#ocr-weight-combo')?.value || '').trim();
  if (wCombo) {
    const pw = parseWeight(wCombo);
    if (pw.kg != null || pw.g != null) {
      kg = pw.kg != null ? pw.kg : 0;
      g = pw.g != null ? pw.g : 0;
    }
  }
  return {
    name: ($('#ocr-name')?.value || '').trim(),
    phone: ($('#ocr-phone')?.value || '').trim(),
    l,
    w,
    h,
    kg,
    g,
  };
}

function applyOcrParsed(parsed) {
  if (parsed.name) {
    const el = $('#f-name');
    if (el) el.value = parsed.name;
  }
  if (parsed.phone) {
    const el = $('#f-phone');
    if (el) el.value = formatPhoneBR(parsed.phone);
  }
  if (parsed.l != null) {
    const el = $('#f-l');
    if (el) el.value = String(parsed.l);
  }
  if (parsed.w != null) {
    const el = $('#f-w');
    if (el) el.value = String(parsed.w);
  }
  if (parsed.h != null) {
    const el = $('#f-h');
    if (el) el.value = String(parsed.h);
  }
  if (parsed.kg != null) {
    const el = $('#f-kg');
    if (el) el.value = String(parsed.kg);
  }
  if (parsed.g != null) {
    const el = $('#f-g');
    if (el) el.value = String(parsed.g);
  }
}

async function onPhotosPicked(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    pendingPhotoBlobs.push(f);
  }
  await refreshPhotoPreview();
}

async function refreshPhotoPreview() {
  const host = $('#photo-preview');
  if (!host) return;
  let html = '';
  if (editingId) {
    try {
      const photos = await listPhotosForRecord(editingId);
      for (const p of photos) {
        const url = trackUrl(photoObjectURL(p));
        html += `
          <div class="thumb" data-saved="${p.id}">
            <img src="${url}" alt="Foto" />
            <button type="button" class="thumb-del" data-del-saved="${p.id}" aria-label="Remover">✕</button>
          </div>`;
      }
    } catch (_) {}
  }
  pendingPhotoBlobs.forEach((blob, i) => {
    const url = trackUrl(URL.createObjectURL(blob));
    html += `
      <div class="thumb" data-pending="${i}">
        <img src="${url}" alt="Nova foto" />
        <button type="button" class="thumb-del" data-del-pending="${i}" aria-label="Remover">✕</button>
      </div>`;
  });
  host.innerHTML = html || '<p class="hint">Nenhuma foto ainda.</p>';
  $$('[data-del-saved]', host).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delSaved;
      await deletePhoto(id);
      try { await syncDeletePhoto(editingId, id); } catch (_) {}
      await refreshPhotoPreview();
      toast('Foto removida');
    });
  });
  $$('[data-del-pending]', host).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.delPending);
      pendingPhotoBlobs.splice(i, 1);
      await refreshPhotoPreview();
    });
  });
}

async function saveForm() {
  if (saveInProgress) return;

  const err = $('#form-error');
  const name = ($('#f-name')?.value || '').trim();
  const phoneRaw = ($('#f-phone')?.value || '').trim();
  const digits = phoneDigits(phoneRaw);
  const workDateEarly =
    parseWorkDate($('#f-work-date')?.value) || todayLocalISO();
  const fingerprint = `${editingId || 'new'}|${name}|${digits}|${workDateEarly}`;
  const nowMs = Date.now();
  if (
    fingerprint === lastSaveFingerprint &&
    nowMs - lastSaveStamp < 2000
  ) {
    return; // ignore second submit within 2s for same form
  }

  if (!name) {
    err.hidden = false;
    err.textContent = 'Informe o nome do cliente.';
    $('#f-name')?.focus();
    return;
  }
  if (digits.length < 10) {
    err.hidden = false;
    err.textContent = 'Telefone inválido. Use o formato (21) 99999-0000.';
    $('#f-phone')?.focus();
    return;
  }
  err.hidden = true;

  saveInProgress = true;
  const btnSave = $('#btn-save');
  const prevSaveLabel = btnSave?.textContent || 'Salvar';
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.textContent = 'Salvando…';
  }

  try {
    const measureL = Number($('#f-l')?.value) || 0;
    const measureW = Number($('#f-w')?.value) || 0;
    const measureH = Number($('#f-h')?.value) || 0;
    const kg = Number($('#f-kg')?.value) || 0;
    const g = Math.min(999, Math.max(0, Math.floor(Number($('#f-g')?.value) || 0)));
    const notes = ($('#f-notes')?.value || '').trim();
    const createdBy = normalizeCreatedBy($('#f-by')?.value || '');
    if (!createdBy) {
      err.hidden = false;
      err.textContent = 'Escolha quem registrou (Ancião Carlos, Aprendiz Guilherme ou Jessica).';
      $('#f-by')?.focus();
      return;
    }
    setSavedNickname(createdBy);
    const workDate = workDateEarly;

    const now = new Date().toISOString();
    let rec;
    if (editingId) {
      const existing = getRecord(editingId);
      rec = normalizeRecord({
        ...existing,
        clientName: name,
        phone: formatPhoneBR(phoneRaw),
        measureL,
        measureW,
        measureH,
        weightGrams: weightToGrams(kg, g),
        notes,
        createdBy,
        workDate: workDate,
        updatedAt: now,
      });
      records = records.map((r) => (r.id === editingId ? rec : r));
    } else {
      rec = normalizeRecord({
        id: crypto.randomUUID(),
        clientName: name,
        phone: formatPhoneBR(phoneRaw),
        measureL,
        measureW,
        measureH,
        weightGrams: weightToGrams(kg, g),
        notes,
        createdBy,
        workDate: workDate,
        createdAt: now,
        updatedAt: now,
      });
      records.push(rec);
      // Immediate: overlapping second save updates this record instead of creating another UUID
      editingId = rec.id;
    }

    // Grava blobs locais (comprimidos) no IndexedDB primeiro
    for (const rawBlob of pendingPhotoBlobs) {
      let blob = rawBlob;
      try {
        const fitted = await compressUntilFit(rawBlob);
        blob = fitted.blob || rawBlob;
        if (!fitted.ok) {
          toast(
            'Foto muito grande mesmo após comprimir — tentaremos na nuvem mesmo assim se couber 1 capa.',
            '',
            4500
          );
        }
      } catch (e) {
        console.warn('Compress foto:', e);
        blob = rawBlob;
      }
      await addPhoto(rec.id, blob, {
        createdAt: new Date().toISOString(),
        kind: 'box',
      });
    }
    pendingPhotoBlobs = [];

    const photos = await listPhotosForRecord(rec.id);
    rec.photoCount = photos.length;
    records = records.map((r) => (r.id === rec.id ? rec : r));
    persistLocal();

    let inlineResult = { ok: true, count: 0 };
    if (isSyncActive()) {
      // Automático: após gravar no IDB, monta photosInline e faz upsert (sem botão)
      inlineResult = await upsertRecordWithInlinePhotos(rec);
      if (inlineResult.ok) {
        if (inlineResult.count > 0) autoPhotoUploadAttempted.add(rec.id);
      } else {
        toast(
          `Falha ao enviar fotos na nuvem: ${inlineResult.message || 'erro'}`,
          'err',
          6000
        );
      }
      if (inlineResult.ok && photos.length && inlineResult.count === 0) {
        toast('Nenhuma foto coube no documento após comprimir.', 'err', 6000);
      }
    }

    afterSuccessfulSave();
    if (isSyncActive() && inlineResult.ok && inlineResult.count > 0) {
      setTimeout(() => {
        toast('Fotos na nuvem', 'ok', 2800);
      }, 4200);
    }
    lastSaveFingerprint = `${rec.id}|${name}|${digits}|${workDate}`;
    lastSaveStamp = Date.now();
    detailId = rec.id;
    editingId = null;
    currentView = 'detail';
    render();
  } finally {
    saveInProgress = false;
    if (btnSave && document.body.contains(btnSave)) {
      btnSave.disabled = false;
      btnSave.textContent = prevSaveLabel;
    }
  }
}

/**
 * Tombstone + purge local + Firestore embalagens + excluidos/{id}.
 * @param {string} id
 * @param {{ silent?: boolean, navigateHome?: boolean }} [opts]
 */
async function deleteContactRecord(id, opts = {}) {
  const silent = !!opts.silent;
  const navigateHome = opts.navigateHome !== false;
  const rid = String(id || '');
  if (!rid) return;

  addTombstone(rid);

  const r = getRecord(rid);
  try {
    await deleteAllPhotosForRecord(rid);
  } catch (_) {}

  records = records.filter((x) => x.id !== rid);
  persistLocal();

  try {
    if (isSyncActive()) {
      try {
        await syncMarkExcluded(rid);
      } catch (err) {
        console.warn('syncMarkExcluded:', err);
      }
      try {
        await syncDeleteRecord(rid);
      } catch (err) {
        console.warn('syncDeleteRecord:', err);
      }
    }
  } catch (_) {}

  if (!silent) {
    toast('Contato excluído — não volta mais');
  }
  if (navigateHome) {
    pendingPhotoBlobs = [];
    detailId = null;
    editingId = null;
    currentView = 'home';
    render();
  }
}

/**
 * Após sync: mantém só 1 Vanessa (mais recente por updatedAt/createdAt);
 * tombstone+delete as demais.
 */
async function collapseVanessaDuplicates() {
  const matches = records.filter((r) =>
    /vanessa/i.test(String(r?.clientName || '').trim())
  );
  if (matches.length <= 1) return 0;

  matches.sort((a, b) => {
    const ta = String(a.updatedAt || a.createdAt || '');
    const tb = String(b.updatedAt || b.createdAt || '');
    return tb.localeCompare(ta);
  });
  const keep = matches[0];
  const dupes = matches.slice(1);
  console.info(
    'collapseVanessaDuplicates: keeping',
    keep.id,
    'removing',
    dupes.map((d) => d.id)
  );
  for (const d of dupes) {
    await deleteContactRecord(d.id, { silent: true, navigateHome: false });
  }
  return dupes.length;
}

/* ---------- Detail ---------- */
function renderDetailShell() {
  const r = getRecord(detailId);
  if (!r) {
    return `
      <div class="screen">
        ${headerHtml({ showBack: true, compact: true, title: 'Detalhe' })}
        <p class="empty-state">Registro não encontrado.</p>
      </div>`;
  }
  return `
    <div class="screen detail-screen">
      ${headerHtml({ showBack: true, compact: true, title: 'Detalhe da caixa' })}
      <section class="card detail-card">
        <button type="button" class="detail-identity" id="btn-edit-identity" aria-label="Editar nome e telefone">
          <h2 class="detail-name">${escapeHtml(r.clientName)}</h2>
          <p class="detail-phone">${escapeHtml(r.phone)}</p>
          <span class="detail-tap-hint">Toque para editar</span>
        </button>
        <button type="button" class="btn btn-primary btn-lg btn-block" id="btn-edit-all">Editar tudo</button>
        <p class="hint edit-hint">Toque em Editar tudo para mudar nome, telefone, medidas, peso e fotos.</p>
        <dl class="detail-dl">
          <div><dt>Medidas</dt><dd>${escapeHtml(formatMeasures(r))}</dd></div>
          <div><dt>Peso</dt><dd>${escapeHtml(formatWeight(r.weightGrams))}</dd></div>
          <div><dt>Data da caixa</dt><dd>${escapeHtml(formatWorkDateSectionTitle(r.workDate))}</dd></div>
          <div><dt>Criado em</dt><dd>${escapeHtml(formatDateBR(r.createdAt))}</dd></div>
          <div><dt>Atualizado</dt><dd>${escapeHtml(formatDateBR(r.updatedAt))}</dd></div>
          ${r.createdBy ? `<div><dt>Por</dt><dd>${escapeHtml(r.createdBy)}</dd></div>` : ''}
          ${r.notes ? `<div class="full"><dt>Observações</dt><dd>${escapeHtml(r.notes)}</dd></div>` : ''}
        </dl>
        <div class="photo-gallery" id="detail-photos"><p class="hint">Buscando fotos na nuvem…</p></div>
        <button type="button" class="btn btn-outline btn-sm btn-block" id="btn-reenviar-fotos" style="margin-top:10px;margin-bottom:4px;opacity:0.9;font-size:0.8rem">
          Reenviar fotos (se falhou)
        </button>
        <p class="hint" style="margin-top:0;margin-bottom:12px">Opcional — as fotos sobem sozinhas ao salvar e ao abrir o detalhe. Use só se a nuvem falhou.</p>
        <div class="move-day-block">
          <p class="card-title" style="margin-bottom:8px">Mover para outro dia</p>
          <div class="btn-row">
            <button type="button" class="btn btn-outline btn-sm" id="btn-move-today">Mover para hoje</button>
            <button type="button" class="btn btn-outline btn-sm" id="btn-move-tomorrow">Mover para amanhã</button>
          </div>
          <div class="form-row" style="margin-top:10px;margin-bottom:0">
            <label for="f-move-date">Escolher outra data…</label>
            <input type="date" id="f-move-date" value="${escapeAttr(r.workDate || todayLocalISO())}" />
          </div>
          <button type="button" class="btn btn-secondary btn-sm btn-block" id="btn-move-custom" style="margin-top:8px">
            Aplicar data escolhida
          </button>
        </div>
        <div class="btn-row stacked">
          <a class="btn btn-whatsapp btn-lg btn-block" id="btn-wa" target="_blank" rel="noopener"
            href="${escapeAttr(waLink(r.phone, r.clientName))}">WhatsApp</a>
        </div>
        <div class="detail-delete-block" style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border, #e5e5e5)">
          <button type="button" class="btn btn-danger btn-lg btn-block" id="btn-delete">Excluir contato</button>
        </div>
      </section>
    </div>
  `;
}

function bindDetail() {
  $('#btn-back')?.addEventListener('click', () => {
    currentView = 'home';
    render();
  });
  const r = getRecord(detailId);
  if (!r) return;

  const goEdit = () => openEditForm(r.id);
  $('#btn-edit-all')?.addEventListener('click', goEdit);
  $('#btn-edit-identity')?.addEventListener('click', goEdit);

  $('#btn-delete')?.addEventListener('click', async () => {
    if (!confirm(`Excluir a caixa de ${r.clientName}? Esta ação não pode ser desfeita.`)) return;
    await deleteContactRecord(r.id);
  });

  $('#btn-move-today')?.addEventListener('click', () => moveRecordToDate(r.id, todayLocalISO()));
  $('#btn-move-tomorrow')?.addEventListener('click', () =>
    moveRecordToDate(r.id, tomorrowLocalISO())
  );
  $('#btn-move-custom')?.addEventListener('click', () => {
    const picked = parseWorkDate($('#f-move-date')?.value);
    if (!picked) {
      toast('Data inválida', 'err');
      return;
    }
    moveRecordToDate(r.id, picked);
  });

  $('#btn-reenviar-fotos')?.addEventListener('click', () => reenviarFotosParaNuvem(r.id));

  loadDetailPhotos(r.id);
}

async function moveRecordToDate(id, workDate) {
  const existing = getRecord(id);
  if (!existing) return;
  const target = parseWorkDate(workDate);
  if (!target) {
    toast('Data inválida', 'err');
    return;
  }
  if (existing.workDate === target) {
    toast(`Já está em ${formatWorkDateSectionTitle(target)}`);
    return;
  }
  const now = new Date().toISOString();
  const rec = normalizeRecord({
    ...existing,
    workDate: target,
    updatedAt: now,
  });
  records = records.map((x) => (x.id === id ? rec : x));
  persistLocal();
  try {
    if (isSyncActive() && !isTombstoned(rec.id)) await syncUpsertRecord(rec);
  } catch (e) {
    console.warn('Sync upsert:', e);
  }
  afterSuccessfulSave();
  detailId = id;
  currentView = 'detail';
  render();
}

function renderDetailPhotoGallery(host, photos) {
  if (!host) return;
  if (!photos.length) {
    host.innerHTML = '<p class="hint">Sem fotos.</p>';
    return;
  }
  host.innerHTML = photos
    .map((p) => {
      const url = trackUrl(photoObjectURL(p));
      return `<a class="gallery-item" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Foto da caixa" /></a>`;
    })
    .join('');
}

async function loadDetailPhotos(recordId) {
  const host = $('#detail-photos');
  if (!host) return;
  try {
    const rec = getRecord(recordId);
    if (isSyncActive()) {
      host.innerHTML = '<p class="hint">Buscando fotos na nuvem…</p>';
      const photos = await hydratePhotosForRecord(recordId);
      if (!$('#detail-photos') || detailId !== recordId) return;
      if (photos.length) {
        renderDetailPhotoGallery($('#detail-photos'), photos);
        // Auto backfill se local tem mais fotos que photosInline remoto
        autoUploadPhotosForRecord(recordId, { toastProgress: true }).catch(() => {});
        return;
      }
      // Fallback: decode photosInline direto (antes/sem IDB)
      const inlinePhotos = galleryFromInline(rec?.photosInline);
      if (inlinePhotos.length) {
        renderDetailPhotoGallery($('#detail-photos'), inlinePhotos);
        return;
      }
      // Sem fotos locais/remotas ainda — tenta backfill se IDB tiver (race) ou fica vazio
      autoUploadPhotosForRecord(recordId, { toastProgress: true })
        .then((res) => {
          if (res && res.ok && res.count > 0 && detailId === recordId) {
            loadDetailPhotos(recordId);
          }
        })
        .catch(() => {});
      renderDetailPhotoGallery($('#detail-photos'), []);
      return;
    }
    let photos = await listPhotosForRecord(recordId);
    if (!$('#detail-photos') || detailId !== recordId) return;
    if (!photos.length) {
      photos = galleryFromInline(rec?.photosInline);
    }
    renderDetailPhotoGallery($('#detail-photos'), photos);
  } catch {
    if ($('#detail-photos') && detailId === recordId) {
      $('#detail-photos').innerHTML = '<p class="hint err">Erro ao carregar fotos.</p>';
    }
  }
}

/** Retry manual (secundário) — força o mesmo pipeline automático. */
async function reenviarFotosParaNuvem(recordId) {
  if (!isSyncActive()) {
    toast('Sincronização inativa. Ative o Firebase em firebase-config.js.', 'err');
    return;
  }
  const rec = getRecord(recordId);
  if (!rec) {
    toast('Registro não encontrado.', 'err');
    return;
  }
  const photos = await listPhotosForRecord(recordId);
  if (!photos.length) {
    toast('Não há fotos locais neste aparelho para enviar.', 'err');
    return;
  }
  autoPhotoUploadAttempted.delete(recordId);
  const result = await autoUploadPhotosForRecord(recordId, {
    toastProgress: true,
    force: true,
  });
  if (result?.ok && result.count > 0 && detailId === recordId) {
    loadDetailPhotos(recordId);
  }
}

/* ---------- Settings ---------- */
function renderSettings() {
  const sync = getSyncStatus();
  return `
    <div class="screen settings-screen">
      ${headerHtml({ showBack: true, compact: true, title: 'Configurações' })}
      <section class="card">
        <h2 class="card-title">Alterar PIN</h2>
        <p class="hint">O PIN padrão está em <code>js/config.js</code> (TEAM_PIN). Você também pode gravar um PIN neste aparelho.</p>
        <div class="form-row">
          <label for="pin-current">PIN atual</label>
          <input type="password" id="pin-current" inputmode="numeric" autocomplete="current-password" />
        </div>
        <div class="form-row">
          <label for="pin-new">Novo PIN</label>
          <input type="password" id="pin-new" inputmode="numeric" autocomplete="new-password" />
        </div>
        <div class="form-row">
          <label for="pin-new2">Confirmar novo PIN</label>
          <input type="password" id="pin-new2" inputmode="numeric" autocomplete="new-password" />
        </div>
        <p class="hint err" id="pin-change-err" hidden></p>
        <button type="button" class="btn btn-primary btn-lg btn-block" id="btn-change-pin">Salvar novo PIN</button>
      </section>
      <section class="card">
        <h2 class="card-title">Sincronização</h2>
        <p class="hint">${escapeHtml(sync.message)}</p>
        <p class="hint">Fotos vão no próprio documento da caixa (photosInline). Sem Blaze / Storage.</p>
      </section>
      <section class="card">
        <button type="button" class="btn btn-secondary btn-lg btn-block" id="btn-lock">Bloquear (pedir PIN)</button>
      </section>
    </div>
  `;
}

function bindSettings() {
  $('#btn-back')?.addEventListener('click', () => {
    currentView = 'home';
    render();
  });
  $('#btn-lock')?.addEventListener('click', () => {
    setSessionUnlocked(false);
    currentView = 'pin';
    render();
  });
  $('#btn-change-pin')?.addEventListener('click', () => {
    const err = $('#pin-change-err');
    const cur = ($('#pin-current')?.value || '').trim();
    const n1 = ($('#pin-new')?.value || '').trim();
    const n2 = ($('#pin-new2')?.value || '').trim();
    const effective = getEffectivePin(TEAM_PIN);
    if (cur !== effective) {
      err.hidden = false;
      err.textContent = 'PIN atual incorreto.';
      return;
    }
    if (n1.length < 4) {
      err.hidden = false;
      err.textContent = 'Novo PIN deve ter pelo menos 4 dígitos.';
      return;
    }
    if (n1 !== n2) {
      err.hidden = false;
      err.textContent = 'A confirmação não confere.';
      return;
    }
    setPinOverride(n1);
    err.hidden = true;
    toast('PIN atualizado neste aparelho');
    $('#pin-current').value = '';
    $('#pin-new').value = '';
    $('#pin-new2').value = '';
  });
}

/* ---------- Backup ---------- */
function renderBackup() {
  const st = getDurabilityStatus(records);
  const backups = listAutoBackups();
  const backupItems = backups.length
    ? backups
        .map(
          (b) => `
      <li class="auto-backup-item">
        <div class="auto-backup-meta">
          <strong>${escapeHtml(formatDateBR(b.at))}</strong>
          <span class="muted">${b.count} caixa(s)</span>
        </div>
        <button type="button" class="btn btn-outline btn-sm" data-restore="${escapeAttr(b.id)}">Restaurar</button>
      </li>`
        )
        .join('')
    : '<p class="hint">Nenhum auto-backup ainda. Salve uma caixa para criar.</p>';

  return `
    <div class="screen backup-screen">
      ${headerHtml({ showBack: true, compact: true, title: 'Backup' })}
      <section class="card status-card">
        <h2 class="card-title">Estado neste aparelho</h2>
        <ul class="status-list">
          <li><span>Caixas</span><strong>${st.count}</strong></li>
          <li><span>Último save</span><strong>${escapeHtml(st.lastSaveAt ? formatDateBR(st.lastSaveAt) : '—')}</strong></li>
          <li><span>Último auto-backup</span><strong>${escapeHtml(st.lastAutoBackupAt ? formatDateBR(st.lastAutoBackupAt) : '—')}</strong></li>
        </ul>
        <p class="hint warn-text">Apagar dados do site no Safari (ou limpar cache) apaga o localStorage. Guarde os JSON baixados em Arquivos / iCloud.</p>
      </section>
      <section class="card">
        <h2 class="card-title">Download obrigatório</h2>
        <p class="hint">Baixa só metadados (leve, com photoCount). Guarde o ficheiro fora do navegador.</p>
        <button type="button" class="btn btn-success btn-lg btn-block" id="btn-download-now">
          Baixar backup agora (obrigatório guardar)
        </button>
      </section>
      <section class="card">
        <h2 class="card-title">Backup completo com fotos</h2>
        <p class="hint warn-text">Pode ficar muito grande (fotos em base64). Use só quando precisar de cópia completa.</p>
        <button type="button" class="btn btn-secondary btn-lg btn-block" id="btn-full-photos">
          Backup completo com fotos
        </button>
      </section>
      <section class="card">
        <h2 class="card-title">Auto-backups neste aparelho</h2>
        <p class="hint">Últimos ${backups.length} de até 30 snapshots no localStorage.</p>
        <ul class="auto-backup-list" id="auto-backup-list">
          ${backupItems}
        </ul>
      </section>
      <section class="card">
        <h2 class="card-title">Importar JSON</h2>
        <p class="hint">Mescla registros pelo id (atualiza se o importado for mais recente). Pedirá confirmação.</p>
        <label class="btn btn-secondary btn-lg btn-block file-btn">
          Escolher arquivo…
          <input type="file" id="import-file" accept="application/json,.json" hidden />
        </label>
      </section>
    </div>
  `;
}

function bindBackup() {
  $('#btn-back')?.addEventListener('click', () => {
    currentView = 'home';
    render();
  });
  $('#btn-download-now')?.addEventListener('click', () => {
    downloadMetadataBackup();
    toast('Backup (metadados) baixado — guarde em Arquivos/iCloud', 'ok', 4000);
  });
  $('#btn-full-photos')?.addEventListener('click', () => {
    if (
      !confirm(
        'Backup completo inclui fotos em base64 e pode ficar MUITO grande (vários MB). Continuar?'
      )
    ) {
      return;
    }
    doExportFull();
  });
  $('#import-file')?.addEventListener('change', (e) => doImport(e));
  $$('[data-restore]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.restore;
      if (
        !confirm(
          'Restaurar este auto-backup? Os dados atuais neste aparelho serão substituídos pelos do snapshot.'
        )
      ) {
        return;
      }
      const restored = restoreFromAutoBackup(id);
      if (!restored) {
        toast('Falha ao restaurar', 'err');
        return;
      }
      records = restored;
      toast('Restaurado do auto-backup', 'ok');
      currentView = 'home';
      render();
    });
  });
}

async function doExportFull() {
  const MAX_PHOTO_BYTES = 1_200_000;
  const MAX_TOTAL = 12_000_000;
  let totalEst = 0;
  const photosNote = [];
  const outRecords = [];
  let includePhotos = true;

  for (const r of records) {
    const copy = { ...r, photos: [] };
    delete copy.photosInline; // fotos vão em photos[] (IDB); evita duplicar base64 enorme
    if (includePhotos) {
      try {
        const photos = await listPhotosForRecord(r.id);
        for (const p of photos) {
          if (!p.blob) continue;
          if (p.blob.size > MAX_PHOTO_BYTES) {
            photosNote.push(
              `Foto grande omitida em ${r.clientName} (${Math.round(p.blob.size / 1024)} KB)`
            );
            continue;
          }
          if (totalEst + p.blob.size > MAX_TOTAL) {
            photosNote.push(
              'Limite de tamanho do JSON atingido — demais fotos ficam no aparelho.'
            );
            includePhotos = false;
            break;
          }
          const dataUrl = await blobToDataURL(p.blob);
          copy.photos.push({
            id: p.id,
            mime: p.mime,
            createdAt: p.createdAt,
            dataUrl,
          });
          totalEst += p.blob.size;
        }
      } catch (_) {}
    }
    outRecords.push(copy);
  }

  const payload = {
    app: 'carol-guerreiro-embalagem',
    kind: 'full-with-photos',
    exportedAt: new Date().toISOString(),
    records: outRecords,
    notes: photosNote,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  downloadBlob(backupFilename(new Date()), blob);
  toast(
    photosNote.length
      ? 'Backup completo baixado (algumas fotos omitidas)'
      : 'Backup completo baixado',
    'ok',
    4000
  );
}

async function doImport(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (
    !confirm(
      `Importar “${file.name}”? Os registros serão mesclados por id (mais recentes vencem).`
    )
  ) {
    return;
  }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(arr)) throw new Error('JSON sem lista de records');
    const map = new Map(records.map((r) => [r.id, r]));
    let added = 0;
    let updated = 0;
    for (const raw of arr) {
      const n = normalizeRecord(raw);
      if (!n || !n.clientName) continue;
      if (isTombstoned(n.id)) continue; // não ressuscitar excluídos
      const local = map.get(n.id);
      if (!local) {
        map.set(n.id, n);
        added++;
      } else if (String(n.updatedAt) >= String(local.updatedAt)) {
        map.set(n.id, { ...local, ...n });
        updated++;
      }
      if (Array.isArray(raw.photos)) {
        for (const ph of raw.photos) {
          if (!ph?.dataUrl) continue;
          try {
            const blob = dataURLToBlob(ph.dataUrl);
            await addPhoto(n.id, blob, { id: ph.id, createdAt: ph.createdAt });
          } catch (_) {}
        }
      }
      try {
        if (isSyncActive() && !isTombstoned(n.id)) await syncUpsertRecord(map.get(n.id));
      } catch (_) {}
    }
    records = [...map.values()];
    persistLocal();
    pushAutoBackup(records);
    toast(`Importado: ${added} novo(s), ${updated} atualizado(s)`, 'ok');
    currentView = 'home';
    render();
  } catch (err) {
    alert('Falha ao importar: ' + (err.message || err));
  }
}

/* ---------- helpers ---------- */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

/* ---------- boot ---------- */

function migrateRegistrarNames() {
  let changed = false;
  records = records.map((r) => {
    const next = normalizeCreatedBy(r.createdBy);
    if (next && next !== r.createdBy) {
      changed = true;
      return { ...r, createdBy: next, updatedAt: new Date().toISOString() };
    }
    // clear unknown free-text to empty so UI forces pick on next edit? keep as-is mapped empty
    if (r.createdBy && !next) {
      changed = true;
      return { ...r, createdBy: '', updatedAt: new Date().toISOString() };
    }
    return r;
  });
  if (changed) {
    persistLocal();
    // push fixed names to cloud (best-effort)
    if (isSyncActive()) {
      for (const r of records) {
        if (!r?.id) continue;
        if (!isTombstoned(r.id)) syncUpsertRecord(r).catch(() => {});
      }
    }
  }
  const saved = normalizeCreatedBy(getSavedNickname());
  if (saved) setSavedNickname(saved);
}

async function boot() {
  records = loadRecords();
  // Descarta locais já tombstoned (ex.: apagados noutro aparelho nesta sessão anterior)
  getDeletedIds(); // init cache
  purgeLocalTombstoned();
  recoveryBanner = peekRecoveryBanner();
  // Render PIN/UI first — never wait on Firebase/network for first paint
  render();

  let cloudSlow = false;
  const noteSlow = (err, label) => {
    console.warn(label + ':', err);
    if (err && err.code === 'TIMEOUT') cloudSlow = true;
  };

  try {
    await withTimeout(initSync(), 8000);
  } catch (err) {
    noteSlow(err, 'initSync');
  }

  migrateRegistrarNames();

  try {
    await withTimeout(maybePullRemote(), 8000);
  } catch (err) {
    noteSlow(err, 'maybePullRemote');
  }

  try {
    const n = await withTimeout(collapseVanessaDuplicates(), 8000);
    if (n > 0) {
      console.info('Vanessa duplicates collapsed:', n);
    }
  } catch (err) {
    noteSlow(err, 'collapseVanessaDuplicates');
  }

  startRealtimeSync();
  render();
  if (cloudSlow) toast('Nuvem lenta — modo local');

  // Após pull: caixas antigas com fotos só no IDB sobem sozinhas (concorrência 2)
  queueBootPhotoBackfill(2).catch((e) => console.warn('boot photo backfill:', e));

  if ('serviceWorker' in navigator) {
    try {
      let updateToastShown = false;
      const showUpdatingOnce = () => {
        if (updateToastShown) return;
        updateToastShown = true;
        toast('Atualizando app…', '', 3500);
      };
      const reg = await navigator.serviceWorker.register('./sw.js?v=15');
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
      }
      if (reg.waiting) {
        showUpdatingOnce();
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdatingOnce();
            nw.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    } catch (err) {
      console.warn('SW:', err);
    }
  }
}

boot().catch((err) => {
  console.error(err);
  try { render(); } catch (_) {}
  toast('Erro ao iniciar: ' + (err && err.message ? err.message : String(err)));
});
