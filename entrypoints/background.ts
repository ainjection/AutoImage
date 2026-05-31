import { browser } from 'wxt/browser';
import { QueueItem } from '../utils/types';

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

let queue: QueueItem[] = [];
let currentMode: 'image' | 'video' = 'image';
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
        sendResponse({ queue });
        return true;

      case 'START_QUEUE': {
        const { prompts, tabId, projectName, mode } = message as { prompts: { scene_number: number; prompt: string }[]; tabId: number; projectName?: string; mode?: 'image' | 'video' };
        activeTabId = tabId;
        currentMode = mode === 'video' ? 'video' : 'image';
        const project = sanitizeProject(projectName) || 'Untitled';
        const newItems: QueueItem[] = prompts.map(p => ({
          id: `${project}-${p.scene_number}-${Math.abs(hashString(p.prompt)).toString(36)}`,
          scene_number: p.scene_number,
          prompt: p.prompt,
          status: 'PENDING',
          project,
          mode: currentMode,
        }));
        queue = [...queue, ...newItems];
        broadcastQueue();
        initAndStart(tabId);
        sendResponse({ success: true });
        return true;
      }

      case 'CLEAR_QUEUE':
        queue = [];
        sceneDownloadCount.clear();
        urlToFilename.clear();
        broadcastQueue();
        sendResponse({ success: true });
        return true;
    }
    return false;
  });
});

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

function broadcastQueue() {
  browser.runtime.sendMessage({ type: 'QUEUE_UPDATED', queue }).catch(() => {});
}

async function initAndStart(tabId: number) {
  if (!isInitialized) {
    isInitialized = true;
    // Record image tiles already on the Flow page so we only download NEW generations.
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        // Record ALL existing tiles (images + videos) so we only act on NEW generations.
        func: () => Array.from(document.querySelectorAll('[data-tile-id]')).map(el => el.getAttribute('data-tile-id')),
      });
      (result ?? []).forEach((id: string | null) => { if (id) seenTileIds.add(id); });
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
  broadcastQueue();

  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      world: 'MAIN',
      func: injectPromptIntoFlow,
      args: [next.prompt],
    });
    await new Promise(r => setTimeout(r, 1500));
  } catch (e) {
    console.error('[AIF] inject error', e);
    next.status = 'ERROR';
  } finally {
    isInjecting = false;
    broadcastQueue();
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

    let scan: { tiles: [string, string][] };
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        func: (mode: 'image' | 'video') => {
          const tiles: [string, string][] = [];
          const iconName = (el: Element) => (el.querySelector('i.google-symbols')?.textContent ?? '').trim();
          document.querySelectorAll('[data-tile-id]').forEach(t => {
            const id = t.getAttribute('data-tile-id');
            if (!id) return;
            if (mode === 'video') {
              // A FINISHED video tile exposes its toolbar (the ⋮ "more_vert" button). Still-
              // generating tiles don't, so this reliably means "ready to download".
              const ready = Array.from(t.querySelectorAll('button')).some(b => iconName(b) === 'more_vert');
              if (ready) tiles.push([id, 'video']);
            } else {
              const img = t.querySelector('img') as HTMLImageElement | null;
              if (img?.src && !img.src.includes('data:image')) {
                tiles.push([id, img.src.startsWith('/') ? location.origin + img.src : img.src]);
              }
            }
          });
          return { tiles };
        },
        args: [currentMode],
      });
      scan = result as { tiles: [string, string][] };
    } catch (e) {
      console.error('[AIF] poll error', e);
      return;
    }

    const current = queue.find(q => q.status === 'IN_PROGRESS');

    if (!current) {
      for (const [tileId] of scan.tiles) seenTileIds.add(tileId);
      return;
    }

    if (current.mode === 'video') {
      // Semi-auto: a real CSS hover can't be synthesized, so we don't fake the download click.
      // When the clip is finished, arm the rename and mark it READY — the user downloads it in
      // Flow (⋮ → Download → 720p) and onDeterminingFilename files it + advances the queue.
      const fresh = scan.tiles.find(([id]) => !seenTileIds.has(id));
      if (!fresh) return;
      seenTileIds.add(fresh[0]);
      const padded = current.scene_number.toString().padStart(2, '0');
      pendingVideoPath = `AutoImage/${current.project}/scene_${padded}.mp4`;
      current.status = 'READY';
      broadcastQueue();
      console.log(`[AIF] scene ${current.scene_number} READY — download it in Flow (⋮ → Download → 720p)`);
      return;
    }

    // Image mode: download by URL.
    for (const [tileId, imgUrl] of scan.tiles) {
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
