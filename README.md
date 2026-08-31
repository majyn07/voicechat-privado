# VoiceChat privado

App de voz/video/tela para voce e seus amigos, feito para substituir o Discord
nas funcoes que foram banidas na sua conta (compartilhamento de tela e camera).

- **Voz, camera e compartilhamento de tela**: conexao direta (P2P/WebRTC) entre
  os participantes. O audio/video **nao passa pelo servidor** — o servidor so
  ajuda os PCs a se encontrarem (sinalizacao) e retransmite o chat de texto.
- **Chat somente texto**, sem upload de imagem/video (como pedido).
- **Configuracoes de audio avancadas**: escolha de microfone/alto-falante/camera,
  cancelamento de eco, supressao de ruido, controle automatico de ganho, ganho
  de entrada (boost do mic), medidor de nivel do microfone, volume individual
  por pessoa, modo "ativado por voz" (com sensibilidade ajustavel), modo
  "push-to-talk" (com tecla configuravel) e atalho global para mutar/desmutar
  mesmo com o app em segundo plano.
- Ate ~8 pessoas por sala (pensado para 3), sem limite de tempo de chamada.

## Como funciona

```
voicechat/
  server/   -> servidor de sinalizacao (Node + Socket.IO), hospedado de graca
  app/      -> aplicativo desktop (Electron) que voce e seus amigos instalam
```

O `server` fica online (ex: Render free tier) so para os 3 PCs trocarem os
dados necessarios para abrir a conexao direta (WebRTC signaling) e para
retransmitir mensagens de chat. Ele nao processa nem armazena audio/video.

## 1. Subir o servidor de sinalizacao (gratis)

Voce so precisa fazer isso **uma vez**; depois os 3 usam o mesmo endereco.

O codigo ja esta no GitHub em **https://github.com/majyn07/voicechat-privado** (repositorio privado), com um
`render.yaml` na raiz configurado para o Render usar automaticamente a pasta
`server/`.

1. Va em [render.com](https://render.com) e crie sua conta (pode ser com o
   mesmo login do GitHub, e mais rapido).
2. Clique em **New +** -> **Blueprint**.
3. Autorize o Render a acessar o GitHub e selecione o repositorio
   **https://github.com/majyn07/voicechat-privado**.
4. O Render vai ler o `render.yaml` sozinho e propor o servico
   `voicechat-signaling` no plano Free — so clicar em **Apply**/**Deploy**.
5. Depois do deploy, o Render te da uma URL tipo
   `https://voicechat-signaling.onrender.com` — essa e a URL que voces vao
   usar no campo "Servidor de sinalizacao" do app.

> Se preferir nao usar Blueprint, da pra fazer manualmente: **New +** ->
> **Web Service** -> selecione o repositorio -> em **Root Directory** coloque
> `server` -> Build Command `npm install` -> Start Command `npm start` ->
> Plan Free.

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

Na tela inicial, cada um preenche:

- **Servidor de sinalizacao**: a URL do Render (ex: `voicechat-signaling.onrender.com`)
- **Sala**: um nome combinado entre voces (ex: `trio-da-pesada`)
- **Senha da sala**: uma senha combinada (protege para gente de fora nao entrar,
  ja que o servidor fica publico na internet)
- **Seu nome**: como vai aparecer para os outros

Quem entrar primeiro "cria" a sala com aquela senha; os proximos precisam usar
a mesma sala + senha.

## Limitacoes conhecidas

- A conexao P2P usa apenas um servidor STUN publico (Google) para atravessar
  NAT. Funciona bem na grande maioria das redes residenciais/4G. Em redes
  corporativas com firewall muito restritivo, pode ser necessario um servidor
  TURN (posso adicionar depois se algum de voces tiver problema para conectar).
- Compartilhar audio do sistema junto com a tela depende do Windows/driver;
  se nao funcionar, desmarque a opcao nas configuracoes e o compartilhamento
  de video continua normal.
- Push-to-talk "segurar tecla" so funciona com o app em foco. O atalho global
  (mutar/desmutar) funciona com o app em segundo plano.
