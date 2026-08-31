import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

// URL do seu proxy + /contexto. Precisa constar em app.json → permissions →
// network → whitelist (só o domínio, sem o path).
const PROXY_URL = 'https://brasileirao-g2-proxy.onrender.com/contexto'

// Fallbacks. O servidor manda proximaConsultaMs em cada resposta e é ele que
// manda de verdade — esses valores só valem antes da primeira resposta e
// quando a rede cai.
const INTERVALO_PADRAO_MS = 30_000
const INTERVALO_ERRO_MS = 60_000
const CICLO_JOGOS_MS = 8_000

type Jogo = {
  casa: string
  fora: string
  placarCasa: number
  placarFora: number
  minuto: string
  encerrado: boolean
  ultimoLance: string | null
}

type LinhaTabela = { posicao: number; time: string; pontos: number; jogos: number }
type Artilheiro = { nome: string; time: string; gols: number }
type MeuTime = {
  nome: string | null
  posicao: number | null
  pontos: number | null
  jogos: number | null
  saldo: number | null
  proximo: { casa: string; fora: string; data: string | null } | null
  anterior: Jogo | null
}

type Contexto = {
  aoVivo: Jogo[]
  tabela: LinhaTabela[]
  artilharia: Artilheiro[]
  meuTime: MeuTime | null
  proximaConsultaMs?: number
}

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
  content: 'Brasileirão\n\nCarregando...',
  isEventCapture: 1, // toque troca de tela
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

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

type Tela = 'placar' | 'tabela' | 'artilharia' | 'time'

let contexto: Contexto = { aoVivo: [], tabela: [], artilharia: [], meuTime: null }
let tela: Tela = 'placar'
let indiceJogo = 0
let cicloTimer: ReturnType<typeof setInterval> | null = null
let buscaTimer: ReturnType<typeof setTimeout> | null = null

/** Só entram no rodízio as telas que têm dado para mostrar. */
function telasDisponiveis(): Tela[] {
  const telas: Tela[] = ['placar']
  if (contexto.tabela.length > 0) telas.push('tabela')
  if (contexto.artilharia.length > 0) telas.push('artilharia')
  if (contexto.meuTime) telas.push('time')
  return telas
}

function proximaTela() {
  const telas = telasDisponiveis()
  const atual = telas.indexOf(tela)
  tela = telas[(atual + 1) % telas.length]
}

// ---------------------------------------------------------------------------
// Render
//
// O display do G2 é estreito. Cada tela cabe em ~7 linhas curtas; a última
// linha é sempre o rodapé de navegação, para o toque nunca virar adivinhação.
// ---------------------------------------------------------------------------

function escrever(linhas: string[]) {
  bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,
      containerName: 'main',
      content: linhas.join('\n'),
    }),
  )
}

function rodape(): string {
  const telas = telasDisponiveis()
  if (telas.length < 2) return 'Toque para atualizar'
  const posicao = telas.indexOf(tela) + 1
  return `${posicao}/${telas.length} · toque p/ trocar`
}

function renderPlacar() {
  const jogos = contexto.aoVivo

  if (jogos.length === 0) {
    escrever(['Brasileirão', '', 'Nenhum jogo ao vivo', 'agora.', '', rodape()])
    return
  }

  if (indiceJogo >= jogos.length) indiceJogo = 0
  const jogo = jogos[indiceJogo]
  const contador = jogos.length > 1 ? ` (${indiceJogo + 1}/${jogos.length})` : ''

  escrever([
    `${jogo.casa} ${jogo.placarCasa} x ${jogo.placarFora} ${jogo.fora}`,
    `${jogo.minuto}${contador}`,
    '',
    jogo.ultimoLance || 'Sem lances recentes.',
    '',
    rodape(),
  ])
}

function renderTabela() {
  const linhas = contexto.tabela
    .slice(0, 5)
    .map((l) => `${String(l.posicao).padStart(2)}. ${l.time}  ${l.pontos}pts`)

  escrever(['Classificação', '', ...linhas, '', rodape()])
}

function renderArtilharia() {
  const linhas = contexto.artilharia.map((a) => `${a.gols}  ${a.nome} (${a.time})`)
  escrever(['Artilharia', '', ...linhas, '', rodape()])
}

function renderMeuTime() {
  const t = contexto.meuTime
  if (!t) return renderPlacar()

  const linhas = [t.nome || 'Meu time', '']

  if (t.posicao !== null) {
    linhas.push(`${t.posicao}º · ${t.pontos} pts · ${t.jogos} jogos`)
  }
  if (t.anterior) {
    const a = t.anterior
    linhas.push(`Último: ${a.casa} ${a.placarCasa}x${a.placarFora} ${a.fora}`)
  }
  if (t.proximo) {
    linhas.push(`Próximo: ${t.proximo.casa} x ${t.proximo.fora}`)
  }

  linhas.push('', rodape())
  escrever(linhas)
}

function render() {
  switch (tela) {
    case 'tabela':
      return renderTabela()
    case 'artilharia':
      return renderArtilharia()
    case 'time':
      return renderMeuTime()
    default:
      return renderPlacar()
  }
}

// ---------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------

function agendar(ms: number) {
  if (buscaTimer) clearTimeout(buscaTimer)
  buscaTimer = setTimeout(buscar, ms)
}

async function buscar() {
  try {
    const resposta = await fetch(PROXY_URL)
    if (!resposta.ok) {
      escrever(['Brasileirão', '', 'Erro ao buscar dados', `(status ${resposta.status})`])
      agendar(INTERVALO_ERRO_MS)
      return
    }

    const dados: Contexto = await resposta.json()
    contexto = {
      aoVivo: dados.aoVivo || [],
      tabela: dados.tabela || [],
      artilharia: dados.artilharia || [],
      meuTime: dados.meuTime || null,
    }

    // Se a tela em que estamos sumiu (a API não devolveu tabela, por exemplo),
    // volta para o placar em vez de mostrar uma tela vazia.
    if (!telasDisponiveis().includes(tela)) tela = 'placar'

    render()
    // O servidor sabe se tem jogo rolando; ele define o ritmo, não o app.
    agendar(dados.proximaConsultaMs || INTERVALO_PADRAO_MS)
  } catch {
    escrever(['Brasileirão', '', 'Sem conexão com o', 'servidor. Tentando de novo...'])
    agendar(INTERVALO_ERRO_MS)
  }
}

function iniciarCicloJogos() {
  if (cicloTimer) clearInterval(cicloTimer)
  cicloTimer = setInterval(() => {
    // O rodízio automático só faz sentido na tela de placar; nas outras, o
    // usuário está lendo e uma troca sozinha seria só atrapalho.
    if (tela === 'placar' && contexto.aoVivo.length > 1) {
      indiceJogo = (indiceJogo + 1) % contexto.aoVivo.length
      renderPlacar()
    }
  }, CICLO_JOGOS_MS)
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

bridge.onEvenHubEvent((event) => {
  const textEvent = event.textEvent
  if (!textEvent || textEvent.containerID !== 1) return

  switch (textEvent.eventType) {
    case OsEventTypeList.CLICK_EVENT:
    case undefined:
      if (telasDisponiveis().length > 1) {
        proximaTela()
        render()
      } else {
        buscar()
      }
      break

    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      // Obrigatório: modo 1 mostra a confirmação do sistema antes de sair.
      bridge.shutDownPageContainer(1)
      break
  }
})

buscar()
iniciarCicloJogos()
