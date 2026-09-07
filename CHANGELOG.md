# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [1.2.1]

### Corrigido
- Download no YouTube: o player usa DASH via MSE e o `<video>` só expõe um `blob:`, o que
  antes não baixava nada útil. Agora um script em `world: MAIN` lê `ytInitialPlayerResponse`
  e extrai as URLs progressivas (áudio+vídeo combinados) do player, que são baixadas como
  arquivo único. Suporta as qualidades progressivas disponíveis (tipicamente até ~720p).

## [1.2.0]

### Melhorado
- Código mais enxuto: os três botões flutuantes (PiP, realce, download) agora são criados por
  uma única função `createFloatingButton`, eliminando a triplicação de lógica de posicionamento
  e exibição ao passar o mouse.
- Removido código morto: listener `action.onClicked` sem efeito (o popup já está definido) e uma
  chamada redundante de detecção de DRM antes de ativar o PiP.
- Ícone redesenhado em vetor (gradiente azul + glifo de Picture-in-Picture), com script
  `icons/generate_icons.py` para regenerar os PNGs em qualquer tamanho.

## [1.1.0]

### Adicionado
- Realce de vídeo em tempo real via WebGL (unsharp mask + contraste + saturação), com botão por
  vídeo, toggle/slider globais no popup, badge de status sobre o vídeo e indicador de FPS.
- Fallback automático de performance e detecção de DRM/CORS no realce, mantendo o vídeo original
  quando o processamento não é seguro ou viável.
- Download de vídeo: detecção da fonte pelo `<video>` em foco, suporte a MP4/WebM direto e a HLS
  (montagem de segmentos + decriptação AES-128 via WebCrypto em um documento offscreen).
- Miniaturas dos vídeos detectados no popup para escolher qual baixar.
- Botão flutuante de download (⬇) sobre cada vídeo, ao lado dos botões de PiP e realce.
- Sincronização do realce com o Picture-in-Picture: o overlay é ocultado ao entrar em PiP para
  não duplicar a reprodução na página.

## [1.0.0]

### Adicionado
- Picture-in-Picture universal com contorno de bloqueios comuns (`disablePictureInPicture`,
  políticas `Permissions-Policy`).
- Detecção de vídeos via DOM/Shadow DOM com `MutationObserver`, inclusive em iframes.
- Popup com contagem de vídeos detectados e atalho `Alt+P` / `MacCtrl+P`.
