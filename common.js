// Общая часть: подключение к Firebase, синхронизация часов, форматирование.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import {
  getFirestore, doc, collection, query, where, onSnapshot, getDoc, getDocFromCache, getDocs,
  setDoc, updateDoc, writeBatch, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

export { doc, collection, query, where, onSnapshot, getDoc, getDocs, setDoc, updateDoc, writeBatch, serverTimestamp };

export const GAME_ID = 'main';
export const COUNTDOWN_MS = 3000;

let app, auth;
export let db;

export function configured() { return !String(firebaseConfig.apiKey).includes('ВСТАВЬТЕ'); }

export async function connect() {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  const user = await new Promise((resolve, reject) => {
    onAuthStateChanged(auth, (u) => {
      if (u) resolve(u);
      else signInAnonymously(auth).catch(reject);
    });
  });
  return user.uid;
}

export const gameRef = () => doc(db, 'games', GAME_ID);

// Часы: серверное время = Date.now() + offset.
// Измеряем, записывая в базу «серверное время» и засекая, сколько занял запрос.
export const Clock = {
  offset: 0,
  rtt: null,
  uid: null,
  now() { return Date.now() + this.offset; },
  async sync(samples = 4) {
    let best = null;
    for (let i = 0; i < samples; i++) {
      try {
        const ref = doc(db, 'clock', this.uid, 's', String(i));
        const t0 = Date.now();
        await setDoc(ref, { at: serverTimestamp() });
        const t1 = Date.now();
        let snap;
        try { snap = await getDocFromCache(ref); } catch (_) { snap = null; }
        let at = snap && snap.exists() ? snap.data({ serverTimestamps: 'none' }).at : null;
        if (!at) { snap = await getDoc(ref); at = snap.data().at; }
        const rtt = t1 - t0;
        if (!best || rtt < best.rtt) best = { rtt, offset: at.toMillis() - (t0 + t1) / 2 };
      } catch (e) { console.warn('clock sync', e); }
    }
    if (best) { this.offset = best.offset; this.rtt = best.rtt; }
    return best;
  },
};

// Данные игры с оценкой серверного времени для ещё не подтверждённых записей
export function gameData(snap) {
  if (!snap.exists()) return null;
  const g = snap.data({ serverTimestamps: 'estimate' });
  g.startAt = g.startedAt ? g.startedAt.toMillis() + (g.countdownMs || COUNTDOWN_MS) : null;
  return g;
}

export function fmtTime(ms) {
  if (ms == null) return '—';
  const neg = ms < 0; ms = Math.abs(ms);
  const cs = Math.floor(ms / 10) % 100, s = Math.floor(ms / 1000) % 60, m = Math.floor(ms / 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return (neg ? '−' : '') + (m ? m + ':' + pad(s) : String(s)) + ',' + pad(cs);
}
export function fmtTarget(ms) {
  if (ms % 1000 === 0 && ms < 60000) return (ms / 1000) + ' сек';
  return fmtTime(ms) + (ms < 60000 ? ' сек' : '');
}
export function fmtDiff(ms) {
  if (ms == null) return '';
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '±';
  return sign + fmtTime(Math.abs(ms)) + ' с';
}
export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const $ = (sel) => document.querySelector(sel);

export function setupError(msg) {
  document.body.innerHTML = `<div style="max-width:560px;margin:15vh auto;padding:24px;font:18px/1.5 system-ui;color:#f3f4fa;text-align:center">${msg}</div>`;
}
