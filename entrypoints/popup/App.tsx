import { useState, useEffect } from 'react';
import { browser } from 'wxt/browser';
import { QueueItem, ScriptData } from '../../utils/types';
import { parseImagePromptToText } from '../../utils/parser';

const STATUS_COLOR: Record<string, string> = {
  PENDING: '#fbbc04',
  IN_PROGRESS: '#4285f4',
  READY: '#a142f4',
  DOWNLOADED: '#34a853',
  RATE_LIMITED: '#fa903e',
  ERROR: '#ea4335',
};
const STATUS_ICON: Record<string, string> = {
  PENDING: '⏳', IN_PROGRESS: '⚙️', READY: '⬇️', DOWNLOADED: '✅', RATE_LIMITED: '🐢', ERROR: '❌',
};

function App() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [error, setError] = useState('');
  const [parsed, setParsed] = useState<{ scene_number: number; prompt: string }[]>([]);
  const [fileName, setFileName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [mode, setMode] = useState<'image' | 'video'>('image');

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
        setParsed(json.scenes.map(s => ({
          scene_number: s.scene_number,
          prompt: s.prompt ?? (s.image_prompt ? parseImagePromptToText(s.image_prompt) : ''),
        })));
        setError('');
      } catch {
        setError('Could not read that JSON file.');
      }
    };
    reader.readAsText(file);
  };

  const start = async () => {
    if (parsed.length === 0) { setError('Upload a JSON file first.'); return; }
    setError('');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) { setError('No active tab found. Open Flow and try again.'); return; }
      await browser.runtime.sendMessage({ type: 'START_QUEUE', prompts: parsed, tabId: tab.id, projectName: projectName.trim(), mode });
      setParsed([]); setFileName('');
    } catch {
      setError('Could not reach the extension background.');
    }
  };

  const clear = () => browser.runtime.sendMessage({ type: 'CLEAR_QUEUE' }).catch(() => {});

  const total = queue.length;
  const done = queue.filter(q => q.status === 'DOWNLOADED').length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const box: React.CSSProperties = { padding: 16, width: 380, display: 'flex', flexDirection: 'column', gap: 14, fontFamily: 'system-ui, sans-serif' };

  return (
    <div style={box}>
      <h2 style={{ margin: 0, fontSize: 18, color: '#1a73e8' }}>AutoImage</h2>

      <div style={{ display: 'flex', gap: 6 }}>
        {(['image', 'video'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)}
            style={{ flex: 1, padding: '6px 0', fontSize: 12, fontWeight: 600, textTransform: 'capitalize', borderRadius: 6, cursor: 'pointer', border: mode === m ? '1px solid #1a73e8' : '1px solid #dadce0', background: mode === m ? '#e8f0fe' : '#fff', color: mode === m ? '#1a73e8' : '#5f6368' }}>
            {m === 'image' ? '🖼️ Images' : '🎬 Video'}
          </button>
        ))}
      </div>
      {mode === 'video' && (
        <div style={{ fontSize: 11, color: '#9aa0a6', marginTop: -6 }}>Set Flow to video + Omni first. Video uses Flow credits (not free) and renders take minutes.</div>
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

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#9aa0a6' }}>
          <input type="checkbox" disabled /> Use reference image (coming soon)
        </label>

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
