/**
 * Firebase — deixe SYNC_ENABLED = false para modo 100% local (um aparelho).
 *
 * Para sincronizar entre celulares:
 * 1. Crie um projeto em https://console.firebase.google.com
 * 2. Ative Firestore Database e Storage
 * 3. Cole as credenciais abaixo (firebaseConfig)
 * 4. Defina SYNC_ENABLED = true
 * 5. Regras sugeridas no README (com PIN no app, não no Firebase)
 *
 * Não inicialize Analytics neste app estático.
 */
export const SYNC_ENABLED = true;

export const firebaseConfig = {
  apiKey: 'AIzaSyD_MZWaKejOAwclw_4YC6rJd--5hoC4o24',
  authDomain: 'carol-embalagem.firebaseapp.com',
  projectId: 'carol-embalagem',
  storageBucket: 'carol-embalagem.firebasestorage.app',
  messagingSenderId: '215450406714',
  appId: '1:215450406714:web:2385a61bcd942fc47a8a03',
  measurementId: 'G-HSF638QS2N',
};

/** Coleção Firestore e caminho no Storage */
export const FIRESTORE_COLLECTION = 'embalagens';
export const STORAGE_PATH_PREFIX = 'embalagens';
