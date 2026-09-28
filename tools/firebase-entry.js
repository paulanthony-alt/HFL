export { initializeApp } from 'firebase/app';
export {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, updatePassword,
  EmailAuthProvider, reauthenticateWithCredential, connectAuthEmulator,
} from 'firebase/auth';
export {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, runTransaction, writeBatch, getDoc, connectFirestoreEmulator,
} from 'firebase/firestore';
