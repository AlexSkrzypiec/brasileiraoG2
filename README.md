# Brasileirão Ao Vivo — Even G2

Duas partes:

- `server/` — proxy Node que guarda sua chave da API Futebol e resolve o problema de CORS.
- `app/` — o app do Even G2 em si (Vite + SDK do Even Hub).

---

## Parte 1 — Deploy do proxy

### Opção A: Render (mais simples)

1. Crie um repositório no GitHub e suba a pasta `brasileirao-g2` inteira (o
   `render.yaml` na raiz já descreve o serviço).
2. Em [render.com](https://render.com), clique **New → Blueprint** e aponte
   pro seu repositório. O Render lê o `render.yaml` sozinho e já configura
   `rootDir: server`, build e start.
3. Quando pedir a variável `API_FUTEBOL_KEY`, cole sua chave da API Futebol
   (a mesma do painel `dash.api-futebol.com.br`).
4. Aguarde o deploy. Você recebe uma URL tipo
   `https://brasileirao-g2-proxy.onrender.com`.
5. Teste no navegador: `https://brasileirao-g2-proxy.onrender.com/jogos-ao-vivo`
   deve devolver um JSON com a lista de jogos (ou `{"jogos": []}` se não
   houver partida ao vivo agora).

Detalhe do plano free do Render: o serviço "dorme" depois de um tempo sem
tráfego e leva alguns segundos pra acordar na primeira chamada seguinte —
sem problema pro seu uso, só espere isso no primeiro fetch depois de um tempo
parado.

### Opção B: Railway

1. Em [railway.app](https://railway.app), **New Project → Deploy from GitHub repo**,
   selecione o mesmo repositório.
2. Em **Settings → Root Directory**, defina `server`.
3. Em **Variables**, adicione `API_FUTEBOL_KEY` com sua chave.
4. O Railway detecta o `package.json` e usa `npm start` automaticamente.
5. Em **Settings → Networking**, gere um domínio público — você recebe algo
   como `https://brasileirao-g2-proxy.up.railway.app`.

Railway não dorme no plano pago, mas o free tier tem um limite de horas por
mês — para um app pessoal como este, qualquer um dos dois resolve.

---

## Parte 2 — Ligar o app do G2 ao proxy

Com a URL pública em mãos (de qualquer uma das opções acima):

1. Em `app/src/main.ts`, troque:
   ```ts
   const PROXY_URL = 'https://SEU-PROXY.exemplo.com/jogos-ao-vivo'
   ```
   pela sua URL real + `/jogos-ao-vivo`.

2. Em `app/app.json`, troque o mesmo domínio (sem o path) dentro de:
   ```json
   "whitelist": ["https://SEU-PROXY.exemplo.com"]
   ```

---

## Parte 3 — Rodar no simulador

```bash
cd app
npm install
npm run dev
```

Em outro terminal:
```bash
evenhub-simulator http://localhost:5173
```

Você deve ver o placar carregando do seu proxy já publicado.

---

## Parte 4 — Rodar no G2 de verdade

Com o celular na mesma rede Wi-Fi do computador:

```bash
# descobrir seu IP local
ipconfig getifaddr en0        # macOS Wi-Fi
hostname -I | awk '{print $1}'  # Linux

# gerar o QR apontando pro Vite local
evenhub qr --url "http://SEU-IP-LOCAL:5173"
```

Escaneie o QR pelo app Even Realities (com Modo Desenvolvedor ativado e o
botão **Scan QR** visível). O app carrega nos óculos e já busca os dados do
seu proxy publicado — o Vite local só serve o front-end, quem responde os
dados é a URL pública que você configurou na Parte 2.

---

## Como funciona

- O óculos chama só o seu proxy (`/jogos-ao-vivo`), nunca a API Futebol
  diretamente — isso evita o bloqueio de CORS que a API Futebol não resolve
  para chamadas de navegador/WebView.
- O proxy busca `/ao-vivo` na API Futebol a cada requisição, filtra pelo
  Brasileirão Série A e devolve um JSON já resumido.
- O app no G2 atualiza o placar a cada 30s e troca de jogo automaticamente
  a cada 8s (ou no toque, se houver mais de uma partida ao vivo).
- Duplo toque mostra a confirmação de saída do sistema — obrigatório pela
  QA do Even Hub em apps de página raiz.
