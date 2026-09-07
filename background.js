// ============================================================
// Download de vídeo: sniffing de rede + orquestração
// ============================================================

// Candidatos capturados por aba, persistidos em chrome.storage.session para sobreviver à
// hibernação do service worker (MV3). Formato por aba: { hls:[{url,ts}], direct:[...], dash:[...] }
const KEY = (tabId) => `dl_${tabId}`;

async function readBucket(tabId) {
  try {
    const data = await chrome.storage.session.get(KEY(tabId));
    return data[KEY(tabId)] || { hls: [], direct: [], dash: [] };
  } catch (e) {
    return { hls: [], direct: [], dash: [] };
  }
}

async function addCandidate(tabId, kind, url) {
  const bucket = await readBucket(tabId);
  const list = bucket[kind] || (bucket[kind] = []);
  if (list.some((x) => x.url === url)) return; // dedup
  list.push({ url, ts: Date.now() });
  if (list.length > 30) list.splice(0, list.length - 30); // manter os 30 mais recentes
  try { await chrome.storage.session.set({ [KEY(tabId)]: bucket }); } catch (e) { /* noop */ }
}

function classifyUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.includes('.m3u8')) return 'hls';
    if (path.includes('.mpd')) return 'dash';
    if (/\.(mp4|webm|m4v|mov)(\?|$)/.test(path)) return 'direct';
  } catch (e) { /* url inválida */ }
  return null;
}

function classifyContentType(ct) {
  if (!ct) return null;
  ct = ct.toLowerCase();
  if (ct.includes('mpegurl') || ct.includes('x-mpegurl')) return 'hls';
  if (ct.includes('dash+xml')) return 'dash';
  if (ct.includes('video/mp4') || ct.includes('video/webm')) return 'direct';
  return null;
}

// Observa requisições (inclui sub-recursos de iframes) para achar playlists/arquivos por URL.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.type === 'main_frame') {
      chrome.storage.session.remove(KEY(details.tabId)).catch(() => {}); // navegação → zera
      chrome.storage.session.remove(YT_KEY(details.tabId)).catch(() => {});
      return;
    }
    const kind = classifyUrl(details.url);
    if (kind) addCandidate(details.tabId, kind, details.url);
  },
  { urls: ['<all_urls>'] }
);

// Classificação por Content-Type (pega URLs sem extensão, comum em CDNs de vídeo).
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || details.type === 'main_frame') return;
    if (classifyUrl(details.url)) return; // já classificado pela URL
    const header = (details.responseHeaders || []).find(
      (h) => h.name.toLowerCase() === 'content-type'
    );
    const kind = classifyContentType(header && header.value);
    if (kind) addCandidate(details.tabId, kind, details.url);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Limpar candidatos ao fechar a aba.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(KEY(tabId)).catch(() => {});
  chrome.storage.session.remove(YT_KEY(tabId)).catch(() => {});
});

async function candidatesForTab(tabId) {
  const bucket = await readBucket(tabId);
  const recent = (list) => (list || []).slice().sort((a, b) => b.ts - a.ts).map((x) => x.url);
  return { hls: recent(bucket.hls), direct: recent(bucket.direct), dash: recent(bucket.dash) };
}

// ---- YouTube: formatos progressivos (áudio+vídeo) extraídos do player ----
const YT_KEY = (tabId) => `yt_${tabId}`;

async function readYtFormats(tabId) {
  try {
    const data = await chrome.storage.session.get(YT_KEY(tabId));
    return data[YT_KEY(tabId)] || null;
  } catch (e) { return null; }
}

async function setYtFormats(tabId, formats) {
  try { await chrome.storage.session.set({ [YT_KEY(tabId)]: formats }); } catch (e) { /* noop */ }
}

function ytQuality(f) {
  const m = /(\d+)p/i.exec(f.qualityLabel || '');
  return m ? parseInt(m[1], 10) : 0;
}

function pickBestYt(formats) {
  return formats.slice().sort((a, b) => ytQuality(b) - ytQuality(a))[0] || null;
}

function ytExt(mimeType) {
  const m = (mimeType || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('matroska')) return 'mkv';
  if (m.includes('mp4') || m.includes('mpeg')) return 'mp4';
  return 'mp4';
}

// ---- Offscreen (motor HLS) ----
let creatingOffscreen = null;
async function ensureOffscreen() {
  const path = 'offscreen.html';
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(path)],
  });
  if (existing.length > 0) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: path,
    reasons: ['BLOBS'],
    justification: 'Montar arquivo de vídeo a partir de segmentos HLS.',
  });
  await creatingOffscreen;
  creatingOffscreen = null;
}

function suggestFilename(tabId, ext) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `video-${stamp}.${ext}`;
}

// Instagram/Facebook servem MP4 progressivo com parâmetros de range (bytestart/byteend)
// e de eficiência; removê-los tende a devolver o arquivo inteiro em vez de um pedaço.
function sanitizeDirectUrl(url) {
  try {
    const u = new URL(url);
    ['bytestart', 'byteend', 'range'].forEach((p) => u.searchParams.delete(p));
    return u.href;
  } catch (e) {
    return url;
  }
}

// Relay de progresso do offscreen para o popup/content (por broadcast).
function broadcastProgress(payload) {
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS', ...payload }).catch(() => {});
}

async function startDirectDownload(url, tabId, ext) {
  try {
    const clean = sanitizeDirectUrl(url);
    console.log('[PiP DL] baixando direto:', clean);
    if (!ext) ext = /\.webm(\?|$)/i.test(clean) ? 'webm' : 'mp4';
    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url: clean, filename: suggestFilename(tabId, ext), conflictAction: 'uniquify' },
        (downloadId) => {
          if (chrome.runtime.lastError || downloadId === undefined) {
            reject(new Error(chrome.runtime.lastError?.message || 'download falhou'));
            return;
          }
          const onChanged = (delta) => {
            if (delta.id !== downloadId) return;
            if (delta.state && delta.state.current === 'complete') {
              chrome.downloads.onChanged.removeListener(onChanged);
              chrome.downloads.search({ id: downloadId }, ([item]) => {
                const size = item && item.fileSize;
                if (size !== undefined && size < 50000) {
                  // Arquivo minúsculo quase sempre é uma página de erro do YouTube
                  // (ex.: decifragem de assinatura incorreta devolvendo texto).
                  console.warn('[PiP DL] arquivo muito pequeno (' + size +
                    ' bytes): provável página de erro do YouTube — a assinatura decifrada pode estar incorreta.');
                }
              });
              resolve();
            } else if (delta.state && delta.state.current === 'interrupted') {
              chrome.downloads.onChanged.removeListener(onChanged);
              reject(new Error('download interrompido'));
            }
          };
          chrome.downloads.onChanged.addListener(onChanged);
        }
      );
    });
    broadcastProgress({ tabId, state: 'done' });
    return { ok: true };
  } catch (e) {
    broadcastProgress({ tabId, state: 'error', message: e.message });
    return { ok: false, error: e.message };
  }
}

async function startHlsDownload(playlistUrl, tabId) {
  await ensureOffscreen();
  broadcastProgress({ tabId, state: 'starting' });
  // Encaminhar job para o offscreen; a resposta traz {ok, objectUrl|reason}.
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen', type: 'HLS_ASSEMBLE', playlistUrl, tabId,
  });
  if (!res || !res.ok) {
    const reason = res && res.reason;
    broadcastProgress({ tabId, state: reason === 'drm' ? 'drm' : 'error', message: res && res.message });
    return { ok: false, error: reason || 'falha' };
  }
  try {
    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url: res.objectUrl, filename: suggestFilename(tabId, 'ts') },
        (downloadId) => {
          if (chrome.runtime.lastError || downloadId === undefined) {
            reject(new Error(chrome.runtime.lastError?.message || 'download falhou'));
            return;
          }
          const onChanged = (delta) => {
            if (delta.id !== downloadId) return;
            if (delta.state && delta.state.current === 'complete') {
              chrome.downloads.onChanged.removeListener(onChanged);
              resolve();
            } else if (delta.state && delta.state.current === 'interrupted') {
              chrome.downloads.onChanged.removeListener(onChanged);
              reject(new Error('download interrompido'));
            }
          };
          chrome.downloads.onChanged.addListener(onChanged);
        }
      );
    });
    broadcastProgress({ tabId, state: 'done' });
    return { ok: true };
  } catch (e) {
    broadcastProgress({ tabId, state: 'error', message: e.message });
    return { ok: false, error: e.message };
  } finally {
    // Liberar o objectURL no offscreen e fechar.
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'HLS_REVOKE', objectUrl: res.objectUrl }).catch(() => {});
    try { await chrome.offscreen.closeDocument(); } catch (e) { /* já fechado */ }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'GET_DOWNLOAD_CANDIDATES') {
    const tabId = msg.tabId || (sender.tab && sender.tab.id);
    (async () => {
      try { sendResponse(await candidatesForTab(tabId)); }
      catch (e) { console.warn('[PiP DL] candidates erro:', e); sendResponse({ hls: [], direct: [], dash: [] }); }
    })();
    return true; // resposta assíncrona (storage.session)
  }

  if (msg.type === 'YT_FORMATS') {
    const tabId = msg.tabId || (sender.tab && sender.tab.id);
    if (tabId) setYtFormats(tabId, msg.formats || []);
    return;
  }

  if (msg.type === 'START_DOWNLOAD') {
    const tabId = msg.tabId || (sender.tab && sender.tab.id);
    (async () => {
      try {
        // 1) URL explícita vinda do currentSrc do vídeo clicado (caminho primário).
        if (msg.url) {
          console.log('[PiP DL] download direto (currentSrc):', msg.url);
          sendResponse(await startDirectDownload(msg.url, tabId));
          return;
        }
        // 1b) YouTube: usar as URLs progressivas (áudio+vídeo) extraídas do player,
        // que baixam como arquivo único. O <video> só expõe um blob via MSE, então os
        // candidatos farejados na rede são fragmentos DASH e não servem sozinhos.
        const ytFormats = await readYtFormats(tabId);
        if (ytFormats && ytFormats.length) {
          const best = pickBestYt(ytFormats);
          if (best) {
            console.log('[PiP DL] YouTube progressivo:', best.qualityLabel || best.itag, best.mimeType || '');
            sendResponse(await startDirectDownload(best.url, tabId, ytExt(best.mimeType)));
            return;
          }
        }
        // 2) Senão, usar candidatos farejados persistidos.
        const cands = await candidatesForTab(tabId);
        console.log('[PiP DL] candidatos aba', tabId, cands);
        if (cands.direct.length > 0) {
          sendResponse(await startDirectDownload(cands.direct[0], tabId));
        } else if (cands.hls.length > 0) {
          sendResponse(await startHlsDownload(cands.hls[0], tabId));
        } else if (cands.dash.length > 0) {
          broadcastProgress({ tabId, state: 'unsupported' });
          sendResponse({ ok: false, error: 'unsupported' });
        } else {
          broadcastProgress({ tabId, state: 'nosource' });
          sendResponse({ ok: false, error: 'nosource' });
        }
      } catch (e) {
        console.warn('[PiP DL] START_DOWNLOAD erro:', e);
        broadcastProgress({ tabId, state: 'error', message: e.message });
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // resposta assíncrona
  }

  // Progresso vindo do offscreen → repassar como broadcast para a UI.
  if (msg.type === 'HLS_PROGRESS') {
    broadcastProgress({ tabId: msg.tabId, state: 'downloading', done: msg.done, total: msg.total });
    return;
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "toggle-pip") {
    try {
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          action: "TOGGLE_PIP"
        });
      }
    } catch (e) {
      console.error("Falha ao enviar mensagem:", e);
    }
  }
});
