# Universal PiP

Extensão para Chrome/Brave/Edge (Manifest V3) que adiciona três recursos a **qualquer** vídeo em
**qualquer** site: Picture-in-Picture universal, realce de imagem em tempo real (nitidez/contraste
via WebGL) e download do vídeo em reprodução.

Não depende de suporte nativo do site — funciona detectando o elemento `<video>` diretamente na
página, inclusive dentro de iframes e Shadow DOM.

---

## Sumário

- [Recursos](#recursos)
- [Instalação](#instalação)
- [Como usar](#como-usar)
- [Permissões e por que cada uma existe](#permissões-e-por-que-cada-uma-existe)
- [Arquitetura](#arquitetura)
- [Limitações conhecidas](#limitações-conhecidas)
- [Aviso legal sobre o download de vídeos](#aviso-legal-sobre-o-download-de-vídeos)
- [Contribuindo](#contribuindo)
- [Licença](#licença)

---

## Recursos

### 1. Picture-in-Picture universal
Ativa o modo PiP nativo do navegador em vídeos de sites que tentam bloquear esse recurso
(atributo `disablePictureInPicture`, política `Permissions-Policy`, etc.). Atalho `Alt+P`
(Windows/Linux) ou `MacCtrl+P` (Mac), botão flutuante no vídeo, ou pelo popup da extensão.

### 2. Realce de vídeo em tempo real (WebGL)
Aplica, via shader GLSL, um *unsharp mask* + ajuste leve de contraste e saturação sobre o vídeo,
melhorando a nitidez percebida de conteúdo em baixa resolução (ex.: 360p–720p) **sem** upscaling
por IA — leve o suficiente para rodar em notebooks com GPU integrada.

- Liga/desliga por vídeo (botão flutuante ✦) ou globalmente (popup, com slider de intensidade).
- Pula automaticamente vídeos já em ≥1080p (não há ganho perceptível).
- Detecta vídeos protegidos por DRM/CORS e mantém o vídeo original sem travar a reprodução.
- Fallback de performance: se o navegador não conseguir sustentar a taxa de quadros, a
  intensidade do efeito é reduzida automaticamente e, em último caso, o realce é desligado.
- Feedback visual: badge sobre o vídeo mostrando resolução/FPS em tempo real, além de toasts de
  status na página e indicador de FPS no popup.

### 3. Download de vídeo
Baixa o vídeo que está sendo exibido — inclusive Reels, Stories e a maioria dos players com MP4
progressivo. Suporta dois caminhos:

- **Arquivo direto (MP4/WebM):** detectado a partir do próprio elemento `<video>` em foco — baixa
  exatamente o vídeo que você está vendo, mesmo em páginas com dezenas de vídeos na tela.
- **HLS (`.m3u8`):** a extensão localiza a playlist, resolve a variante de maior qualidade, baixa
  e remonta os segmentos `.ts` (decriptando `AES-128` via WebCrypto quando aplicável) num único
  arquivo reproduzível em qualquer player (VLC, etc.).

O popup mostra miniaturas de todos os vídeos detectados na página para você escolher qual baixar,
e um botão flutuante (⬇) aparece diretamente sobre cada vídeo.

---

## Instalação

Esta extensão ainda não está publicada na Chrome Web Store — instale manualmente ("modo
desenvolvedor"):

1. Baixe/clone este repositório.
2. Abra `chrome://extensions` (funciona também em `brave://extensions` e `edge://extensions`).
3. Ative o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e selecione a pasta do repositório.
5. Fixe o ícone da extensão na barra de ferramentas para acesso rápido.

Após qualquer alteração no código, clique no botão de recarregar (↻) do card da extensão em
`chrome://extensions` e recarregue as abas abertas.

---

## Como usar

Passe o mouse sobre qualquer vídeo da página: três botões flutuantes aparecem no canto superior
direito — **⧉** (PiP), **✦** (realce) e **⬇** (download). Ou abra o popup da extensão (clique no
ícone) para:

- Ativar o PiP no vídeo em reprodução.
- Ligar o realce globalmente e ajustar a intensidade com o slider (acompanhe o FPS ao vivo).
- Ver miniaturas dos vídeos detectados na página e baixar o que escolher.

---

## Permissões e por que cada uma existe

| Permissão | Uso |
|---|---|
| `activeTab` / `scripting` | Rodar o content script e consultar o estado da página a partir do popup. |
| `storage` | Persistir preferências (realce ligado/desligado, intensidade) entre sessões. |
| `declarativeNetRequest(WithHostAccess)` | Remover cabeçalhos `Permissions-Policy` que alguns sites usam para bloquear PiP. |
| `webRequest` | Observar (sem bloquear) requisições de rede para localizar playlists HLS/arquivos de vídeo, inclusive dentro de iframes. |
| `downloads` | Salvar o arquivo de vídeo montado no disco do usuário. |
| `offscreen` | Montar o arquivo de vídeo (decodificar/concatenar segmentos HLS) fora do service worker, que não tem acesso a `URL.createObjectURL` nem DOM. |
| `host_permissions: <all_urls>` | Os três recursos precisam funcionar em qualquer site — inclui o `fetch` cross-origin dos segmentos de vídeo. |

A extensão **não envia dados a nenhum servidor externo**: todo o processamento (shader WebGL,
sniffing de rede, montagem de arquivos) acontece localmente, no navegador do usuário.

---

## Arquitetura

```
universal-pip-extension/
├── manifest.json          # Manifest V3: permissões, content scripts, comandos
├── background.js          # Service worker: sniffing de rede, orquestração de downloads
├── contentScript.js        # Detecção de vídeos, botões flutuantes, PiP, toasts de feedback
├── offscreen.html/.js      # Documento offscreen: motor de montagem de HLS (fetch + WebCrypto)
├── popup.html/.js/.css     # UI da extensão: toggle de PiP, controles de realce, download
├── rules.json              # Regra do declarativeNetRequest (remove Permissions-Policy restritiva)
└── utils/
    ├── earlyInjection.js   # Roda em document_start: neutraliza bloqueios de PiP antes da página
    ├── videoDetector.js    # Varre o DOM/Shadow DOM em busca de <video>, observa mutações
    └── videoEnhancer.js    # Pipeline WebGL do realce (shader, loop de render, fallback de perf)
```

**Fluxo do realce:** `videoDetector.js` encontra o vídeo → `videoEnhancer.js` cria um `<canvas>`
WebGL posicionado sobre o vídeo, copia cada frame via `texImage2D` (usando
`requestVideoFrameCallback` para sincronia) e aplica o shader de nitidez/contraste/saturação.

**Fluxo do download:** o content script identifica a fonte do vídeo em foco (`currentSrc`). Se for
um arquivo direto, o `background.js` aciona `chrome.downloads` imediatamente. Se for HLS, o
`background.js` sobe um documento `offscreen` que baixa a playlist, resolve os segmentos,
decripta (quando necessário) e concatena tudo num `Blob`, devolvendo um `objectURL` para o
download final.

---

## Limitações conhecidas

- **DRM (Widevine/SAMPLE-AES):** detectado e recusado com aviso claro — não há como decriptar
  conteúdo protegido por hardware DRM.
- **DASH (`.mpd`):** ainda não suportado (comum no feed principal do Facebook/Instagram, entre
  outros). É detectado e reportado como "formato não suportado" em vez de falhar silenciosamente.
- **Saída do HLS é `.ts`, não `.mp4`:** o arquivo é uma cópia fiel dos segmentos, reproduzível em
  VLC e na maioria dos players, mas sem remuxagem para `.mp4` (isso exigiria embutir um
  transcoder como `ffmpeg.wasm`, avaliado para uma fase futura).
- **Performance do realce** depende da GPU disponível; em hardware muito limitado o fallback
  automático reduz a intensidade ou desliga o efeito para não travar a reprodução.

---

## Aviso legal sobre o download de vídeos

O recurso de download foi criado para uso pessoal em conteúdo ao qual você **já tem acesso
legítimo** (aulas de cursos que você comprou, seus próprios vídeos, material de domínio público
etc.). Baixar conteúdo protegido por direitos autorais sem autorização pode violar os Termos de
Serviço da plataforma e a legislação de direitos autorais aplicável. O uso desta funcionalidade é
de inteira responsabilidade de quem a utiliza.

---

## Contribuindo

Contribuições são bem-vindas. Para propor uma mudança:

1. Abra uma *issue* descrevendo o problema ou a ideia antes de codificar algo grande.
2. Faça um fork, crie uma branch descritiva (`feat/...`, `fix/...`).
3. Teste manualmente carregando a extensão sem compactação (não há suíte de testes automatizada
   ainda) antes de abrir o Pull Request.
4. Descreva no PR o que mudou e como testar.

## Licença

Distribuído sob a [licença MIT](LICENSE).

---

<sub>by: SaldanhaC3, (Gabriel Saldanha) · <a href="https://www.linkedin.com/in/luizgabrielsaldanha/">LinkedIn</a></sub>
