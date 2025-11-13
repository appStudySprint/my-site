import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'AIzaSyDpSRlKg3wxQPGi5k9BIp6q876I7vLfNoo',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'idea-rate.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'idea-rate',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? 'idea-rate.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '847438048954',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '1:847438048954:web:e02500efc74d370d4c5c83',
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID ?? 'G-005KNF1EK8',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

export { app, auth, db, googleProvider };

