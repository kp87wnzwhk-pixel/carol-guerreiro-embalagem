# Carol Guerreiro Importado — Embalagem

App **estático** (PWA mobile-first) para registrar caixas embaladas no armazém.

**Slogan:** *No Brasil é luxo, com a Carol é barato.*

- Lista de caixas com busca por nome/telefone
- Medidas (C × L × A em cm), peso (kg + g), fotos, observações
- PIN da equipe (padrão temporário: **`2026`**)
- Durabilidade local reforçada (espelho + auto-backups + download automático)
- Backup JSON (exportar / importar)
- Pronto para Firebase Firestore + Storage (desligado por padrão)

## Abrir localmente

Use um servidor HTTP (módulos ES — não abra com `file://`).

```bash
npx --yes serve .
# ou
python3 -m http.server 8080
```

## PIN da equipe

- Padrão em `js/config.js`: `TEAM_PIN = '2026'`
- Sobrescrita neste aparelho: chave `localStorage` `cgi_pack_pin`
- Após o PIN correto, a sessão fica desbloqueada (`sessionStorage`) até fechar a aba
- Em **Configurações** (ícone ⚙): alterar PIN (exige o PIN atual) ou bloquear de novo

## Modo local (padrão)

Com `SYNC_ENABLED = false` em `js/firebase-config.js`:

- Metadados das caixas → `localStorage` (chave principal + espelho)
- Auto-backups → até 30 snapshots em `cgi_pack_auto_backups_v1`
- Fotos → IndexedDB
- Funciona offline em **um** aparelho

A lista começa **vazia** (sem clientes inventados).

### Limite honesto do Safari / iPhone

**Apagar dados do site** (Safari → Definições → Avançadas / Dados de sites, ou “Limpar histórico e dados”) **apaga** `localStorage` e IndexedDB deste app. O espelho e os auto-backups **também somem** nesse caso — estão no mesmo armazenamento do navegador.

Por isso o app:

1. Grava em dual-write (`cgi_pack_records_v1` + `cgi_pack_records_mirror_v1`)
2. Mantém histórico de auto-backups no aparelho
3. **Baixa automaticamente um JSON leve** (só metadados / `photoCount`) a cada save — **guarde esse ficheiro em Arquivos / iCloud Drive**
4. Oferece “Backup completo com fotos” (base64) quando precisar de cópia pesada

**Você DEVE guardar os JSON descarregados fora do Safari.** Sem isso, limpar dados do site = perda dos registos locais.

Para **vários aparelhos / nuvem**, configure Firebase (secção abaixo). O modo local sozinho **não** substitui sync multi-dispositivo.

## Durabilidade e backups

| Camada | O quê |
|--------|--------|
| Primary | `cgi_pack_records_v1` |
| Mirror | `cgi_pack_records_mirror_v1` (mesmos dados) |
| Auto-backups | `cgi_pack_auto_backups_v1` — últimos 30 `{ id, at, count, data }` |
| Download automático | A cada create/edit: `carol-embalagem-backup-YYYY-MM-DD-HHmm.json` (metadados) |
| Toast | “Salvo no aparelho ✓ · Backup automático #N” |
| Arranque | Se primary faltar/corromper → restaura mirror ou último auto-backup + banner “Dados recuperados do backup automático” |

Ecrã **Backup**:

- Botão verde **Baixar backup agora (obrigatório guardar)**
- Lista de auto-backups com **Restaurar** (confirmação)
- **Backup completo com fotos** (aviso de tamanho)
- Importar JSON (com confirmação)
- Estado: último save, último auto-backup, contagem

## Sincronização multi-aparelho (Firebase)

1. Crie um projeto gratuito em [Firebase Console](https://console.firebase.google.com)
2. Ative **Firestore Database** (modo produção ou teste; ajuste as regras)
3. Ative **Storage**
4. Em Configurações do projeto → Seus apps → Web: copie o objeto `firebaseConfig`
5. Cole em `js/firebase-config.js` e defina:

```js
export const SYNC_ENABLED = true;
```

6. Coleção Firestore: `embalagens`  
   Fotos no Storage: `embalagens/{id}/…`

### Regras sugeridas (teste / equipe pequena)

O app usa PIN no cliente — **não** substitui autenticação Firebase. Para produção, prefira Auth + regras por usuário. Em teste rápido (só equipe interna):

**Firestore**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /embalagens/{doc} {
      allow read, write: if true; // TROQUE por Auth em produção
    }
  }
}
```

**Storage**

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /embalagens/{allPaths=**} {
      allow read, write: if true; // TROQUE por Auth em produção
    }
  }
}
```

## GitHub Pages

1. Suba a pasta para um repositório GitHub
2. **Settings → Pages** → branch `main` / pasta `/ (root)`
3. Abra `https://<usuario>.github.io/<repo>/`
4. No celular: **Adicionar à tela inicial** (PWA)

O service worker usa cache `cgi-pack-v2` — após deploy, feche e reabra o PWA (ou limpe só o cache do SW) para receber a atualização.

## Estrutura

```
index.html
css/styles.css
js/app.js
js/config.js          ← TEAM_PIN + STORAGE_KEYS
js/storage.js         ← dual-write, auto-backups, recovery
js/db.js              ← IndexedDB fotos
js/sync.js
js/firebase-config.js ← SYNC_ENABLED + credenciais
manifest.json
sw.js                 ← cache cgi-pack-v2
icons/
README.md
```

## Privacidade

Telefones e fotos ficam no navegador (e no Firebase se a sync estiver ligada). Use HTTPS em produção e restrinja as regras do Firebase.
