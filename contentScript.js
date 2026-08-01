// Função para remover bloqueios comuns ao PiP (Ex: sites com disablePictureInPicture)
function removePiPBlocks(video) {
  if (video.hasAttribute('disablePictureInPicture')) {
    video.removeAttribute('disablePictureInPicture');
  }
  try {
    Object.defineProperty(video, 'disablePictureInPicture', {
      get: () => false,
      set: () => {},
      configurable: true
    });
  } catch (e) {
    // Ignorar erros caso a propriedade já tenha sido sobresscrita de outra forma
  }
}

// Função assíncrona que deteta o DRM por via de canvas antes de disparar falsos positivos
async function detectDRMType(video) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  try {
    canvas.width = 2; // Tamanho mímino pra agilizar o processo
    canvas.height = 2;
    
    // Tentar desenhar
    ctx.drawImage(video, 0, 0, 1, 1);
    const pixel = ctx.getImageData(0, 0, 1, 1).data;
    
    // Se tudo for rgb(0,0,0) estrito com zero de alpha ou puro zero... 
    // OBS: O Widevine às vezes torna o canvas opaco mas sem renderizar
    if (pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0) {
      // Retornar DRM apenas se o vídeo estiver rolando (ou seja, não deveria ser preto)
      if (!video.paused && video.currentTime > 0) {
        return 'HARDWARE_DRM'; 
      }
    }
    return 'NO_DRM';
  } catch (e) {
    if (e.name === 'SecurityError') {
      return 'CORS_DRM'; // Geralmente CORS de iframes protegidos ou restrições severas
    }
    return 'UNKNOWN';
  }
}

async function togglePictureInPicture(videoElement) {
  try {
    if (!document.pictureInPictureEnabled) {
      throw new Error('PiP não suportado neste navegador');
    }

    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      if (videoElement.readyState < 2) {
        await new Promise(resolve => {
          videoElement.addEventListener('loadeddata', resolve, { once: true });
        });
      }
      
      removePiPBlocks(videoElement);

      const isDRM = await detectDRMType(videoElement);
      // Tentativa oficial independente
      await videoElement.requestPictureInPicture();
    }
  } catch (error) {
    console.error('[PiP Unlocker] Erro capturado ao alternar PiP:', error.name, error.message);
    
    if (error.name === 'NotAllowedError') {
      detectDRMType(videoElement).then(drmCheck => {
        if (drmCheck === 'HARDWARE_DRM') {
          alert('🔒 Este vídeo usa proteção DRM de hardware nível L1/L3. O Picture-in-Picture bloqueado no navegador por segurança.');
        } else {
          alert('⚠️ O site desativou o PiP preventivamente via Script ou a ação exigia iteração real do cursor no vídeo.');
        }
      });
    } else {
      chrome.runtime.sendMessage({
        type: 'PIP_ERROR',
        error: error.message
      });
    }
  }
}

function createPiPButton(video) {
  const container = video.parentElement;
  if (!container) return;

  // Evitar duplicar botões
  if (container.querySelector('.universal-pip-extension-btn')) {
    return;
  }

  const button = document.createElement('button');
  button.className = 'universal-pip-extension-btn';
  button.innerHTML = '⧉';
  button.title = "Ativar Picture-in-Picture";
  
  // Isolar CSS para evitar conflito com a página host
  button.style.cssText = `
    position: absolute !important;
    top: 10px !important;
    right: 10px !important;
    z-index: 2147483647 !important;
    background: rgba(0, 0, 0, 0.7) !important;
    color: white !important;
    border: 1px solid rgba(255,255,255,0.2) !important;
    border-radius: 4px !important;
    padding: 6px 10px !important;
    cursor: pointer !important;
    display: none !important;
    font-size: 16px !important;
    backdrop-filter: blur(4px) !important;
    transition: opacity 0.2s, background 0.2s !important;
    line-height: 1 !important;
    box-sizing: border-box !important;
  `;

  button.addEventListener('mouseenter', () => {
    button.style.background = 'rgba(0, 0, 0, 0.95) !important';
  });
  
  button.addEventListener('mouseleave', () => {
    button.style.background = 'rgba(0, 0, 0, 0.7) !important';
  });

  const style = window.getComputedStyle(container);
  if (style.position === 'static') {
    container.style.position = 'relative';
  }

  container.appendChild(button);
  
  container.addEventListener('mouseenter', () => {
    button.style.setProperty('display', 'block', 'important');
    button.style.setProperty('opacity', '1', 'important');
  });
  
  container.addEventListener('mouseleave', () => {
    button.style.setProperty('opacity', '0', 'important');
    setTimeout(() => {
      if (button.style.opacity === '0') {
        button.style.setProperty('display', 'none', 'important');
      }
    }, 200);
  });
  
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePictureInPicture(video);
  });
}

// ----- Realce de vídeo (WebGL) -----

const enhancers = new Map(); // video -> VideoEnhancer
let globalEnhanceEnabled = false;
let globalEnhanceIntensity = 0.5;

// Mensagens de feedback por código de status do enhancer.
const ENHANCE_MESSAGES = {
  enabled:  (d) => ({ text: `✦ Realce ativado · ${d.width}×${d.height}`, tone: 'ok' }),
  disabled: ()  => ({ text: '✦ Realce desativado', tone: 'info' }),
  skip_hd:  (d) => ({ text: `Vídeo já em ${d.height}p — realce desnecessário`, tone: 'info' }),
  blocked:  ()  => ({ text: 'Vídeo protegido (DRM/CORS) — realce indisponível', tone: 'warn' }),
  no_webgl: ()  => ({ text: 'WebGL indisponível neste navegador', tone: 'warn' }),
  slow:     ()  => ({ text: 'Desempenho insuficiente — exibindo vídeo original', tone: 'warn' }),
};

let _toastEl = null;
let _toastTimer = null;
function showToast(text, tone) {
  const colors = {
    ok:   { bg: 'rgba(22, 101, 52, 0.95)',  border: '#22c55e' },
    info: { bg: 'rgba(30, 41, 59, 0.95)',   border: '#3b82f6' },
    warn: { bg: 'rgba(120, 53, 15, 0.95)',  border: '#f59e0b' },
  };
  const c = colors[tone] || colors.info;

  if (!_toastEl) {
    _toastEl = document.createElement('div');
    _toastEl.className = 'universal-pip-toast';
    document.documentElement.appendChild(_toastEl);
  }
  _toastEl.style.cssText = `
    position: fixed !important;
    bottom: 24px !important;
    left: 50% !important;
    transform: translateX(-50%) translateY(10px) !important;
    z-index: 2147483647 !important;
    background: ${c.bg} !important;
    color: #fff !important;
    border: 1px solid ${c.border} !important;
    border-radius: 8px !important;
    padding: 10px 16px !important;
    font: 600 13px/1.3 'Segoe UI', system-ui, sans-serif !important;
    box-shadow: 0 6px 20px rgba(0,0,0,0.4) !important;
    backdrop-filter: blur(6px) !important;
    pointer-events: none !important;
    opacity: 0 !important;
    transition: opacity 0.2s ease, transform 0.2s ease !important;
    max-width: 80vw !important;
    text-align: center !important;
  `;
  _toastEl.textContent = text;
  // Forçar reflow para animar.
  void _toastEl.offsetWidth;
  _toastEl.style.setProperty('opacity', '1', 'important');
  _toastEl.style.setProperty('transform', 'translateX(-50%) translateY(0)', 'important');

  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    if (_toastEl) {
      _toastEl.style.setProperty('opacity', '0', 'important');
      _toastEl.style.setProperty('transform', 'translateX(-50%) translateY(10px)', 'important');
    }
  }, 2800);
}

function reportEnhanceStatus(reason, detail) {
  const builder = ENHANCE_MESSAGES[reason];
  if (!builder) return;
  const { text, tone } = builder(detail || {});
  showToast(text, tone);
}

function getEnhancer(video) {
  if (typeof window.VideoEnhancer === 'undefined') return null;
  let enh = enhancers.get(video);
  if (!enh && video.isConnected) {
    enh = new window.VideoEnhancer(video);
    enh.setIntensity(globalEnhanceIntensity);
    enh.onStatus(reportEnhanceStatus);
    enhancers.set(video, enh);
  }
  return enh;
}

function toggleEnhance(video) {
  const enh = getEnhancer(video);
  if (!enh) return { enabled: false, reason: 'no_webgl' };
  const result = enh.toggle();
  const detail = enh.getResolution();
  reportEnhanceStatus(result.reason, detail); // toast por ação do usuário
  return result;
}

function applyGlobalEnhance(enabled, announce) {
  globalEnhanceEnabled = enabled;
  const videos = (window.currentVideoScanner && window.currentVideoScanner.getVideos()) || [];

  let activated = 0;
  let firstBlock = null; // captura motivo de falha (ex.: skip_hd, blocked)
  let firstDetail = null;

  videos.forEach(v => {
    const enh = getEnhancer(v);
    if (!enh) return;
    enh.setIntensity(globalEnhanceIntensity);
    if (enabled) {
      const reason = enh.enable();
      if (reason === 'enabled') activated++;
      else if (!firstBlock && reason !== 'already') { firstBlock = reason; firstDetail = enh.getResolution(); }
    } else {
      enh.disable();
    }
  });

  if (!announce) return;
  if (!enabled) {
    reportEnhanceStatus('disabled', {});
  } else if (activated > 0) {
    const ref = getEnhancer(videos[0]);
    reportEnhanceStatus('enabled', ref ? ref.getResolution() : {});
  } else if (firstBlock) {
    reportEnhanceStatus(firstBlock, firstDetail || {});
  } else if (videos.length === 0) {
    showToast('Nenhum vídeo detectado nesta página', 'info');
  }
}

function applyGlobalIntensity(value) {
  globalEnhanceIntensity = value;
  enhancers.forEach(enh => enh.setIntensity(value));
}

function getEnhanceStatus() {
  let fps = 0;
  let activeCount = 0;
  let width = 0, height = 0;
  enhancers.forEach(enh => {
    if (enh.enabled) {
      activeCount++;
      fps = Math.max(fps, enh.getFps());
      const r = enh.getResolution();
      if (r.height > height) { width = r.width; height = r.height; }
    }
  });
  return { enabled: globalEnhanceEnabled, intensity: globalEnhanceIntensity, fps, activeCount, width, height };
}

function createEnhanceButton(video) {
  const container = video.parentElement;
  if (!container) return;
  if (container.querySelector('.universal-pip-enhance-btn')) return;

  const button = document.createElement('button');
  button.className = 'universal-pip-enhance-btn';
  button.innerHTML = '✦';
  button.title = 'Ativar realce de vídeo';

  button.style.cssText = `
    position: absolute !important;
    top: 10px !important;
    right: 52px !important;
    z-index: 2147483647 !important;
    background: rgba(0, 0, 0, 0.7) !important;
    color: white !important;
    border: 1px solid rgba(255,255,255,0.2) !important;
    border-radius: 4px !important;
    padding: 6px 10px !important;
    cursor: pointer !important;
    display: none !important;
    font-size: 16px !important;
    backdrop-filter: blur(4px) !important;
    transition: opacity 0.2s, background 0.2s !important;
    line-height: 1 !important;
    box-sizing: border-box !important;
  `;

  const style = window.getComputedStyle(container);
  if (style.position === 'static') {
    container.style.position = 'relative';
  }
  container.appendChild(button);

  container.addEventListener('mouseenter', () => {
    button.style.setProperty('display', 'block', 'important');
    button.style.setProperty('opacity', '1', 'important');
  });
  container.addEventListener('mouseleave', () => {
    button.style.setProperty('opacity', '0', 'important');
    setTimeout(() => {
      if (button.style.opacity === '0') {
        button.style.setProperty('display', 'none', 'important');
      }
    }, 200);
  });

  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const { enabled } = toggleEnhance(video);
    button.style.setProperty('background',
      enabled ? 'rgba(59, 130, 246, 0.9)' : 'rgba(0, 0, 0, 0.7)', 'important');
    button.style.setProperty('border-color',
      enabled ? 'rgba(96, 165, 250, 0.9)' : 'rgba(255,255,255,0.2)', 'important');
    button.title = enabled ? 'Desativar realce de vídeo' : 'Ativar realce de vídeo';
  });
}

// Classifica a fonte de um <video> a partir do seu currentSrc.
function sourceOf(video) {
  const url = video.currentSrc || video.src || '';
  let kind = 'none';
  if (/^https?:/i.test(url)) {
    if (/\.m3u8(\?|$)/i.test(url)) kind = 'hls';
    else if (/\.mpd(\?|$)/i.test(url)) kind = 'dash';
    else kind = 'direct';
  } else if (/^blob:/i.test(url)) {
    kind = 'blob';
  }
  return { kind, url, width: video.videoWidth || 0, height: video.videoHeight || 0 };
}

// Escolhe o "melhor" vídeo do frame: tocando > tela cheia > maior área.
function pickBestVideo() {
  const videos = (window.currentVideoScanner && window.currentVideoScanner.getVideos()) || [];
  if (videos.length === 0) return null;
  const fs = document.fullscreenElement;
  const score = (v) => {
    const r = v.getBoundingClientRect();
    let s = r.width * r.height;
    if (!v.paused && !v.ended) s += 1e9;      // tocando pesa muito
    if (fs && (v === fs || fs.contains(v))) s += 2e9; // tela cheia pesa mais ainda
    return s;
  };
  return videos.slice().sort((a, b) => score(b) - score(a))[0];
}

// Captura uma miniatura do frame atual do vídeo. Retorna dataURL ou null se cross-origin (tainted).
function captureThumb(video, w) {
  try {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    w = w || 120;
    const h = Math.max(1, Math.round(w * vh / vw));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(video, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.5); // lança SecurityError se tainted
  } catch (e) {
    return null;
  }
}

// Lista os vídeos "relevantes" do frame com miniatura, fonte e metadados (para o popup escolher).
function listVideosForDownload() {
  const videos = (window.currentVideoScanner && window.currentVideoScanner.getVideos()) || [];
  return videos.map((v, idx) => {
    const s = sourceOf(v);
    const r = v.getBoundingClientRect();
    return {
      idx,
      thumb: captureThumb(v),
      kind: s.kind,
      width: s.width,
      height: s.height,
      playing: !v.paused && !v.ended,
      area: Math.round(r.width * r.height),
    };
  }).filter((x) => x.playing || x.area > 4000); // descartar vídeos minúsculos/ocultos
}

// Inicia o download para um <video> específico (fonte amarrada ao elemento).
function startDownloadForVideo(video) {
  const src = sourceOf(video);
  if (src.kind === 'direct') {
    showToast('Baixando vídeo…', 'info');
    chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', url: src.url }, () => void chrome.runtime.lastError);
  } else if (src.kind === 'hls' || src.kind === 'blob') {
    // blob/HLS → depende do farejamento de rede no background.
    showToast('Procurando a fonte do stream…', 'info');
    chrome.runtime.sendMessage({ type: 'START_DOWNLOAD' }, () => void chrome.runtime.lastError);
  } else if (src.kind === 'dash') {
    showToast('Formato DASH não suportado ainda', 'warn');
  } else {
    showToast('Nenhuma fonte reproduzível detectada', 'warn');
  }
}

function createDownloadButton(video) {
  const container = video.parentElement;
  if (!container) return;
  if (container.querySelector('.universal-pip-download-btn')) return;

  const button = document.createElement('button');
  button.className = 'universal-pip-download-btn';
  button.innerHTML = '⬇';
  button.title = 'Baixar vídeo';

  button.style.cssText = `
    position: absolute !important;
    top: 10px !important;
    right: 94px !important;
    z-index: 2147483647 !important;
    background: rgba(16, 185, 129, 0.85) !important;
    color: white !important;
    border: 1px solid rgba(52, 211, 153, 0.9) !important;
    border-radius: 4px !important;
    padding: 6px 10px !important;
    cursor: pointer !important;
    display: none !important;
    font-size: 16px !important;
    backdrop-filter: blur(4px) !important;
    transition: opacity 0.2s, background 0.2s !important;
    line-height: 1 !important;
    box-sizing: border-box !important;
  `;

  const style = window.getComputedStyle(container);
  if (style.position === 'static') {
    container.style.position = 'relative';
  }
  container.appendChild(button);

  container.addEventListener('mouseenter', () => {
    button.style.setProperty('display', 'block', 'important');
    button.style.setProperty('opacity', '1', 'important');
  });
  container.addEventListener('mouseleave', () => {
    button.style.setProperty('opacity', '0', 'important');
    setTimeout(() => {
      if (button.style.opacity === '0') {
        button.style.setProperty('display', 'none', 'important');
      }
    }, 200);
  });

  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startDownloadForVideo(video); // fonte amarrada a ESTE vídeo
  });
}

// Feedback de progresso do download (broadcast do background).
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'DOWNLOAD_PROGRESS') return;
  if (window.top !== window) return; // toast apenas no frame de topo, evita duplicar
  switch (msg.state) {
    case 'starting':    showToast('Preparando download…', 'info'); break;
    case 'downloading': showToast(`Baixando ${msg.done}/${msg.total} segmentos…`, 'info'); break;
    case 'done':        showToast('✓ Download concluído', 'ok'); break;
    case 'drm':         showToast('Vídeo protegido (DRM) — download indisponível', 'warn'); break;
    case 'unsupported': showToast('Formato não suportado (DASH/blob)', 'warn'); break;
    case 'nosource':    showToast('Nenhuma fonte de vídeo detectada', 'warn'); break;
    case 'error':       showToast('Erro no download' + (msg.message ? `: ${msg.message}` : ''), 'warn'); break;
  }
});

// Inicializar detector se o script for importado corretamente
if (typeof window.VideoScanner !== 'undefined') {
  const scanner = new window.VideoScanner();
  window.currentVideoScanner = scanner; // <-- Exposto globalmente

  // Controle do realce exposto globalmente para o popup ler/agir em TODOS os frames
  // (o vídeo pode estar num iframe; messaging só atinge o frame de topo).
  window.__pipEnhance = {
    status: () => getEnhanceStatus(),
    toggle: (enabled) => { scanner.scan(); applyGlobalEnhance(enabled, true); return getEnhanceStatus(); },
    setIntensity: (v) => { applyGlobalIntensity(v); return getEnhanceStatus(); },
  };

  // Controle de download exposto para o popup ler/agir em todos os frames.
  window.__pipDownload = {
    getFocusedSource: () => {
      scanner.scan();
      const v = pickBestVideo();
      if (!v) return { kind: 'none', url: '', width: 0, height: 0, playing: false };
      const s = sourceOf(v);
      s.playing = !v.paused && !v.ended;
      return s;
    },
    downloadFocused: () => {
      const v = pickBestVideo();
      if (!v) { showToast('Nenhum vídeo encontrado', 'warn'); return { ok: false }; }
      startDownloadForVideo(v);
      return { ok: true };
    },
    list: () => listVideosForDownload(),
    downloadByIndex: (idx) => {
      const videos = (window.currentVideoScanner && window.currentVideoScanner.getVideos()) || [];
      const v = videos[idx];
      if (!v) { showToast('Vídeo não encontrado', 'warn'); return { ok: false }; }
      startDownloadForVideo(v);
      return { ok: true };
    },
  };
  
  scanner.onVideoFound((video) => {
    removePiPBlocks(video);
    createPiPButton(video);
    createEnhanceButton(video);
    createDownloadButton(video);
    // Aplicar realce global se já estiver ligado para a aba.
    if (globalEnhanceEnabled) {
      const enh = getEnhancer(video);
      if (enh) {
        enh.setIntensity(globalEnhanceIntensity);
        enh.enable();
      }
    }
  });

  // Carregar estado persistido do realce.
  try {
    chrome.storage.sync.get(['enhanceEnabled', 'enhanceIntensity'], (data) => {
      if (chrome.runtime.lastError) return;
      if (typeof data.enhanceIntensity === 'number') {
        globalEnhanceIntensity = data.enhanceIntensity;
      }
      if (data.enhanceEnabled) {
        applyGlobalEnhance(true);
      }
    });
  } catch (e) { /* storage indisponível em alguns contextos */ }
  
  // Aguardar body existir antes do scan completo
  if (document.body) {
    scanner.scan();
  } else {
    document.addEventListener('DOMContentLoaded', () => scanner.scan());
  }

  // Listener para o background e popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "TOGGLE_PIP") {
      // Resscanear no atoção caso a página tenha modificado algo
      scanner.scan();
      
      const videos = scanner.getVideos();
      if (videos.length > 0) {
        // Encontrar vídeo tocando
        const playingVideo = videos.find(v => !v.paused);
        // Se nenhum estiver tocando, tente ativar no primeiro maior vídeo (simplificado aqui pro primeiro)
        togglePictureInPicture(playingVideo || videos[0]);
      }
    } else if (request.action === "GET_VIDEOS") {
      // Mandar callback
      sendResponse({ count: scanner.getVideos().length });
    } else if (request.action === "ENHANCE_TOGGLE") {
      scanner.scan();
      applyGlobalEnhance(!!request.enabled, true);
      sendResponse(getEnhanceStatus());
    } else if (request.action === "ENHANCE_SET_INTENSITY") {
      applyGlobalIntensity(request.intensity);
      sendResponse(getEnhanceStatus());
    } else if (request.action === "GET_ENHANCE_STATUS") {
      sendResponse(getEnhanceStatus());
    }
  });

} else {
  console.error("VideoScanner não carregado. Certifique-se de que videoDetector.js foi incluído no manifest.json.");
}
