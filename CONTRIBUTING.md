# Contribuindo com o Universal PiP

Obrigado pelo interesse em contribuir! Este é um projeto pequeno, sem processo burocrático —
algumas orientações para manter tudo organizado.

## Antes de codificar

- Para bugs, abra uma *issue* descrevendo: site onde ocorreu, passos para reproduzir, e (se
  possível) o log relevante do console da página ou do service worker
  (`chrome://extensions` → "service worker" da extensão → aba Console).
- Para funcionalidades novas ou mudanças de arquitetura, abra uma *issue* de discussão antes de
  implementar — evita retrabalho.

## Ambiente de desenvolvimento

Não há passo de build: é JavaScript puro (sem bundler, sem dependências de `npm`).

1. Clone o repositório.
2. Em `chrome://extensions`, ative o **Modo do desenvolvedor** e **Carregue sem compactação**
   apontando para a pasta do repositório.
3. Após qualquer alteração, clique em recarregar (↻) no card da extensão **e** recarregue as
   abas de teste — content scripts só atualizam com a página recarregada.

## Estilo de código

- Sem dependências externas nem frameworks — o projeto é intencionalmente enxuto para rodar bem
  em hardware modesto (GPU integrada).
- Comentários em português, focados no *porquê* de decisões não óbvias (ex.: uma restrição do
  Manifest V3), não no *o quê* o código já deixa claro.
- Prefira reaproveitar os padrões existentes (ex.: `window.__pipEnhance` /
  `window.__pipDownload` para comunicação popup ↔ content script através de iframes) em vez de
  criar um novo mecanismo de mensageria.

## Testando manualmente

Não há suíte de testes automatizada ainda. Ao alterar algo, teste no mínimo:

- Um vídeo local (`<video src="arquivo.mp4">`) para PiP, realce e download.
- Um site com o vídeo dentro de um iframe (ex.: um player embedado).
- Um site com HLS (ex.: uma plataforma de cursos) para o fluxo de download por segmentos.

## Pull Requests

- Um PR por mudança lógica; evite misturar reffactors não relacionados.
- Descreva o que mudou, por quê, e como foi testado.
- Referencie a *issue* relacionada, se houver.
