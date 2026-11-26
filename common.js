// Общая часть: подключение к Firebase, синхронизация часов, форматирование.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import {
  initializeFirestore, doc, collection, query, where, onSnapshot, getDoc, getDocFromCache, getDocs,
  setDoc, updateDoc, writeBatch, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js?v=4';

export { doc, collection, query, where, onSnapshot, getDoc, getDocs, setDoc, updateDoc, writeBatch, serverTimestamp };

export const GAME_ID = 'main';
export const COUNTDOWN_MS = 3000;
export const DEBUG = /[?&]debug/.test(location.search);

let app, auth;
export let db;

export function configured() { return !String(firebaseConfig.apiKey).includes('ВСТАВЬТЕ'); }

export async function connect() {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  // Long-polling вместо потокового соединения: работает через любые мобильные сети,
  // прокси, антивирусы и встроенные браузеры (Telegram, Instagram, сканеры QR).
  db = initializeFirestore(app, { experimentalForceLongPolling: true });
  const user = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('auth timeout')), 20000);
    onAuthStateChanged(auth, (u) => {
      if (u) { clearTimeout(t); resolve(u); }
      else signInAnonymously(auth).catch((e) => { clearTimeout(t); reject(e); });
    });
  });
  return user.uid;
}

export const gameRef = () => doc(db, 'games', GAME_ID);

// Часы: серверное время = Date.now() + offset.
// Измеряем, записывая в базу «серверное время» и засекая, сколько занял запрос.
// Берём самый быстрый замер — у него самая маленькая погрешность (не больше половины его длительности).
export const Clock = {
  offset: 0,
  rtt: null,
  uid: null,
  synced: false,
  lastSync: 0,
  _busy: null,
  now() { return Date.now() + this.offset; },
  sync(samples = 4) {
    if (this._busy) return this._busy;
    this._busy = this._sync(samples).finally(() => { this._busy = null; });
    return this._busy;
  },
  async _sync(samples) {
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
    // Новый замер принимаем, если он не хуже прежнего или прежний устарел (часы устройства могли сдвинуться)
    if (best && (!this.synced || best.rtt <= this.rtt * 2 + 50 || Date.now() - this.lastSync > 60000)) {
      this.offset = best.offset; this.rtt = best.rtt; this.synced = true; this.lastSync = Date.now();
    }
    return best;
  },
};

// Данные игры. Время старта берём ТОЛЬКО подтверждённое сервером:
// у ведущего сразу после «Старта» Firebase подставляет оценку по часам компьютера,
// а они могут расходиться с сервером на секунду и больше.
let pendingStart = null;
export function gameData(snap) {
  if (!snap.exists()) return null;
  const g = snap.data({ serverTimestamps: 'none' });
  const cd = g.countdownMs || COUNTDOWN_MS;
  if (g.startedAt) { g.startAt = g.startedAt.toMillis() + cd; pendingStart = null; }
  else if (g.status === 'running') {
    // запись ещё не подтверждена сервером — временная оценка по синхронизированным часам
    if (!pendingStart || pendingStart.round !== g.round) pendingStart = { round: g.round, at: Clock.now() + cd };
    g.startAt = pendingStart.at;
  } else g.startAt = null;
  g.fromCache = snap.metadata ? snap.metadata.fromCache : false;
  return g;
}

// Отладочная строка (открыть страницу с ?debug)
export function debugLine(extra = '') {
  if (!DEBUG) return;
  let el = document.getElementById('dbg');
  if (!el) {
    el = document.createElement('div'); el.id = 'dbg';
    el.style.cssText = 'position:fixed;left:6px;bottom:6px;font:11px/1.3 monospace;color:#8a90b0;background:rgba(0,0,0,.6);padding:3px 6px;border-radius:6px;z-index:99;pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent = `сдвиг часов ${Math.round(Clock.offset)} мс · замер ${Clock.rtt ?? '—'} мс · ${Clock.synced ? 'синхр.' : 'НЕТ СИНХР.'} ${extra}`;
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
