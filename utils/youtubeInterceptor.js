// youtubeInterceptor.js
// Roda no mundo principal (world: MAIN) da página do YouTube. O player expõe
// `window.ytInitialPlayerResponse`. Cada formato de vídeo traz a URL em um de
// três formatos:
//   - `url` direto (ráreo hoje em dia);
//   - `signatureCipher` / `cipher`: query string com `url`, `s` (assinatura) e
//     `sp` (nome do parâmetro, normalmente "signature");
//   - `url` já assinada mas com parâmetro `n` que precisa de uma transformação.
// Baixar a URL bruta não funciona: o YouTube devolve 403. É preciso decifrar a
// assinatura usando a função que está no JavaScript do player.
//
// Como scripts de content script em world: MAIN nem sempre têm acesso direto às
// APIs de extensão de forma confiável, repassamos os dados via postMessage para
// o earlyInjection (mundo isolado), que encaminha ao background.
(function () {
  if (!/youtube\.com/.test(location.hostname)) return;

  let lastVideoId = null;
  let decoderPromise = null; // cache da função de decifração do player

  // ---- Decifração de assinatura do YouTube ----

  function getJsUrl() {
    const scripts = document.querySelectorAll('script[src]');
    for (const s of scripts) {
      if (/\/player\//.test(s.src)) return s.src;
    }
    const m = document.documentElement.innerHTML.match(/"jsUrl":"([^"]+)"/);
    if (m) return m[1];
    return null;
  }

  // Extrai o corpo do IIFE do player e devolve a função nomeada por `fnName`.
  function buildDecoder(js, fnName) {
    try {
      const start = js.indexOf('(function(){');
      if (start < 0) return null;
      let i = js.indexOf('{', start);
      let depth = 0, end = -1;
      for (; i < js.length; i++) {
        if (js[i] === '{') depth++;
        else if (js[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end < 0) return null;
      const body = js.slice(js.indexOf('{', start), end + 1);
      return new Function(body + '\nreturn ' + fnName + ';')();
    } catch (e) {
      console.warn('[PiP YT] falha ao montar decoder:', e.message);
      return null;
    }
  }

  async function getDecoder() {
    if (decoderPromise) return decoderPromise;
    decoderPromise = (async () => {
      try {
        const jsUrl = getJsUrl();
        if (!jsUrl) { console.warn('[PiP YT] jsUrl do player não encontrado'); return null; }
        const js = await fetch(jsUrl).then((r) => r.text());
        const m = js.match(/function ([A-Za-z0-9_$]+)\(a\)\{a=a\.split\(""\)/);
        if (!m) { console.warn('[PiP YT] função de assinatura não encontrada no player'); return null; }
        const fn = buildDecoder(js, m[1]);
        console.log('[PiP YT] decoder obtido:', typeof fn === 'function');
        return fn;
      } catch (e) {
        console.warn('[PiP YT] erro ao obter decoder:', e.message);
        return null;
      }
    })();
    return decoderPromise;
  }

  async function decipherFormat(fmt) {
    let url = fmt.url || '';
    let sig = null;
    let sp = 'signature';
    if (fmt.signatureCipher || fmt.cipher) {
      const p = new URLSearchParams(fmt.signatureCipher || fmt.cipher);
      url = p.get('url') || '';
      sig = p.get('s');
      sp = p.get('sp') || 'signature';
    }
    if (!url) return null;

    const u = new URL(url);
    const dec = await getDecoder();

    if (u.searchParams.has('n') && dec) {
      try { u.searchParams.set('n', dec(u.searchParams.get('n'))); } catch (e) { /* noop */ }
    }
    if (sig && dec) {
      try { u.searchParams.set(sp, dec(sig)); } catch (e) { /* noop */ }
    }
    return u.toString();
  }

  // ---- Extração dos formatos progressivos (áudio+vídeo) ----

  function currentVideoId(y) {
    return (
      (y.videoDetails && y.videoDetails.videoId) ||
      (y.microformat && y.microformat.playerMicroformatRenderer &&
        y.microformat.playerMicroformatRenderer.videoId) ||
      ((location.search.match(/[?&]v=([^&]+)/) || [])[1]) ||
      null
    );
  }

  async function extract() {
    const y = window.ytInitialPlayerResponse;
    if (!y || !y.streamingData) return;

    const videoId = currentVideoId(y);
    if (!videoId || videoId === lastVideoId) return;

    const sd = y.streamingData;
    const progressives = (sd.formats || []).filter((f) => f && (f.url || f.signatureCipher || f.cipher));
    console.log('[PiP YT] response ok | videoId=' + videoId +
      ' | formatos=' + (sd.formats || []).length +
      ' | progressivos=' + progressives.length +
      ' | adaptive=' + (sd.adaptiveFormats || []).length);

    if (!progressives.length) return;

    const urls = [];
    for (const f of progressives) {
      const u = await decipherFormat(f);
      if (u) urls.push({ url: u, qualityLabel: f.qualityLabel || '', mimeType: f.mimeType || '', itag: f.itag });
    }
    console.log('[PiP YT] URLs decifradas: ' + urls.length);
    if (!urls.length) return;

    lastVideoId = videoId;
    try {
      window.postMessage({ __pipYtFormats: urls, videoId }, '*');
    } catch (e) { /* noop */ }
  }

  extract();
  const timer = setInterval(extract, 1500);

  document.addEventListener('yt-page-data-updated', extract);
  window.addEventListener('yt-navigate-finish', extract);
  window.addEventListener('beforeunload', () => clearInterval(timer));
})();
