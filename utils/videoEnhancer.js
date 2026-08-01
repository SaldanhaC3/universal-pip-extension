// videoEnhancer.js
// Realce de vídeo em tempo real via WebGL (unsharp mask + contraste + saturação).
// Uma instância por elemento <video>. Leve o suficiente para GPU integrada.

const VERTEX_SHADER_SRC = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  varying vec2 v_texCoord;
  void main() {
    // a_position vem em clip-space (-1..1); flip vertical no texCoord
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
  }
`;

// Unsharp mask 3x3 + contraste + saturação. u_intensity (0..1) escala o efeito.
const FRAGMENT_SHADER_SRC = `
  precision mediump float;
  varying vec2 v_texCoord;
  uniform sampler2D u_image;
  uniform vec2 u_texel;     // 1.0 / resolução
  uniform float u_intensity;

  void main() {
    vec3 center = texture2D(u_image, v_texCoord).rgb;

    // Blur leve 3x3 (aproximação box) para o high-pass do unsharp mask
    vec3 blur = vec3(0.0);
    blur += texture2D(u_image, v_texCoord + u_texel * vec2(-1.0, -1.0)).rgb;
    blur += texture2D(u_image, v_texCoord + u_texel * vec2( 0.0, -1.0)).rgb;
    blur += texture2D(u_image, v_texCoord + u_texel * vec2( 1.0, -1.0)).rgb;
    blur += texture2D(u_image, v_texCoord + u_texel * vec2(-1.0,  0.0)).rgb;
    blur += center;
    blur += texture2D(u_image, v_texCoord + u_texel * vec2( 1.0,  0.0)).rgb;
    blur += texture2D(u_image, v_texCoord + u_texel * vec2(-1.0,  1.0)).rgb;
    blur += texture2D(u_image, v_texCoord + u_texel * vec2( 0.0,  1.0)).rgb;
    blur += texture2D(u_image, v_texCoord + u_texel * vec2( 1.0,  1.0)).rgb;
    blur /= 9.0;

    // Unsharp mask: original + (original - blur) * quantidade
    float sharpAmount = 1.2 * u_intensity;
    vec3 color = center + (center - blur) * sharpAmount;

    // Contraste leve em torno de 0.5
    float contrast = 1.0 + 0.15 * u_intensity;
    color = (color - 0.5) * contrast + 0.5;

    // Saturação leve
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    float sat = 1.0 + 0.15 * u_intensity;
    color = mix(vec3(luma), color, sat);

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  }
`;

class VideoEnhancer {
  constructor(video) {
    this.video = video;
    this.canvas = null;
    this.gl = null;
    this.program = null;
    this.texture = null;
    this.locations = {};
    this.intensity = 0.5;
    this.enabled = false;
    this.rvfcHandle = null;
    this.rafHandle = null;
    this.resizeObserver = null;
    this.onScroll = null;
    this._destroyed = false;

    // Medição de FPS / fallback de performance
    this.fps = 0;
    this._frameCount = 0;
    this._fpsWindowStart = 0;
    this._slowFrames = 0;
    this._autoReduced = false;

    this.badge = null;
    this.statusListener = null; // (reason, detail) => void
  }

  onStatus(cb) {
    this.statusListener = cb;
  }

  _emit(reason, detail) {
    if (this.statusListener) {
      try { this.statusListener(reason, detail || {}); } catch (e) { /* noop */ }
    }
  }

  // ---- Ciclo de vida público ----
  // Retorna um código de status: 'enabled' | 'skip_hd' | 'blocked' | 'no_webgl' | 'already'

  enable() {
    if (this.enabled || this._destroyed) return 'already';

    // Threshold: vídeos já em alta resolução não precisam de realce.
    if (this.video.videoHeight >= 1080) {
      console.info('[PiP Enhancer] Vídeo >=1080p; realce ignorado.');
      return 'skip_hd';
    }

    // Detecção de taint/DRM antes de montar o pipeline pesado.
    if (this._isTaintedOrDRM()) {
      console.warn('[PiP Enhancer] Canvas tainted/DRM; realce indisponível neste vídeo.');
      return 'blocked';
    }

    if (!this._initGL()) {
      console.warn('[PiP Enhancer] Falha ao inicializar WebGL; mantendo vídeo original.');
      this._teardownGL();
      return 'no_webgl';
    }

    this.enabled = true;
    this._autoReduced = false;
    this._slowFrames = 0;
    this._mountCanvas();
    this._startLoop();
    return 'enabled';
  }

  // Resolução atual da fonte, para mensagens de feedback.
  getResolution() {
    return { width: this.video.videoWidth || 0, height: this.video.videoHeight || 0 };
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this._stopLoop();
    this._unmountCanvas();
    this.fps = 0;
  }

  toggle() {
    if (this.enabled) {
      this.disable();
      return { enabled: false, reason: 'disabled' };
    }
    const reason = this.enable();
    return { enabled: this.enabled, reason };
  }

  setIntensity(v) {
    this.intensity = Math.max(0, Math.min(1, v));
    this._autoReduced = false; // usuário assumiu o controle
  }

  getFps() {
    return Math.round(this.fps);
  }

  destroy() {
    this._destroyed = true;
    this.disable();
    this._teardownGL();
    this.video = null;
  }

  // ---- Detecção de CORS / DRM (mesmo padrão de detectDRMType) ----

  _isTaintedOrDRM() {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    try {
      c.width = 2;
      c.height = 2;
      ctx.drawImage(this.video, 0, 0, 2, 2);
      const px = ctx.getImageData(0, 0, 1, 1).data; // lança SecurityError se tainted
      // Frame totalmente preto durante reprodução => DRM de hardware.
      if (px[0] === 0 && px[1] === 0 && px[2] === 0 && !this.video.paused && this.video.currentTime > 0) {
        return true;
      }
      return false;
    } catch (e) {
      return true; // SecurityError (CORS) ou outro bloqueio
    }
  }

  // ---- Inicialização WebGL ----

  _initGL() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: false })
      || canvas.getContext('experimental-webgl');
    if (!gl) return false;

    const program = this._buildProgram(gl, VERTEX_SHADER_SRC, FRAGMENT_SHADER_SRC);
    if (!program) return false;

    gl.useProgram(program);

    // Quad cobrindo todo o clip-space. texCoord com Y invertido (vídeo é top-down).
    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1,  1,  1, -1,   1, 1,
    ]), gl.STATIC_DRAW);
    const aPosition = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    const texBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 1,  1, 1,  0, 0,
      0, 0,  1, 1,  1, 0,
    ]), gl.STATIC_DRAW);
    const aTexCoord = gl.getAttribLocation(program, 'a_texCoord');
    gl.enableVertexAttribArray(aTexCoord);
    gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    this.locations = {
      u_image: gl.getUniformLocation(program, 'u_image'),
      u_texel: gl.getUniformLocation(program, 'u_texel'),
      u_intensity: gl.getUniformLocation(program, 'u_intensity'),
    };

    this.canvas = canvas;
    this.gl = gl;
    this.program = program;
    this.texture = texture;
    return true;
  }

  _buildProgram(gl, vsSrc, fsSrc) {
    const vs = this._compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = this._compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[PiP Enhancer] Link error:', gl.getProgramInfoLog(program));
      return null;
    }
    return program;
  }

  _compileShader(gl, type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('[PiP Enhancer] Shader error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  _teardownGL() {
    const gl = this.gl;
    if (gl) {
      if (this.texture) gl.deleteTexture(this.texture);
      if (this.program) gl.deleteProgram(this.program);
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
    this.gl = null;
    this.program = null;
    this.texture = null;
    this.canvas = null;
  }

  // ---- Posicionamento do canvas sobre o vídeo ----

  _mountCanvas() {
    const c = this.canvas;
    c.className = 'universal-pip-enhance-canvas';
    c.style.cssText = `
      position: absolute !important;
      pointer-events: none !important;
      z-index: 2147483646 !important;
      margin: 0 !important;
      padding: 0 !important;
    `;

    const container = this.video.parentElement || document.body;
    const style = window.getComputedStyle(container);
    if (style.position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(c);

    this._syncCanvasPosition();
    this._createBadge(container);

    // Esconder o vídeo original enquanto o canvas mostra a versão realçada.
    this._prevVisibility = this.video.style.visibility;
    this.video.style.visibility = 'hidden';

    // Reagir a mudanças de tamanho.
    this.resizeObserver = new ResizeObserver(() => this._syncCanvasPosition());
    this.resizeObserver.observe(this.video);

    this.onScroll = () => this._syncCanvasPosition();
    window.addEventListener('scroll', this.onScroll, { passive: true, capture: true });

    // Enquanto o vídeo estiver em Picture-in-Picture, o canvas não deve duplicar a
    // reprodução na página: pausa o loop, esconde o canvas e devolve o comportamento
    // nativo ao <video>. Ao sair do PiP, retoma o realce.
    this._onEnterPiP = () => this._handlePiP(true);
    this._onLeavePiP = () => this._handlePiP(false);
    this.video.addEventListener('enterpictureinpicture', this._onEnterPiP);
    this.video.addEventListener('leavepictureinpicture', this._onLeavePiP);

    // Se já estiver em PiP no momento de ligar o realce, respeitar esse estado.
    if (document.pictureInPictureElement === this.video) {
      this._handlePiP(true);
    }
  }

  _handlePiP(inPiP) {
    if (!this.enabled || !this.canvas) return;
    if (inPiP) {
      this._stopLoop();
      this.canvas.style.setProperty('display', 'none', 'important');
      if (this.badge) this.badge.style.setProperty('display', 'none', 'important');
      // Devolver o comportamento nativo ao vídeo (PiP cuida da exibição).
      this.video.style.visibility = this._prevVisibility || '';
    } else {
      this.video.style.visibility = 'hidden';
      this.canvas.style.removeProperty('display');
      if (this.badge) this.badge.style.removeProperty('display');
      this._syncCanvasPosition();
      this._startLoop();
      this._showBadge(true);
    }
  }

  _createBadge(container) {
    const badge = document.createElement('div');
    badge.className = 'universal-pip-enhance-badge';
    badge.style.cssText = `
      position: absolute !important;
      z-index: 2147483647 !important;
      top: 10px !important;
      left: 10px !important;
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      background: rgba(15, 23, 42, 0.82) !important;
      color: #fff !important;
      border: 1px solid rgba(59, 130, 246, 0.6) !important;
      border-radius: 6px !important;
      padding: 4px 9px !important;
      font: 600 12px/1.2 'Segoe UI', system-ui, sans-serif !important;
      letter-spacing: 0.2px !important;
      pointer-events: none !important;
      backdrop-filter: blur(4px) !important;
      box-shadow: 0 2px 8px rgba(0,0,0,0.35) !important;
      opacity: 0 !important;
      transition: opacity 0.25s ease !important;
    `;
    badge.innerHTML =
      '<span style="color:#60a5fa">✦</span>' +
      '<span class="upe-badge-text">Realce ativo</span>';
    container.appendChild(badge);
    this.badge = badge;
    this._updateBadge();

    // Aparece ao passar o mouse no vídeo; some sozinho após alguns segundos.
    this._showBadge(true);
    this._badgeContainer = container;
    this._badgeShow = () => this._showBadge(false);
    container.addEventListener('mouseenter', this._badgeShow);

    // Pulso inicial de 2.5s para confirmar que ligou.
    clearTimeout(this._badgeTimer);
    this._badgeTimer = setTimeout(() => {
      if (this.badge) this.badge.style.setProperty('opacity', '0', 'important');
    }, 2500);
  }

  _showBadge(autoHide) {
    if (!this.badge) return;
    this.badge.style.setProperty('opacity', '1', 'important');
    if (autoHide) {
      clearTimeout(this._badgeTimer);
      this._badgeTimer = setTimeout(() => {
        if (this.badge) this.badge.style.setProperty('opacity', '0', 'important');
      }, 2500);
    }
  }

  _updateBadge() {
    if (!this.badge) return;
    const text = this.badge.querySelector('.upe-badge-text');
    if (!text) return;
    const w = this.video.videoWidth || 0;
    const h = this.video.videoHeight || 0;
    const fps = Math.round(this.fps);
    const intensity = Math.round(this.intensity * 100);
    text.textContent = `Realce ${intensity}% · ${w}×${h}${fps ? ` · ${fps}fps` : ''}`;
  }

  _unmountCanvas() {
    if (this.badge) {
      clearTimeout(this._badgeTimer);
      if (this._badgeContainer && this._badgeShow) {
        this._badgeContainer.removeEventListener('mouseenter', this._badgeShow);
      }
      this._badgeContainer = null;
      this._badgeShow = null;
      if (this.badge.parentElement) this.badge.parentElement.removeChild(this.badge);
      this.badge = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.onScroll) {
      window.removeEventListener('scroll', this.onScroll, { capture: true });
      this.onScroll = null;
    }
    if (this.video) {
      if (this._onEnterPiP) this.video.removeEventListener('enterpictureinpicture', this._onEnterPiP);
      if (this._onLeavePiP) this.video.removeEventListener('leavepictureinpicture', this._onLeavePiP);
      this._onEnterPiP = null;
      this._onLeavePiP = null;
    }
    if (this.video) {
      this.video.style.visibility = this._prevVisibility || '';
    }
    if (this.canvas && this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
  }

  _syncCanvasPosition() {
    const c = this.canvas;
    if (!c) return;
    const container = c.parentElement;
    if (!container) return;

    const vRect = this.video.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();

    // Posição relativa ao container posicionado.
    c.style.left = (vRect.left - cRect.left + container.scrollLeft) + 'px';
    c.style.top = (vRect.top - cRect.top + container.scrollTop) + 'px';
    c.style.width = vRect.width + 'px';
    c.style.height = vRect.height + 'px';

    // Backing store na resolução do vídeo (limitada) para nitidez sem custo excessivo.
    const w = this.video.videoWidth || Math.round(vRect.width);
    const h = this.video.videoHeight || Math.round(vRect.height);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      if (this.gl) this.gl.viewport(0, 0, w, h);
    }
  }

  // ---- Loop de render ----

  _startLoop() {
    const useRVFC = typeof this.video.requestVideoFrameCallback === 'function';
    if (useRVFC) {
      const cb = () => {
        if (!this.enabled) return;
        this._renderFrame();
        this.rvfcHandle = this.video.requestVideoFrameCallback(cb);
      };
      this.rvfcHandle = this.video.requestVideoFrameCallback(cb);
    } else {
      const cb = () => {
        if (!this.enabled) return;
        this._renderFrame();
        this.rafHandle = requestAnimationFrame(cb);
      };
      this.rafHandle = requestAnimationFrame(cb);
    }
  }

  _stopLoop() {
    if (this.rvfcHandle != null && typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this.rvfcHandle);
    }
    if (this.rafHandle != null) {
      cancelAnimationFrame(this.rafHandle);
    }
    this.rvfcHandle = null;
    this.rafHandle = null;
  }

  _renderFrame() {
    const gl = this.gl;
    if (!gl || this.video.readyState < 2) return;

    const t0 = performance.now();

    try {
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.video);
    } catch (e) {
      // Vídeo virou cross-origin/DRM em runtime (ex.: troca de fonte). Cair pro original.
      console.warn('[PiP Enhancer] texImage2D falhou; desativando realce.', e.name);
      this._emit('blocked', { width: this.video.videoWidth, height: this.video.videoHeight });
      this.disable();
      return;
    }

    gl.uniform1i(this.locations.u_image, 0);
    gl.uniform2f(this.locations.u_texel, 1 / this.canvas.width, 1 / this.canvas.height);
    gl.uniform1f(this.locations.u_intensity, this.intensity);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this._trackPerformance(performance.now() - t0);
  }

  _trackPerformance(frameMs) {
    // FPS por janela de 1s.
    this._frameCount++;
    const now = performance.now();
    if (this._fpsWindowStart === 0) this._fpsWindowStart = now;
    const elapsed = now - this._fpsWindowStart;
    if (elapsed >= 1000) {
      this.fps = (this._frameCount * 1000) / elapsed;
      this._frameCount = 0;
      this._fpsWindowStart = now;
      this._updateBadge();
    }

    // Fallback: orçamento ~33ms (30fps). Frames lentos sustentados reduzem a intensidade.
    if (frameMs > 33) {
      this._slowFrames++;
    } else if (this._slowFrames > 0) {
      this._slowFrames--;
    }

    if (!this._autoReduced && this._slowFrames > 30) {
      if (this.intensity > 0.25) {
        this.intensity = Math.max(0.25, this.intensity - 0.25);
        console.info('[PiP Enhancer] Performance baixa; reduzindo intensidade para', this.intensity);
        this._slowFrames = 0;
      } else {
        // Já no mínimo e ainda lento: desistir e mostrar original.
        console.warn('[PiP Enhancer] Performance insuficiente; exibindo vídeo original.');
        this._emit('slow', { width: this.video.videoWidth, height: this.video.videoHeight });
        this._autoReduced = true;
        this.disable();
      }
    }
  }
}

window.VideoEnhancer = VideoEnhancer;
