// offscreen.js
// Motor de download HLS: roda num documento offscreen (página de extensão), que tem DOM,
// URL.createObjectURL e faz fetch cross-origin usando as host_permissions (sem CORS do CDN).

const objectUrls = new Set();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.type === 'HLS_ASSEMBLE') {
    assembleHls(msg.playlistUrl, msg.tabId)
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ ok: false, reason: 'error', message: e.message }));
    return true; // assíncrono
  }

  if (msg.type === 'HLS_REVOKE') {
    if (msg.objectUrl && objectUrls.has(msg.objectUrl)) {
      URL.revokeObjectURL(msg.objectUrl);
      objectUrls.delete(msg.objectUrl);
    }
    return;
  }
});

// Resolve URI relativo contra a URL base da playlist.
function resolveUrl(base, uri) {
  try { return new URL(uri, base).href; } catch (e) { return uri; }
}

// Parse simples de atributos de uma linha de tag HLS (ex.: METHOD=AES-128,URI="...",IV=0x...).
function parseAttributes(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    attrs[m[1]] = val;
  }
  return attrs;
}

async function fetchText(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' em ' + url);
  return resp.text();
}

async function fetchBytes(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' em ' + url);
  return new Uint8Array(await resp.arrayBuffer());
}

function hexToBytes(hex) {
  hex = hex.replace(/^0x/i, '');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// IV a partir do índice de sequência quando o tag KEY não traz IV explícito.
function ivFromSequence(seq) {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(12, seq >>> 0, false); // big-endian nos últimos 4 bytes
  return iv;
}

async function assembleHls(playlistUrl, tabId) {
  let text = await fetchText(playlistUrl);
  let baseUrl = playlistUrl;

  // Se for master playlist, escolher a variante de maior BANDWIDTH.
  if (text.includes('#EXT-X-STREAM-INF')) {
    const lines = text.split(/\r?\n/);
    let best = null, bestBw = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const attrs = parseAttributes(lines[i]);
        const bw = parseInt(attrs['BANDWIDTH'] || attrs['AVERAGE-BANDWIDTH'] || '0', 10);
        const uri = (lines[i + 1] || '').trim();
        if (uri && !uri.startsWith('#') && bw > bestBw) { bestBw = bw; best = uri; }
      }
    }
    if (!best) return { ok: false, reason: 'error', message: 'Variante HLS não encontrada' };
    baseUrl = resolveUrl(playlistUrl, best);
    text = await fetchText(baseUrl);
  }

  // Parse da media playlist.
  const lines = text.split(/\r?\n/);
  const segments = [];
  let mediaSeq = 0;
  let currentKey = null; // { method, uri, ivBytes|null }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      mediaSeq = parseInt(line.split(':')[1] || '0', 10) || 0;
    } else if (line.startsWith('#EXT-X-KEY')) {
      const attrs = parseAttributes(line);
      const method = (attrs['METHOD'] || 'NONE').toUpperCase();
      if (method === 'NONE') {
        currentKey = null;
      } else if (method === 'AES-128') {
        currentKey = {
          method,
          uri: resolveUrl(baseUrl, attrs['URI'] || ''),
          ivBytes: attrs['IV'] ? hexToBytes(attrs['IV']) : null,
        };
      } else {
        // SAMPLE-AES / Widevine / outros: não temos como decriptar.
        return { ok: false, reason: 'drm', message: 'Vídeo protegido (' + method + ')' };
      }
    } else if (line && !line.startsWith('#')) {
      segments.push({ uri: resolveUrl(baseUrl, line), key: currentKey, seq: mediaSeq + segments.length });
    }
  }

  if (segments.length === 0) return { ok: false, reason: 'error', message: 'Nenhum segmento encontrado' };

  // Cache de CryptoKey por URI de chave.
  const keyCache = new Map();
  async function getCryptoKey(uri) {
    if (keyCache.has(uri)) return keyCache.get(uri);
    const raw = await fetchBytes(uri);
    const ck = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
    keyCache.set(uri, ck);
    return ck;
  }

  const total = segments.length;
  const parts = new Array(total);
  const CONCURRENCY = 4;
  let done = 0;
  let nextIndex = 0;
  let failed = null;

  async function worker() {
    while (nextIndex < total && !failed) {
      const idx = nextIndex++;
      const seg = segments[idx];
      try {
        let bytes = await fetchBytes(seg.uri);
        if (seg.key) {
          const ck = await getCryptoKey(seg.key.uri);
          const iv = seg.key.ivBytes || ivFromSequence(seg.seq);
          const dec = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ck, bytes);
          bytes = new Uint8Array(dec);
        }
        parts[idx] = bytes;
        done++;
        if (done % 3 === 0 || done === total) {
          chrome.runtime.sendMessage({ type: 'HLS_PROGRESS', tabId, done, total }).catch(() => {});
        }
      } catch (e) {
        failed = e;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  if (failed) return { ok: false, reason: 'error', message: failed.message };

  const blob = new Blob(parts, { type: 'video/mp2t' });
  const objectUrl = URL.createObjectURL(blob);
  objectUrls.add(objectUrl);
  return { ok: true, objectUrl, total };
}
