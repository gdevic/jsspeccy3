import { b64urlDecode } from './playzx-crypto.js';

const SESSION_URL = 'https://baltazarstudios.com/PlayZX/v2/session.php';
const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const TURNSTILE_SITE_KEY = '0x4AAAAAAE2oLpIBDtRgk1jO';
const PLAYZX_HOSTS = ['baltazarstudios.com'];
const CLIENT_VERSION = '2.0.0';

export function isPlayZXAvailable() {
    return typeof location !== 'undefined' && PLAYZX_HOSTS.includes(location.hostname);
}

let cached = null; // {sid, keyBytes, exp}
let turnstilePromise = null;
let mintPromise = null;

function loadTurnstile() {
    if (turnstilePromise) return turnstilePromise;
    turnstilePromise = new Promise((resolve, reject) => {
        if (window.turnstile) { resolve(window.turnstile); return; }
        const script = document.createElement('script');
        script.src = TURNSTILE_SCRIPT_URL;
        script.async = true;
        script.onload = () => resolve(window.turnstile);
        script.onerror = () => reject(new Error('Failed to load the verification widget.'));
        document.head.appendChild(script);
    });
    return turnstilePromise;
}

function getTurnstileToken() {
    return loadTurnstile().then((turnstile) => new Promise((resolve, reject) => {
        const container = document.createElement('div');
        Object.assign(container.style, {position: 'fixed', bottom: '8px', right: '8px', zIndex: '999999'});
        document.body.appendChild(container);
        let widgetId;
        const cleanup = () => {
            if (widgetId !== undefined) turnstile.remove(widgetId);
            container.remove();
        };
        widgetId = turnstile.render(container, {
            sitekey: TURNSTILE_SITE_KEY,
            size: 'flexible',
            appearance: 'interaction-only',
            callback: (token) => { cleanup(); resolve(token); },
            'error-callback': () => { cleanup(); reject(new Error('Verification failed.')); },
            'expired-callback': () => { cleanup(); reject(new Error('Verification expired , please retry.')); },
        });
    }));
}

async function mintSession() {
    const token = await getTurnstileToken();
    const body = new URLSearchParams({r: 'Web', v: CLIENT_VERSION, cf: token});
    const response = await fetch(SESSION_URL, {method: 'POST', body});
    if (!response.ok) {
        const detail = await response.json().catch(() => null);
        const err = new Error((detail && detail.message) || `Session request failed (${response.status}).`);
        err.code = detail && detail.error;
        err.status = response.status;
        throw err;
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data.sid !== 'string' || typeof data.key !== 'string') {
        throw new Error('Malformed session response from the PlayZX server. Please try again.');
    }
    let keyBytes;
    try {
        keyBytes = b64urlDecode(data.key);
    } catch (e) {
        throw new Error('Malformed session response from the PlayZX server. Please try again.');
    }
    return {
        sid: data.sid,
        keyBytes,
        exp: Date.now() + Math.max(0, (Number(data.ttl) || 0) - 30) * 1000, // renew a little early
    };
}

export async function getSession() {
    if (cached && Date.now() < cached.exp) return cached;
    if (!mintPromise) {
        mintPromise = mintSession().finally(() => { mintPromise = null; });
    }
    cached = await mintPromise;
    return cached;
}

export function invalidateSession() {
    cached = null;
}
