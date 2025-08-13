const els = {
  providerBadge: document.getElementById('active-provider'),
  form: document.getElementById('settings-form'),
  radios: Array.from(document.querySelectorAll('input[name="aiProvider"]')),
  groqGroup: document.getElementById('groq-fields'),
  groqApiKey: document.getElementById('groq-apiKey'),
  groqModel: document.getElementById('groq-model'),
  ollamaGroup: document.getElementById('ollama-fields'),
  ollamaUrl: document.getElementById('ollama-url'),
  ollamaModel: document.getElementById('ollama-model'),
  testBtn: document.getElementById('test-btn'),
  testStatus: document.getElementById('test-status'),
  saveBtn: document.getElementById('save-btn'),
  saveStatus: document.getElementById('save-status'),
  resetBtn: document.getElementById('reset-btn'),
  uploadZone: document.getElementById('upload-zone'),
  filePicker: document.getElementById('file-picker'),
  uploadStatus: document.getElementById('upload-status'),
  rebuildBtn: document.getElementById('rebuild-btn'),
  rebuildStatus: document.getElementById('rebuild-status'),
  rebuildBar: document.getElementById('rebuild-bar'),
  docSearch: document.getElementById('doc-search'),
  docListing: document.getElementById('doc-listing'),
};

function setBadge(text, ok) {
  if (!els.providerBadge) return;
  els.providerBadge.textContent = text || '';
  els.providerBadge.style.opacity = ok ? '1' : '0.8';
}

function showGroups(provider) {
  const isGroq = provider === 'groq';
  els.groqGroup.hidden = !isGroq;
  els.ollamaGroup.hidden = isGroq;
}

function getFormSettings() {
  const provider = els.radios.find(r => r.checked)?.value || 'groq';
  const payload = { aiProvider: provider, groq: {}, ollama: {} };
  if (provider === 'groq') {
    if (els.groqApiKey.value.trim()) payload.groq.apiKey = els.groqApiKey.value.trim();
    if (els.groqModel.value.trim()) payload.groq.model = els.groqModel.value.trim();
  } else {
    if (els.ollamaUrl.value.trim()) payload.ollama.url = els.ollamaUrl.value.trim();
    if (els.ollamaModel.value.trim()) payload.ollama.model = els.ollamaModel.value.trim();
  }
  return payload;
}

function applySettingsToForm(s) {
  const provider = (s.aiProvider || 'groq').toLowerCase();
  (els.radios.find(r => r.value === provider) || els.radios[0]).checked = true;
  showGroups(provider);
  if (s.groq) {
    els.groqModel.value = s.groq.model || '';
    // Do not prefill API key for safety; leave empty unless the user wants to rotate it
  }
  if (s.ollama) {
    els.ollamaUrl.value = s.ollama.url || '';
    els.ollamaModel.value = s.ollama.model || '';
  }
}

async function fetchSettings() {
  const res = await fetch('/api/settings');
  return res.json();
}

async function testConnection() {
  els.testBtn.disabled = true;
  els.testStatus.textContent = 'Testing...';
  try {
    const res = await fetch('/api/settings/test');
    const data = await res.json();
    els.testStatus.textContent = data.message || (data.success ? 'OK' : 'Failed');
    els.testStatus.style.color = data.success ? '#7dd97c' : '#ff9a8a';
  } catch (e) {
    els.testStatus.textContent = 'Network error';
    els.testStatus.style.color = '#ff9a8a';
  } finally {
    els.testBtn.disabled = false;
  }
}

async function saveSettings(payload) {
  els.saveBtn.disabled = true;
  els.saveStatus.textContent = 'Saving...';
  els.saveStatus.style.color = '';
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.success) {
      els.saveStatus.textContent = 'Saved';
      els.saveStatus.style.color = '#7dd97c';
      // Refresh badge
      setBadge(`Saved • Provider: ${payload.aiProvider}`, true);
    } else {
      els.saveStatus.textContent = data.error || 'Failed';
      els.saveStatus.style.color = '#ff9a8a';
    }
  } catch (e) {
    els.saveStatus.textContent = 'Network error';
    els.saveStatus.style.color = '#ff9a8a';
  } finally {
    els.saveBtn.disabled = false;
  }
}

// Init
(async function init() {
  els.radios.forEach(r => r.addEventListener('change', () => showGroups(r.value)));
  els.testBtn.addEventListener('click', testConnection);
  els.resetBtn.addEventListener('click', async () => {
    const data = await fetchSettings();
    if (data.success) applySettingsToForm(data.data);
  });
  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = getFormSettings();
    // Simple client validation
    if (payload.aiProvider === 'ollama') {
      if (payload.ollama?.url && !/^https?:\/\//i.test(payload.ollama.url)) {
        els.saveStatus.textContent = 'Invalid Ollama URL';
        els.saveStatus.style.color = '#ff9a8a';
        return;
      }
    }
    await saveSettings(payload);
  });

  try {
    const data = await fetchSettings();
    if (data.success) {
      applySettingsToForm(data.data);
      setBadge(`Provider: ${data.data.aiProvider}`, true);
    } else {
      setBadge('Provider: unknown', false);
    }
  } catch {
    setBadge('Provider: unknown', false);
  }

  // Documents management
  // Bind browse label explicitly
  const browseLabel = document.querySelector('label[for="file-picker"]');
  if (browseLabel && els.filePicker) {
    browseLabel.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!els.filePicker.disabled) els.filePicker.click();
    });
  }

  // Always bind file input change if present
  if (els.filePicker) {
    els.filePicker.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      await uploadFiles(files);
      els.filePicker.value = '';
      await refreshDocuments();
    });
  }

  if (els.uploadZone && els.docListing) {
    const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => els.uploadZone.addEventListener(ev, prevent));
    els.uploadZone.addEventListener('drop', async (e) => {
      const files = Array.from(e.dataTransfer.files || []);
      await uploadFiles(files);
      await refreshDocuments();
    });
    els.uploadZone.addEventListener('click', () => { if (!els.filePicker?.disabled) els.filePicker?.click(); });
    els.rebuildBtn?.addEventListener('click', rebuildIndex);
    els.docSearch?.addEventListener('input', renderDocuments);
    await refreshDocuments();
  }
})();

let documentsCache = [];

async function refreshDocuments() {
  try {
    const res = await fetch('/api/documents');
    const data = await res.json();
    if (data.success) {
      documentsCache = data.data.documents || [];
      renderDocuments();
    }
  } catch {}
}

function renderDocuments() {
  if (!els.docListing) return;
  const q = (els.docSearch?.value || '').toLowerCase();
  const list = documentsCache.filter(d => !q || d.name.toLowerCase().includes(q));
  els.docListing.innerHTML = '';
  if (!list.length) {
    els.docListing.innerHTML = '<div class="muted">No documents found.</div>';
    return;
  }
  for (const d of list) {
    const row = document.createElement('div');
    row.className = 'doc-row';
    const meta = document.createElement('div');
    meta.className = 'doc-meta';
    meta.innerHTML = `<div class="name">${d.name}</div><div class="sub muted">${formatSize(d.size)} • ${d.type || ''} ${d.uploadDate ? '• ' + d.uploadDate : ''}</div>`;
    const actions = document.createElement('div');
    actions.className = 'doc-actions';
    const del = document.createElement('button');
    del.className = 'btn-secondary';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete ${d.name}?`)) return;
      const resp = await fetch(`/api/documents/${encodeURIComponent(d.name)}`, { method: 'DELETE' });
      const json = await resp.json();
      if (json.success) await refreshDocuments();
    });
    actions.appendChild(del);
    row.appendChild(meta);
    row.appendChild(actions);
    els.docListing.appendChild(row);
  }
}

async function uploadFiles(files) {
  const allowed = ['pdf','docx','md','txt','html','htm','csv','tsv','log','json','jsonl','yaml','yml','ipynb','xlsx','epub','pptx'];
  const maxBytes = 20 * 1024 * 1024;
  for (const f of files) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (!allowed.includes(ext)) continue;
    if (f.size > maxBytes) continue;
    const contentBase64 = await fileToBase64(f);
    els.uploadStatus.textContent = `Uploading ${f.name}...`;
    const resp = await fetch('/api/documents/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: f.name, contentBase64 }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!json.success) {
      els.uploadStatus.textContent = `Failed to upload ${f.name}: ${json.error || 'error'}`;
    } else {
      els.uploadStatus.textContent = `Uploaded ${f.name}`;
    }
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      const base64 = res.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function rebuildIndex() {
  if (!els.rebuildStatus) return;
  els.rebuildBtn.disabled = true;
  els.rebuildStatus.textContent = 'Starting...';
  if (els.rebuildBar) els.rebuildBar.style.width = '0%';
  // Disable uploads during rebuild
  els.uploadZone?.classList.add('disabled');
  if (els.filePicker) els.filePicker.disabled = true;
  try {
    const startResp = await fetch('/api/ingest/start', { method: 'POST' });
    const started = await startResp.json().catch(() => ({}));
    if (!started.success) {
      els.rebuildStatus.textContent = started.error || 'Failed to start';
      els.rebuildBtn.disabled = false;
      return;
    }
    els.rebuildStatus.textContent = 'Scanning...';
    // Poll status
    const poll = async () => {
      const resp = await fetch('/api/ingest/status');
      const json = await resp.json();
      const st = json.data || {};
      const label = st.stage === 'embedding' ? 'Embedding' : st.stage === 'chunking' ? 'Chunking' : (st.stage || 'Working');
      if (st.stage === 'error') {
        els.rebuildStatus.textContent = st.error || 'Error';
        els.rebuildBtn.disabled = false;
        els.uploadZone?.classList.remove('disabled');
        if (els.filePicker) els.filePicker.disabled = false;
        return;
      }
      if (st.stage === 'done') {
        els.rebuildStatus.textContent = `Indexed ${st.processed} chunks`;
        if (els.rebuildBar) els.rebuildBar.style.width = '100%';
        els.rebuildBtn.disabled = false;
        els.uploadZone?.classList.remove('disabled');
        if (els.filePicker) els.filePicker.disabled = false;
        await refreshDocuments();
        return;
      }
      // Progress
      if (st.total > 0 && els.rebuildBar) {
        const pct = Math.max(0, Math.min(100, Math.round((st.processed / st.total) * 100)));
        els.rebuildBar.style.width = pct + '%';
      }
      els.rebuildStatus.textContent = `${label}... ${st.processed || 0}/${st.total || 0}`;
      setTimeout(poll, 800);
    };
    setTimeout(poll, 600);
  } catch {
    els.rebuildStatus.textContent = 'Network error';
    els.rebuildBtn.disabled = false;
    els.uploadZone?.classList.remove('disabled');
    if (els.filePicker) els.filePicker.disabled = false;
  }
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B','KB','MB','GB'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}


