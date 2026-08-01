document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.getElementById('toggleBtn');
  const videoCountEl = document.getElementById('videoCount');

  // Consulta aba ativa
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      const activeTabId = tabs[0].id;

      // Verificar se a URL permite injeção
      if (tabs[0].url.startsWith("chrome://") || tabs[0].url.startsWith("edge://")) {
        videoCountEl.textContent = "PiP indisponível nesta página.";
        toggleBtn.disabled = true;
        return;
      }

      // Envia requisição para descobrir vídeos em ALL FRAMES usando a API chrome.scripting
      try {
        chrome.scripting.executeScript({
          target: { tabId: activeTabId, allFrames: true },
          func: () => {
            // Escaneia a página por precaução
            if (window.currentVideoScanner) {
              window.currentVideoScanner.scan();
              return window.currentVideoScanner.getVideos().length;
            }
            return 0;
          }
        }, (injectionResults) => {
          if (chrome.runtime.lastError || !injectionResults) {
            videoCountEl.textContent = "Atualize a página para contar os vídeos.";
            // NÃO DESABILITAR o botão para evitar lock indevido previso
            toggleBtn.disabled = false; 
          } else {
            let totalCount = 0;
            for (const frameResult of injectionResults) {
              if (frameResult.result) {
                totalCount += frameResult.result;
              }
            }

            if (totalCount === 0) {
              videoCountEl.textContent = "Nenhum vídeo contado (aperte para forçar).";
              toggleBtn.disabled = false; // Mantém ativo caso o scanner esteja demorando
            } else {
              videoCountEl.textContent = `${totalCount} vídeo(s) detectado(s)`;
              toggleBtn.disabled = false;
            }
          }
        });
      } catch (err) {
        videoCountEl.textContent = "Status offline";
        toggleBtn.disabled = false; // Falha segura
      }
    } else {
      videoCountEl.textContent = "Aba inativa.";
      toggleBtn.disabled = true;
    }
  });

  // O clique no botão
  toggleBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "TOGGLE_PIP" });
        window.close();
      }
    });
  });

  // ----- Controles de realce -----
  const enhanceToggle = document.getElementById('enhanceToggle');
  const enhanceIntensity = document.getElementById('enhanceIntensity');
  const enhanceFps = document.getElementById('enhanceFps');

  // Executa uma função do controle de realce em TODOS os frames e agrega os status.
  // Usa chrome.scripting (mesmo caminho da contagem de vídeos), que alcança iframes.
  function runEnhance(method, arg, cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) { if (cb) cb(null); return; }
      const url = tabs[0].url || "";
      if (url.startsWith("chrome://") || url.startsWith("edge://")) { if (cb) cb(null); return; }
      try {
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id, allFrames: true },
          func: (m, a) => {
            if (!window.__pipEnhance || typeof window.__pipEnhance[m] !== 'function') return null;
            try { return window.__pipEnhance[m](a); } catch (e) { return null; }
          },
          args: [method, arg === undefined ? null : arg],
        }, (results) => {
          if (chrome.runtime.lastError || !results) { if (cb) cb(null); return; }
          // Agregar respostas de todos os frames.
          const agg = { enabled: false, activeCount: 0, fps: 0, height: 0, width: 0, any: false };
          for (const r of results) {
            const s = r && r.result;
            if (!s) continue;
            agg.any = true;
            agg.enabled = agg.enabled || s.enabled;
            agg.activeCount += s.activeCount || 0;
            if ((s.fps || 0) > agg.fps) agg.fps = s.fps;
            if ((s.height || 0) > agg.height) { agg.height = s.height; agg.width = s.width; }
          }
          if (cb) cb(agg);
        });
      } catch (e) { if (cb) cb(null); }
    });
  }

  function renderStatus(agg) {
    if (!agg || !agg.any) {
      enhanceFps.textContent = "● sem conexão com a página";
      enhanceFps.style.color = "#9ca3af";
      return;
    }
    if (!agg.enabled) {
      enhanceFps.textContent = "○ realce desligado";
      enhanceFps.style.color = "#9ca3af";
    } else if (agg.activeCount > 0) {
      const res = agg.height ? `${agg.height}p` : "—";
      const fps = agg.fps || 0;
      const dot = fps >= 25 ? "🟢" : (fps > 0 ? "🟡" : "⚪");
      enhanceFps.textContent = `${dot} realçando ${res} · ${fps} fps`;
      enhanceFps.style.color = "#60a5fa";
    } else {
      enhanceFps.textContent = "⚠ nenhum vídeo realçável aqui";
      enhanceFps.style.color = "#f59e0b";
    }
  }

  // Carregar estado persistido.
  chrome.storage.sync.get(['enhanceEnabled', 'enhanceIntensity'], (data) => {
    enhanceToggle.checked = !!data.enhanceEnabled;
    if (typeof data.enhanceIntensity === 'number') {
      enhanceIntensity.value = Math.round(data.enhanceIntensity * 100);
    }
  });

  enhanceToggle.addEventListener('change', () => {
    const enabled = enhanceToggle.checked;
    chrome.storage.sync.set({ enhanceEnabled: enabled });
    runEnhance('toggle', enabled, renderStatus);
  });

  enhanceIntensity.addEventListener('input', () => {
    const intensity = enhanceIntensity.value / 100;
    chrome.storage.sync.set({ enhanceIntensity: intensity });
    runEnhance('setIntensity', intensity, renderStatus);
  });

  // Polling de status enquanto o popup estiver aberto.
  function pollStatus() {
    runEnhance('status', undefined, renderStatus);
  }
  pollStatus();
  setInterval(pollStatus, 1000);

  // ----- Download de vídeo -----
  const downloadBtn = document.getElementById('downloadBtn');
  const downloadStatus = document.getElementById('downloadStatus');
  const progressTrack = document.getElementById('progressTrack');
  const progressFill = document.getElementById('progressFill');
  const videoThumbs = document.getElementById('videoThumbs');
  let activeTabId = null;
  let entries = [];        // [{frameId, idx, thumb, kind, width, height, playing}]
  let selectedKey = null;  // `${frameId}:${idx}`
  let lastSig = '';        // assinatura para evitar re-render desnecessário

  const KIND_LABEL = {
    direct: 'Arquivo direto (MP4)',
    hls:    'Stream HLS — salvo como .ts',
    blob:   'Stream (blob) — tentaremos via rede',
    dash:   'DASH — não suportado ainda',
    none:   'Sem fonte reproduzível',
  };
  const KIND_TAG = { direct: 'MP4', hls: 'HLS', blob: 'BLOB', dash: 'DASH', none: '—' };

  function keyOf(e) { return `${e.frameId}:${e.idx}`; }

  function selectedEntry() {
    return entries.find((e) => keyOf(e) === selectedKey) || null;
  }

  function renderThumbs() {
    videoThumbs.innerHTML = '';
    entries.forEach((e) => {
      const cell = document.createElement('div');
      cell.className = 'thumb' + (keyOf(e) === selectedKey ? ' selected' : '');

      if (e.thumb) {
        const img = document.createElement('img');
        img.src = e.thumb;
        cell.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'thumb-ph';
        ph.textContent = '🎬';
        cell.appendChild(ph);
      }

      const tag = document.createElement('span');
      tag.className = 'thumb-kind';
      tag.textContent = KIND_TAG[e.kind] || '—';
      cell.appendChild(tag);

      if (e.playing) {
        const p = document.createElement('span');
        p.className = 'thumb-play';
        p.textContent = '▶';
        cell.appendChild(p);
      }

      const meta = document.createElement('div');
      meta.className = 'thumb-meta';
      meta.textContent = e.height ? `${e.height}p` : `${e.kind}`;
      cell.appendChild(meta);

      cell.addEventListener('click', () => {
        selectedKey = keyOf(e);
        renderThumbs();
        updateStatusForSelection();
      });
      videoThumbs.appendChild(cell);
    });
  }

  function updateStatusForSelection() {
    const e = selectedEntry();
    if (!e) { downloadBtn.disabled = true; return; }
    downloadStatus.textContent = KIND_LABEL[e.kind] || 'Fonte detectada';
    downloadBtn.disabled = (e.kind === 'dash' || e.kind === 'none');
  }

  // Consulta a lista de vídeos (com miniatura) em TODOS os frames.
  function refreshCandidates() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) return;
      activeTabId = tabs[0].id;
      const url = tabs[0].url || '';
      if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('brave://')) {
        downloadStatus.textContent = 'Indisponível nesta página';
        downloadBtn.disabled = true;
        return;
      }
      try {
        chrome.scripting.executeScript({
          target: { tabId: activeTabId, allFrames: true },
          func: () => (window.__pipDownload ? window.__pipDownload.list() : null),
        }, (results) => {
          if (chrome.runtime.lastError || !results) {
            downloadStatus.textContent = 'Fonte indisponível';
            downloadBtn.disabled = true;
            return;
          }
          let anyResponded = false;
          const next = [];
          for (const r of results) {
            if (!Array.isArray(r && r.result)) continue;
            anyResponded = true;
            for (const v of r.result) next.push({ ...v, frameId: r.frameId });
          }
          entries = next;

          if (entries.length === 0) {
            downloadStatus.textContent = anyResponded
              ? 'Nenhum vídeo relevante (dê play no vídeo)'
              : 'Recarregue a extensão e a página (F5)';
            downloadBtn.disabled = true;
            videoThumbs.innerHTML = '';
            selectedKey = null;
            return;
          }

          // Manter seleção anterior se ainda existir; senão escolher tocando > maior área.
          if (!selectedEntry()) {
            const best = entries.slice().sort((a, b) =>
              ((b.playing ? 1e9 : 0) + b.area) - ((a.playing ? 1e9 : 0) + a.area))[0];
            selectedKey = keyOf(best);
          }
          // Só re-renderiza se a composição mudou (evita flicker das imagens).
          const sig = entries.map((e) => `${keyOf(e)}|${e.kind}|${e.playing ? 1 : 0}`).join(',') + '#' + selectedKey;
          if (sig !== lastSig) {
            lastSig = sig;
            renderThumbs();
          }
          updateStatusForSelection();
        });
      } catch (e) {
        downloadStatus.textContent = 'Fonte indisponível';
        downloadBtn.disabled = true;
      }
    });
  }

  downloadBtn.addEventListener('click', () => {
    const e = selectedEntry();
    if (!e) return;
    downloadBtn.disabled = true;
    progressTrack.hidden = false;
    progressFill.style.width = '0%';
    downloadStatus.textContent = 'Iniciando…';
    chrome.scripting.executeScript({
      target: { tabId: activeTabId, frameIds: [e.frameId] },
      func: (i) => window.__pipDownload && window.__pipDownload.downloadByIndex(i),
      args: [e.idx],
    }, () => void chrome.runtime.lastError);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'DOWNLOAD_PROGRESS') return;
    switch (msg.state) {
      case 'starting':
        downloadStatus.textContent = 'Preparando…';
        break;
      case 'downloading': {
        const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
        progressTrack.hidden = false;
        progressFill.style.width = pct + '%';
        downloadStatus.textContent = `Baixando ${msg.done}/${msg.total} (${pct}%)`;
        break;
      }
      case 'done':
        progressFill.style.width = '100%';
        downloadStatus.textContent = '✓ Concluído';
        downloadBtn.disabled = false;
        setTimeout(() => { progressTrack.hidden = true; }, 1500);
        break;
      case 'drm':
        downloadStatus.textContent = 'Vídeo protegido (DRM) — indisponível';
        progressTrack.hidden = true;
        downloadBtn.disabled = false;
        break;
      case 'unsupported':
        downloadStatus.textContent = 'Formato não suportado (DASH/blob)';
        progressTrack.hidden = true;
        downloadBtn.disabled = false;
        break;
      case 'nosource':
        downloadStatus.textContent = 'Nenhuma fonte detectada';
        progressTrack.hidden = true;
        downloadBtn.disabled = false;
        break;
      case 'error':
        downloadStatus.textContent = 'Erro' + (msg.message ? `: ${msg.message}` : '');
        progressTrack.hidden = true;
        downloadBtn.disabled = false;
        break;
    }
  });

  refreshCandidates();
  setInterval(refreshCandidates, 2000);
});
