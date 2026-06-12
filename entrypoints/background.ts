import { browser } from 'wxt/browser';
import { QueueItem, GenMode } from '../utils/types';

/**
 * Auto Image Flow — background orchestrator.
 *
 * Drives Google Flow to generate one image per scene and files each download under
 * Auto_Image_Flow/Scene_XX/image_N.jpg. Processes ONE scene at a time so newly-appearing
 * image tiles map unambiguously to the current scene — no dependency on Google's internal
 * API (which makes it far more robust to Flow UI changes).
 */

const IMAGES_PER_SCENE = 1;          // how many images Flow produces per prompt (set Flow to match)
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;
const WHISK_COOLDOWN_MS = 15_000;    // pause between Whisk prompts so we don't trip its rate limit

let queue: QueueItem[] = [];
let currentMode: GenMode = 'image';
let refImageDataUrl: string | null = null;   // optional reference image to lock style/character
let refAttached = false;                      // have we attached it to Flow's composer this batch?
let activeTabId: number | null = null;
let isInjecting = false;
let isInitialized = false;
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let rateLimitCooldownUntil = 0;

const seenTileIds = new Set<string>();             // tiles already accounted for (pre-existing or downloaded)
const sceneDownloadCount = new Map<number, number>();
const urlToFilename = new Map<string, string>();   // image url / uuid → forced relative path
const videoAttempts = new Map<string, number>();   // video tile id → menu-click attempts
let pendingVideoPath: string | null = null;        // next video download's forced path (menu-triggered)
let frameImagesMap = new Map<string, string>();     // popup-uploaded local images: name -> dataUrl
const uploadedFrameNames = new Set<string>();       // names already uploaded to Flow this batch
let pendingSettings: any = null;                    // JSON "settings" block, applied before first scene
let settingsApplied = false;
// --- relay bridge (hands-off jobs from external tools) ---
const RELAY_URL = "http://127.0.0.1:8766";
let relayKey: string | null = null;
let relayOn = false;
let relayJobId: string | null = null;     // job currently being run for the relay
let relayPoll: ReturnType<typeof setInterval> | null = null;
// Whisk: send each prompt, then auto-download the FINISHED images (they're <img> with base64
// data: URLs once rendered — directly downloadable). "Failed" tiles have no img and are skipped.
// Advance when this prompt's tile slots have settled (finished or failed). Cap 2 saved per prompt.
const whiskSceneCount = new Map<number, number>(); // images saved for the current scene
const whiskSeen = new Set<string>();               // fingerprints of images already downloaded
let whiskBaseline = 0;      // tile count captured BEFORE sending the prompt (so growth = this prompt's images)
let whiskLastCount = 0;     // tile count seen last poll (for stability detection)
let whiskStable = 0;        // consecutive polls the count hasn't changed after growing
let whiskWaitPolls = 0;     // polls waited with NO new tiles yet (stuck guard)
let whiskPolls = 0;         // polls since this prompt was sent (min dwell before advancing)

export default defineBackground(() => {
  console.log('[AIF] Auto Image Flow background started');

  // Force our folder structure even when an image arrives via a redirect whose
  // Content-Disposition would otherwise dump it (as uuid.jpg) into the Downloads root.
  if (chrome.downloads?.onDeterminingFilename) {
    chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
      // Semi-auto video: the user downloads the READY clip in Flow; we rename it to the scene
      // path, mark that scene done, and advance to the next prompt automatically.
      if (pendingVideoPath) {
        suggest({ filename: pendingVideoPath, conflictAction: 'uniquify' });
        pendingVideoPath = null;
        const ready = queue.find(q => q.status === 'READY');
        if (ready) { ready.status = 'DOWNLOADED'; broadcastQueue(); processQueue(); }
        return;
      }
      const haystack = `${item.url ?? ''} ${item.finalUrl ?? ''}`;
      const uuid = haystack.match(/[?&]name=([0-9a-fA-F-]{36})/)?.[1];
      const intended =
        urlToFilename.get(item.url) ||
        urlToFilename.get(item.finalUrl) ||
        (uuid ? urlToFilename.get(uuid) : undefined);
      if (intended) suggest({ filename: intended, conflictAction: 'uniquify' });
      else suggest();
    });
  }

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'GET_QUEUE':
        sendResponse({ queue, relayOn, relayJobId });
        return true;

      case 'RELAY_TOGGLE': {
        const { on, tabId } = message as { on: boolean; tabId?: number };
        relayOn = !!on;
        if (tabId) activeTabId = tabId;
        if (relayOn) {
          fetch(RELAY_URL + '/key.txt').then(r => r.ok ? r.text() : null).then(k => {
            relayKey = k ? k.trim() : relayKey;
            chrome.storage.local.set({ relayOn: true, relayKey, relayTabId: activeTabId });
            startRelayPolling();
          }).catch(() => {
            chrome.storage.local.set({ relayOn: true, relayTabId: activeTabId });
            startRelayPolling();
          });
        } else {
          chrome.storage.local.set({ relayOn: false });
          chrome.alarms.clear("relayPoll");
        }
        sendResponse({ relayOn });
        return true;
      }

      case 'RELAY_TICK': {
        // popup-driven fast tick while the popup is open (5s); alarm covers closed.
        relayTick();
        sendResponse({ ok: true });
        return true;
      }

      case 'RELAY_SETKEY': {
        const { key } = message as { key: string };
        relayKey = (key || '').trim() || null;
        sendResponse({ ok: true });
        return true;
      }

      case 'START_QUEUE': {
        const { prompts, tabId, projectName, mode, refImage, frameImages, settings } = message as { prompts: { scene_number: number; prompt: string; start_frame?: string; end_frame?: string; character?: string }[]; tabId: number; projectName?: string; mode?: GenMode; refImage?: string | null; frameImages?: { name: string; dataUrl: string }[]; settings?: unknown };
        activeTabId = tabId;
        currentMode = (mode === 'video' || mode === 'whisk') ? mode : 'image';
        frameImagesMap = new Map((frameImages ?? []).map(f => [f.name.toLowerCase(), f.dataUrl]));
        uploadedFrameNames.clear();
        pendingSettings = settings ?? null;
        settingsApplied = false;
        refImageDataUrl = typeof refImage === 'string' && refImage.startsWith('data:') ? refImage : null;
        refAttached = false;   // new batch → attach the reference again before the first prompt
        const project = sanitizeProject(projectName) || 'Untitled';
        const newItems: QueueItem[] = prompts.map(p => ({
          id: `${project}-${p.scene_number}-${Math.abs(hashString(p.prompt)).toString(36)}`,
          scene_number: p.scene_number,
          prompt: p.prompt,
          status: 'PENDING',
          project,
          mode: currentMode,
          start_frame: p.start_frame,
          end_frame: p.end_frame,
          character: p.character,
        }));
        queue = [...queue, ...newItems];
        broadcastQueue();
        initAndStart(tabId);
        sendResponse({ success: true });
        return true;
      }

      case 'CLEAR_QUEUE':
        queue = [];
        refImageDataUrl = null;
        refAttached = false;
        sceneDownloadCount.clear();
        urlToFilename.clear();
        whiskSceneCount.clear();
        whiskSeen.clear();
        broadcastQueue();
        sendResponse({ success: true });
        return true;

      case 'SCAN_UPLOAD': {
        const { tabId } = message as { tabId: number };
        chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: scanFlowUpload })
          .then(results => {
            const report = results.map((r, i) => `--- frame ${i} ---\n${r.result ?? '(no result)'}`).join('\n\n');
            sendResponse({ report });
          })
          .catch(err => { console.error('[AIF] scan error', err); sendResponse({ report: 'scan error: ' + err.message }); });
        return true;
      }

      case 'INSPECT_MODE': {
        const { tabId } = message as { tabId: number };
        // allFrames: the Whisk tool may render inside a sub-frame, so we must inject everywhere.
        chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: injectInspector })
          .then(() => sendResponse({ success: true }))
          .catch(err => { console.error('[AIF] inspect error', err); sendResponse({ success: false }); });
        return true;
      }
    }
    return false;
  });
});

// Injected into EVERY frame: a click-to-capture inspector. The top frame paints an overlay;
// sub-frames (the Whisk tool may live in one) capture clicks and postMessage their selectors up
// to the top overlay. Each captured click is frozen (page won't react) and its selector logged,
// so we can wire a new site without DevTools. Self-contained — runs in the isolated content world.
function injectInspector() {
  const w = window as any;
  const isTop = window.top === window;

  const cssPath = (el: Element): string => {
    const seg: string[] = [];
    let e: Element | null = el;
    let depth = 0;
    while (e && e.nodeType === 1 && depth < 5) {
      let s = e.tagName.toLowerCase();
      const id = (e as HTMLElement).id;
      if (id) { s += '#' + id; seg.unshift(s); break; }
      const cls = (typeof e.className === 'string' ? e.className : '').trim().split(/\s+/).filter(Boolean)[0];
      if (cls) s += '.' + cls;
      const parent: Element | null = e.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === (e as Element).tagName);
        if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(e) + 1})`;
      }
      seg.unshift(s);
      e = e.parentElement; depth++;
    }
    return seg.join(' > ');
  };

  const describe = (el: Element): string => {
    const p: string[] = [el.tagName.toLowerCase()];
    if ((el as HTMLElement).id) p.push('#' + (el as HTMLElement).id);
    const cls = (typeof el.className === 'string' ? el.className : '').trim();
    if (cls) p.push('.' + cls.split(/\s+/).slice(0, 6).join('.'));
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith('data-') || ['role', 'aria-label', 'placeholder', 'type', 'contenteditable', 'title', 'name'].includes(a.name))
        p.push(`[${a.name}="${a.value.slice(0, 40)}"]`);
    }
    const icon = el.querySelector?.('i.google-symbols');
    if (icon) p.push(`icon=${icon.textContent?.trim()}`);
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (txt) p.push(`text="${txt}"`);
    return p.join(' ');
  };

  // Build a capture entry for a clicked element (+ its nearest actionable ancestor + tile imagery).
  const captureEntry = (t: Element): string => {
    const actionable = (t.closest('button,[contenteditable="true"],[data-slate-editor],textarea,input,[role="button"],[role="textbox"],[data-tile-id]') as Element) || t;
    let entry = `CLICKED: ${describe(t)}\n      PATH: ${cssPath(t)}`;
    if (actionable !== t) entry += `\n    NEAREST: ${describe(actionable)}\n      PATH: ${cssPath(actionable)}`;
    // Diagnostic: how is the picture stored in this tile? Dump <img> srcs + any background-image.
    const tile = (t.closest('div.aspect-video') || t.closest('[class*="aspect"]') || t.parentElement) as Element | null;
    if (tile) {
      const imgs = Array.from(tile.querySelectorAll('img')).map(im => {
        const i = im as HTMLImageElement;
        return `src=${(i.currentSrc || i.src || '').slice(0, 64)} nw=${i.naturalWidth}`;
      });
      const bgs: string[] = [];
      [tile, ...Array.from(tile.querySelectorAll('*'))].forEach(e => {
        const bg = getComputedStyle(e as Element).backgroundImage;
        if (bg && bg !== 'none') bgs.push(bg.slice(0, 80));
      });
      entry += `\n    TILE tag=${tile.tagName.toLowerCase()} imgs=[${imgs.join(' || ') || 'none'}] bgs=[${bgs.slice(0, 3).join(' || ') || 'none'}]`;
    }
    return entry;
  };

  // ---------- SUB-FRAME: capture clicks and post the selector up to the top overlay ----------
  if (!isTop) {
    if (w.__aiInspectChild) return;
    w.__aiInspectChild = true;
    const onDownChild = (e: Event) => {
      const t = e.target as Element;
      if (!t || !t.tagName) return;
      e.preventDefault(); e.stopPropagation();
      try { window.top!.postMessage({ __aiInspect: true, frame: location.href, entry: captureEntry(t) }, '*'); } catch {}
    };
    document.addEventListener('pointerdown', onDownChild, true);
    return;
  }

  // ---------- TOP FRAME: overlay + aggregation across frames ----------
  if (w.__aiInspect) { w.__aiInspect.stop(); return; }

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:12px;right:12px;width:460px;max-height:84vh;overflow:auto;z-index:2147483647;background:#0c1018;color:#e6edf3;font:12px/1.45 monospace;border:2px solid #a142f4;border-radius:10px;padding:12px;box-shadow:0 8px 40px rgba(0,0,0,.6)';
  const head = document.createElement('div');
  head.innerHTML = '<div style="font-weight:700;color:#c896ff;margin-bottom:6px">AutoImage Inspect</div><div style="color:#9aa0a6;margin-bottom:6px">Click on the page: (1) the prompt box, (2) the send (→) button, (3) a finished image tile. The page won\'t react. Then screenshot this box (or Copy all).</div>';
  overlay.appendChild(head);
  const status = document.createElement('div');
  status.style.cssText = 'color:#ffd166;margin-bottom:8px';
  overlay.appendChild(status);
  const log = document.createElement('pre');
  log.style.cssText = 'white-space:pre-wrap;margin:0 0 8px;color:#7ee787';
  overlay.appendChild(log);
  const row = document.createElement('div');
  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy all';
  const stopBtn = document.createElement('button');
  stopBtn.textContent = 'Stop / Close';
  for (const b of [copyBtn, stopBtn]) b.style.cssText = 'margin-right:8px;padding:6px 10px;border-radius:6px;border:1px solid #444;background:#1c2333;color:#e6edf3;cursor:pointer;font:12px monospace';
  row.appendChild(copyBtn); row.appendChild(stopBtn);
  overlay.appendChild(row);
  document.documentElement.appendChild(overlay);

  let seen = 0;
  const lines: string[] = [];
  const render = () => {
    status.textContent = `clicks seen: ${seen}   |   captured: ${lines.length}`;
    log.textContent = lines.length ? lines.map((l, i) => `#${i + 1} ${l}`).join('\n\n') : '(no captures yet — click an element on the page)';
  };
  const appendEntry = (entry: string, frame?: string) => {
    lines.push((frame && frame !== location.href ? `[frame ${frame.slice(0, 50)}]\n      ` : '') + entry);
    render();
  };
  render();

  const onDown = (e: Event) => {
    const t = e.target as Element;
    if (!t || !t.tagName || overlay.contains(t)) return;
    seen++;
    e.preventDefault(); e.stopPropagation();
    appendEntry(captureEntry(t));
  };
  // pointerdown is harder for the app to swallow than click; also freeze stray clicks.
  document.addEventListener('pointerdown', onDown, true);
  const swallowClick = (e: Event) => { if (!overlay.contains(e.target as Node)) { e.preventDefault(); e.stopPropagation(); } };
  document.addEventListener('click', swallowClick, true);

  const onMsg = (ev: MessageEvent) => {
    if (ev.data && ev.data.__aiInspect) { seen++; appendEntry(ev.data.entry, ev.data.frame); }
  };
  window.addEventListener('message', onMsg, false);

  copyBtn.onclick = (e) => { e.stopPropagation(); try { navigator.clipboard?.writeText(lines.join('\n\n')); copyBtn.textContent = 'Copied!'; setTimeout(() => { copyBtn.textContent = 'Copy all'; }, 1500); } catch {} };
  const stop = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('click', swallowClick, true);
    window.removeEventListener('message', onMsg, false);
    overlay.remove(); w.__aiInspect = null;
  };
  stopBtn.onclick = (e) => { e.stopPropagation(); stop(); };
  w.__aiInspect = { stop };
}

// Keep project names safe as a folder name.
function sanitizeProject(name?: string): string {
  return (name || '').replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// Stable id without Math.random (avoids non-determinism).
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  return h;
}

async function relayFetch(path: string, opts: RequestInit = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) } as Record<string, string>;
  if (relayKey) headers["X-API-Key"] = relayKey;
  return fetch(RELAY_URL + path, { ...opts, headers });
}

async function relayReport(status: string, extra: Record<string, unknown> = {}) {
  if (!relayJobId) return;
  try {
    await relayFetch("/status", { method: "POST", body: JSON.stringify({ id: relayJobId, status, ...extra }) });
  } catch { /* relay down — ignore */ }
}

// Ingest a relay job exactly as if the popup sent START_QUEUE.
function ingestRelayJob(job: { id: string; project: string; mode: string; settings: unknown; scenes: any[] }) {
  relayJobId = job.id;
  activeTabId = activeTabId;  // keep whatever tab is active (Flow)
  currentMode = (job.mode === "video" || job.mode === "whisk") ? (job.mode as GenMode) : "image";
  frameImagesMap = new Map();
  uploadedFrameNames.clear();
  pendingSettings = job.settings ?? null;
  settingsApplied = false;
  refImageDataUrl = null;
  refAttached = false;
  const project = sanitizeProject(job.project) || "Relay";
  const items: QueueItem[] = job.scenes.map((p: any, i: number) => ({
    id: `${project}-${p.scene_number ?? i + 1}-${Math.abs(hashString(String(p.prompt))).toString(36)}`,
    scene_number: p.scene_number ?? i + 1,
    prompt: p.prompt,
    status: "PENDING",
    project,
    mode: currentMode,
    start_frame: p.start_frame,
    end_frame: p.end_frame,
    character: p.character,
  }));
  queue = [...queue, ...items];
  broadcastQueue();
  relayReport("RUNNING", { log: `picked up ${items.length} scenes` });
}

// MV3 service workers are ephemeral — a setInterval dies when Chrome idles the
// worker, which is exactly when the relay needs to poll. chrome.alarms wakes the
// worker on schedule, and state is persisted so it survives a worker restart.
async function relayTick() {
  const st = await chrome.storage.local.get(["relayOn", "relayKey", "relayTabId", "relayJobId"]);
  if (!st.relayOn) return;
  relayOn = true;
  relayKey = st.relayKey ?? relayKey;
  if (st.relayTabId) activeTabId = st.relayTabId;
  relayJobId = st.relayJobId ?? relayJobId;
  const busy = queue.some(q => q.status === "PENDING" || q.status === "IN_PROGRESS" || q.status === "READY");
  if (busy || !activeTabId) return;
  if (relayJobId) {
    await relayReport("DONE", { log: "all scenes downloaded" });
    relayJobId = null;
    await chrome.storage.local.remove("relayJobId");
  }
  try {
    const r = await relayFetch("/next");
    if (!r.ok) return;
    const job = await r.json();
    if (job && job.id) {
      await chrome.storage.local.set({ relayJobId: job.id });
      ingestRelayJob(job);
    }
  } catch { /* relay not running — stay quiet */ }
}

function startRelayPolling() {
  // 0.5 min is the MV3 alarm floor; fine for hands-off batch jobs. Also tick once now.
  chrome.alarms.create("relayPoll", { periodInMinutes: 1 });
  relayTick();
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(a => { if (a.name === "relayPoll") relayTick(); });
}

function broadcastQueue() {
  browser.runtime.sendMessage({ type: 'QUEUE_UPDATED', queue }).catch(() => {});
}

async function initAndStart(tabId: number) {
  if (!isInitialized) {
    isInitialized = true;
    // Record tiles already on the page so we only download NEW generations.
    try {
      if (currentMode === 'whisk') {
        // Whisk lives in an about:srcdoc iframe and uses no data-tile-id — track existing image URLs.
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: () => Array.from(document.querySelectorAll('div.aspect-video img'))
            .map(img => (img as HTMLImageElement).src).filter(s => s && !s.includes('data:image')),
        });
        results.forEach(r => (r.result ?? []).forEach((s: string) => seenTileIds.add(s)));
      } else {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          // Record ALL existing tiles (images + videos) so we only act on NEW generations.
          func: () => Array.from(document.querySelectorAll('[data-tile-id]')).map(el => el.getAttribute('data-tile-id')),
        });
        (result ?? []).forEach((id: string | null) => { if (id) seenTileIds.add(id); });
      }
    } catch (e) {
      console.error('[AIF] init error', e);
    }
  }
  processQueue();
  startPolling();
}

async function processQueue() {
  if (isInjecting || !activeTabId) return;
  if (Date.now() < rateLimitCooldownUntil) return;
  // sequential: don't start the next prompt while one is generating OR awaiting its download
  if (queue.some(q => q.status === 'IN_PROGRESS' || q.status === 'READY')) return;

  const next = queue.find(q => q.status === 'PENDING' || q.status === 'RATE_LIMITED');
  if (!next) return;

  isInjecting = true;
  next.status = 'IN_PROGRESS';
  whiskStable = 0;
  whiskWaitPolls = 0;
  whiskPolls = 0;
  broadcastQueue();

  try {
    // JSON "settings" block: set Flow's mode/model/duration/aspect once per batch
    if (pendingSettings && !settingsApplied && currentMode !== 'whisk') {
      settingsApplied = true;
      try {
        const sr = await chrome.scripting.executeScript({
          target: { tabId: activeTabId },
          world: 'MAIN',
          func: applyFlowSettings,
          args: [pendingSettings],
        });
        console.log('[AIF] settings:', sr?.[0]?.result);
        await new Promise(r => setTimeout(r, 800));
      } catch (e) {
        console.error('[AIF] settings apply error', e);
      }
    }

    if (currentMode === 'whisk') {
      // Capture how many result tiles exist BEFORE we send, so any growth = THIS prompt's images.
      try {
        const counts = await chrome.scripting.executeScript({
          target: { tabId: activeTabId, allFrames: true },
          func: () => document.querySelectorAll('div.aspect-video').length,
        });
        whiskBaseline = counts.reduce((a, c) => a + (typeof c.result === 'number' ? c.result : 0), 0);
        whiskLastCount = whiskBaseline;
      } catch { whiskBaseline = 0; whiskLastCount = 0; }
      // Whisk is in an about:srcdoc iframe — inject into all frames; only the Whisk frame acts.
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId, allFrames: true },
        world: 'MAIN',
        func: injectPromptIntoWhisk,
        args: [next.prompt],
      });
    } else {
      // Attach the reference image to Flow's composer once per batch, before the first prompt,
      // so every start-frame keeps the same character/style. (Whisk locks refs itself.)
      if (refImageDataUrl && !refAttached) {
        refAttached = true;
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId: activeTabId },
            world: 'MAIN',
            func: attachReferenceToFlow,
            args: [refImageDataUrl],
          });
          console.log('[AIF] reference attach:', r?.[0]?.result);
          await new Promise(res => setTimeout(res, 2000));  // let Flow register the upload
        } catch (e) {
          console.error('[AIF] reference attach error', e);
        }
      }
      // Saved Flow Character: attach via the picker's Characters tab first
      if (next.character) {
        try {
          const cr = await chrome.scripting.executeScript({
            target: { tabId: activeTabId },
            world: 'MAIN',
            func: attachCharacterToPrompt,
            args: [next.character],
          });
          console.log('[AIF] character:', cr?.[0]?.result);
        } catch (e) {
          console.error('[AIF] character attach error', e);
        }
      }

      // Video Frames mode: place start/end frame images into their slots first
      if (next.mode === 'video' && (next.start_frame || next.end_frame)) {
        for (const [slot, match] of [['Start', next.start_frame], ['End', next.end_frame]] as const) {
          if (!match) continue;
          const key = match.toLowerCase();
          const needUpload = frameImagesMap.has(key) && !uploadedFrameNames.has(key);
          try {
            const fr = await chrome.scripting.executeScript({
              target: { tabId: activeTabId },
              world: 'MAIN',
              func: attachFrameToSlot,
              args: [slot, match, needUpload ? frameImagesMap.get(key)! : null, needUpload ? key : null],
            });
            const out = String(fr?.[0]?.result ?? '');
            if (needUpload && out.startsWith('uploaded')) uploadedFrameNames.add(key);
            console.log(`[AIF] ${slot} frame:`, out);
          } catch (e) {
            console.error(`[AIF] ${slot} frame attach error`, e);
          }
        }
      }
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        world: 'MAIN',
        func: injectPromptIntoFlow,
        args: [next.prompt],
      });
    }
    await new Promise(r => setTimeout(r, 1500));
  } catch (e) {
    console.error('[AIF] inject error', e);
    next.status = 'ERROR';
  } finally {
    isInjecting = false;
    broadcastQueue();
  }
}

// Runs in EVERY frame: SELF-DRIVING diagnostic. The user can't hold Flow's menu open while
// clicking the extension popup (the popup closes on page-click + the menu closes on blur), so
// this opens the "+ Create" menu ITSELF, waits, then reports what appeared — file inputs
// (drivable directly), drop zones, and the menu items that mention image/upload. Async so
// executeScript awaits the result; runs in-page so the popup closing is irrelevant.
async function scanFlowUpload(): Promise<string> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const lines: string[] = [];
  const desc = (el: Element) => {
    const t = [el.tagName.toLowerCase()];
    const icon = (el.querySelector('i.google-symbols, span.material-symbols-outlined')?.textContent || '').trim();
    if (icon) t.push(`icon=${icon}`);
    const al = el.getAttribute('aria-label'); if (al) t.push(`aria="${al.slice(0, 40)}"`);
    const ti = el.getAttribute('title'); if (ti) t.push(`title="${ti.slice(0, 40)}"`);
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 36); if (txt) t.push(`txt="${txt}"`);
    return t.join(' ');
  };
  const countInputs = () => Array.from(document.querySelectorAll('input[type="file"]'));
  const reportInputs = (label: string) => {
    const inputs = countInputs();
    lines.push(`${label}: ${inputs.length} file input(s)`);
    inputs.forEach((i, n) => {
      const inp = i as HTMLInputElement;
      lines.push(`  [${n}] accept="${inp.accept || '(any)'}" multiple=${inp.multiple} parent=${desc(inp.parentElement || inp)}`);
    });
  };

  reportInputs('BEFORE (no menu)');

  // Open Flow's "+ Create" menu ourselves (icon add_2 / text Create).
  const createBtn = Array.from(document.querySelectorAll('button,[role="button"]')).find(b => {
    const icon = (b.querySelector('i.google-symbols, span.material-symbols-outlined')?.textContent || '').trim();
    const blob = `${icon} ${b.getAttribute('aria-label') || ''} ${(b.textContent || '').slice(0, 30)}`;
    return icon === 'add_2' || /add_2|create/i.test(blob);
  }) as HTMLElement | undefined;
  if (!createBtn) { lines.push('\n(could not find the + Create button in this frame)'); return lines.join('\n'); }
  lines.push(`\nCLICKED: ${desc(createBtn)}`);
  createBtn.click();
  await sleep(1200);

  reportInputs('AFTER opening menu');

  // Menu items that appeared (role=menuitem, or new buttons mentioning image/upload/device).
  const wants = /image|photo|upload|reference|ingredient|frame|computer|device|library|collection|gallery/i;
  const items = Array.from(document.querySelectorAll('[role="menuitem"],[role="option"],button,a,li')).filter(el => {
    const icon = (el.querySelector('i.google-symbols, span.material-symbols-outlined')?.textContent || '').trim();
    const blob = `${icon} ${el.getAttribute('aria-label') || ''} ${(el.textContent || '').slice(0, 40)}`;
    return wants.test(blob);
  });
  lines.push(`\nMENU ITEMS THAT MENTION IMAGE/UPLOAD: ${items.length}`);
  items.slice(0, 16).forEach(el => lines.push(`  • ${desc(el)}`));

  // Go one level deeper: click an "Upload media / image" item to open the upload dialog, then
  // re-check for a hidden file input (react-dropzone renders one we can set without a pop-up).
  const uploadItem = items.find(el => {
    const icon = (el.querySelector('i.google-symbols, span.material-symbols-outlined')?.textContent || '').trim();
    const blob = `${icon} ${el.getAttribute('aria-label') || ''} ${(el.textContent || '')}`;
    return /upload|image|photo|computer|device/i.test(blob);
  }) as HTMLElement | undefined;
  if (uploadItem) {
    lines.push(`\nCLICKED upload item: ${desc(uploadItem)}`);
    uploadItem.click();
    await sleep(1300);
    reportInputs('AFTER clicking upload');
  }

  const dz = Array.from(document.querySelectorAll('[class*="drop"],[class*="Drop"],[data-testid*="drop"],[aria-label*="drop" i]'));
  lines.push(`\nDROPZONE HINTS: ${dz.length}${dz.length ? ' → ' + dz.slice(0, 3).map(desc).join(' | ') : ''}`);

  lines.push('\nVERDICT: ' + (countInputs().length > 0
    ? 'file input present → I can set it directly (no Windows pop-up).'
    : dz.length > 0
      ? 'no input but a dropzone exists → I will use drag-and-drop.'
      : 'no input, no dropzone → likely a native Windows pop-up (hardest case).'));

  return lines.join('\n') || '(nothing found in this frame)';
}

// Runs in the page (MAIN world): set Flow's prompt-bar generation settings from the JSON
// "settings" block. DOM mapped live: settings chip opens a [role=menu] with tablists
// (Image/Video, Frames/Ingredients, aspect ratios, 1x-x4 counts, 4s-10s durations) and a
// model dropdown button. All respond to plain synthetic clicks.
async function applyFlowSettings(cfg: { mode?: string; video_mode?: string; model?: string; duration?: number; aspect?: string; count?: number }): Promise<string> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const visible = (el: Element) => (el as HTMLElement).offsetParent !== null;
  const log: string[] = [];
  // This menu only opens on a full pointer sequence (plain .click() is ignored)
  const fire = (el: Element) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
    for (const t of ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor: any = t.startsWith('pointer') ? PointerEvent : MouseEvent;
      try { el.dispatchEvent(new Ctor(t, o)); } catch {}
    }
    const k = Object.keys(el).find(key => key.startsWith('__reactProps$'));
    if (k) { try { (el as any)[k]?.onClick?.({ preventDefault() {}, stopPropagation() {}, nativeEvent: { isTrusted: true } }); } catch {} }
  };

  // 1. open the settings chip — the LAST matching button (the prompt bar sits last in the DOM)
  const chips = Array.from(document.querySelectorAll('button')).filter(b =>
    visible(b) && /crop_|·/.test(b.textContent ?? '') && b.querySelector('i.google-symbols')) as HTMLElement[];
  const chip = chips[chips.length - 1];
  if (!chip) return 'no-settings-chip';
  fire(chip);
  await sleep(1300);

  const menu = () => Array.from(document.querySelectorAll('[role="menu"]')).find(visible) as HTMLElement | undefined;
  let m = menu();
  if (!m) return 'no-settings-menu';

  const clickTab = async (match: (txt: string) => boolean, label: string) => {
    m = menu() ?? m;
    const tab = Array.from(m!.querySelectorAll('[role="tab"]')).find(t => visible(t) && match((t.textContent ?? '').trim()));
    if (!tab) { log.push('miss:' + label); return; }
    fire(tab);
    log.push(label);
    await sleep(900);
  };

  // 2. mode
  if (cfg.mode === 'video') await clickTab(t => /Video/i.test(t) && !/·/.test(t), 'mode=video');
  else if (cfg.mode === 'image') await clickTab(t => /Image/i.test(t), 'mode=image');

  // 3. video sub-mode
  if (cfg.video_mode === 'frames') await clickTab(t => /Frames/i.test(t), 'frames');
  else if (cfg.video_mode === 'ingredients') await clickTab(t => /Ingredients/i.test(t), 'ingredients');

  // 4. aspect ratio (tab text contains e.g. "16:9")
  if (cfg.aspect) await clickTab(t => t.includes(cfg.aspect!), 'aspect=' + cfg.aspect);

  // 5. outputs per prompt: tabs are labelled "1x", "x2", "x3", "x4"
  if (cfg.count) {
    const want = cfg.count === 1 ? '1x' : 'x' + cfg.count;
    await clickTab(t => t === want, 'count=' + want);
  }

  // 6. duration tabs "4s" "6s" "8s" "10s" (video only)
  if (cfg.duration) await clickTab(t => t === cfg.duration + 's', 'duration=' + cfg.duration);

  // 7. model dropdown (button inside the menu with arrow_drop_down)
  if (cfg.model) {
    m = menu() ?? m;
    const dd = Array.from(m!.querySelectorAll('button')).find(b =>
      visible(b) && (b.textContent ?? '').includes('arrow_drop_down')) as HTMLElement | undefined;
    if (dd) {
      fire(dd);
      await sleep(900);
      const q = cfg.model.toLowerCase();
      const item = Array.from(document.querySelectorAll('[role="menuitem"] button, [role="menuitem"]'))
        .find(b => visible(b) && (b.textContent ?? '').toLowerCase().includes(q)) as HTMLElement | undefined;
      if (item) { fire(item); log.push('model=' + cfg.model); await sleep(900); }
      else { log.push('miss:model'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }
    } else log.push('miss:model-dropdown');
  }

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(400);
  return 'applied: ' + log.join(', ');
}

// Runs in the page (MAIN world): attach a saved Flow CHARACTER to the prompt via the
// media picker's Characters tab. Live-verified: add_2 -> dialog -> Characters tab ->
// tile by name -> Add to Prompt. (No add_2 button exists in video FRAMES mode — characters
// work in Image and Video/Ingredients modes.)
async function attachCharacterToPrompt(name: string): Promise<string> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const visible = (el: Element) => (el as HTMLElement).offsetParent !== null;

  const addBtn = Array.from(document.querySelectorAll('button')).find(b => {
    const i = b.querySelector('i.google-symbols');
    return i && i.textContent?.trim() === 'add_2' && visible(b);
  }) as HTMLElement | undefined;
  if (!addBtn) return 'no-add-button (Frames mode has none — use Image or Ingredients)';
  addBtn.click();
  await sleep(1500);

  let dlg = Array.from(document.querySelectorAll('[role="dialog"]')).find(visible) as HTMLElement | undefined;
  if (!dlg) return 'no-picker';

  const charTab = Array.from(dlg.querySelectorAll('[role="tab"], button'))
    .find(t => (t.textContent ?? '').includes('Characters') && visible(t)) as HTMLElement | undefined;
  if (!charTab) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'no-characters-tab'; }
  charTab.click();
  await sleep(1300);
  dlg = (Array.from(document.querySelectorAll('[role="dialog"]')).find(visible) as HTMLElement | undefined) ?? dlg;

  const q = name.toLowerCase();
  const findTile = () => Array.from(dlg!.querySelectorAll('[role="option"]'))
    .find(t => (t.textContent ?? '').toLowerCase().includes(q)) as HTMLElement | undefined;
  let tile = findTile();
  if (!tile) { await sleep(1200); tile = findTile(); }
  if (!tile) {
    const seen = Array.from(dlg.querySelectorAll('[role="option"]')).map(t => (t.textContent ?? '').trim().slice(0, 20)).join('/');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 'character-not-found:' + name + '; saw: ' + (seen || 'none');
  }
  tile.click();
  await sleep(1000);

  const add = Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent ?? '').trim() === 'Add to Prompt' && visible(b)) as HTMLElement | undefined;
  if (add) { add.click(); await sleep(900); }
  const still = Array.from(document.querySelectorAll('[role="dialog"]')).find(visible);
  if (still) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return 'character-attached:' + name;
}

// Runs in the page (MAIN world): put a project-media image into the video Frames mode
// "Start" or "End" slot. matchText is matched against tile alt/name (the search box is used
// when present). Live-verified sequence: slot click -> picker dialog -> tile -> Add to Prompt.
async function attachFrameToSlot(slotLabel: string, matchText: string, uploadDataUrl?: string | null, uploadName?: string | null): Promise<string> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const visible = (el: Element) => (el as HTMLElement).offsetParent !== null;

  // The slot is a small labelled element in the prompt bar ("Start" / "End")
  const slot = Array.from(document.querySelectorAll('div,span'))
    .filter(d => (d.textContent ?? '').trim() === slotLabel && visible(d))
    .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0] as HTMLElement | undefined;
  if (!slot) return 'no-slot:' + slotLabel;
  slot.click();
  await sleep(1500);

  const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).find(visible) as HTMLElement | undefined;
  if (!dlg) return 'no-picker';

  // LOCAL UPLOAD branch: a dataUrl was provided (popup "Frame images" box) — set it on
  // Flow's file input directly (one global input[type=file] backs the Upload button; setting
  // it programmatically skips the native file dialog entirely).
  if (uploadDataUrl) {
    const comma = uploadDataUrl.indexOf(',');
    const meta = uploadDataUrl.slice(0, comma);
    const bin = atob(uploadDataUrl.slice(comma + 1));
    const mime = (meta.match(/data:(.*?);/) || [, 'image/png'])[1] as string;
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const ext = mime.includes('jpeg') ? 'jpg' : (mime.split('/')[1] || 'png');
    const file = new File([arr], `${uploadName || 'frame'}.${ext}`, { type: mime });
    const input = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
      .find(i => (i.accept || '') === '' || /image/i.test(i.accept));
    if (!input) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'no-file-input'; }
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // wait for the upload to land + auto-select in the dialog
    for (let i = 0; i < 20; i++) {
      await sleep(700);
      const add = Array.from(document.querySelectorAll('button'))
        .find(b => (b.textContent ?? '').trim() === 'Add to Prompt' && visible(b)) as HTMLElement | undefined;
      if (add) { add.click(); await sleep(900);
        const still = Array.from(document.querySelectorAll('[role="dialog"]')).find(visible);
        if (still) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return 'uploaded+attached:' + slotLabel;
      }
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 'upload-timeout';
  }

  // Prefer the picker's own search box — most reliable with many media items
  const search = dlg.querySelector<HTMLInputElement>('input[placeholder*="Search" i]');
  if (search && matchText) {
    search.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter ? setter.call(search, matchText) : (search.value = matchText);
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(1300);
  }

  const findTile = () => {
    const imgs = Array.from(dlg.querySelectorAll('img')) as HTMLImageElement[];
    const q = (matchText || '').toLowerCase();
    return (q
      ? imgs.find(i => ((i.alt || '') + ' ' + (i.closest('[role="option"]')?.textContent || '')).toLowerCase().includes(q))
      : imgs[0]) ?? null;
  };
  let tile = findTile();
  if (!tile) { await sleep(1200); tile = findTile(); }
  if (!tile) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 'no-tile:' + matchText;
  }
  ((tile.closest('[role="option"], button, div[tabindex]') as HTMLElement) ?? tile).click();
  await sleep(1000);

  const add = Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent ?? '').trim() === 'Add to Prompt' && visible(b)) as HTMLElement | undefined;
  if (add) { add.click(); await sleep(900); }

  const still = Array.from(document.querySelectorAll('[role="dialog"]')).find(visible);
  if (still) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return 'attached:' + slotLabel;
}

// Runs in the page (MAIN world): attach a reference image to Flow's composer so generations
// keep a consistent character/style. Tries an existing file input first; if none, clicks a
// likely "add image / reference" button to reveal one, then sets the file on it. Returns a
// status string for logging (so we can see whether Flow's button moved). ASYNC — executeScript
// awaits the resolved value.
async function attachReferenceToFlow(dataUrl: string): Promise<string> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  try {
    // dataURL → File
    const comma = dataUrl.indexOf(',');
    const meta = dataUrl.slice(0, comma);
    const bin = atob(dataUrl.slice(comma + 1));
    const mime = (meta.match(/data:(.*?);/) || [, 'image/png'])[1] as string;
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const ext = mime.includes('jpeg') ? 'jpg' : (mime.split('/')[1] || 'png');
    const file = new File([arr], `reference.${ext}`, { type: mime });

    const findInput = (): HTMLInputElement | undefined =>
      Array.from(document.querySelectorAll('input[type="file"]')).find(i => {
        const a = (i as HTMLInputElement).accept || '';
        return a === '' || /image/i.test(a);
      }) as HTMLInputElement | undefined;

    const setInput = (input: HTMLInputElement): boolean => {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch { return false; }
    };

    // 1) An image file input already present?
    let input = findInput();
    if (input) return setInput(input) ? 'attached(existing-input)' : 'set-failed';

    // 2) None — Flow hides the input behind a menu chain (e.g. "+ Create" → "Upload image").
    // Click likely buttons/menu-items, checking for the input after each, up to 2 levels deep.
    const wantIcon = ['add_2', 'add_photo_alternate', 'image', 'add', 'attach_file', 'photo_library', 'collections', 'add_a_photo', 'imagesmode', 'frame_inspect'];
    const wantText = /image|reference|ingredient|upload|photo|frame|create|add/i;
    const clicked = new Set<Element>();
    const findBtn = (): HTMLElement | undefined =>
      Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"]')).find(b => {
        if (clicked.has(b)) return false;
        const icon = (b.querySelector('i.google-symbols, span.material-symbols-outlined')?.textContent || '').trim();
        const blob = `${icon} ${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${(b.textContent || '').slice(0, 40)}`;
        return wantIcon.includes(icon) || wantText.test(blob);
      }) as HTMLElement | undefined;

    const trail: string[] = [];
    for (let level = 0; level < 3 && !input; level++) {
      const btn = findBtn();
      if (!btn) break;
      clicked.add(btn);
      trail.push((btn.querySelector('i.google-symbols, span.material-symbols-outlined')?.textContent || btn.textContent || '?').trim().slice(0, 16));
      btn.click();
      for (let i = 0; i < 8 && !input; i++) { await sleep(250); input = findInput(); }
    }
    if (input) return setInput(input) ? `attached(via ${trail.join(' → ')})` : 'set-failed';

    // No settable input — try DRAG-AND-DROP onto the upload dialog's dropzone (react-dropzone
    // style). Synthesize the full drag sequence with a DataTransfer carrying the File.
    const dz = (document.querySelector('[class*="drop" i],[data-testid*="drop" i],[aria-label*="drop" i]')
      || document.querySelector('div[role="dialog"]')
      || document.querySelector('div[id^="radix-"]')) as HTMLElement | null;
    if (dz) {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        for (const type of ['dragenter', 'dragover', 'drop']) {
          const ev = new DragEvent(type, { bubbles: true, cancelable: true });
          Object.defineProperty(ev, 'dataTransfer', { value: dt });
          dz.dispatchEvent(ev);
          await sleep(120);
        }
        return `dropped(via ${trail.join(' → ') || 'dialog'})`;
      } catch (e) {
        return 'drop-failed:' + (e as Error).message;
      }
    }
    return `no-input-no-dropzone (clicked: ${trail.join(' → ') || 'nothing'}) — run 🔬 Scan Flow for upload`;
  } catch (e) {
    return 'error:' + (e as Error).message;
  }
}

// Runs in the page (MAIN world): type the prompt into Flow's editor and click Generate.
function injectPromptIntoFlow(promptText: string) {
  const editor = document.querySelector<HTMLElement>('[data-slate-editor="true"]');
  if (!editor) { console.warn('[AIF] Flow editor not found'); return; }
  editor.focus();

  const leaf = editor.querySelector('[data-slate-leaf="true"]') || editor;
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(leaf);
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);

  const evt = new InputEvent('beforeinput', { inputType: 'insertText', data: promptText, bubbles: true, cancelable: true }) as any;
  evt.getTargetRanges = () => [range];
  editor.dispatchEvent(evt);
  if (!evt.defaultPrevented) {
    document.execCommand('insertText', false, promptText);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  setTimeout(() => {
    const sendBtn = Array.from(document.querySelectorAll('button')).find(b => {
      const icon = b.querySelector('i.google-symbols');
      return icon && icon.textContent?.trim() === 'arrow_forward';
    });
    if (sendBtn) {
      sendBtn.removeAttribute('disabled');
      sendBtn.removeAttribute('aria-disabled');
      (sendBtn as HTMLElement).style.pointerEvents = 'auto';
      sendBtn.click();
      const key = Object.keys(sendBtn).find(k => k.startsWith('__reactProps$'));
      if (key) {
        const props = (sendBtn as any)[key];
        try { props?.onClick?.({ preventDefault() {}, stopPropagation() {}, nativeEvent: { isTrusted: true } }); } catch {}
      }
    }
  }, 800);
}

// Runs in EVERY frame (MAIN world): type the prompt into Whisk's plain <input> and click send.
// Only the Whisk srcdoc frame has the input; every other frame no-ops. Whisk keeps the locked
// Subject/Scene/Style references for each generation, so we only ever set the text + send.
function injectPromptIntoWhisk(promptText: string) {
  const input = document.querySelector<HTMLInputElement>('input[placeholder^="Describe your idea or Whisk"]');
  if (!input) return; // not the Whisk frame
  input.focus();
  // React-controlled input: use the native value setter, then fire input/change so React sees it.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter ? setter.call(input, promptText) : (input.value = promptText);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  setTimeout(() => {
    const sendBtn = Array.from(document.querySelectorAll('button')).find(b => {
      const icon = b.querySelector('span.material-symbols-outlined, i.google-symbols');
      return icon && icon.textContent?.trim() === 'arrow_forward';
    });
    if (sendBtn) {
      sendBtn.removeAttribute('disabled');
      sendBtn.removeAttribute('aria-disabled');
      (sendBtn as HTMLElement).style.pointerEvents = 'auto';
      sendBtn.click();
      const key = Object.keys(sendBtn).find(k => k.startsWith('__reactProps$'));
      if (key) {
        try { (sendBtn as any)[key]?.onClick?.({ preventDefault() {}, stopPropagation() {}, nativeEvent: { isTrusted: true } }); } catch {}
      }
    } else {
      // Fallback: submit via Enter key on the input.
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }, 600);
}

// Runs in EVERY frame: fetch an image URL (incl. a blob: owned by this frame) and return it as a
// data URL. Only the frame that owns the blob succeeds; others throw and return null. The background
// then downloads the data URL (chrome.downloads can't fetch a page-scoped blob: directly).
async function fetchToDataUrl(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    return await new Promise<string | null>(res => {
      const fr = new FileReader();
      fr.onload = () => res(typeof fr.result === 'string' ? fr.result : null);
      fr.onerror = () => res(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// Runs in the page (MAIN world): download a finished video tile via Flow's own menu:
// ⋮ (more_vert) → Download → 720p (Original). Returns a status string for logging.
async function triggerFlowVideoDownload(tileId: string): Promise<string> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const iconName = (el: Element) => (el.querySelector('i.google-symbols')?.textContent ?? '').trim();

  // Fire a full, React-friendly activation on an element (hover + pointer + click + React onClick).
  const fire = (el: Element | null | undefined) => {
    if (!el) return;
    (el as HTMLElement).scrollIntoView?.({ block: 'center' });
    for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        const Ctor: any = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
      } catch {}
    }
    const k = Object.keys(el).find(key => key.startsWith('__reactProps$'));
    if (k) { try { (el as any)[k]?.onClick?.({ preventDefault() {}, stopPropagation() {}, nativeEvent: { isTrusted: true } }); } catch {} }
  };

  // Smallest element whose trimmed text exactly matches (i.e. the label, not a big container).
  const byText = (txt: string): Element | undefined => {
    const all = Array.from(document.querySelectorAll('[role="menuitem"],[role="option"],button,a,li,div,span'));
    const matches = all.filter(el => (el.textContent ?? '').trim() === txt);
    matches.sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0));
    return matches[0];
  };
  const clickable = (el: Element) => el.closest('[role="menuitem"],button') ?? el;

  const tile = document.querySelector(`[data-tile-id="${tileId}"]`);
  if (!tile) return 'no-tile';

  const moreBtn = Array.from(tile.querySelectorAll('button')).find(b => iconName(b) === 'more_vert');
  if (!moreBtn) return 'no-more';

  const findDownload = () => byText('Download') ?? Array.from(document.querySelectorAll('[role="menuitem"]')).find(el => (el.textContent ?? '').includes('Download'));
  // Only open the menu if it isn't already open (re-clicking ⋮ would toggle it shut).
  let dl = findDownload();
  if (!dl) { fire(moreBtn); await sleep(700); dl = findDownload(); }
  if (!dl) return `no-download(menuitems=${document.querySelectorAll('[role="menuitem"]').length})`;
  // A real CSS hover can't be faked, but ARIA menus support KEYBOARD navigation. So focus
  // "Download", press ArrowRight (open submenu) / Enter fallback, ArrowDown to 720p, Enter.
  const dlEl = clickable(dl) as HTMLElement;
  const sendKey = (target: Element, key: string, keyCode: number) => {
    for (const t of ['keydown', 'keyup']) {
      try { target.dispatchEvent(new KeyboardEvent(t, { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true })); } catch {}
    }
  };
  const activeText = () => (document.activeElement?.textContent ?? '').trim();
  const submenuShowing = () => /270p|720p|1080p/i.test(document.body.textContent ?? '');

  dlEl.focus?.();
  await sleep(150);
  sendKey(document.activeElement ?? dlEl, 'ArrowRight', 39);
  await sleep(300);
  if (!submenuShowing()) { sendKey(document.activeElement ?? dlEl, 'Enter', 13); await sleep(300); }

  let got720 = /720p/i.test(activeText());
  for (let i = 0; i < 6 && !got720; i++) {
    sendKey(document.activeElement ?? dlEl, 'ArrowDown', 40);
    await sleep(150);
    got720 = /720p/i.test(activeText());
  }
  if (got720) {
    sendKey(document.activeElement ?? dlEl, 'Enter', 13);
    (document.activeElement as HTMLElement)?.click?.();
    return 'kb-clicked-720';
  }

  // Fallback: if the submenu rendered into the DOM, click 720p directly.
  const opt = byText('720p') ?? Array.from(document.querySelectorAll('[role="menuitem"],button,li,div'))
    .find(el => { const t = (el.textContent ?? '').trim(); return /720p/i.test(t) && t.length < 80; });
  if (opt) { fire(clickable(opt)); return 'kb-fallback-720'; }
  return `kb-no-720(active="${activeText().slice(0, 24)}",submenu=${submenuShowing()})`;
}

function startPolling() {
  if (pollingInterval || !activeTabId) return;
  pollingInterval = setInterval(async () => {
    if (!queue.some(q => q.status === 'IN_PROGRESS')) {
      // nothing active; keep polling only while work remains
      if (!queue.some(q => q.status === 'PENDING' || q.status === 'RATE_LIMITED')) {
        clearInterval(pollingInterval!); pollingInterval = null;
      }
      return;
    }
    if (!activeTabId) return;

    let tiles: [string, string][] = [];
    let whiskCount = 0;
    let whiskNewImgs: [string, string][] = [];   // [fingerprint, dataUrl] of finished, not-yet-saved images
    try {
      if (currentMode === 'whisk') {
        // Whisk (about:srcdoc iframe): count result tiles (to detect settle) AND grab any FINISHED
        // images — they become <img> with a base64 data: URL once rendered. "Failed" tiles have no
        // img. We pass the already-saved fingerprints in so the page only returns NEW finished ones.
        const seenArr = Array.from(whiskSeen);
        const results = await chrome.scripting.executeScript({
          target: { tabId: activeTabId, allFrames: true },
          func: (seen: string[]) => {
            const seenSet = new Set(seen);
            let count = 0;
            const imgs: [string, string][] = [];
            document.querySelectorAll('div.aspect-video').forEach(tile => {
              count++;
              tile.querySelectorAll('img').forEach(el => {
                const img = el as HTMLImageElement;
                if (img.src && img.src.startsWith('data:image') && img.naturalWidth >= 512) {
                  const fp = `${img.src.length}_${img.src.slice(0, 48)}`;   // cheap unique key
                  if (!seenSet.has(fp)) imgs.push([fp, img.src]);
                }
              });
            });
            return { count, imgs };
          },
          args: [seenArr],
        });
        results.forEach(r => {
          const v = r.result as { count: number; imgs: [string, string][] } | undefined;
          if (v) { whiskCount += v.count; whiskNewImgs.push(...v.imgs); }
        });
      } else {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: activeTabId },
          func: (mode: 'image' | 'video') => {
            const t: [string, string][] = [];
            const iconName = (el: Element) => (el.querySelector('i.google-symbols')?.textContent ?? '').trim();
            document.querySelectorAll('[data-tile-id]').forEach(tile => {
              const id = tile.getAttribute('data-tile-id');
              if (!id) return;
              if (mode === 'video') {
                // A FINISHED video tile has a <video> with a real https src (Flow's
                // media.getMediaUrlRedirect URL — directly downloadable with cookies).
                // The ⋮ toolbar only mounts on REAL hover, so it can't be the signal.
                const vid = tile.querySelector('video') as HTMLVideoElement | null;
                const src = vid?.src || (vid?.querySelector('source') as HTMLSourceElement | null)?.src || '';
                const ready = /^https?:/.test(src)
                  || Array.from(tile.querySelectorAll('button')).some(b => iconName(b) === 'more_vert');
                if (ready) t.push([id, src || 'video']);
              } else {
                const img = tile.querySelector('img') as HTMLImageElement | null;
                if (img?.src && !img.src.includes('data:image')) {
                  t.push([id, img.src.startsWith('/') ? location.origin + img.src : img.src]);
                }
              }
            });
            return t;
          },
          args: [currentMode as 'image' | 'video'],
        });
        tiles = (result as [string, string][]) ?? [];
      }
    } catch (e) {
      console.error('[AIF] poll error', e);
      return;
    }

    const current = queue.find(q => q.status === 'IN_PROGRESS');

    if (!current) {
      for (const [tileId] of tiles) seenTileIds.add(tileId);
      return;
    }

    if (current.mode === 'video') {
      // Semi-auto: a real CSS hover can't be synthesized, so we don't fake the download click.
      // When the clip is finished, arm the rename and mark it READY — the user downloads it in
      // Flow (⋮ → Download → 720p) and onDeterminingFilename files it + advances the queue.
      const fresh = tiles.find(([id]) => !seenTileIds.has(id));
      if (!fresh) return;
      seenTileIds.add(fresh[0]);
      const padded = current.scene_number.toString().padStart(2, '0');
      const videoPath = `AutoImage/${current.project}/scene_${padded}.mp4`;

      // FULL AUTO: the tile's <video> src is a plain https URL (media.getMediaUrlRedirect)
      // — download it directly through the Downloads API (cookie-authenticated, no CORS).
      const [, vidSrc] = fresh;
      if (/^https?:/.test(vidSrc)) {
        urlToFilename.set(vidSrc, videoPath);
        const vuuid = vidSrc.match(/[?&]name=([0-9a-fA-F-]{36})/)?.[1];
        if (vuuid) urlToFilename.set(vuuid, videoPath);
        try {
          await browser.downloads.download({ url: vidSrc, filename: videoPath, saveAs: false });
          current.status = 'DOWNLOADED';
          broadcastQueue();
          console.log(`[AIF] scene ${current.scene_number} video downloaded direct → ${videoPath}`);
          processQueue();
          return;
        } catch (err) {
          console.warn('[AIF] direct video download failed — falling back to menu/manual:', err);
        }
      }

      pendingVideoPath = videoPath;
      current.status = 'READY';
      broadcastQueue();
      console.log(`[AIF] scene ${current.scene_number} READY — download it in Flow (⋮ → Download → 720p)`);

      // Full-auto attempt: the ⋮ button only SHOWS on CSS hover, but it exists in the DOM and
      // JS .click() works fine on hover-hidden elements. Chain: ⋮ → Download → 720p. The
      // download then hits onDeterminingFilename (pendingVideoPath is armed) which renames the
      // file and advances the queue. If any step fails we stay READY — manual download still
      // works exactly as before.
      try {
        const [{ result: clickResult }] = await chrome.scripting.executeScript({
          target: { tabId: activeTabId },
          func: async (tileId: string) => {
            const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
            const iconName = (el: Element) => (el.querySelector('i.google-symbols')?.textContent ?? '').trim();
            // React/MUI components often ignore a bare .click() — dispatch the full
            // pointer sequence (same trick as the reference-picker attach code).
            const fire = (el: Element) => {
              const r = el.getBoundingClientRect();
              const o = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
              el.dispatchEvent(new PointerEvent('pointerover', o));
              el.dispatchEvent(new MouseEvent('mouseover', o));
              el.dispatchEvent(new PointerEvent('pointerdown', o));
              el.dispatchEvent(new MouseEvent('mousedown', o));
              el.dispatchEvent(new PointerEvent('pointerup', o));
              el.dispatchEvent(new MouseEvent('mouseup', o));
              el.dispatchEvent(new MouseEvent('click', o));
            };
            const tile = document.querySelector(`[data-tile-id="${tileId}"]`);
            if (!tile) return 'no-tile';
            // Hover the tile first — some toolbars only mount on mouseenter
            fire(tile);
            await sleep(400);
            const more = Array.from(tile.querySelectorAll('button')).find(b => iconName(b) === 'more_vert');
            if (!more) return 'no-menu-button';
            fire(more);
            await sleep(900);
            const menuItems = () =>
              Array.from(document.querySelectorAll<HTMLElement>(
                '[role="menuitem"], [role="menu"] button, [role="menu"] li, [role="dialog"] button, [class*="popover"] button, [class*="menu"] [tabindex]'))
                .filter(el => el.offsetParent !== null && el.getBoundingClientRect().width > 0);
            let dl = menuItems().find(el => /download/i.test(el.textContent ?? '') || iconName(el) === 'download');
            if (!dl) { await sleep(900); dl = menuItems().find(el => /download/i.test(el.textContent ?? '') || iconName(el) === 'download'); }
            if (!dl) {
              const seen = menuItems().map(el => (el.textContent ?? '').trim().slice(0, 20)).filter(Boolean).slice(0, 8).join('/');
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              return 'no-download-item; menu showed: ' + (seen || 'nothing');
            }
            fire(dl);
            await sleep(900);
            let q = menuItems().find(el => /720/.test(el.textContent ?? ''))
              ?? menuItems().find(el => /original|1080|mp4|gif/i.test(el.textContent ?? ''));
            if (!q) { await sleep(900); q = menuItems().find(el => /720|original|1080|mp4/i.test(el.textContent ?? '')); }
            if (!q) {
              const seen = menuItems().map(el => (el.textContent ?? '').trim().slice(0, 20)).filter(Boolean).slice(0, 8).join('/');
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              return 'no-quality-item; menu showed: ' + (seen || 'nothing');
            }
            fire(q);
            return 'clicked';
          },
          args: [fresh[0]],
        });
        console.log('[AIF] video auto-download click chain:', clickResult);
      } catch (e) {
        console.warn('[AIF] video auto-download click failed — download manually (READY armed):', e);
      }
      return;
    }

    if (current.mode === 'whisk') {
      whiskPolls++;
      // Download any newly-FINISHED images for this prompt (data: URLs download directly). Cap 2.
      const WHISK_MAX = 2;
      for (const [fp, dataUrl] of whiskNewImgs) {
        if ((whiskSceneCount.get(current.scene_number) ?? 0) >= WHISK_MAX) break;
        if (whiskSeen.has(fp)) continue;
        whiskSeen.add(fp);
        const k = (whiskSceneCount.get(current.scene_number) ?? 0) + 1;
        whiskSceneCount.set(current.scene_number, k);
        const padded = current.scene_number.toString().padStart(2, '0');
        browser.downloads.download({ url: dataUrl, filename: `AutoImage/${current.project}/scene_${padded}_${k}.jpg`, saveAs: false })
          .catch(err => console.error('[AIF] whisk download error', err));
        console.log(`[AIF] whisk scene ${current.scene_number} image ${k}`);
      }

      const saved = whiskSceneCount.get(current.scene_number) ?? 0;
      // Got our 2 — move on, but PACE it: wait a cooldown before the next prompt so we don't trip
      // Whisk's rate limit (which is what makes later scenes fail on big batches).
      if (saved >= WHISK_MAX) { current.status = 'DOWNLOADED'; broadcastQueue(); setTimeout(() => processQueue(), WHISK_COOLDOWN_MS); return; }

      // Otherwise advance once this prompt's tile slots have appeared and settled (finished OR failed).
      if (whiskCount <= whiskBaseline) {
        if (++whiskWaitPolls >= 30) { current.status = 'GENERATED'; broadcastQueue(); setTimeout(() => processQueue(), WHISK_COOLDOWN_MS); }  // ~90s nothing
        return;
      }
      if (whiskCount === whiskLastCount) whiskStable++;
      else { whiskStable = 0; whiskLastCount = whiskCount; }
      // stable for ~3 polls gives late images time to render into data: URLs before we move on.
      if (whiskStable >= 3 && whiskPolls >= 4) {
        current.status = saved > 0 ? 'DOWNLOADED' : 'GENERATED';   // GENERATED = all variations failed
        broadcastQueue();
        setTimeout(() => processQueue(), WHISK_COOLDOWN_MS);       // pace the next prompt
      }
      return;
    }

    // Image mode: download by URL.
    for (const [tileId, imgUrl] of tiles) {
      if (seenTileIds.has(tileId)) continue;
      const already = sceneDownloadCount.get(current.scene_number) ?? 0;
      if (already >= IMAGES_PER_SCENE) break;

      seenTileIds.add(tileId);
      const imageIndex = already + 1;
      sceneDownloadCount.set(current.scene_number, imageIndex);

      const padded = current.scene_number.toString().padStart(2, '0');
      const intended = IMAGES_PER_SCENE === 1
        ? `AutoImage/${current.project}/scene_${padded}.jpg`
        : `AutoImage/${current.project}/Scene_${padded}/image_${imageIndex}.jpg`;
      urlToFilename.set(imgUrl, intended);
      const uuid = imgUrl.match(/[?&]name=([0-9a-fA-F-]{36})/)?.[1];
      if (uuid) urlToFilename.set(uuid, intended);

      browser.downloads.download({ url: imgUrl, filename: intended, saveAs: false })
        .catch(err => console.error('[AIF] download error', err));
      console.log(`[AIF] downloaded scene ${current.scene_number} image ${imageIndex}`);

      if (imageIndex >= IMAGES_PER_SCENE) {
        current.status = 'DOWNLOADED';
        broadcastQueue();
        processQueue();
        break;
      }
    }
  }, POLL_INTERVAL_MS);
}
