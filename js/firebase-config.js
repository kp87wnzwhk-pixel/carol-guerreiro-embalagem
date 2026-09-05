/**
 * Firebase — deixe SYNC_ENABLED = false para modo 100% local (um aparelho).
 *
 * Para sincronizar entre celulares:
 * 1. Crie um projeto em https://console.firebase.google.com
 * 2. Ative Firestore Database e Storage
 * 3. Cole as credenciais abaixo (firebaseConfig)
 * 4. Defina SYNC_ENABLED = true
 * 5. Regras sugeridas no README (com PIN no app, não no Firebase)
 */
export const SYNC_ENABLED = false;

export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
};

/** Coleção Firestore e caminho no Storage */
export const FIRESTORE_COLLECTION = 'embalagens';
export const STORAGE_PATH_PREFIX = 'embalagens';
