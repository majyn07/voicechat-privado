# VoiceChat privado

App de voz/video/tela para voce e seus amigos, feito para substituir o Discord
nas funcoes que foram banidas na sua conta (compartilhamento de tela e camera).

- **Voz, camera e compartilhamento de tela**: conexao direta (P2P/WebRTC) entre
  os participantes. O audio/video **nao passa pelo servidor** — o servidor so
  ajuda os PCs a se encontrarem (sinalizacao) e retransmite o chat de texto.
- **Canais, igual Discord**: o grupo comeca com um canal "Geral" e qualquer
  um pode criar outros (botao **+** na barra lateral). Cada canal e um
  espaco de voz+texto+video independente; trocar de canal reconecta a
  chamada automaticamente.
- **Mensagens/chamada privada**: clique no botao 💬 (ou "Privado") ao lado
  do nome de alguem pra abrir uma conversa 1-a-1, isolada dos outros
  canais. Aparece em "Conversas privadas" na barra lateral.
- **Entrada simples**: so nome + senha do grupo — sem precisar digitar nome
  de sala. Quem usa a mesma senha cai automaticamente no mesmo grupo.
- **Modo destaque (igual Discord)**: clique na tela/camera de alguem pra
  focar em tela cheia, com os demais virando miniaturas clicaveis embaixo.
  Tem botao de tela cheia de verdade tambem.
- **Chat somente texto**, sem upload de imagem/video (como pedido).
- **Configuracoes de audio avancadas**: escolha de microfone/alto-falante/camera,
  cancelamento de eco, supressao de ruido, controle automatico de ganho, ganho
  de entrada (boost do mic), medidor de nivel do microfone, volume individual
  por pessoa, modo "ativado por voz" (com sensibilidade ajustavel), modo
  "push-to-talk" (com tecla configuravel) e atalho global para mutar/desmutar
  mesmo com o app em segundo plano.
- **Sons de interface** ao mutar/desmutar, ensurdecer/desensurdecer e
  ligar/parar camera e tela.
- **Atualizacao automatica**: a partir da v1.1.0, o app verifica sozinho se
  ha uma versao nova (via GitHub Releases) e baixa em segundo plano; um aviso
  aparece no canto da tela quando estiver pronta para reiniciar e aplicar.
- Ate ~8 pessoas por sala (pensado para 3), sem limite de tempo de chamada.

## Baixar o instalador

O instalador mais recente (`VoiceChat Setup 1.2.0.exe`) fica versionado na
pasta [`installer/`](installer) deste repositorio. Ao baixar o repositorio
inteiro como ZIP (botao verde **Code** -> **Download ZIP** no GitHub), o
instalador ja vem junto. Basta extrair o ZIP e rodar o `.exe`.

> A partir dessa versao, instalacoes futuras se atualizam sozinhas — so
> precisa reinstalar manualmente quem ainda estiver numa versao anterior a
> v1.1.0 (sem o auto-update).

## Como funciona

```
voicechat/
  server/   -> servidor de sinalizacao (Node + Socket.IO), hospedado de graca
  app/      -> aplicativo desktop (Electron) que voce e seus amigos instalam
```

O `server` fica online (ex: Render free tier) so para os 3 PCs trocarem os
dados necessarios para abrir a conexao direta (WebRTC signaling) e para
retransmitir mensagens de chat. Ele nao processa nem armazena audio/video.

## 1. Servidor de sinalizacao — ja esta no ar ✅

Codigo publicado em **https://github.com/majyn07/voicechat-privado** (repo
privado) e implantado no Render (plano Free) via Blueprint (`render.yaml` na
raiz, que aponta pra pasta `server/`).

- **URL do servidor:** `https://voicechat-signaling.onrender.com`
- Ja vem preenchida por padrao no campo "Servidor de sinalizacao" do app —
  ninguem precisa digitar nada.
- Painel do servico: https://dashboard.render.com (workspace da conta
  `majyn07`, servico `voicechat-signaling`).

Qualquer atualizacao no `server/index.js` que voce enviar pra branch `master`
do repositorio (`git push`) reimplanta automaticamente no Render.

> Caso precise recriar do zero em outra conta: **New +** -> **Blueprint** ->
> conectar o repositorio -> o Render le o `render.yaml` sozinho e propoe o
> servico `voicechat-signaling` no plano Free.

> Alternativas gratuitas equivalentes: Fly.io, Railway, Cyclic, Glitch. O
> `server/index.js` e um servidor Node comum, funciona em qualquer um deles.

> **Nota sobre o plano free do Render:** ele "dorme" depois de ~15 min sem uso
> e demora ~30s para acordar na proxima conexao. Isso so afeta a entrada na
> sala, nunca a chamada em si (que e P2P).

### Rodar o servidor localmente (opcional, para testes)

```bash
cd voicechat/server
npm install
npm start
```

Ele sobe em `http://localhost:3000`.

## 2. Instalar o app (voce e seus 2 amigos)

Cada pessoa precisa ter o app rodando no Windows. Duas formas:

### Opcao A — gerar um instalador `.exe` para distribuir

```bash
cd voicechat/app
npm install
npm run dist
```

Isso cria um instalador em `voicechat/app/dist/`. Envie esse `.exe` para os
seus amigos (ex: por um link de download qualquer, ou pendrive).

### Opcao B — rodar direto do codigo (bom para voce testar agora)

```bash
cd voicechat/app
npm install
npm start
```

## 3. Entrando no grupo

Na tela inicial, cada um preenche so duas coisas:

- **Senha do grupo**: uma senha combinada entre voces (e a propria identidade
  do grupo — todo mundo que usar a mesma senha cai automaticamente junto;
  protege pra gente de fora nao entrar, ja que o servidor fica publico)
- **Seu nome**: como vai aparecer para os outros

(O servidor ja vem pre-configurado; so mexa em "Avancado" se for usar um
servidor proprio.)

Depois de entrar, voce cai automaticamente no canal **Geral**. Use a barra
lateral pra criar outros canais, trocar de canal, ou clicar em alguem pra
conversar em particular.

## Limitacoes conhecidas

- **Canais e conversas privadas nao persistem** — vivem so na memoria do
  servidor. Se o servidor reiniciar (ex: plano free dormindo por muito
  tempo) ou todo mundo do grupo desconectar, os canais criados (alem do
  "Geral") e o historico de mensagens somem. Nao ha banco de dados.
- A conexao P2P usa STUN publico (Google) e TURN publico (Open Relay
  Project) como fallback quando a conexao direta nao consegue atravessar o
  NAT. Na lista de membros, o texto embaixo do nome de cada pessoa mostra o
  estado real da conexao ("conectando...", "conectado · recebendo audio",
  "falha na conexao" etc) — use isso pra diagnosticar problema de audio/video.
- Compartilhar audio do sistema junto com a tela depende do Windows/driver;
  se nao funcionar, desmarque a opcao nas configuracoes e o compartilhamento
  de video continua normal.
- Push-to-talk "segurar tecla" so funciona com o app em foco. O atalho global
  (mutar/desmutar) funciona com o app em segundo plano.
