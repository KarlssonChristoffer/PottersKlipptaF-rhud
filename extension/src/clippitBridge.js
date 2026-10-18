// The extension's side of the bridge to the Clippit app (lib/bridge.mjs): a WebSocket to 127.0.0.1 that
// Clippit uses to ask for things it used to get through "Allow JavaScript from Apple Events".
//
// Clippit has to prove itself: the first Clippit to answer pairs with this extension and hands it a key
// (trust on first use); on every later connection it must answer a fresh nonce with HMAC(key, nonce), or
// the extension hangs up and does nothing it asks. "Forget Clippit" in the popup allows a new pairing.
//
// What Clippit may ask, and why each is safe to do without a click:
//   probe   the elements under a zone you just marked on screen (you started it with ⌘⇧K)

import clippitProbe from './zoneProbe.js';

const URL_ = "ws://127.0.0.1:41178/ext";
const BROWSER = /Safari\//.test(navigator.userAgent) && !/Chrome\//.test(navigator.userAgent) ? "safari" : "chromium";

let ws = null, trusted = false, nonce = null;

const store = {
    get: () => new Promise(r => chrome.storage.local.get({ clippitKey: null, clippitRepair: false }, r)),
    set: v => new Promise(r => chrome.storage.local.set(v, r)),
};

async function hmac(key, text) {
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
    return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function rand() {
    return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function handle(m) {
    if (m.type === "paired") {
        const { clippitKey, clippitRepair } = await store.get();
        if (clippitKey && !clippitRepair) { ws.close(); return; }      // already paired with another Clippit
        await store.set({ clippitKey: m.key, clippitRepair: false });
        trusted = true;
        return;
    }
    if (m.type === "proof") {
        const { clippitKey } = await store.get();
        trusted = !!clippitKey && m.nonce === nonce && m.hmac === await hmac(clippitKey, nonce);
        if (!trusted) ws.close();
        return;
    }
    if (m.type === "request") {
        const reply = (data, error) => ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: "reply", id: m.id, data, error }));
        if (!trusted) return reply(null, "not paired");
        try { reply(await answer(m.msg, m.data || {})); } catch (e) { reply(null, String(e && e.message || e)); }
    }
}

async function activeTab() {
    let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) [tab] = await chrome.tabs.query({ active: true });
    if (!tab) throw new Error("no tab in front");
    return tab;
}

async function answer(msg, data) {
    if (msg === "probe") {
        const tab = await activeTab();
        const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: clippitProbe, args: [data.rect] });
        return { url: tab.url, title: tab.title, dom: res && res.result };
    }
    throw new Error("unknown request " + msg);
}

// Opens the connection if it isn't open. Called at startup and whenever a page nudges the background
// (Safari and Chrome put an idle background to sleep, and that closes the socket).
export async function ensureBridge() {
    if (ws && ws.readyState <= 1) return;
    const { clippitKey } = await store.get();
    if (ws && ws.readyState <= 1) return;           // another call got there while we read the key
    try { ws = new WebSocket(URL_); } catch (e) { return; }
    trusted = false;
    ws.onopen = () => { nonce = rand(); ws.send(JSON.stringify({ type: "hello", browser: BROWSER, nonce, paired: !!clippitKey })); };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } handle(m); };
    ws.onclose = () => { ws = null; trusted = false; };
    ws.onerror = () => {};
}

export function bridgeStatus() {
    return { connected: !!ws && ws.readyState === 1 && trusted };
}

export async function forgetClippit() {
    await store.set({ clippitKey: null, clippitRepair: true });
    if (ws) ws.close();
}
