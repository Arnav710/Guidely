const BACKEND = 'http://localhost:8000';

const dot      = document.getElementById('status-dot');
const statusTxt = document.getElementById('status-text');
const modelSel = document.getElementById('model-select');
const applyBtn = document.getElementById('apply-btn');
const feedback = document.getElementById('model-feedback');

async function checkBackend() {
  try {
    const res = await fetch(`${BACKEND}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      dot.className = 'online';
      statusTxt.textContent = 'Backend online ✓';
      return true;
    }
  } catch { /* fall through */ }
  dot.className = 'offline';
  statusTxt.textContent = 'Backend offline — start uvicorn';
  return false;
}

async function loadModels() {
  try {
    const res = await fetch(`${BACKEND}/models`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error('non-ok');
    const data = await res.json();

    modelSel.innerHTML = '';
    for (const m of data.available) {
      const opt = document.createElement('option');
      opt.value = m.name;
      const gb = m.size_bytes ? ` (${(m.size_bytes / 1e9).toFixed(1)} GB)` : '';
      const params = m.parameter_size ? ` — ${m.parameter_size}` : '';
      opt.textContent = `${m.name}${params}${gb}`;
      if (m.name === data.active) opt.selected = true;
      modelSel.appendChild(opt);
    }
    modelSel.disabled = false;
    applyBtn.disabled = false;
  } catch {
    modelSel.innerHTML = '<option value="">Could not load models</option>';
  }
}

applyBtn.addEventListener('click', async () => {
  const chosen = modelSel.value;
  if (!chosen) return;
  applyBtn.disabled = true;
  feedback.textContent = 'Switching…';
  feedback.className = '';
  try {
    const res = await fetch(`${BACKEND}/models/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: chosen }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      feedback.textContent = `✓ Now using ${chosen}`;
      feedback.className = 'ok';
    } else {
      const err = await res.json();
      feedback.textContent = err.detail || 'Failed to switch model';
      feedback.className = 'err';
    }
  } catch {
    feedback.textContent = 'Could not reach backend';
    feedback.className = 'err';
  }
  applyBtn.disabled = false;
});

(async () => {
  const online = await checkBackend();
  if (online) await loadModels();
})();
