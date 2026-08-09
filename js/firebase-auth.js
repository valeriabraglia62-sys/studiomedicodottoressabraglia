import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';

const firebaseConfig = {
  projectId: "focused-span-1pt51",
  appId: "1:724880593223:web:5c5461be63732ff12e7c62",
  apiKey: "AIzaSyBzdx_zFZ9WO2jp9bp_Zd-nbAbAKH4MUzM",
  authDomain: "focused-span-1pt51.firebaseapp.com",
  storageBucket: "focused-span-1pt51.firebasestorage.app",
  messagingSenderId: "724880593223",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/calendar.events');

let cachedAccessToken = null;

export const initAuth = (onAuthChanged) => {
    return onAuthStateChanged(auth, (user) => {
        if (!user) {
            cachedAccessToken = null;
        }
        if (onAuthChanged) onAuthChanged(user, cachedAccessToken);
    });
};

export const googleSignIn = async () => {
    try {
        const result = await signInWithPopup(auth, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (credential?.accessToken) {
            cachedAccessToken = credential.accessToken;
        }
        return { user: result.user, accessToken: cachedAccessToken };
    } catch (error) {
        console.error('Sign in error:', error);
        throw error;
    }
};

export const getAccessToken = () => cachedAccessToken;

export const logout = async () => {
    await signOut(auth);
    cachedAccessToken = null;
};
