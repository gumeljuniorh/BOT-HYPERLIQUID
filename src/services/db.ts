import { initializeApp, cert, getApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// In this environment, we might not have a service account JSON file.
// We try to initialize with default credentials if possible.
const firebaseApp = getApps().length === 0 ? initializeApp() : getApp();
export const db = getFirestore(firebaseApp);
