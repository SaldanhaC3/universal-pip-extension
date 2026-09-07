// youtubeInterceptor.js
// Roda no mundo principal (world: MAIN) da página do YouTube. O player expõe
// `window.ytInitialPlayerResponse` com `streamingData.formats`: streams
// progressivos que já trazem áudio+vídeo combinados em uma única URL assinada,
// baixável como arquivo. Sem isso, o YouTube usa DASH via MSE e o <video> só
// mostra um blob:, que não vira um arquivo único.
//
// O script roda no mundo principal justamente para enxergar a global da página;
// como scripts de content script nesse mundo nem sempre têm acesso direto às
// APIs de extensão de forma confiável, repassamos os dados via postMessage para
// o earlyInjection (mundo isolado), que encaminha ao background.
(function () {
  if (!/youtube\.com/.test(location.hostname)) return;

  let lastVideoId = null;

  function currentVideoId(y) {
    return (
      (y.videoDetails && y.videoDetails.videoId) ||
      (y.microformat && y.microformat.playerMicroformatRenderer &&
        y.microformat.playerMicroformatRenderer.videoId) ||
      ((location.search.match(/[?&]v=([^&]+)/) || [])[1]) ||
      null
    );
  }

  function extract() {
    const y = window.ytInitialPlayerResponse;
    if (!y || !y.streamingData) return;

    const videoId = currentVideoId(y);
    if (!videoId || videoId === lastVideoId) return;

    // formats = progressivos (áudio+vídeo). adaptiveFormats são separados (DASH).
    const formats = (y.streamingData.formats || []).filter((f) => f && f.url);
    if (!formats.length) return;

    lastVideoId = videoId;
    const payload = formats.map((f) => ({
      url: f.url,
      qualityLabel: f.qualityLabel || '',
      mimeType: f.mimeType || '',
      itag: f.itag,
    }));
    try {
      window.postMessage({ __pipYtFormats: payload, videoId }, '*');
    } catch (e) { /* noop */ }
  }

  extract();
  const timer = setInterval(extract, 1500);

  // YouTube é SPA: ao trocar de vídeo sem recarregar, o ytInitialPlayerResponse
  // é atualizado. Estes eventos cobrem a maior parte das navegações internas.
  document.addEventListener('yt-page-data-updated', extract);
  window.addEventListener('yt-navigate-finish', extract);
  window.addEventListener('beforeunload', () => clearInterval(timer));
})();
