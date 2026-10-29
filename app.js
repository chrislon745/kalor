'use strict';

// ---------- Grundlagen ----------

const TZ = 'Europe/Berlin';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const round = n => Math.round(Number(n) || 0);
const fmt = n => round(n).toLocaleString('de-DE');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: TZ });
const timeStr = (d = new Date()) => d.toLocaleTimeString('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const shiftDay = (key, n) => { const d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayLabel = key => {
  const today = dayKey();
  if (key === today) return 'Heute';
  if (key === shiftDay(today, -1)) return 'Gestern';
  return new Date(key + 'T12:00:00Z').toLocaleDateString('de-DE', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
};
const weekKey = key => { // Montag der Woche
  const d = new Date(key + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

const store = {
  get(k, def) { try { const v = JSON.parse(localStorage.getItem('bilanz.' + k)); return v ?? def; } catch { return def; } },
  set(k, v) { localStorage.setItem('bilanz.' + k, JSON.stringify(v)); },
};

const db = {
  profile: store.get('profile', null),
  entries: store.get('entries', []),
  weights: store.get('weights', []),
  favorites: store.get('favorites', []),
  settings: store.get('settings', { apiKey: '', model: 'gemini-flash-latest' }),
  save() { ['profile', 'entries', 'weights', 'favorites', 'settings'].forEach(k => store.set(k, this[k])); },
};

// Fotos liegen in IndexedDB (zu groß für localStorage)
const photoDb = {
  open() {
    return this._p ??= new Promise((res, rej) => {
      const r = indexedDB.open('bilanz', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction('photos', mode);
      const out = fn(t.objectStore('photos'));
      t.oncomplete = () => res(out.result ?? out);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx('readonly', s => s.getAll()); },
  put(p) { return this.tx('readwrite', s => s.put(p)); },
  del(id) { return this.tx('readwrite', s => s.delete(id)); },
  clear() { return this.tx('readwrite', s => s.clear()); },
};

let ui = { view: 'today', day: dayKey() };

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}


// ---------- Bedarfsrechnung ----------

const JOBS = {
  sitzend: { label: 'Sitzend', f: 1.25 },
  gemischt: { label: 'Gemischt', f: 1.4 },
  stehend: { label: 'Stehend / gehend', f: 1.55 },
  schwer: { label: 'Körperlich schwer', f: 1.75 },
};
const GOALS = {
  abnehmen: { label: 'Abnehmen', adj: -500, protein: 2.0 },
  halten: { label: 'Halten', adj: 0, protein: 1.6 },
  aufbauen: { label: 'Muskeln aufbauen', adj: 250, protein: 1.8 },
};

function currentWeight() {
  const w = [...db.weights].sort((a, b) => a.day.localeCompare(b.day)).pop();
  return w ? w.kg : db.profile.weight;
}

function calc() {
  const p = db.profile;
  const kg = currentWeight();
  const bmr = 10 * kg + 6.25 * p.height - 5 * p.age + (p.sex === 'm' ? 5 : -161);
  const tdee = bmr * JOBS[p.job].f;
  let suggested = GOALS[p.goal].adj;
  if (p.goal === 'abnehmen') suggested = Math.max(suggested, -0.25 * tdee); // höchstens 25 % Defizit
  const adj = p.customAdj ?? round(suggested);
  return {
    bmr: round(bmr),
    tdee: round(tdee),
    adj,
    suggested: round(suggested),
    target: round(tdee + adj),
    protein: round(kg * GOALS[p.goal].protein),
    kg,
  };
}

function dayTotals(key) {
  const list = db.entries.filter(e => e.day === key);
  const eaten = list.filter(e => e.type === 'food').reduce((s, e) => s + e.kcal, 0);
  const burned = list.filter(e => e.type === 'training').reduce((s, e) => s + e.kcal, 0);
  const protein = list.filter(e => e.type === 'food').reduce((s, e) => s + (e.protein || 0), 0);
  return { list, eaten, burned, protein };
}


// ---------- Gemini ----------

const FALLBACK_MODEL = 'gemini-flash-lite-latest';
const GEMINI_TIMEOUT_MS = 30000;

// Probiert erst das eingestellte Modell, bei Zeitüberschreitung/Überlastung das schnellere Lite-Modell.
async function gemini(parts) {
  const { apiKey, model } = db.settings;
  if (!apiKey) throw new Error('Kein Gemini-Schlüssel hinterlegt. Trag ihn unter Profil ein.');
  let lastErr;
  for (const m of [...new Set([model, FALLBACK_MODEL])]) {
    try {
      return await callGemini(m, apiKey, parts, true);
    } catch (err) {
      lastErr = err;
      if (!err.retry) throw err;
    }
  }
  throw lastErr;
}

async function callGemini(model, apiKey, parts, thinking) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2,
          // Wenig Nachdenken = schnelle Antwort
          ...(thinking ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
        },
      }),
    });
  } catch (err) {
    throw Object.assign(new Error(err.name === 'AbortError'
      ? 'Gemini antwortet gerade nicht. Bitte gleich nochmal versuchen.'
      : 'Keine Verbindung zu Gemini. Prüf dein Internet und versuch es nochmal.'), { retry: true });
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || '';
    // Ältere Modelle kennen thinkingLevel nicht → ohne nochmal
    if (thinking && res.status === 400 && /thinking/i.test(msg)) return callGemini(model, apiKey, parts, false);
    if ((data.error?.details || []).some(d => d.reason === 'ACCESS_TOKEN_TYPE_UNSUPPORTED')) {
      throw new Error('Google lehnt diesen Schlüssel ab. Erstell in AI Studio einen neuen Schlüssel und füg ihn unter Profil ein.');
    }
    throw Object.assign(new Error(msg || 'Gemini-Fehler ' + res.status), { retry: res.status === 429 || res.status >= 500 });
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  try {
    return JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
  } catch {
    throw new Error('Antwort nicht lesbar. Bitte nochmal versuchen.');
  }
}

function bodyInfo() {
  const p = db.profile;
  return `${p.sex === 'm' ? 'Mann' : 'Frau'}, ${p.age} Jahre, ${p.height} cm, ${currentWeight()} kg`;
}

function estimateFood({ text, image }) {
  const prompt =
    'Du bist Ernährungsexperte. Schätze Kalorien und Eiweiß möglichst genau. ' +
    'Nutze typische Portionsgrößen in Deutschland, wenn keine Menge genannt ist. ' +
    (image ? 'Auf dem Foto ist eine Mahlzeit. Schätze die Portion anhand von Tellergröße und Besteck. ' : '') +
    (text ? `Beschreibung: "${text}". ` : '') +
    'Antworte nur als JSON: {"name": "kurzer deutscher Name", "kcal": Zahl, "protein": Gramm als Zahl, ' +
    '"details": "knappe Aufschlüsselung in einem Satz"}';
  const parts = [{ text: prompt }];
  if (image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: image } });
  return gemini(parts);
}

function estimateTraining(text) {
  const c = calc();
  const prompt =
    'Du bist Sportwissenschaftler. Schätze den Energieverbrauch einer Trainingseinheit so genau wie möglich. ' +
    `Person: ${bodyInfo()}. Grundumsatz: ${c.bmr} kcal/Tag (= ${(c.bmr / 1440).toFixed(2)} kcal/Min). ` +
    `Training: "${text}". ` +
    'Vorgehen: ' +
    '1) Zerlege das Training in Abschnitte und nutze JEDE Angabe der Person (Dauer, Tempo, Steigung, Puls, Schritte, Gewichte, Pausen, Gefühl). ' +
    '2) Ist ein Puls genannt, berechne den Bruttoverbrauch dieses Abschnitts mit der Keytel-Formel ' +
    '(Mann: kcal/Min = (-55.0969 + 0.6309*Puls + 0.1988*kg + 0.2017*Alter) / 4.184; ' +
    'Frau: kcal/Min = (-20.4022 + 0.4472*Puls - 0.1263*kg + 0.074*Alter) / 4.184) und prüfe das Ergebnis gegen MET-Werte. ' +
    '3) Ohne Puls nutze MET-Werte (Compendium of Physical Activities) mit dem Körpergewicht. ' +
    '4) Sind Schritte genannt, rechne die Schrittfrequenz (Schritte pro Minute) aus und nutze sie als Maß für Tempo und Intensität ' +
    '(z. B. beim Stairmaster: Stufen pro Minute; beim Gehen/Laufen: Kadenz). ' +
    '5) Ist keine Dauer genannt, nimm eine realistische an und nenne sie. ' +
    '6) Ziehe vom Bruttoverbrauch den Grundumsatz für die Trainingsdauer ab: Gib den NETTO-Mehrverbrauch an. ' +
    'Antworte nur als JSON: {"name": "kurzer deutscher Name", "minutes": Gesamtminuten als Zahl, "kcal": Netto-kcal als Zahl, ' +
    '"details": "Rechenweg knapp, pro Abschnitt eine kurze Angabe", ' +
    '"used": "welche Angaben der Person eingeflossen sind, z. B. Puls 125, 1000 Schritte in 35 Min (≈ 29/Min)", ' +
    '"ignored": "Angaben, die nicht verwertbar waren, sonst leerer String"}';
  return gemini([{ text: prompt }]);
}


// ---------- Ansichten ----------

function render() {
  const app = $('#app');
  $('#nav').hidden = !db.profile;
  if (!db.profile) return renderOnboarding(app);
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === ui.view));
  if (ui.view === 'today') renderToday(app);
  if (ui.view === 'body') renderBody(app);
  if (ui.view === 'settings') renderSettings(app);
}

function renderToday(app) {
  const c = calc();
  const t = dayTotals(ui.day);
  const budget = c.target + t.burned;
  const left = budget - t.eaten;
  const progress = Math.min(1, budget > 0 ? t.eaten / budget : 0);
  const R = 92, C = 2 * Math.PI * R;
  const isToday = ui.day === dayKey();
  ui.wasToday = isToday;

  app.innerHTML = `
    <div class="topbar">
      <button data-day="-1" aria-label="Vortag">‹</button>
      <span class="day">${dayLabel(ui.day)}</span>
      <button data-day="1" aria-label="Nächster Tag" ${isToday ? 'style="visibility:hidden"' : ''}>›</button>
    </div>

    <div class="ring ${left < 0 ? 'over' : ''}">
      <svg viewBox="0 0 210 210" width="210" height="210">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9a3c"/><stop offset="1" stop-color="#d9480f"/></linearGradient></defs>
        <circle cx="105" cy="105" r="${R}" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="12"/>
        <circle cx="105" cy="105" r="${R}" fill="none" stroke="url(#g)" stroke-width="12" stroke-linecap="round"
          stroke-dasharray="${C * progress} ${C}"/>
      </svg>
      <div class="inner">
        <span class="big">${fmt(Math.abs(left))}</span>
        <span class="lbl">${left < 0 ? 'kcal drüber' : 'kcal übrig'}</span>
      </div>
    </div>

    <div class="card">
      <div class="row between small"><span class="muted">Eiweiß</span><span>${fmt(t.protein)} / ${fmt(c.protein)} g</span></div>
      <div class="bar" style="margin-top:8px"><div style="width:${Math.min(100, t.protein / c.protein * 100)}%"></div></div>
    </div>

    <div class="grid2" style="margin-top:10px">
      <div class="card stat"><div class="k">Gegessen</div><div class="v">${fmt(t.eaten)}</div></div>
      <div class="card stat"><div class="k">Training</div><div class="v">+${fmt(t.burned)}</div></div>
    </div>
    <p class="small muted center" style="margin:10px 0 0">Ziel ${fmt(c.target)} kcal (${c.adj > 0 ? '+' : ''}${fmt(c.adj)}) · mit Training ${fmt(budget)}</p>

    <div class="actions">
      <button class="btn primary big" id="add-food"><span class="ico">📷</span>Essen</button>
      <button class="btn big" id="add-training"><span class="ico">🏋️</span>Training</button>
    </div>

    ${t.list.length ? `<h2>Einträge</h2><div class="card">${t.list
      .sort((a, b) => a.time.localeCompare(b.time))
      .map(e => `
        <div class="entry">
          <div class="dot">${e.type === 'food' ? '🍽' : '🔥'}</div>
          <div class="grow">
            <div class="name">${esc(e.name)}</div>
            <div class="sub">${e.time}${e.type === 'food' ? ` · ${fmt(e.protein)} g Eiweiß` : e.minutes ? ` · ${e.minutes} Min` : ''}</div>
          </div>
          <div class="kcal ${e.type === 'training' ? 'plus' : ''}">${e.type === 'training' ? '+' : ''}${fmt(e.kcal)}</div>
          <button class="del" data-del="${e.id}" aria-label="Löschen">×</button>
        </div>`).join('')}</div>` : ''}
  `;

  $$('[data-day]', app).forEach(b => b.onclick = () => { ui.day = shiftDay(ui.day, +b.dataset.day); render(); });
  $('#add-food').onclick = openFood;
  $('#add-training').onclick = openTraining;
  $$('[data-del]', app).forEach(b => b.onclick = () => {
    const e = db.entries.find(x => x.id === b.dataset.del);
    if (!confirm(`„${e.name}“ löschen?`)) return;
    db.entries = db.entries.filter(x => x.id !== e.id);
    db.save();
    render();
  });
}

function addEntry(e) {
  const now = new Date();
  db.entries.push({ id: uid(), day: ui.day, time: ui.day === dayKey() ? timeStr(now) : '12:00', ...e, kcal: round(e.kcal), protein: round(e.protein) });
  db.save();
  closeSheet();
  render();
}


// ---------- Sheet (Eingabe-Fenster) ----------

let scanStream = null;

function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false;
  $$('[data-close]').forEach(b => b.onclick = closeSheet);
}

function closeSheet() {
  stopScan();
  stopDictation();
  $('#sheet').hidden = true;
}

let recognition = null;
function stopDictation() {
  if (recognition) { recognition.onend = null; recognition.stop(); recognition = null; }
  $$('.mic.rec').forEach(m => m.classList.remove('rec'));
}

function dictate(textarea, btn) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Spracheingabe nicht verfügbar – nutze das Mikrofon der Tastatur.');
  if (recognition) return stopDictation();
  const start = textarea.value ? textarea.value.trim() + ' ' : '';
  recognition = new SR();
  recognition.lang = 'de-DE';
  recognition.interimResults = true;
  // Android-Chrome liefert im Dauer-Modus jeden Zwischenstand erneut als eigenes Ergebnis
  // (→ "500 500 g 500 g …"). Ein Satz pro Aufnahme; nochmal tippen hängt weiteren Text an.
  recognition.continuous = false;
  recognition.onresult = ev => {
    const last = ev.results[ev.results.length - 1];
    textarea.value = start + last[0].transcript.trim();
  };
  recognition.onerror = ev => { if (ev.error !== 'aborted') toast('Spracheingabe: ' + ev.error); };
  recognition.onend = () => stopDictation();
  btn.classList.add('rec');
  recognition.start();
}

function sheetHead(title) {
  return `<div class="sheet-title"><h2>${title}</h2><button class="x" data-close aria-label="Schließen">×</button></div>`;
}

function loading(el, msg) {
  el.innerHTML = `<div class="result center"><div class="spinner"></div><p class="small muted">${msg}</p></div>`;
}

function showError(el, err) {
  el.innerHTML = `<div class="result" style="border-color:var(--danger)"><p style="margin:0">${esc(err.message || err)}</p></div>`;
}

// Ergebnis-Karte mit editierbaren Werten
function resultForm(el, r, type) {
  el.innerHTML = `
    <div class="result">
      <label class="f"><span>Bezeichnung</span><input id="r-name" value="${esc(r.name)}"></label>
      <div class="grid2">
        <label class="f"><span>kcal${type === 'training' ? ' verbrannt' : ''}</span><input id="r-kcal" type="number" inputmode="numeric" value="${round(r.kcal)}"></label>
        ${type === 'food'
          ? `<label class="f"><span>Eiweiß (g)</span><input id="r-protein" type="number" inputmode="numeric" value="${round(r.protein)}"></label>`
          : `<label class="f"><span>Minuten</span><input id="r-min" type="number" inputmode="numeric" value="${round(r.minutes)}"></label>`}
      </div>
      ${r.details ? `<div class="details">${esc(r.details)}</div>` : ''}
      ${r.used ? `<div class="details"><span style="color:var(--accent)">✓ Berücksichtigt:</span> ${esc(r.used)}</div>` : ''}
      ${r.ignored ? `<div class="details"><span style="color:var(--danger)">✗ Nicht verwertet:</span> ${esc(r.ignored)}</div>` : ''}
      <button class="btn primary" id="r-save">Eintragen</button>
      ${type === 'food' ? `<button class="btn ghost" id="r-fav" style="margin-top:8px">☆ Eintragen + als Favorit</button>` : ''}
    </div>`;
  const read = () => ({
    type,
    name: $('#r-name').value.trim() || (type === 'food' ? 'Essen' : 'Training'),
    kcal: +$('#r-kcal').value,
    protein: type === 'food' ? +$('#r-protein').value : 0,
    minutes: type === 'training' ? +$('#r-min').value : undefined,
  });
  $('#r-save').onclick = () => addEntry(read());
  if (type === 'food') {
    $('#r-fav').onclick = () => {
      const e = read();
      db.favorites = db.favorites.filter(f => f.name !== e.name);
      db.favorites.unshift({ name: e.name, kcal: round(e.kcal), protein: round(e.protein) });
      addEntry(e);
      toast('Als Favorit gespeichert');
    };
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}


// ---------- Essen ----------

function openFood() {
  openSheet(`
    ${sheetHead('Essen')}
    <div class="tools">
      <button id="f-photo"><span class="ico">📷</span>Foto</button>
      <button id="f-scan"><span class="ico">▥</span>Barcode</button>
      <button id="f-manual"><span class="ico">✎</span>Manuell</button>
    </div>
    ${db.favorites.length ? `<div style="margin-bottom:10px">${db.favorites.slice(0, 12).map((f, i) =>
      `<button class="chip" data-fav="${i}">★ ${esc(f.name)} <span class="muted">${fmt(f.kcal)}</span></button>`).join('')}</div>` : ''}
    <div class="input-mic">
      <textarea id="f-text" placeholder="z. B. 2 Brötchen mit Käse und ein Cappuccino"></textarea>
      <button class="mic" id="f-mic" aria-label="Sprechen">🎙</button>
    </div>
    <button class="btn primary" id="f-go" style="margin-top:10px">Schätzen</button>
    <div id="f-out"></div>
  `);
  const out = $('#f-out');
  $('#f-mic').onclick = e => dictate($('#f-text'), e.currentTarget);
  $('#f-go').onclick = async () => {
    const text = $('#f-text').value.trim();
    if (!text) return toast('Beschreib kurz, was du gegessen hast.');
    stopDictation();
    loading(out, 'Gemini schätzt …');
    try { resultForm(out, await estimateFood({ text }), 'food'); } catch (err) { showError(out, err); }
  };
  $('#f-photo').onclick = () => $('#file-food').click();
  $('#file-food').onchange = async ev => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    loading(out, 'Foto wird analysiert …');
    try {
      const image = await toJpegBase64(file, 1024);
      resultForm(out, await estimateFood({ text: $('#f-text').value.trim(), image }), 'food');
    } catch (err) { showError(out, err); }
  };
  $('#f-manual').onclick = () => resultForm(out, { name: '', kcal: '', protein: '' }, 'food');
  $('#f-scan').onclick = () => startScan(out);
  $$('[data-fav]').forEach(b => b.onclick = () => {
    const f = db.favorites[+b.dataset.fav];
    resultForm(out, f, 'food');
  });
}

async function toJpegBase64(file, max) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = round(img.width * scale);
  c.height = round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82).split(',')[1];
}

function stopScan() {
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
}

async function startScan(out) {
  out.innerHTML = `
    <div class="result">
      <video class="scan" id="scan-video" playsinline muted></video>
      <div class="row" style="margin-top:10px">
        <input id="scan-code" inputmode="numeric" placeholder="oder Barcode-Nummer eingeben">
        <button class="btn ghost" id="scan-go" style="width:auto;padding:13px 16px">OK</button>
      </div>
    </div>`;
  $('#scan-go').onclick = () => { const c = $('#scan-code').value.trim(); if (c) { stopScan(); lookupBarcode(c, out); } };

  if (!('BarcodeDetector' in window)) { toast('Kamera-Scan hier nicht verfügbar – Nummer eintippen.'); return; }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    toast('Kein Kamerazugriff – Nummer eintippen.');
    return;
  }
  const video = $('#scan-video');
  video.srcObject = scanStream;
  await video.play();
  const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
  const loop = async () => {
    if (!scanStream) return;
    try {
      const codes = await detector.detect(video);
      if (codes.length) {
        stopScan();
        navigator.vibrate?.(60);
        return lookupBarcode(codes[0].rawValue, out);
      }
    } catch { /* nächster Frame */ }
    requestAnimationFrame(loop);
  };
  loop();
}

async function lookupBarcode(code, out) {
  loading(out, 'Produkt wird gesucht …');
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_de,brands,nutriments,serving_quantity`);
    const data = await res.json();
    const p = data.product;
    const kcal100 = p?.nutriments?.['energy-kcal_100g'];
    if (!p || kcal100 == null) throw new Error('Produkt nicht gefunden. Beschreib es per Text oder Foto.');
    const name = [p.brands?.split(',')[0], p.product_name_de || p.product_name].filter(Boolean).join(' – ') || 'Produkt ' + code;
    const prot100 = p.nutriments.proteins_100g || 0;
    out.innerHTML = `
      <div class="result">
        <div class="name" style="font-weight:600">${esc(name)}</div>
        <div class="details">${fmt(kcal100)} kcal · ${fmt(prot100)} g Eiweiß pro 100 g</div>
        <label class="f"><span>Menge (g / ml)</span><input id="bc-g" type="number" inputmode="numeric" value="${round(p.serving_quantity) || 100}"></label>
        <button class="btn primary" id="bc-ok">Weiter</button>
      </div>`;
    $('#bc-ok').onclick = () => {
      const g = +$('#bc-g').value || 0;
      resultForm(out, { name: `${name} (${g} g)`, kcal: kcal100 * g / 100, protein: prot100 * g / 100 }, 'food');
    };
  } catch (err) { showError(out, err); }
}


// ---------- Training ----------

function openTraining() {
  const recent = [...new Map(db.entries.filter(e => e.type === 'training').reverse().map(e => [e.name, e])).values()].slice(0, 6);
  openSheet(`
    ${sheetHead('Training')}
    ${recent.length ? `<div style="margin-bottom:10px">${recent.map((e, i) =>
      `<button class="chip" data-recent="${i}">↻ ${esc(e.name)} <span class="muted">${fmt(e.kcal)}</span></button>`).join('')}</div>` : ''}
    <div class="input-mic">
      <textarea id="t-text" placeholder="z. B. 75 Min Football-Training, viele Sprints, danach 15 Min Pilates"></textarea>
      <button class="mic" id="t-mic" aria-label="Sprechen">🎙</button>
    </div>
    <button class="btn primary" id="t-go" style="margin-top:10px">Verbrauch schätzen</button>
    <div id="t-out"></div>
  `);
  const out = $('#t-out');
  $('#t-mic').onclick = e => dictate($('#t-text'), e.currentTarget);
  $('#t-go').onclick = async () => {
    const text = $('#t-text').value.trim();
    if (!text) return toast('Beschreib kurz dein Training.');
    stopDictation();
    loading(out, 'Gemini rechnet mit deinen Körperdaten …');
    try { resultForm(out, await estimateTraining(text), 'training'); } catch (err) { showError(out, err); }
  };
  $$('[data-recent]').forEach(b => b.onclick = () => resultForm(out, recent[+b.dataset.recent], 'training'));
}


// ---------- Körper ----------

async function renderBody(app) {
  const ws = [...db.weights].sort((a, b) => a.day.localeCompare(b.day));
  const photos = (await photoDb.all()).sort((a, b) => b.day.localeCompare(a.day));
  const thisWeek = weekKey(dayKey());
  const photoDone = photos.some(p => weekKey(p.day) === thisWeek);
  const c = calc();

  let chart = '';
  const last = ws.slice(-30);
  if (last.length >= 2) {
    const min = Math.min(...last.map(w => w.kg)) - 0.5, max = Math.max(...last.map(w => w.kg)) + 0.5;
    const pts = last.map((w, i) => `${(i / (last.length - 1) * 300).toFixed(1)},${(100 - (w.kg - min) / (max - min) * 100).toFixed(1)}`).join(' ');
    const diff = last[last.length - 1].kg - last[0].kg;
    chart = `
      <svg viewBox="-4 -6 308 112" style="width:100%;height:120px;margin-top:10px">
        <polyline points="${pts}" fill="none" stroke="#ff7a1a" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
      <div class="small muted">${diff <= 0 ? '' : '+'}${diff.toFixed(1).replace('.', ',')} kg seit ${dayLabel(last[0].day)}</div>`;
  }

  app.innerHTML = `
    <h1>Körper</h1>
    <div class="card">
      <div class="row between"><span class="muted">Aktuell</span><span style="font-size:22px;font-weight:600">${c.kg.toLocaleString('de-DE')} kg</span></div>
      ${chart}
      <div class="row" style="margin-top:14px">
        <input id="w-kg" type="number" inputmode="decimal" step="0.1" placeholder="Gewicht heute (kg)">
        <button class="btn primary" id="w-save" style="width:auto;padding:13px 18px">Speichern</button>
      </div>
    </div>

    <h2>Fortschrittsfotos</h2>
    <div class="card">
      ${photoDone
        ? '<p class="small muted" style="margin:0 0 10px">Foto für diese Woche ist drin. Nächstes ab Montag.</p>'
        : '<button class="btn" id="p-add" style="margin-bottom:12px">📷 Wochenfoto aufnehmen</button>'}
      ${photos.length ? `<div class="photos">${photos.map(p => `
        <figure><img src="${p.data}" alt="Foto vom ${p.day}" data-photo="${p.id}"><figcaption>${dayLabel(p.day)}</figcaption></figure>`).join('')}</div>`
        : '<p class="small muted" style="margin:0">Noch keine Fotos. Gleiche Pose, gleiches Licht – dann siehst du den Unterschied.</p>'}
    </div>

    <h2>Deine Zahlen</h2>
    <div class="card small">
      <div class="row between"><span class="muted">Grundumsatz</span><span>${fmt(c.bmr)} kcal</span></div>
      <div class="row between" style="margin-top:6px"><span class="muted">Alltag (ohne Training)</span><span>${fmt(c.tdee)} kcal</span></div>
      <div class="row between" style="margin-top:6px"><span class="muted">${GOALS[db.profile.goal].label}</span><span>${c.adj > 0 ? '+' : ''}${fmt(c.adj)} kcal</span></div>
      <div class="row between" style="margin-top:6px"><span class="muted">Tagesziel</span><span style="color:var(--accent);font-weight:600">${fmt(c.target)} kcal</span></div>
      <div class="row between" style="margin-top:6px"><span class="muted">Eiweißziel</span><span>${fmt(c.protein)} g</span></div>
    </div>
  `;

  $('#w-save').onclick = () => {
    const kg = parseFloat($('#w-kg').value.replace(',', '.'));
    if (!(kg > 30 && kg < 300)) return toast('Bitte ein gültiges Gewicht eingeben.');
    const day = dayKey();
    db.weights = db.weights.filter(w => w.day !== day);
    db.weights.push({ day, kg: Math.round(kg * 10) / 10 });
    db.save();
    toast('Gewicht gespeichert – Ziele neu berechnet');
    render();
  };
  if ($('#p-add')) $('#p-add').onclick = () => $('#file-progress').click();
  $('#file-progress').onchange = async ev => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    const data = 'data:image/jpeg;base64,' + await toJpegBase64(file, 1200);
    await photoDb.put({ id: uid(), day: dayKey(), data });
    toast('Wochenfoto gespeichert');
    render();
  };
  $$('[data-photo]').forEach(img => img.onclick = async () => {
    if (!confirm('Dieses Foto löschen?')) return;
    await photoDb.del(img.dataset.photo);
    render();
  });
}


// ---------- Profil / Einstellungen ----------

function seg(name, options, value) {
  return `<div class="seg" data-seg="${name}">${Object.entries(options).map(([k, v]) =>
    `<button type="button" data-v="${k}" class="${k === value ? 'on' : ''}">${v.label ?? v}</button>`).join('')}</div>`;
}

function bindSegs(root, values) {
  $$('[data-seg]', root).forEach(s => s.onclick = ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    $$('button', s).forEach(x => x.classList.toggle('on', x === b));
    values[s.dataset.seg] = b.dataset.v;
    s.dispatchEvent(new Event('segchange', { bubbles: true }));
  });
}

function profileFields(p) {
  return `
    <label class="f"><span>Geschlecht</span>${seg('sex', { m: 'Mann', w: 'Frau' }, p.sex)}</label>
    <div class="grid2">
      <label class="f"><span>Alter</span><input id="p-age" type="number" inputmode="numeric" value="${p.age ?? ''}"></label>
      <label class="f"><span>Größe (cm)</span><input id="p-height" type="number" inputmode="numeric" value="${p.height ?? ''}"></label>
    </div>
    <label class="f"><span>Gewicht (kg)</span><input id="p-weight" type="number" inputmode="decimal" step="0.1" value="${p.weight ?? ''}"></label>
    <label class="f"><span>Arbeit / Alltag (ohne Training)</span>${seg('job', JOBS, p.job)}</label>
    <label class="f"><span>Ziel</span>${seg('goal', GOALS, p.goal)}</label>`;
}

function readProfile(values) {
  const p = {
    ...values,
    age: +$('#p-age').value,
    height: +$('#p-height').value,
    weight: parseFloat(String($('#p-weight').value).replace(',', '.')),
  };
  if (!p.sex || !p.job || !p.goal) throw new Error('Bitte alle Felder auswählen.');
  if (!(p.age >= 14 && p.age <= 100)) throw new Error('Bitte ein gültiges Alter eingeben.');
  if (!(p.height >= 120 && p.height <= 230)) throw new Error('Bitte eine gültige Größe eingeben.');
  if (!(p.weight >= 30 && p.weight <= 300)) throw new Error('Bitte ein gültiges Gewicht eingeben.');
  return p;
}

function renderOnboarding(app) {
  const values = { sex: '', job: 'sitzend', goal: '' };
  app.innerHTML = `
    <div class="logo" style="margin-top:20px">KALOR</div>
    <p class="muted" style="margin-top:4px">Training rein, Essen rein, fertig. Erst kurz zu dir.</p>
    <div class="step">1 · KÖRPERDATEN</div>
    <div class="card" style="margin-top:8px">${profileFields(values)}</div>
    <div class="step">2 · GEMINI-SCHLÜSSEL</div>
    <div class="card" style="margin-top:8px">
      <p class="small muted" style="margin-top:0">Kostenlos unter <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> → „API-Schlüssel erstellen“ → kopieren. Geht auch später unter Profil.</p>
      ${keyField('p-key', '')}
    </div>
    <button class="btn primary" id="ob-next" style="margin-top:18px">Weiter</button>
    <div id="ob-out"></div>`;
  bindSegs(app, values);
  $('#p-key-paste').onclick = () => pasteInto($('#p-key'));
  $('#ob-next').onclick = () => {
    let p;
    try { p = readProfile(values); } catch (err) { return toast(err.message); }
    db.settings.apiKey = $('#p-key').value.trim();
    db.profile = { ...p, customAdj: null };
    db.weights = [{ day: dayKey(), kg: p.weight }];
    const c = calc();
    db.profile = null; // erst nach Bestätigung speichern
    app.innerHTML = `
      <div class="logo" style="margin-top:20px">KALOR</div>
      <div class="step">3 · DEIN TAGESZIEL</div>
      <div class="card target-box" style="margin-top:8px">
        <div class="big">${fmt(c.target)}</div>
        <div class="muted">kcal pro Tag – ohne Training</div>
        <p class="small muted">Alltag ${fmt(c.tdee)} kcal ${c.adj >= 0 ? '+' : '−'} ${fmt(Math.abs(c.adj))} kcal ${GOALS[p.goal].label.toLowerCase()}.
        Training kommt jeden Tag obendrauf. Eiweißziel: ${fmt(c.protein)} g.</p>
      </div>
      <label class="f" style="margin-top:14px"><span>Anpassen: kcal pro Tag über/unter Bedarf (Vorschlag ${c.suggested > 0 ? '+' : ''}${fmt(c.suggested)})</span>
        <input id="ob-adj" type="number" inputmode="numeric" value="${c.adj}"></label>
      <button class="btn primary" id="ob-done">Los geht's</button>`;
    $('#ob-done').onclick = () => {
      const adj = round($('#ob-adj').value);
      db.profile = { ...p, customAdj: adj === c.suggested ? null : adj };
      db.save();
      ui.view = 'today';
      render();
    };
  };
}

function keyField(id, value) {
  return `<div class="row">
      <input id="${id}" value="${esc(value)}" placeholder="Schlüssel einfügen" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button type="button" class="btn ghost" id="${id}-paste" style="width:auto;padding:13px 14px">Einfügen</button>
    </div>`;
}

async function pasteInto(input) {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) { toast('Zwischenablage ist leer – Schlüssel erst in AI Studio kopieren.'); return false; }
    input.value = text;
    return true;
  } catch {
    toast('Kein Zugriff auf die Zwischenablage. Bitte beim Nachfragen „Zulassen“ tippen.');
    return false;
  }
}

function renderSettings(app) {
  const p = db.profile;
  const values = { sex: p.sex, job: p.job, goal: p.goal };
  const c = calc();
  app.innerHTML = `
    <h1>Profil</h1>
    <div class="card">${profileFields({ ...p, weight: c.kg })}
      <label class="f"><span>Über/unter Bedarf (kcal/Tag) – leer = Vorschlag (${c.suggested > 0 ? '+' : ''}${fmt(c.suggested)})</span>
        <input id="s-adj" type="number" inputmode="numeric" value="${p.customAdj ?? ''}" placeholder="${c.suggested}"></label>
      <button class="btn primary" id="s-save">Speichern</button>
    </div>

    <h2>Gemini</h2>
    <div class="card">
      <label class="f"><span>API-Schlüssel (<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">kostenlos holen</a>)</span>
        ${keyField('s-key', db.settings.apiKey)}</label>
      <label class="f"><span>Modell</span><input id="s-model" value="${esc(db.settings.model)}"></label>
      <button class="btn ghost" id="s-key-save">Speichern</button>
    </div>

    <h2>Daten</h2>
    <div class="card">
      <p class="small muted" style="margin-top:0">Alles liegt nur auf diesem Handy. Sichere ab und zu eine Datei, z. B. in Google Drive.</p>
      <div class="grid2">
        <button class="btn ghost" id="s-export">Exportieren</button>
        <button class="btn ghost" id="s-import">Importieren</button>
      </div>
      <button class="btn danger" id="s-reset" style="margin-top:10px">Alles löschen</button>
    </div>`;
  bindSegs(app, values);

  $('#s-save').onclick = () => {
    let np;
    try { np = readProfile(values); } catch (err) { return toast(err.message); }
    const adjRaw = $('#s-adj').value.trim();
    if (np.weight !== c.kg) {
      const day = dayKey();
      db.weights = db.weights.filter(w => w.day !== day);
      db.weights.push({ day, kg: np.weight });
    }
    db.profile = { ...np, customAdj: adjRaw === '' ? null : round(adjRaw) };
    db.save();
    toast(`Gespeichert – Tagesziel ${fmt(calc().target)} kcal`);
    render();
  };
  $('#s-key-paste').onclick = async () => {
    if (await pasteInto($('#s-key'))) $('#s-key-save').click();
  };
  $('#s-key-save').onclick = () => {
    db.settings.apiKey = $('#s-key').value.trim();
    db.settings.model = $('#s-model').value.trim() || 'gemini-flash-latest';
    db.save();
    toast('Gespeichert');
  };
  $('#s-export').onclick = exportData;
  $('#s-import').onclick = () => $('#file-import').click();
  $('#file-import').onchange = importData;
  $('#s-reset').onclick = async () => {
    if (!confirm('Wirklich alle Daten auf diesem Handy löschen?')) return;
    Object.keys(localStorage).filter(k => k.startsWith('bilanz.')).forEach(k => localStorage.removeItem(k));
    await photoDb.clear();
    location.reload();
  };
}

async function exportData() {
  const data = {
    app: 'bilanz', version: 1, exported: new Date().toISOString(),
    profile: db.profile, entries: db.entries, weights: db.weights, favorites: db.favorites,
    settings: { model: db.settings.model },
    photos: await photoDb.all(),
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const file = new File([blob], `kalor-${dayKey()}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Kalor-Sicherung' }); return; } catch { /* abgebrochen → Download */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importData(ev) {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'bilanz') throw new Error('Keine Kalor-Sicherung.');
    if (!confirm('Aktuelle Daten durch die Sicherung ersetzen?')) return;
    db.profile = data.profile;
    db.entries = data.entries || [];
    db.weights = data.weights || [];
    db.favorites = data.favorites || [];
    db.settings.model = data.settings?.model || db.settings.model;
    db.save();
    await photoDb.clear();
    for (const p of data.photos || []) await photoDb.put(p);
    toast('Sicherung geladen');
    render();
  } catch (err) {
    toast('Import fehlgeschlagen: ' + err.message);
  }
}


// ---------- Start ----------

$$('#nav button').forEach(b => b.onclick = () => {
  ui.view = b.dataset.view;
  if (ui.view === 'today') ui.day = dayKey();
  window.scrollTo(0, 0);
  render();
});

document.addEventListener('visibilitychange', () => {
  // Nach Mitternacht beim Zurückkehren auf den neuen Tag springen
  if (!document.hidden && ui.view === 'today' && ui.wasToday && ui.day !== dayKey()) {
    ui.day = dayKey();
    render();
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

render();
