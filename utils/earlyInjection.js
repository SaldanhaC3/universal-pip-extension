// earlyInjection.js
// Roda em 'document_start', garantindo interceptação antes do script primário da página host

try {
  // Ocultar a propriedade para os sites não a utilizarem como bloqueador
  Object.defineProperty(HTMLVideoElement.prototype, 'disablePictureInPicture', {
    enumerable: true,
    configurable: true,
    get: function() {
      return false; // Sempre falsifica o estado como desbloqueado
    },
    set: function(val) {
      console.log('[PiP Unlocker] Tentativa de bloquearem o PiP ignorada via Setter');
      return true;
    }
  });

  // Também interceptar explicitamente a invocação
  const originalRequestPiP = HTMLVideoElement.prototype.requestPictureInPicture;
  if (originalRequestPiP) {
    HTMLVideoElement.prototype.requestPictureInPicture = function() {
      // Remove no escopo deste objeto específico, caso atributos via DOM tenham sido plantados via script
      this.removeAttribute('disablePictureInPicture');
      
      // Aplicamos o apply pra chamar no contexto da promessa
      return originalRequestPiP.apply(this, arguments);
    };
  }

  // Interceptar tentativas de bloqueio via Policies via META
  const observer = new MutationObserver((mutations) => {
    for (let mutation of mutations) {
      for (let node of mutation.addedNodes) {
        if (node.nodeName === 'META') {
          if (node.getAttribute('http-equiv') === 'Permissions-Policy') {
            const content = node.getAttribute('content') || '';
            if (content.includes('picture-in-picture')) {
              console.log('[PiP Unlocker] Removendo node "Permissions-Policy" restritiva interceptado no nascimento');
              node.remove();
            }
          }
        }
      }
    }
  });

  observer.observe(document.documentElement || document, {
    childList: true,
    subtree: true
  });
  
  // Como estamos em document_start, head/body podem ainda não existir completamente,
  // O MutationObserver garante que pegamos assim que a tag é injetada.
} catch (err) {
  console.log('[PiP Unlocker] Injeção precoce bypassou um erro de compatibilidade:', err);
}
