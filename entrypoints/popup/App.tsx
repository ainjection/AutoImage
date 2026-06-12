import { useState, useEffect } from 'react';
import { browser } from 'wxt/browser';
import { QueueItem, ScriptData } from '../../utils/types';
import { parseImagePromptToText } from '../../utils/parser';

const STATUS_COLOR: Record<string, string> = {
  PENDING: '#fbbc04',
  IN_PROGRESS: '#4285f4',
  READY: '#a142f4',
  DOWNLOADED: '#34a853',
  GENERATED: '#34a853',
  RATE_LIMITED: '#fa903e',
  ERROR: '#ea4335',
};
const STATUS_ICON: Record<string, string> = {
  PENDING: '⏳', IN_PROGRESS: '⚙️', READY: '⬇️', DOWNLOADED: '✅', GENERATED: '🎨', RATE_LIMITED: '🐢', ERROR: '❌',
};

function App() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [error, setError] = useState('');
  const [parsed, setParsed] = useState<{ scene_number: number; prompt: string; start_frame?: string; end_frame?: string; character?: string }[]>([]);
  const [fileName, setFileName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [mode, setMode] = useState<'image' | 'video' | 'whisk'>('image');
  const [useRefImg, setUseRefImg] = useState(false);
  const [frameImages, setFrameImages] = useState<{ name: string; dataUrl: string }[]>([]);
  const [settings, setSettings] = useState<any>(null);
  const [refImage, setRefImage] = useState('');   // dataURL of the reference image
  const [refName, setRefName] = useState('');

  useEffect(() => {
    browser.runtime.sendMessage({ type: 'GET_QUEUE' }).then((res: any) => {
      if (res?.queue) setQueue(res.queue);
    }).catch(() => {});
    const listener = (msg: any) => { if (msg?.type === 'QUEUE_UPDATED') setQueue(msg.queue); };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    // Pre-fill the project name from the file name (e.g. "fatbob.json" → "fatbob") if empty.
    setProjectName(prev => prev || file.name.replace(/\.json$/i, ''));
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const json = JSON.parse(ev.target?.result as string) as ScriptData;
        if (!json.scenes || !Array.isArray(json.scenes)) {
          setError('That JSON is missing a "scenes" array.');
          return;
        }
        setSettings((json as any).settings ?? null);
        if ((json as any).settings?.mode) setMode((json as any).settings.mode === 'video' ? 'video' : 'image');
        setParsed(json.scenes.map(s => ({
          scene_number: s.scene_number,
          prompt: s.prompt ?? (s.image_prompt ? parseImagePromptToText(s.image_prompt) : ''),
          start_frame: s.start_frame,
          end_frame: s.end_frame,
          character: s.character,
        })));
        setError('');
      } catch {
        setError('Could not read that JSON file.');
      }
    };
    reader.readAsText(file);
  };

  const onRefFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setRefName(file.name);
    const reader = new FileReader();
    reader.onload = ev => setRefImage(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const onFrameFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = ev => {
        const name = file.name.replace(/\.[^.]+$/, '').toLowerCase();
        setFrameImages(prev => [...prev.filter(f => f.name !== name), { name, dataUrl: ev.target?.result as string }]);
      };
      reader.readAsDataURL(file);
    });
  };

  const start = async () => {
    if (parsed.length === 0) { setError('Upload a JSON file first.'); return; }
    if (useRefImg && !refImage) { setError('Pick a reference image (or untick the box).'); return; }
    setError('');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) { setError('No active tab found. Open Flow and try again.'); return; }
      await browser.runtime.sendMessage({
        type: 'START_QUEUE', prompts: parsed, tabId: tab.id, projectName: projectName.trim(), mode,
        refImage: useRefImg && mode !== 'whisk' ? refImage : null,
        frameImages, settings,
      });
      setParsed([]); setFileName('');
    } catch {
      setError('Could not reach the extension background.');
    }
  };

  const clear = () => browser.runtime.sendMessage({ type: 'CLEAR_QUEUE' }).catch(() => {});

  const [scanReport, setScanReport] = useState('');
  const scan = async () => {
    setError(''); setScanReport('Scanning…');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) { setError('No active tab found. Open Flow and try again.'); return; }
      const res: any = await browser.runtime.sendMessage({ type: 'SCAN_UPLOAD', tabId: tab.id });
      setScanReport(res?.report || '(no report)');
    } catch {
      setError('Could not run the scan.');
    }
  };

  const inspect = async () => {
    setError('');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) { setError('No active tab found. Open the page and try again.'); return; }
      await browser.runtime.sendMessage({ type: 'INSPECT_MODE', tabId: tab.id });
    } catch {
      setError('Could not start inspect mode.');
    }
  };

  const total = queue.length;
  const done = queue.filter(q => q.status === 'DOWNLOADED' || q.status === 'GENERATED').length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const box: React.CSSProperties = { padding: 16, width: 380, display: 'flex', flexDirection: 'column', gap: 14, fontFamily: 'system-ui, sans-serif' };

  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 18, color: '#1a73e8' }}>AutoImage</h2>
        <button
          onClick={() => browser.tabs.create({ url: browser.runtime.getURL('/guide.html') })}
          style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid #dadce0', background: '#fff', color: '#5f6368', cursor: 'pointer' }}>
          📖 How to use
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        {(['image', 'video', 'whisk'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)}
            style={{ flex: 1, padding: '6px 0', fontSize: 12, fontWeight: 600, textTransform: 'capitalize', borderRadius: 6, cursor: 'pointer', border: mode === m ? '1px solid #1a73e8' : '1px solid #dadce0', background: mode === m ? '#e8f0fe' : '#fff', color: mode === m ? '#1a73e8' : '#5f6368' }}>
            {m === 'image' ? '🖼️ Images' : m === 'video' ? '🎬 Video' : '🎨 Whisk'}
          </button>
        ))}
      </div>
      {mode === 'video' && (
        <div style={{ fontSize: 11, color: '#9aa0a6', marginTop: -6 }}>{settings ? "JSON has a settings block — Flow's mode/model/duration get set automatically." : "Set Flow to video + the model you want first (or add a settings block to the JSON and it's automatic)."} Video uses Flow credits and renders take minutes.</div>
      )}
      {mode === 'whisk' && (
        <div style={{ fontSize: 11, color: '#9aa0a6', marginTop: -6 }}>Lock your Subject / Scene / Style in Whisk first (it keeps them for every prompt). AutoImage fires each prompt, saves the first 2 finished images (skips any that fail), then moves on. JSON = same as video: a plain "prompt" per scene.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, background: '#f8f9fa', borderRadius: 8, border: '1px dashed #dadce0' }}>
        <p style={{ margin: 0, fontSize: 12, color: '#5f6368', fontWeight: 500 }}>1. Upload your prompts JSON</p>
        <input type="file" accept=".json" onChange={onFile} style={{ fontSize: 12 }} />

        <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5f6368', fontWeight: 500 }}>2. Project name (its folder)</p>
        <input type="text" value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="e.g. FatBob"
          style={{ fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid #dadce0' }} />
        <div style={{ fontSize: 11, color: '#9aa0a6' }}>→ Downloads\AutoImage\{(projectName.trim() || 'Untitled')}\</div>
        {parsed.length > 0 && (
          <div style={{ fontSize: 12, color: '#1e8e3e', fontWeight: 700 }}>✓ {fileName} — {parsed.length} scenes detected</div>
        )}

        {mode === 'video' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <p style={{ margin: 0, fontSize: 12, color: '#5f6368', fontWeight: 500 }}>Frame images (optional)</p>
            <input type="file" accept="image/*" multiple onChange={onFrameFiles} style={{ fontSize: 12 }} />
            {frameImages.length > 0 && (
              <div style={{ fontSize: 11, color: '#1e8e3e', fontWeight: 600 }}>✓ {frameImages.map(f => f.name).join(', ')}</div>
            )}
            <div style={{ fontSize: 11, color: '#9aa0a6' }}>Drop pictures here, then reference them by name in your JSON: "start_frame": "image1". They upload to Flow automatically when their scene runs.</div>
          </div>
        )}
        {mode !== 'whisk' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#3c4043', fontWeight: 500 }}>
              <input type="checkbox" checked={useRefImg} onChange={e => setUseRefImg(e.target.checked)} />
              Use reference image (lock style / character)
            </label>
            {useRefImg && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 22 }}>
                <input type="file" accept="image/*" onChange={onRefFile} style={{ fontSize: 12 }} />
                {refName && <div style={{ fontSize: 11, color: '#1e8e3e', fontWeight: 600 }}>✓ {refName}</div>}
                <div style={{ fontSize: 11, color: '#9aa0a6' }}>Attached to Flow's composer before each prompt so every start-frame keeps the same look. If Flow's "add image" button moved, run 🔍 Inspect mode → click it → send me the selector.</div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: '#9aa0a6' }}>Whisk mode locks references itself — set Subject/Scene/Style in Whisk above.</div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
          <button onClick={start} disabled={parsed.length === 0}
            style={{ flex: 1, background: parsed.length === 0 ? '#dadce0' : '#1a73e8', color: parsed.length === 0 ? '#5f6368' : '#fff', border: 'none', padding: '10px 16px', borderRadius: 20, cursor: parsed.length === 0 ? 'not-allowed' : 'pointer', fontWeight: 500 }}>
            Start Generation
          </button>
          <button onClick={clear}
            style={{ background: '#fff', color: '#ea4335', border: '1px solid #ea4335', padding: '10px 16px', borderRadius: 20, cursor: 'pointer', fontWeight: 500 }}>
            Clear Queue
          </button>
        </div>
      </div>

      {error && <p style={{ margin: 0, fontSize: 12, color: '#d93025', textAlign: 'center' }}>{error}</p>}

      <button onClick={inspect}
        style={{ background: '#fff', color: '#a142f4', border: '1px solid #a142f4', padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
        🔍 Inspect mode (capture selectors)
      </button>
      <div style={{ fontSize: 11, color: '#9aa0a6', marginTop: -8 }}>Turn on, then click an element on the page to log its selector. Click again to turn off.</div>

      <button onClick={scan}
        style={{ background: '#fff', color: '#1a73e8', border: '1px solid #1a73e8', padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
        🔬 Scan Flow for upload
      </button>
      <div style={{ fontSize: 11, color: '#9aa0a6', marginTop: -8 }}>Just click this on the Flow tab — it opens the + Create → Upload menu ITSELF and reports the result (you don't need to keep any menu open). Copy the report to me.</div>
      {scanReport && (
        <div>
          <button onClick={() => { try { navigator.clipboard.writeText(scanReport); } catch {} }}
            style={{ fontSize: 11, padding: '4px 8px', marginBottom: 4, borderRadius: 6, border: '1px solid #dadce0', background: '#fff', cursor: 'pointer' }}>Copy report</button>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 10, background: '#0c1018', color: '#7ee787', padding: 8, borderRadius: 6, maxHeight: 220, overflow: 'auto', margin: 0 }}>{scanReport}</pre>
        </div>
      )}

      {queue.some(q => q.status === 'READY') && (
        <div style={{ fontSize: 12, color: '#5b2a86', background: '#f3e8fd', border: '1px solid #a142f4', borderRadius: 8, padding: 10, fontWeight: 600 }}>
          ⬇️ A clip is ready — in Flow, click ⋮ → Download → 720p. It auto-files and moves to the next prompt.
        </div>
      )}

      {total > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#5f6368', fontWeight: 700 }}>
            <span>Overall Progress</span><span>{done} / {total} ({pct}%)</span>
          </div>
          <div style={{ height: 8, width: '100%', background: '#e8eaed', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: '#34a853', transition: 'width .3s' }} />
          </div>
        </div>
      )}

      <div style={{ borderTop: '1px solid #eee', paddingTop: 12 }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 14, color: '#3c4043' }}>Scene Details</h3>
        {queue.length === 0 ? (
          <p style={{ fontSize: 12, color: '#9aa0a6', fontStyle: 'italic' }}>No scenes in progress.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 250, overflowY: 'auto' }}>
            {queue.map(item => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: 8, background: '#f8f9fa', borderRadius: 6, borderLeft: `4px solid ${STATUS_COLOR[item.status] ?? '#5f6368'}` }}>
                <span title={item.status} style={{ marginTop: 2 }}>{STATUS_ICON[item.status] ?? '❓'}</span>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{ fontSize: 11, color: '#5f6368', fontWeight: 700 }}>Scene {item.scene_number} — {item.status}</div>
                  <div style={{ fontSize: 11, color: '#202124', marginTop: 4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{item.prompt}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
