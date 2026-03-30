"use strict";

/* ═══════════════════════════════════════════════════════════════
   VS-CAP — Main Application
   ═══════════════════════════════════════════════════════════════ */
const VSCAP = {
  /* ─── State ─── */
  data: {
    workspaces: [],
    globalStorage: new Map(),
    settingsJson: null,
    allFiles: new Map(),
    totalSize: 0,
    parsedSessions: new Map()
  },
  _failedLibs: [],
  _sqlDb: null,
  _activeWs: null,
  _activeTab: null,

  _libFail(name) { VSCAP._failedLibs.push(name) },

  /* ─── Initialize ─── */
  init() {
    if (window._VSCAP_LIB_FAILS) VSCAP._failedLibs = window._VSCAP_LIB_FAILS;

    const dz = document.getElementById('dropZone');
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over') });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); VSCAP.ingest.handleDrop(e) });
    document.getElementById('zipInput').addEventListener('change', e => { if(e.target.files[0]) VSCAP.ingest.fromZip(e.target.files[0]) });
    document.getElementById('folderInput').addEventListener('change', e => { if(e.target.files.length) VSCAP.ingest.fromFolder(e.target.files) });
    document.getElementById('searchInput').addEventListener('input', VSCAP._debounce(e => VSCAP.search.run(e.target.value), 300));
    document.getElementById('dateFrom').addEventListener('change', () => VSCAP.ui.applyDateFilter());
    document.getElementById('dateTo').addEventListener('change', () => VSCAP.ui.applyDateFilter());

    // Configure marked — escape raw HTML to prevent XSS from evidence data
    if (typeof marked !== 'undefined') {
      marked.use({
        breaks: true, gfm: true,
        renderer: {
          html(token) { return VSCAP._esc(typeof token === 'string' ? token : token.text || token.raw || ''); }
        }
      });
    }

    // Check libraries
    setTimeout(() => {
      const libs = [];
      if (typeof JSZip !== 'undefined') libs.push('JSZip ✓');
      else libs.push('JSZip ✗');
      if (typeof initSqlJs !== 'undefined') libs.push('sql.js ✓');
      else libs.push('sql.js ✗');
      if (typeof marked !== 'undefined') libs.push('marked ✓');
      else libs.push('marked ✗');
      document.getElementById('statLib').textContent = libs.join(' | ');
    }, 2000);
  },

  _debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } },

  _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML },

  _formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  },

  _formatDate(epoch) {
    if (!epoch) return 'Unknown';
    try { return new Date(epoch).toLocaleString() } catch { return String(epoch) }
  },

  _renderMd(text) {
    if (typeof marked !== 'undefined') {
      try { return marked.parse(text) } catch { return '<pre>' + VSCAP._esc(text) + '</pre>' }
    }
    return '<pre>' + VSCAP._esc(text) + '</pre>';
  },

  /* ═══════════════════════════════════════════════════════════
     INGEST — ZIP & Folder loading
     ═══════════════════════════════════════════════════════════ */
  ingest: {
    async handleDrop(e) {
      const items = e.dataTransfer.items;
      if (items && items.length === 1 && items[0].kind === 'file') {
        const file = items[0].getAsFile();
        if (file.name.endsWith('.zip')) {
          return VSCAP.ingest.fromZip(file);
        }
      }
      if (e.dataTransfer.files.length) {
        const f = e.dataTransfer.files[0];
        if (f.name.endsWith('.zip')) return VSCAP.ingest.fromZip(f);
      }
      if (items && items[0] && items[0].webkitGetAsEntry) {
        const entry = items[0].webkitGetAsEntry();
        if (entry && entry.isDirectory) {
          return VSCAP.ingest.fromDirectoryEntry(entry);
        }
      }
      alert('Please drop a .zip file or a folder.');
    },

    async fromZip(file) {
      if (typeof JSZip === 'undefined') { alert('JSZip library not loaded. Cannot process ZIP files.'); return }
      VSCAP.ui.showProgress(0, 'Reading ZIP file...');
      try {
        const zip = await JSZip.loadAsync(file, {
          onUpdate: meta => VSCAP.ui.showProgress(Math.round(meta.percent * 0.4), 'Extracting: ' + Math.round(meta.percent) + '%')
        });
        VSCAP.ui.showProgress(40, 'Building file index...');
        const entries = Object.keys(zip.files);
        let processed = 0;
        for (const path of entries) {
          const entry = zip.files[path];
          if (!entry.dir) {
            const data = await entry.async('uint8array');
            const normPath = path.replace(/\\/g, '/');
            VSCAP.data.allFiles.set(normPath, { data, size: data.byteLength });
            VSCAP.data.totalSize += data.byteLength;
          }
          processed++;
          if (processed % 50 === 0) VSCAP.ui.showProgress(40 + Math.round((processed / entries.length) * 30), `Indexing files: ${processed}/${entries.length}`);
        }
        await VSCAP.ingest._processFiles();
      } catch (err) {
        VSCAP.ui.hideProgress();
        alert('Error processing ZIP: ' + err.message);
        console.error(err);
      }
    },

    async fromFolder(fileList) {
      VSCAP.ui.showProgress(0, 'Reading folder...');
      let processed = 0;
      for (const file of fileList) {
        const path = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
        try {
          const buf = await file.arrayBuffer();
          const data = new Uint8Array(buf);
          VSCAP.data.allFiles.set(path, { data, size: data.byteLength });
          VSCAP.data.totalSize += data.byteLength;
        } catch {}
        processed++;
        if (processed % 50 === 0) VSCAP.ui.showProgress(Math.round((processed / fileList.length) * 70), `Reading: ${processed}/${fileList.length} files`);
      }
      await VSCAP.ingest._processFiles();
    },

    async fromDirectoryEntry(dirEntry) {
      VSCAP.ui.showProgress(0, 'Scanning folder...');
      const files = [];
      async function traverse(entry, path) {
        if (entry.isFile) {
          const file = await new Promise((res, rej) => entry.file(res, rej));
          files.push({ file, path: path + entry.name });
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          let entries = [];
          let batch;
          do {
            batch = await new Promise((res, rej) => reader.readEntries(res, rej));
            entries = entries.concat(batch);
          } while (batch.length > 0);
          for (const child of entries) {
            await traverse(child, path + entry.name + '/');
          }
        }
      }
      await traverse(dirEntry, '');
      VSCAP.ui.showProgress(30, `Found ${files.length} files, reading...`);
      let i = 0;
      for (const { file, path } of files) {
        try {
          const buf = await file.arrayBuffer();
          const data = new Uint8Array(buf);
          VSCAP.data.allFiles.set(path, { data, size: data.byteLength });
          VSCAP.data.totalSize += data.byteLength;
        } catch {}
        i++;
        if (i % 50 === 0) VSCAP.ui.showProgress(30 + Math.round((i / files.length) * 40), `Reading: ${i}/${files.length}`);
      }
      await VSCAP.ingest._processFiles();
    },

    async _processFiles() {
      VSCAP.ui.showProgress(70, 'Discovering workspaces...');
      const files = VSCAP.data.allFiles;

      const wsJsonPaths = [...files.keys()].filter(p => p.match(/workspaceStorage\/[^/]+\/workspace\.json$/i) || p.match(/[^/]+\/workspace\.json$/) && !p.includes('globalStorage'));
      const hashMap = new Map();

      for (const wjPath of wsJsonPaths) {
        try {
          const text = new TextDecoder().decode(files.get(wjPath).data);
          const wsJson = JSON.parse(text);
          const parts = wjPath.replace(/\\/g, '/').split('/');
          const wsJsonIdx = parts.indexOf('workspace.json');
          const hash = parts[wsJsonIdx - 1];
          const prefix = parts.slice(0, wsJsonIdx).join('/') + '/';

          let folderUri = wsJson.folder || wsJson.workspace || '';
          let friendlyName = folderUri;
          try {
            friendlyName = decodeURIComponent(folderUri.replace(/^file:\/\/\//i, '').replace(/\+/g, ' '));
          } catch { friendlyName = folderUri }
          const shortName = friendlyName.split('/').filter(Boolean).pop() || hash;

          hashMap.set(hash, { hash, prefix, path: friendlyName, name: shortName, wsJson,
            files: new Map(), chatSessions: [], editSessions: [], artifacts: [], memory: [], stateDbBuffer: null });
        } catch {}
      }

      if (hashMap.size === 0) {
        const topFolders = new Set();
        for (const p of files.keys()) {
          const first = p.split('/')[0];
          if (first && /^[a-f0-9]{20,}$/i.test(first)) topFolders.add(first);
        }
        for (const hash of topFolders) {
          hashMap.set(hash, { hash, prefix: hash + '/', path: hash, name: hash.substring(0, 12) + '…',
            wsJson: null, files: new Map(), chatSessions: [], editSessions: [], artifacts: [], memory: [], stateDbBuffer: null });
        }
      }

      VSCAP.ui.showProgress(75, `Found ${hashMap.size} workspaces, categorizing files...`);

      for (const [filePath, fileData] of files) {
        const norm = filePath.replace(/\\/g, '/');
        let assigned = false;
        for (const [, ws] of hashMap) {
          if (norm.startsWith(ws.prefix) || norm.startsWith(ws.hash + '/')) {
            const relPath = norm.startsWith(ws.prefix) ? norm.substring(ws.prefix.length) : norm.substring(ws.hash.length + 1);
            ws.files.set(relPath, fileData);

            if (/^chatSessions\/.*\.jsonl$/i.test(relPath)) {
              ws.chatSessions.push(relPath);
            } else if (/^chatEditingSessions\/.*\/state\.json$/i.test(relPath)) {
              ws.editSessions.push(relPath);
            } else if (/^GitHub\.copilot-chat\/chat-session-resources\//i.test(relPath)) {
              ws.artifacts.push(relPath);
            } else if (/^GitHub\.copilot-chat\/memory-tool\//i.test(relPath)) {
              ws.memory.push(relPath);
            } else if (/^state\.vscdb$/i.test(relPath)) {
              ws.stateDbBuffer = fileData.data;
            }
            assigned = true;
            break;
          }
        }
        if (!assigned) {
          if (/globalStorage/i.test(norm)) VSCAP.data.globalStorage.set(norm, fileData);
          if (/settings\.json$/i.test(norm) && !norm.includes('workspaceStorage') && !norm.includes('globalStorage')) {
            try { VSCAP.data.settingsJson = JSON.parse(new TextDecoder().decode(fileData.data)) } catch {}
          }
        }
      }

      VSCAP.data.workspaces = [...hashMap.values()].sort((a, b) => a.name.localeCompare(b.name));

      VSCAP.ui.showProgress(90, 'Building interface...');
      await new Promise(r => setTimeout(r, 100));

      let totalSessions = 0;
      for (const ws of VSCAP.data.workspaces) totalSessions += ws.chatSessions.length;

      document.getElementById('statWorkspaces').textContent = `📁 ${VSCAP.data.workspaces.length} workspaces`;
      document.getElementById('statSessions').textContent = `💬 ${totalSessions} sessions`;
      document.getElementById('statFiles').textContent = `📄 ${files.size} files`;
      document.getElementById('statSize').textContent = `💾 ${VSCAP._formatSize(VSCAP.data.totalSize)}`;

      VSCAP.ui.showProgress(100, 'Done!');
      await new Promise(r => setTimeout(r, 400));
      VSCAP.ui.hideProgress();

      document.getElementById('landing').classList.add('hidden');
      document.getElementById('viewer').classList.remove('hidden');
      VSCAP.ui.renderSidebar();
    }
  },

  /* ═══════════════════════════════════════════════════════════
     PARSE — Data parsers
     ═══════════════════════════════════════════════════════════ */
  parse: {
    chatSession(text) {
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length === 0) return null;
      let state = {};
      for (let i = 0; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.kind === 0) {
            state = structuredClone ? structuredClone(entry.v) : JSON.parse(JSON.stringify(entry.v));
          } else if (entry.kind === 1 || entry.kind === 2) {
            VSCAP.parse._applyMutation(state, entry.k, entry.v);
          }
        } catch (e) { console.warn('JSONL parse error line', i, e) }
      }

      const requests = (state.requests || []).map(r => VSCAP.parse._extractRequest(r));
      return {
        sessionId: state.sessionId || '',
        title: state.customTitle || 'Untitled Session',
        creationDate: state.creationDate || null,
        model: state.inputState?.selectedModel?.metadata?.name || state.inputState?.selectedModel?.identifier || 'Unknown',
        modelId: state.inputState?.selectedModel?.identifier || '',
        mode: state.inputState?.mode?.kind || state.inputState?.mode?.id || 'Unknown',
        responder: state.responderUsername || 'AI',
        requests,
        rawLineCount: lines.length,
        hasPendingEdits: !!state.hasPendingEdits
      };
    },

    _applyMutation(obj, path, value) {
      if (!path || path.length === 0) return;
      let target = obj;
      for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        if (target[key] === undefined || target[key] === null) {
          target[key] = typeof path[i + 1] === 'number' ? [] : {};
        }
        target = target[key];
      }
      target[path[path.length - 1]] = value;
    },

    _extractRequest(req) {
      if (!req) return null;
      let userMessage = '';
      let userContext = '';
      if (req.result?.metadata?.renderedUserMessage) {
        const full = req.result.metadata.renderedUserMessage.map(r => r.text || r.value || '').join('\n');
        const userMatch = full.match(/<userRequest>([\s\S]*?)<\/userRequest>/i);
        userMessage = userMatch ? userMatch[1].trim() : full;
        const ctxMatch = full.match(/<context>([\s\S]*?)<\/context>/i);
        const editorMatch = full.match(/<editorContext>([\s\S]*?)<\/editorContext>/i);
        const reminderMatch = full.match(/<reminderInstructions>([\s\S]*?)<\/reminderInstructions>/i);
        const parts = [];
        if (ctxMatch) parts.push('Context: ' + ctxMatch[1].trim());
        if (editorMatch) parts.push('Editor: ' + editorMatch[1].trim());
        if (reminderMatch) parts.push('System Instructions: ' + reminderMatch[1].trim().substring(0, 200) + '...');
        userContext = parts.join('\n\n');
        if (!userMatch && !ctxMatch) userMessage = full;
      }
      if (!userMessage && req.message) {
        userMessage = typeof req.message === 'string' ? req.message : (req.message.text || req.message.value || JSON.stringify(req.message));
      }

      const responseElements = [];
      if (Array.isArray(req.response)) {
        for (const elem of req.response) {
          if (!elem) continue;
          if (elem.kind === 'thinking') {
            if (elem.value && !elem.metadata?.vscodeReasoningDone) {
              responseElements.push({ type: 'thinking', text: elem.value, title: elem.generatedTitle || '' });
            }
          } else if (elem.kind === 'toolInvocationSerialized') {
            let msg = elem.pastTenseMessage?.value || elem.invocationMessage?.value || elem.invocationMessage || '';
            if (typeof msg !== 'string') msg = JSON.stringify(msg);
            let source = elem.originMessage || elem.source?.label || '';
            if (typeof source !== 'string') source = source.label || JSON.stringify(source);
            responseElements.push({ type: 'tool', message: msg, source,
              toolData: elem.toolSpecificData || null,
              isComplete: elem.isComplete });
          } else if (elem.kind === 'mcpServersStarting') {
            // skip
          } else if (elem.value !== undefined) {
            const text = typeof elem.value === 'string' ? elem.value : JSON.stringify(elem.value);
            if (text.trim()) responseElements.push({ type: 'text', text });
          }
        }
      }

      const consolidated = [];
      let textBuffer = '';
      for (const el of responseElements) {
        if (el.type === 'text') {
          textBuffer += el.text;
        } else {
          if (textBuffer.trim()) { consolidated.push({ type: 'text', text: textBuffer }); textBuffer = '' }
          consolidated.push(el);
        }
      }
      if (textBuffer.trim()) consolidated.push({ type: 'text', text: textBuffer });

      return {
        requestId: req.requestId || '',
        timestamp: req.timestamp || null,
        model: req.modelId || '',
        userMessage,
        userContext,
        response: consolidated,
        timings: req.result?.timings || {},
        completedAt: req.modelState?.completedAt || null,
        agent: req.agent?.fullName || req.agent?.name || '',
        agentId: req.agent?.id || '',
        contentReferences: req.contentReferences || [],
        codeCitations: req.codeCitations || [],
        followups: req.followups || []
      };
    },

    chatSessionMeta(text) {
      const firstLine = text.split('\n', 1)[0];
      if (!firstLine) return null;
      try {
        const entry = JSON.parse(firstLine);
        if (entry.kind !== 0) return null;
        const v = entry.v;
        let title = v.customTitle || '';
        if (!title) {
          const titleMatch = text.match(/"customTitle"\s*,\s*"v"\s*:\s*"([^"]+)"/);
          if (titleMatch) title = titleMatch[1];
        }
        return {
          sessionId: v.sessionId || '',
          title: title || 'Untitled Session',
          creationDate: v.creationDate || null,
          model: v.inputState?.selectedModel?.metadata?.name || v.inputState?.selectedModel?.identifier || 'Unknown',
          requestCount: (v.requests || []).length,
          lineCount: text.split('\n').filter(l => l.trim()).length
        };
      } catch { return null }
    },

    editSession(text) {
      try {
        const data = JSON.parse(text);
        return {
          version: data.version,
          checkpoints: data.timeline?.checkpoints || [],
          currentEpoch: data.timeline?.currentEpoch || 0,
          operations: data.timeline?.operations || [],
          fileBaselines: data.timeline?.fileBaselines || [],
          initialFiles: data.initialFileContents || [],
          snapshot: data.recentSnapshot || null
        };
      } catch { return null }
    },

    async stateDb(buffer) {
      if (typeof initSqlJs === 'undefined') return { error: 'sql.js library not loaded', rows: [] };
      try {
        const SQL = await initSqlJs({
          locateFile: file => 'lib/' + file
        });
        const db = new SQL.Database(new Uint8Array(buffer));
        const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
        const result = { tables: [], rows: [] };
        if (tables.length > 0) {
          result.tables = tables[0].values.map(r => r[0]);
        }
        try {
          const items = db.exec("SELECT key, value FROM ItemTable ORDER BY key");
          if (items.length > 0) {
            result.rows = items[0].values.map(([key, value]) => {
              let parsed = value;
              try { parsed = JSON.parse(value) } catch {}
              return { key, value, parsed, isJson: parsed !== value };
            });
          }
        } catch {}
        db.close();
        return result;
      } catch (e) {
        return { error: e.message, rows: [] };
      }
    }
  },

  /* ═══════════════════════════════════════════════════════════
     UI — Rendering
     ═══════════════════════════════════════════════════════════ */
  ui: {
    renderSidebar() {
      const sb = document.getElementById('sidebar');
      let html = '';

      html += `<div class="sidebar-section">
        <div class="sidebar-section-header" onclick="VSCAP.ui.toggleSection(this)">
          <span class="chevron">▼</span> Workspaces
          <span class="count">${VSCAP.data.workspaces.length}</span>
        </div>
        <div class="sidebar-section-body">`;

      for (let wi = 0; wi < VSCAP.data.workspaces.length; wi++) {
        const ws = VSCAP.data.workspaces[wi];
        const totalItems = ws.chatSessions.length + ws.editSessions.length + ws.artifacts.length + ws.memory.length + (ws.stateDbBuffer ? 1 : 0);
        if (totalItems === 0 && ws.files.size <= 1) continue;
        html += `<div class="ws-item" onclick="VSCAP.ui.selectWorkspace(${wi})" data-ws="${wi}" title="${VSCAP._esc(ws.path)}">
          <span class="ws-icon">📂</span>
          <span class="ws-name">${VSCAP._esc(ws.name)}</span>
          <span class="ws-count">${ws.chatSessions.length > 0 ? '💬' + ws.chatSessions.length : ''}</span>
        </div>`;
      }

      html += '</div></div>';

      if (VSCAP.data.globalStorage.size > 0) {
        html += `<div class="sidebar-section">
          <div class="sidebar-section-header" onclick="VSCAP.ui.toggleSection(this)">
            <span class="chevron">▼</span> Global Storage
            <span class="count">${VSCAP.data.globalStorage.size}</span>
          </div>
          <div class="sidebar-section-body">
            <div class="ws-item" onclick="VSCAP.ui.showGlobalStorage()">
              <span class="ws-icon">🌐</span><span class="ws-name">Browse Global Storage</span>
            </div>
          </div>
        </div>`;
      }

      if (VSCAP.data.settingsJson) {
        html += `<div class="sidebar-section">
          <div class="sidebar-section-header" onclick="VSCAP.ui.toggleSection(this)">
            <span class="chevron">▼</span> Settings
          </div>
          <div class="sidebar-section-body">
            <div class="ws-item" onclick="VSCAP.ui.showSettings()">
              <span class="ws-icon">⚙️</span><span class="ws-name">settings.json</span>
            </div>
          </div>
        </div>`;
      }

      sb.innerHTML = html;
    },

    toggleSection(header) {
      header.classList.toggle('collapsed');
      const body = header.nextElementSibling;
      if (body) body.classList.toggle('hidden');
    },

    selectWorkspace(idx) {
      VSCAP._activeWs = idx;
      document.querySelectorAll('.ws-item').forEach(el => el.classList.remove('active'));
      const item = document.querySelector(`.ws-item[data-ws="${idx}"]`);
      if (item) item.classList.add('active');

      const ws = VSCAP.data.workspaces[idx];
      const content = document.getElementById('content');
      document.getElementById('welcomePane')?.classList.add('hidden');

      const tabs = [];
      if (ws.chatSessions.length > 0) tabs.push({ id: 'chat', label: `💬 Chat Sessions (${ws.chatSessions.length})` });
      if (ws.editSessions.length > 0) tabs.push({ id: 'edit', label: `✏️ Edit Sessions (${ws.editSessions.length})` });
      if (ws.artifacts.length > 0 || ws.memory.length > 0) tabs.push({ id: 'artifacts', label: `🤖 Copilot Data (${ws.artifacts.length + ws.memory.length})` });
      if (ws.stateDbBuffer) tabs.push({ id: 'statedb', label: '💾 Workspace State' });
      tabs.push({ id: 'raw', label: `📄 Raw Files (${ws.files.size})` });

      let html = `<div class="tab-bar" id="tabBar">`;
      for (const t of tabs) {
        html += `<div class="tab${t.id === (tabs[0]?.id) ? ' active' : ''}" data-tab="${t.id}" onclick="VSCAP.ui.switchTab('${t.id}')">${t.label}</div>`;
      }
      html += `</div><div class="tab-content" id="tabContent"></div>`;
      content.innerHTML = html;

      VSCAP._activeTab = tabs[0]?.id;
      VSCAP.ui.switchTab(tabs[0]?.id);
    },

    switchTab(tabId) {
      if (!tabId) return;
      VSCAP._activeTab = tabId;
      document.querySelectorAll('#tabBar .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
      const ws = VSCAP.data.workspaces[VSCAP._activeWs];
      const container = document.getElementById('tabContent');

      switch (tabId) {
        case 'chat': VSCAP.ui.renderChatList(ws, container); break;
        case 'edit': VSCAP.ui.renderEditSessions(ws, container); break;
        case 'artifacts': VSCAP.ui.renderArtifacts(ws, container); break;
        case 'statedb': VSCAP.ui.renderStateDb(ws, container); break;
        case 'raw': VSCAP.ui.renderRawFiles(ws, container); break;
      }
    },

    renderChatList(ws, container) {
      let html = '<div class="session-list">';
      const metas = [];

      for (let i = 0; i < ws.chatSessions.length; i++) {
        const relPath = ws.chatSessions[i];
        const fileData = ws.files.get(relPath);
        if (!fileData) continue;
        const text = new TextDecoder().decode(fileData.data);
        const meta = VSCAP.parse.chatSessionMeta(text);
        if (!meta) continue;
        metas.push({ idx: i, meta, relPath, text });
      }

      metas.sort((a, b) => (b.meta.creationDate || 0) - (a.meta.creationDate || 0));

      const dateFrom = document.getElementById('dateFrom').value;
      const dateTo = document.getElementById('dateTo').value;
      const filtered = metas.filter(m => {
        if (!m.meta.creationDate) return true;
        const d = new Date(m.meta.creationDate);
        if (dateFrom && d < new Date(dateFrom)) return false;
        if (dateTo && d > new Date(dateTo + 'T23:59:59')) return false;
        return true;
      });

      if (filtered.length === 0) {
        html += '<div style="color:var(--text-muted);padding:20px;text-align:center">No chat sessions found</div>';
      }

      for (const m of filtered) {
        html += `<div class="session-card" onclick="VSCAP.ui.openSession(${VSCAP._activeWs}, ${m.idx})">
          <div class="session-title">${VSCAP._esc(m.meta.title)}</div>
          <div class="session-meta">
            <span>📅 ${VSCAP._formatDate(m.meta.creationDate)}</span>
            <span>🤖 ${VSCAP._esc(m.meta.model)}</span>
            <span>💬 ${m.meta.requestCount || '?'} exchanges</span>
            <span>📝 ${m.meta.lineCount} mutations</span>
          </div>
        </div>`;
      }
      html += '</div>';
      container.innerHTML = html;
    },

    openSession(wsIdx, sessionIdx) {
      const ws = VSCAP.data.workspaces[wsIdx];
      const relPath = ws.chatSessions[sessionIdx];
      const fileData = ws.files.get(relPath);
      if (!fileData) return;

      const cacheKey = wsIdx + ':' + relPath;
      let session = VSCAP.data.parsedSessions.get(cacheKey);
      if (!session) {
        const text = new TextDecoder().decode(fileData.data);
        session = VSCAP.parse.chatSession(text);
        if (!session) return;
        VSCAP.data.parsedSessions.set(cacheKey, session);
      }

      const container = document.getElementById('tabContent');
      let html = `<div class="conv-header">
        <span class="conv-back" onclick="VSCAP.ui.switchTab('chat')">← </span>
        <h2>${VSCAP._esc(session.title)}</h2>
        <span class="badge badge-blue">${VSCAP._esc(session.model)}</span>
        <span class="badge badge-green">${VSCAP._esc(session.mode)}</span>
      </div>
      <div class="conv-meta">
        <span>📅 Created: ${VSCAP._formatDate(session.creationDate)}</span>
        <span>🔑 Session: <code>${VSCAP._esc(session.sessionId)}</code></span>
        <span>📝 ${session.rawLineCount} JSONL lines</span>
        <span>💬 ${session.requests.length} exchanges</span>
      </div>
      <div class="conv-messages">`;

      for (let ri = 0; ri < session.requests.length; ri++) {
        const req = session.requests[ri];
        if (!req) continue;

        if (req.userMessage) {
          html += `<div class="msg msg-user">
            <div class="msg-header">
              <span class="sender">👤 User</span>
              <span>${VSCAP._formatDate(req.timestamp)}</span>
            </div>
            <div class="msg-body">${VSCAP._renderMd(req.userMessage)}</div>`;
          if (req.userContext) {
            html += `<div class="msg-context"><details>
              <summary>📋 View full context sent to model</summary>
              <pre>${VSCAP._esc(req.userContext)}</pre>
            </details></div>`;
          }
          html += `<div class="msg-footer">
            ${req.model ? `<span>Model: ${VSCAP._esc(req.model)}</span>` : ''}
            ${req.agent ? `<span>Agent: ${VSCAP._esc(req.agent)}</span>` : ''}
            ${req.requestId ? `<span>ID: ${VSCAP._esc(req.requestId.substring(0, 20))}…</span>` : ''}
          </div></div>`;
        }

        if (req.response.length > 0) {
          html += `<div class="msg msg-ai">
            <div class="msg-header">
              <span class="sender">🤖 ${VSCAP._esc(session.responder || 'AI')}</span>
              ${req.completedAt ? `<span>${VSCAP._formatDate(req.completedAt)}</span>` : ''}
            </div>
            <div class="msg-body">`;

          for (const elem of req.response) {
            switch (elem.type) {
              case 'text':
                html += VSCAP._renderMd(elem.text);
                break;
              case 'thinking':
                html += `<details class="thinking-block">
                  <summary>💭 ${VSCAP._esc(elem.title || 'Thinking...')}</summary>
                  <div class="thinking-content">${VSCAP._esc(elem.text)}</div>
                </details>`;
                break;
              case 'tool':
                html += `<div class="tool-call">
                  <span class="tool-icon">🔧</span>
                  <span class="tool-msg">${VSCAP._esc(elem.message)}</span>
                  ${elem.source ? `<span class="tool-source">${VSCAP._esc(elem.source)}</span>` : ''}
                </div>`;
                break;
            }
          }

          html += '</div>';

          const parts = [];
          if (req.timings.firstProgress) parts.push(`First response: ${(req.timings.firstProgress / 1000).toFixed(1)}s`);
          if (req.timings.totalElapsed) parts.push(`Total: ${(req.timings.totalElapsed / 1000).toFixed(1)}s`);
          if (req.contentReferences.length > 0) parts.push(`${req.contentReferences.length} references`);
          if (req.codeCitations.length > 0) parts.push(`${req.codeCitations.length} citations`);
          if (parts.length > 0) {
            html += `<div class="msg-footer">${parts.map(p => '<span>' + p + '</span>').join('')}</div>`;
          }

          html += '</div>';
        }
      }

      html += '</div>';
      container.innerHTML = html;
    },

    renderEditSessions(ws, container) {
      let html = '<h3 style="margin-bottom:16px">Chat Editing Sessions</h3>';

      for (const relPath of ws.editSessions) {
        const fileData = ws.files.get(relPath);
        if (!fileData) continue;
        const session = VSCAP.parse.editSession(new TextDecoder().decode(fileData.data));
        if (!session) continue;

        const uuid = relPath.split('/')[1] || 'Unknown';
        html += `<div class="edit-card">
          <h4>Session: <code>${VSCAP._esc(uuid)}</code></h4>
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">
            Version: ${session.version} | Epoch: ${session.currentEpoch} | Checkpoints: ${session.checkpoints.length}
          </div>`;

        if (session.checkpoints.length > 0) {
          html += '<div class="timeline">';
          for (const cp of session.checkpoints) {
            html += `<div class="timeline-item">
              <strong>${VSCAP._esc(cp.label || 'Checkpoint')}</strong>
              <div style="font-size:12px;color:var(--text-secondary)">${VSCAP._esc(cp.description || '')} (Epoch ${cp.epoch})</div>
            </div>`;
          }
          html += '</div>';
        }

        if (session.operations.length > 0) {
          html += `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:var(--info)">
            ${session.operations.length} operations</summary>
            <pre>${VSCAP._esc(JSON.stringify(session.operations, null, 2))}</pre>
          </details>`;
        }

        html += '</div>';
      }

      if (ws.editSessions.length === 0) {
        html += '<div style="color:var(--text-muted);text-align:center;padding:40px">No edit sessions found</div>';
      }
      container.innerHTML = html;
    },

    renderArtifacts(ws, container) {
      let html = '<h3 style="margin-bottom:16px">GitHub Copilot Chat Data</h3>';

      if (ws.artifacts.length > 0) {
        html += `<h4 style="margin-bottom:8px;color:var(--info)">Chat Session Resources (${ws.artifacts.length})</h4>`;
        for (const relPath of ws.artifacts) {
          const fileData = ws.files.get(relPath);
          if (!fileData) continue;
          let content;
          try { content = new TextDecoder().decode(fileData.data) } catch { content = '[Binary data]' }
          html += `<div class="artifact-card">
            <div class="artifact-path">${VSCAP._esc(relPath)}</div>
            <div class="artifact-content"><pre>${VSCAP._esc(content.substring(0, 5000))}${content.length > 5000 ? '\n\n... [truncated]' : ''}</pre></div>
          </div>`;
        }
      }

      if (ws.memory.length > 0) {
        html += `<h4 style="margin:20px 0 8px;color:var(--success)">Agent Memory Files (${ws.memory.length})</h4>`;
        for (const relPath of ws.memory) {
          const fileData = ws.files.get(relPath);
          if (!fileData) continue;
          let content;
          try { content = new TextDecoder().decode(fileData.data) } catch { content = '[Binary data]' }
          const isMarkdown = relPath.endsWith('.md');
          html += `<div class="artifact-card">
            <h4>${VSCAP._esc(relPath.split('/').pop())}</h4>
            <div class="artifact-path">${VSCAP._esc(relPath)}</div>
            <div class="artifact-content">${isMarkdown ? VSCAP._renderMd(content) : '<pre>' + VSCAP._esc(content) + '</pre>'}</div>
          </div>`;
        }
      }

      if (ws.artifacts.length === 0 && ws.memory.length === 0) {
        html += '<div style="color:var(--text-muted);text-align:center;padding:40px">No Copilot data found</div>';
      }
      container.innerHTML = html;
    },

    async renderStateDb(ws, container) {
      container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-secondary)">Loading SQLite database...</div>';

      const result = await VSCAP.parse.stateDb(ws.stateDbBuffer);
      if (result.error) {
        container.innerHTML = `<div style="padding:20px"><div class="badge badge-red">${VSCAP._esc(result.error)}</div>
          <p style="margin-top:12px;color:var(--text-secondary)">The sql.js WASM library is required to parse state.vscdb files.
          Ensure the lib/ directory contains sql-wasm.wasm.</p></div>`;
        return;
      }

      let html = `<h3 style="margin-bottom:8px">Workspace State Database</h3>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">
          Tables: ${result.tables.join(', ')} | Rows: ${result.rows.length}
        </div>
        <div class="state-filter">
          <input type="text" id="stateFilterInput" placeholder="Filter keys..." style="width:300px"
            oninput="VSCAP.ui.filterStateTable(this.value)">
        </div>
        <div style="max-height:calc(100vh - 250px);overflow:auto">
        <table class="state-table" id="stateTable">
          <thead><tr><th style="width:35%">Key</th><th>Value</th></tr></thead>
          <tbody>`;

      for (const row of result.rows) {
        const valDisplay = row.isJson
          ? '<details><summary style="cursor:pointer;color:var(--info)">JSON Object</summary><pre>' + VSCAP._esc(JSON.stringify(row.parsed, null, 2)).substring(0, 2000) + '</pre></details>'
          : '<span>' + VSCAP._esc(String(row.value).substring(0, 500)) + '</span>';
        html += `<tr data-key="${VSCAP._esc(row.key)}">
          <td class="key-col" title="${VSCAP._esc(row.key)}">${VSCAP._esc(row.key)}</td>
          <td class="val-col">${valDisplay}</td>
        </tr>`;
      }

      html += '</tbody></table></div>';
      container.innerHTML = html;
    },

    filterStateTable(query) {
      const rows = document.querySelectorAll('#stateTable tbody tr');
      const q = query.toLowerCase();
      rows.forEach(row => {
        row.style.display = row.dataset.key.toLowerCase().includes(q) ? '' : 'none';
      });
    },

    renderRawFiles(ws, container) {
      const tree = {};
      for (const [relPath] of ws.files) {
        const parts = relPath.split('/');
        let node = tree;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!node[parts[i]]) node[parts[i]] = {};
          node = node[parts[i]];
        }
        node[parts[parts.length - 1]] = relPath;
      }

      function renderTree(node, depth = 0) {
        let html = '';
        const entries = Object.entries(node).sort(([a, av], [b, bv]) => {
          const aIsDir = typeof av === 'object';
          const bIsDir = typeof bv === 'object';
          if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
          return a.localeCompare(b);
        });
        for (const [name, value] of entries) {
          if (typeof value === 'object') {
            html += `<details><summary class="file-tree-item folder" style="padding-left:${depth * 18}px">📁 ${VSCAP._esc(name)}</summary>
              <div class="file-tree-children">${renderTree(value, depth + 1)}</div></details>`;
          } else {
            const size = ws.files.get(value)?.size || 0;
            html += `<div class="file-tree-item" style="padding-left:${depth * 18}px"
              onclick="VSCAP.ui.previewFile(${VSCAP._activeWs}, '${VSCAP._esc(value)}')">
              📄 ${VSCAP._esc(name)} <span style="color:var(--text-muted);font-size:11px;margin-left:auto">${VSCAP._formatSize(size)}</span>
            </div>`;
          }
        }
        return html;
      }

      container.innerHTML = `<h3 style="margin-bottom:12px">File Browser</h3>
        <div class="file-tree">${renderTree(tree)}</div>
        <div id="filePreview"></div>`;
    },

    previewFile(wsIdx, relPath) {
      const ws = VSCAP.data.workspaces[wsIdx];
      const fileData = ws.files.get(relPath);
      if (!fileData) return;
      const preview = document.getElementById('filePreview');
      let content;
      try {
        content = new TextDecoder().decode(fileData.data);
        if (content.includes('\0')) throw new Error('Binary');
      } catch {
        content = '[Binary file — ' + VSCAP._formatSize(fileData.size) + ']';
      }
      const ext = relPath.split('.').pop().toLowerCase();
      const isJson = ext === 'json' || ext === 'jsonl';
      let displayContent = content;
      if (isJson && content.length < 50000) {
        try { displayContent = JSON.stringify(JSON.parse(content), null, 2) } catch {}
      }
      preview.innerHTML = `<div class="file-preview">
        <div style="margin-bottom:8px;font-size:12px;color:var(--text-muted)">${VSCAP._esc(relPath)} — ${VSCAP._formatSize(fileData.size)}</div>
        <pre>${VSCAP._esc(displayContent.substring(0, 50000))}${displayContent.length > 50000 ? '\n\n... [truncated]' : ''}</pre>
      </div>`;
      preview.scrollIntoView({ behavior: 'smooth' });
    },

    showSettings() {
      VSCAP._activeWs = null;
      document.querySelectorAll('.ws-item').forEach(el => el.classList.remove('active'));
      const content = document.getElementById('content');
      document.getElementById('welcomePane')?.classList.add('hidden');

      const settings = VSCAP.data.settingsJson;
      if (!settings) { content.innerHTML = '<div class="content-welcome"><p>No settings.json found</p></div>'; return }

      const groups = {};
      for (const [key, value] of Object.entries(settings)) {
        const group = key.split('.')[0] || 'other';
        if (!groups[group]) groups[group] = [];
        groups[group].push({ key, value });
      }

      let html = '<div style="padding:20px"><h3 style="margin-bottom:16px">⚙️ VS Code User Settings</h3><div class="settings-tree">';
      for (const [group, items] of Object.entries(groups).sort()) {
        html += `<details class="settings-group"><summary>${VSCAP._esc(group)} (${items.length})</summary>`;
        for (const item of items) {
          const valStr = typeof item.value === 'object' ? JSON.stringify(item.value, null, 2) : String(item.value);
          html += `<div class="settings-pair">
            <div class="settings-key">${VSCAP._esc(item.key)}</div>
            <div class="settings-val">${valStr.length > 200 ? '<pre>' + VSCAP._esc(valStr) + '</pre>' : VSCAP._esc(valStr)}</div>
          </div>`;
        }
        html += '</details>';
      }
      html += '</div></div>';
      content.innerHTML = html;
    },

    showGlobalStorage() {
      VSCAP._activeWs = null;
      document.querySelectorAll('.ws-item').forEach(el => el.classList.remove('active'));
      const content = document.getElementById('content');
      document.getElementById('welcomePane')?.classList.add('hidden');

      let html = '<div style="padding:20px"><h3 style="margin-bottom:16px">🌐 Global Storage</h3>';

      for (const [path, fileData] of VSCAP.data.globalStorage) {
        let preview = '';
        try {
          const text = new TextDecoder().decode(fileData.data);
          if (!text.includes('\0')) preview = text.substring(0, 500);
          else preview = '[Binary — ' + VSCAP._formatSize(fileData.size) + ']';
        } catch { preview = '[Binary — ' + VSCAP._formatSize(fileData.size) + ']'; }

        html += `<div class="artifact-card">
          <div class="artifact-path">${VSCAP._esc(path)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${VSCAP._formatSize(fileData.size)}</div>
          <pre style="max-height:200px;overflow:auto;font-size:11px">${VSCAP._esc(preview)}</pre>
        </div>`;
      }

      html += '</div>';
      content.innerHTML = html;
    },

    toggleTheme() {
      const html = document.documentElement;
      const current = html.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', next);
      document.getElementById('themeBtn').textContent = next === 'dark' ? '🌙' : '☀️';
    },

    applyDateFilter() {
      if (VSCAP._activeWs !== null && VSCAP._activeTab === 'chat') {
        const ws = VSCAP.data.workspaces[VSCAP._activeWs];
        VSCAP.ui.renderChatList(ws, document.getElementById('tabContent'));
      }
    },

    showProgress(pct, msg) {
      const overlay = document.getElementById('progress-overlay');
      overlay.classList.remove('hidden');
      document.getElementById('progressFill').style.width = pct + '%';
      document.getElementById('progress-msg').textContent = msg || '';
    },
    hideProgress() {
      document.getElementById('progress-overlay').classList.add('hidden');
    },

    showExportModal() {
      document.getElementById('exportModal')?.remove();

      const modal = document.createElement('div');
      modal.id = 'exportModal';
      modal.className = 'modal-overlay';
      modal.innerHTML = `<div class="modal">
        <h3>📤 Export Data</h3>
        <p style="color:var(--text-secondary);font-size:13px;margin-bottom:16px">Export parsed evidence data for reporting</p>
        <div>
          <label><input type="radio" name="exportScope" value="all" checked> All workspaces &amp; sessions</label>
          <label><input type="radio" name="exportScope" value="workspace"> Current workspace only</label>
          <label><input type="radio" name="exportScope" value="session"> Current session only</label>
        </div>
        <div class="modal-actions">
          <button class="btn-ghost" onclick="document.getElementById('exportModal').remove()">Cancel</button>
          <button class="btn-primary" onclick="VSCAP.export.toJSON()">Export JSON</button>
          <button class="btn-primary" onclick="VSCAP.export.toCSV()">Export CSV</button>
        </div>
      </div>`;
      modal.addEventListener('click', e => { if (e.target === modal) modal.remove() });
      document.body.appendChild(modal);
    }
  },

  /* ═══════════════════════════════════════════════════════════
     SEARCH
     ═══════════════════════════════════════════════════════════ */
  search: {
    run(query) {
      if (!query || query.length < 2) {
        if (VSCAP._activeWs !== null) VSCAP.ui.switchTab(VSCAP._activeTab);
        else { document.getElementById('welcomePane')?.classList.remove('hidden') }
        return;
      }

      const q = query.toLowerCase();
      const results = [];

      for (let wi = 0; wi < VSCAP.data.workspaces.length; wi++) {
        const ws = VSCAP.data.workspaces[wi];

        if (ws.name.toLowerCase().includes(q) || ws.path.toLowerCase().includes(q)) {
          results.push({ type: 'workspace', wsIdx: wi, title: ws.name, context: ws.path });
        }

        for (let si = 0; si < ws.chatSessions.length; si++) {
          const relPath = ws.chatSessions[si];
          const fileData = ws.files.get(relPath);
          if (!fileData) continue;
          const text = new TextDecoder().decode(fileData.data);

          if (text.toLowerCase().includes(q)) {
            const meta = VSCAP.parse.chatSessionMeta(text);
            const idx = text.toLowerCase().indexOf(q);
            const start = Math.max(0, idx - 60);
            const end = Math.min(text.length, idx + query.length + 60);
            let snippet = text.substring(start, end).replace(/[{}"\\]/g, ' ').replace(/\s+/g, ' ');
            const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            snippet = VSCAP._esc(snippet).replace(re, '<mark>$1</mark>');

            results.push({
              type: 'session', wsIdx: wi, sessionIdx: si,
              title: (meta?.title || 'Session') + ' — ' + ws.name,
              context: snippet
            });
          }

          if (results.length >= 50) break;
        }
        if (results.length >= 50) break;
      }

      const content = document.getElementById('content');
      document.getElementById('welcomePane')?.classList.add('hidden');
      let html = `<div class="search-results">
        <h3>Search Results for "${VSCAP._esc(query)}" (${results.length}${results.length >= 50 ? '+' : ''})</h3>`;

      for (const r of results) {
        const onclick = r.type === 'session'
          ? `VSCAP.ui.selectWorkspace(${r.wsIdx}); setTimeout(()=>VSCAP.ui.openSession(${r.wsIdx},${r.sessionIdx}),100)`
          : `VSCAP.ui.selectWorkspace(${r.wsIdx})`;
        html += `<div class="search-result" onclick="${onclick}">
          <div class="sr-title">${r.type === 'session' ? '💬' : '📂'} ${r.title}</div>
          <div class="sr-context">${r.context}</div>
        </div>`;
      }

      if (results.length === 0) {
        html += '<div style="color:var(--text-muted);padding:20px;text-align:center">No results found</div>';
      }

      html += '</div>';
      content.innerHTML = html;
    }
  },

  /* ═══════════════════════════════════════════════════════════
     EXPORT — CSV & JSON
     ═══════════════════════════════════════════════════════════ */
  export: {
    _getScope() {
      const radio = document.querySelector('input[name="exportScope"]:checked');
      return radio ? radio.value : 'all';
    },

    _getSessions() {
      const scope = VSCAP.export._getScope();
      const sessions = [];

      if (scope === 'session' && VSCAP._activeWs !== null) {
        for (const [key, session] of VSCAP.data.parsedSessions) {
          if (key.startsWith(VSCAP._activeWs + ':')) {
            sessions.push({ ws: VSCAP.data.workspaces[VSCAP._activeWs], session });
            break;
          }
        }
      } else {
        const workspaces = scope === 'workspace' && VSCAP._activeWs !== null
          ? [VSCAP.data.workspaces[VSCAP._activeWs]]
          : VSCAP.data.workspaces;

        for (const ws of workspaces) {
          for (const relPath of ws.chatSessions) {
            const fileData = ws.files.get(relPath);
            if (!fileData) continue;
            const cacheKey = VSCAP.data.workspaces.indexOf(ws) + ':' + relPath;
            let session = VSCAP.data.parsedSessions.get(cacheKey);
            if (!session) {
              const text = new TextDecoder().decode(fileData.data);
              session = VSCAP.parse.chatSession(text);
              if (session) VSCAP.data.parsedSessions.set(cacheKey, session);
            }
            if (session) sessions.push({ ws, session });
          }
        }
      }
      return sessions;
    },

    toJSON() {
      const sessions = VSCAP.export._getSessions();
      const data = {
        exportDate: new Date().toISOString(),
        tool: 'VS-CAP Viewer',
        version: '1.0',
        workspaceCount: VSCAP.data.workspaces.length,
        sessions: sessions.map(({ ws, session }) => ({
          workspace: ws.name,
          workspacePath: ws.path,
          ...session,
          requests: session.requests.filter(Boolean)
        }))
      };

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      VSCAP.export._download(blob, `vs-cap-export-${Date.now()}.json`);
      document.getElementById('exportModal')?.remove();
    },

    toCSV() {
      const sessions = VSCAP.export._getSessions();
      const rows = [['Workspace', 'Workspace Path', 'Session ID', 'Session Title', 'Creation Date',
        'Request #', 'Timestamp', 'Model', 'Agent', 'User Message', 'AI Response (Text)', 'Duration (s)',
        'Tool Calls', 'Thinking Blocks'].join(',')];

      for (const { ws, session } of sessions) {
        for (let ri = 0; ri < session.requests.length; ri++) {
          const req = session.requests[ri];
          if (!req) continue;
          const responseText = req.response.filter(e => e.type === 'text').map(e => e.text).join(' ');
          const toolCount = req.response.filter(e => e.type === 'tool').length;
          const thinkingCount = req.response.filter(e => e.type === 'thinking').length;
          const duration = req.timings.totalElapsed ? (req.timings.totalElapsed / 1000).toFixed(1) : '';

          rows.push([
            VSCAP.export._csvEsc(ws.name),
            VSCAP.export._csvEsc(ws.path),
            VSCAP.export._csvEsc(session.sessionId),
            VSCAP.export._csvEsc(session.title),
            VSCAP.export._csvEsc(VSCAP._formatDate(session.creationDate)),
            ri + 1,
            VSCAP.export._csvEsc(VSCAP._formatDate(req.timestamp)),
            VSCAP.export._csvEsc(req.model),
            VSCAP.export._csvEsc(req.agent),
            VSCAP.export._csvEsc(req.userMessage),
            VSCAP.export._csvEsc(responseText.substring(0, 5000)),
            duration,
            toolCount,
            thinkingCount
          ].join(','));
        }
      }

      const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
      VSCAP.export._download(blob, `vs-cap-export-${Date.now()}.csv`);
      document.getElementById('exportModal')?.remove();
    },

    _csvEsc(val) {
      if (val === null || val === undefined) return '""';
      const s = String(val).replace(/"/g, '""');
      return '"' + s + '"';
    },

    _download(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  },

  /* ═══════════════════════════════════════════════════════════
     CLEAR — Remove all data from memory
     ═══════════════════════════════════════════════════════════ */
  clearAll() {
    if (!confirm('Clear all loaded evidence data? This cannot be undone.')) return;
    VSCAP.data.workspaces = [];
    VSCAP.data.globalStorage = new Map();
    VSCAP.data.settingsJson = null;
    VSCAP.data.allFiles = new Map();
    VSCAP.data.totalSize = 0;
    VSCAP.data.parsedSessions = new Map();
    VSCAP._activeWs = null;
    VSCAP._activeTab = null;

    document.getElementById('viewer').classList.add('hidden');
    document.getElementById('landing').classList.remove('hidden');
    document.getElementById('searchInput').value = '';
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value = '';
  }
};

/* ─── Bootstrap ─── */
document.addEventListener('DOMContentLoaded', () => VSCAP.init());
