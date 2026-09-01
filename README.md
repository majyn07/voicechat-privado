# VoiceChat privado

App de voz/video/tela para voce e seus amigos, feito para substituir o Discord
nas funcoes que foram banidas na sua conta (compartilhamento de tela e camera).

- **Voz, camera e compartilhamento de tela**: conexao direta (P2P/WebRTC) entre
  os participantes. O audio/video **nao passa pelo servidor** — o servidor so
  ajuda os PCs a se encontrarem (sinalizacao) e retransmite o chat de texto.
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

O instalador mais recente (`VoiceChat Setup 1.1.7.exe`) fica versionado na
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

## 3. Entrando na sala

Na tela inicial, cada um preenche (o campo do servidor ja vem pronto):

- **Servidor de sinalizacao**: ja preenchido com `voicechat-signaling.onrender.com`
- **Sala**: um nome combinado entre voces (ex: `trio-da-pesada`)
- **Senha da sala**: uma senha combinada (protege para gente de fora nao entrar,
  ja que o servidor fica publico na internet)
- **Seu nome**: como vai aparecer para os outros

Quem entrar primeiro "cria" a sala com aquela senha; os proximos precisam usar
a mesma sala + senha.

## Limitacoes conhecidas

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
