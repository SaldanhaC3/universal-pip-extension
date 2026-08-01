# Política de Privacidade

A **Universal PiP** não coleta, armazena remotamente ou transmite dados de navegação, vídeos,
credenciais ou qualquer informação pessoal a servidores de terceiros ou do desenvolvedor.

## O que a extensão faz localmente

- **Preferências** (realce ligado/desligado, intensidade) são salvas apenas em
  `chrome.storage` — local ao seu navegador, nunca enviadas a nenhum servidor.
- **Sniffing de rede** (`webRequest`): a extensão observa (sem bloquear nem modificar) URLs de
  requisições feitas pelas próprias abas, exclusivamente para localizar a fonte do vídeo que você
  já está assistindo. Essas URLs ficam em `chrome.storage.session` (memória temporária da sessão
  do navegador) e são descartadas ao fechar a aba ou navegar para outra página.
- **Processamento de vídeo** (realce WebGL e montagem de downloads HLS) acontece inteiramente no
  seu navegador — nenhum frame, segmento ou arquivo de vídeo é enviado para fora do seu
  computador.
- **Downloads** são salvos diretamente no seu disco via a API nativa `chrome.downloads`.

## O que a extensão NÃO faz

- Não usa analytics, telemetria ou rastreadores de terceiros.
- Não injeta anúncios nem afiliados.
- Não vende, compartilha ou monetiza dados de navegação.

## Permissões

Veja a seção [Permissões e por que cada uma existe](README.md#permissões-e-por-que-cada-uma-existe)
no README para o detalhamento de cada permissão solicitada no `manifest.json`.

## Contato

Dúvidas sobre privacidade podem ser abertas como *issue* neste repositório.
