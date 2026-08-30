import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

// Troque pela URL do seu proxy depois do deploy (ver server/index.js).
// Precisa constar em app.json → permissions → network → whitelist.
const PROXY_URL = https://brasileirao-g2-proxy.onrender.com/jogos-ao-vivo
const REFRESH_MS = 30_000
const CYCLE_MS = 8_000 // troca de jogo automaticamente se houver mais de um

const bridge = await waitForEvenAppBridge()

const mainText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 1,
  containerName: 'main',
  content: 'Brasileirão\n\nCarregando jogos...',
  isEventCapture: 1, // tap avança pro próximo jogo manualmente
})

const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [mainText],
  }),
)

if (result !== 0) {
  console.error('createStartUpPageContainer failed:', result)
}

type Jogo = {
  casa: string
  fora: string
  placarCasa: number
  placarFora: number
  minuto: string
  encerrado: boolean
  ultimoLance: string | null
}

let jogos: Jogo[] = []
let indiceAtual = 0
let cycleTimer: ReturnType<typeof setInterval> | null = null

function renderJogo() {
  if (jogos.length === 0) {
    atualizarTexto('Brasileirão\n\nNenhum jogo ao vivo\nagora.')
    return
  }

  const jogo = jogos[indiceAtual]
  const linhas = [
    `${jogo.casa} ${jogo.placarCasa} x ${jogo.placarFora} ${jogo.fora}`,
    jogo.minuto,
    '',
    jogo.ultimoLance || 'Sem lances recentes.',
    '',
    jogos.length > 1 ? `Jogo ${indiceAtual + 1}/${jogos.length} · toque p/ trocar` : 'Toque para atualizar',
  ]
  atualizarTexto(linhas.join('\n'))
}

function atualizarTexto(content: string) {
  bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,
      containerName: 'main',
      content,
    }),
  )
}

async function buscarJogos() {
  try {
    const resposta = await fetch(PROXY_URL)
    if (!resposta.ok) {
      atualizarTexto(`Brasileirão\n\nErro ao buscar jogos\n(status ${resposta.status})`)
      return
    }
    const dados = await resposta.json()
    jogos = dados.jogos || []
    if (indiceAtual >= jogos.length) indiceAtual = 0
    renderJogo()
  } catch (err) {
    atualizarTexto('Brasileirão\n\nSem conexão com o\nservidor. Tentando de novo...')
  }
}

function iniciarCiclo() {
  if (cycleTimer) clearInterval(cycleTimer)
  cycleTimer = setInterval(() => {
    if (jogos.length > 1) {
      indiceAtual = (indiceAtual + 1) % jogos.length
      renderJogo()
    }
  }, CYCLE_MS)
}

bridge.onEvenHubEvent((event) => {
  const textEvent = event.textEvent
  if (!textEvent || textEvent.containerID !== 1) return

  switch (textEvent.eventType) {
    case OsEventTypeList.CLICK_EVENT:
    case undefined:
      if (jogos.length > 1) {
        indiceAtual = (indiceAtual + 1) % jogos.length
        renderJogo()
      } else {
        buscarJogos()
      }
      break

    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      // Obrigatório: modo 1 mostra a confirmação do sistema antes de sair.
      bridge.shutDownPageContainer(1)
      break
  }
})

buscarJogos()
setInterval(buscarJogos, REFRESH_MS)
iniciarCiclo()
