/**
 * Configuração local do app de embalagem.
 * Altere TEAM_PIN aqui; ou defina localStorage key `cgi_pack_pin` para sobrescrever.
 */
export const TEAM_PIN = '2026';

export const STORAGE_KEYS = {
  records: 'cgi_pack_records_v1',
  recordsMirror: 'cgi_pack_records_mirror_v1',
  autoBackups: 'cgi_pack_auto_backups_v1',
  lastSaveAt: 'cgi_pack_last_save_at_v1',
  deleted: 'cgi_pack_deleted_v1',
  pinOverride: 'cgi_pack_pin',
  sessionUnlock: 'cgi_pack_unlocked',
  nickname: 'cgi_pack_nickname',
  recoveryBanner: 'cgi_pack_recovery_banner',
  trackingTpl: 'cgi_pack_tracking_tpl_v1',
};

export const AUTO_BACKUP_MAX = 30;

export const APP_NAME = 'Carol Guerreiro Importado';
export const SLOGAN = 'No Brasil é luxo, com a Carol é barato.';
