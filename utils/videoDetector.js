class VideoScanner {
  constructor() {
    this.videos = new Set();
    this.observer = null;
    this.debounceTimeout = null;
    this.onVideoFoundCb = null;
  }

  onVideoFound(cb) {
    this.onVideoFoundCb = cb;
  }

  scan() {
    this.findVideos(document.body);
    this.observeMutations();
  }

  findVideos(root) {
    if (!root) return;
    
    const videos = [];
    
    // Função recursiva para varrer o DOM e o Shadow DOM
    const traverse = (node) => {
      // Registrar vídeos
      if (node.nodeName === 'VIDEO') {
        videos.push(node);
      }
      
      // Mergulhar no Shadow DOM
      if (node.shadowRoot) {
        traverse(node.shadowRoot);
      }
      
      // Filhos convencionais do nó (se houver)
      if (node.childNodes && node.childNodes.length > 0) {
        node.childNodes.forEach(traverse);
      }
    };
    
    traverse(root);
    
    videos.forEach(v => this.addVideo(v));
  }

  addVideo(video) {
    if (!this.videos.has(video)) {
      this.videos.add(video);
      if (this.onVideoFoundCb) {
        this.onVideoFoundCb(video);
      }
    }
  }

  debounce(func, wait) {
    return (...args) => {
      clearTimeout(this.debounceTimeout);
      this.debounceTimeout = setTimeout(() => func(...args), wait);
    };
  }

  observeMutations() {
    const debouncedScan = this.debounce((mutations) => {
      // Podemos otimizar checando apenas dentro dos nós adicionados
      // mas `findVideos(document.body)` cobre tudo de forma segura.
      // Para melhorar performance:
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          this.findVideos(node);
        });
      });
    }, 100);

    this.observer = new MutationObserver(debouncedScan);
    
    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
  
  getVideos() {
    // Filtrar vídeos que ainda estão no DOM document
    const activeVideos = Array.from(this.videos).filter(v => v.isConnected);
    this.videos = new Set(activeVideos);
    return activeVideos;
  }
}

// Tornando acessível para o contentScript
window.VideoScanner = VideoScanner;
