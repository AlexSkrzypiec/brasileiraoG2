// Proxy do app Brasileirão Ao Vivo (Even G2).
//
// Por quê isso existe: o WebView dos óculos chama fetch() como qualquer
// navegador. Se a API Futebol não devolver cabeçalhos CORS liberando seu
// domínio, a chamada falha do mesmo jeito que falharia no navegador — o
// whitelist de rede do app.json é uma permissão do lado do Even, não um
// bypass de CORS. Este servidor guarda a chave, faz as chamadas do lado do
// servidor e devolve UMA resposta já pronta para a tela do G2.
//
// O que mudou em relação à versão anterior:
//   - cache por endpoint, com TTL diferente para cada tipo de dado;
//   - último lance de verdade (o /ao-vivo é um resumo e não traz eventos;
//     os eventos vêm de /partidas/{id});
//   - tabela, artilharia e próximo/último jogo do seu time;
//   - rota única /contexto, para o óculos gastar 1 requisição por ciclo;
//   - o servidor diz ao cliente quando voltar (proximaConsultaMs), então
//     fora de jogo o app para de acordar de 30 em 30 segundos.

import express from 'express'
import cors from 'cors'

const app = express()
const PORT = process.env.PORT || 3000

const API_KEY = process.env.API_FUTEBOL_KEY
const BASE = 'https://api.api-futebol.com.br/v1'

// Brasileirão Série A = 10. Troque via env se quiser outro campeonato.
const CAMPEONATO_ID = Number(process.env.CAMPEONATO_ID || 10)
// Opcional: o time que você acompanha, para a tela "meu time".
// Descubra o id em GET /v1/campeonatos/10/tabela (campo time.time_id).
const TIME_ID = process.env.TIME_ID ? Number(process.env.TIME_ID) : null
// Opcional: teto diário de requisições à API Futebol (0 = sem trava).
// Veja o limite do seu plano em GET /v1/me.
const LIMITE_DIARIO = Number(process.env.LIMITE_DIARIO || 0)
// Quantas partidas ao vivo buscamos em detalhe por ciclo. Cada uma custa
// 1 requisição extra; 3 cobre bem uma rodada de domingo.
const MAX_DETALHES = Number(process.env.MAX_DETALHES || 3)

if (!API_KEY) {
  console.error('Defina API_FUTEBOL_KEY nas variáveis de ambiente antes de rodar.')
  process.exit(1)
}

if (API_KEY.startsWith('test_')) {
  console.warn(
    'ATENÇÃO: chave de testes (test_*). Todos os endpoints respondem, sem ' +
      'limite, mas com dados fictícios. Placar real exige a chave de produção.',
  )
}

// TTLs em ms. Tudo configurável: ajuste depois de ver seu limite no /v1/me.
const TTL = {
  aoVivo: Number(process.env.TTL_AO_VIVO || 25_000),
  // Quando não há nenhum jogo rolando, não faz sentido perguntar de novo em
  // 25s — é aqui que mora a maior economia de requisições do dia.
  aoVivoOcioso: Number(process.env.TTL_AO_VIVO_OCIOSO || 300_000),
  partida: Number(process.env.TTL_PARTIDA || 25_000),
  tabela: Number(process.env.TTL_TABELA || 30 * 60_000),
  artilharia: Number(process.env.TTL_ARTILHARIA || 6 * 3600_000),
  time: Number(process.env.TTL_TIME || 6 * 3600_000),
}

app.use(cors())

// ---------------------------------------------------------------------------
// Cache + orçamento de requisições
// ---------------------------------------------------------------------------

const cache = new Map() // path -> { valor, expiraEm, gravadoEm }

let consumo = { dia: diaAtual(), requisicoes: 0 }

// O limite da API Futebol renova à meia-noite no horário de Brasília (UTC-3).
function diaAtual() {
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
}

function contabilizar() {
  const hoje = diaAtual()
  if (consumo.dia !== hoje) consumo = { dia: hoje, requisicoes: 0 }
  consumo.requisicoes += 1
}

function orcamentoEsgotado() {
  if (!LIMITE_DIARIO) return false
  if (consumo.dia !== diaAtual()) return false
  return consumo.requisicoes >= LIMITE_DIARIO
}

/**
 * Busca um path da API Futebol com cache.
 * Se a chamada falhar (ou o orçamento acabar) e existir valor velho em cache,
 * devolve o velho em vez de quebrar a tela — no plano free do Render o
 * serviço dorme e a primeira chamada depois disso costuma ser lenta.
 */
async function api(path, ttl) {
  const agora = Date.now()
  const emCache = cache.get(path)

  if (emCache && agora < emCache.expiraEm) return emCache.valor

  if (orcamentoEsgotado()) {
    if (emCache) return emCache.valor
    throw new Error('Limite diário de requisições atingido')
  }

  try {
    const resposta = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    })
    contabilizar()

    if (!resposta.ok) throw new Error(`API Futebol respondeu ${resposta.status} em ${path}`)

    const valor = await resposta.json()
    cache.set(path, { valor, expiraEm: agora + ttl, gravadoEm: agora })
    return valor
  } catch (err) {
    if (emCache) {
      console.warn(
        `${path} falhou (${err.message}); servindo cache de ${new Date(emCache.gravadoEm).toISOString()}`,
      )
      return emCache.valor
    }
    throw err
  }
}

/** Estende a validade de uma entrada já em cache, sem gastar requisição. */
function adiarRevalidacao(path, ttl) {
  const entrada = cache.get(path)
  if (entrada) entrada.expiraEm = Math.max(entrada.expiraEm, Date.now() + ttl)
}

// ---------------------------------------------------------------------------
// Normalização
//
// A API evoluiu de formato ao longo das versões e alguns endpoints devolvem o
// mesmo dado com nomes diferentes. Os helpers abaixo aceitam as duas formas
// para o app não quebrar quando um campo muda de lugar.
// ---------------------------------------------------------------------------

function lista(dados, ...chaves) {
  if (Array.isArray(dados)) return dados
  for (const chave of chaves) {
    if (Array.isArray(dados?.[chave])) return dados[chave]
  }
  return []
}

function nomeTime(time, fallback) {
  if (typeof time === 'string') return time
  return time?.nome_popular || time?.nome || time?.sigla || fallback
}

function idCampeonato(jogo) {
  return jogo?.campeonato?.campeonato_id ?? jogo?.campeonato_id ?? null
}

function ehDoNossoCampeonato(jogo) {
  const id = idCampeonato(jogo)
  return id === null || id === CAMPEONATO_ID
}

function descreverEvento(evento) {
  if (!evento) return null
  const minuto = evento.minuto ?? evento.min ?? evento.tempo ?? ''
  const tipo = evento.tipo_evento || evento.tipo || evento.descricao || ''
  const quem = evento.atleta?.nome_popular || evento.atleta?.nome || evento.jogador || ''
  const texto = [tipo, quem].filter(Boolean).join(' ')
  if (!texto) return null
  return minuto ? `${minuto}' ${texto}` : texto
}

function resumirPartida(jogo) {
  const status = String(jogo?.status || '').toLowerCase()
  const encerrado = status.includes('encerr') || status.includes('finaliz')

  return {
    id: jogo?.partida_id ?? jogo?.id ?? null,
    casa: nomeTime(jogo?.time_mandante ?? jogo?.mandante, 'Casa'),
    fora: nomeTime(jogo?.time_visitante ?? jogo?.visitante, 'Fora'),
    placarCasa: jogo?.placar_mandante ?? jogo?.placarMandante ?? 0,
    placarFora: jogo?.placar_visitante ?? jogo?.placarVisitante ?? 0,
    minuto: encerrado ? 'FIM' : jogo?.minuto ? `${jogo.minuto}'` : 'AO VIVO',
    encerrado,
    ultimoLance: null, // preenchido depois, com /partidas/{id}
  }
}

// ---------------------------------------------------------------------------
// Coletores
// ---------------------------------------------------------------------------

async function coletarAoVivo() {
  const dados = await api('/ao-vivo', TTL.aoVivo)
  const jogos = lista(dados, 'jogos', 'partidas').filter(ehDoNossoCampeonato).map(resumirPartida)

  // Nada rolando: adia a próxima ida à API. Em um dia sem jogo isso derruba o
  // consumo de ~2.880 para ~290 requisições.
  if (jogos.length === 0) adiarRevalidacao('/ao-vivo', TTL.aoVivoOcioso)

  // Último lance de verdade. O /ao-vivo devolve só o resumo; quem tem os
  // eventos (gol, cartão, substituição) é /partidas/{id}.
  const comId = jogos.filter((j) => j.id).slice(0, MAX_DETALHES)
  await Promise.all(
    comId.map(async (jogo) => {
      try {
        const detalhe = await api(`/partidas/${jogo.id}`, TTL.partida)
        const eventos = lista(detalhe?.eventos ?? detalhe?.timeline ?? detalhe, 'eventos', 'timeline')
        jogo.ultimoLance = descreverEvento(eventos[eventos.length - 1])
      } catch {
        // Sem detalhe, o placar sozinho já serve. Não derruba o ciclo.
      }
    }),
  )

  return jogos
}

async function coletarTabela() {
  const dados = await api(`/campeonatos/${CAMPEONATO_ID}/tabela`, TTL.tabela)
  const linhas = Array.isArray(dados) ? dados : lista(dados, 'tabela')

  return linhas
    .map((linha) => ({
      posicao: linha?.posicao ?? null,
      timeId: linha?.time?.time_id ?? linha?.time_id ?? null,
      time: nomeTime(linha?.time, '—'),
      sigla: linha?.time?.sigla || null,
      pontos: linha?.pontos ?? 0,
      jogos: linha?.jogos ?? 0,
      saldo: linha?.saldo_gols ?? linha?.saldo_de_gols ?? 0,
    }))
    .filter((linha) => linha.posicao !== null)
    .sort((a, b) => a.posicao - b.posicao)
}

async function coletarArtilharia() {
  const dados = await api(`/campeonatos/${CAMPEONATO_ID}/artilharia`, TTL.artilharia)

  return lista(dados, 'artilharia')
    .slice(0, 5)
    .map((item) => ({
      nome: item?.atleta?.nome_popular || item?.atleta?.nome || item?.nome || '—',
      time: nomeTime(item?.time, ''),
      gols: item?.gols ?? 0,
    }))
}

async function coletarMeuTime(tabela) {
  if (!TIME_ID) return null

  const naTabela = tabela.find((linha) => linha.timeId === TIME_ID) || null
  const resultado = {
    nome: naTabela?.time || null,
    posicao: naTabela?.posicao ?? null,
    pontos: naTabela?.pontos ?? null,
    jogos: naTabela?.jogos ?? null,
    saldo: naTabela?.saldo ?? null,
    proximo: null,
    anterior: null,
  }

  // Estes dois paths são os documentados hoje; se a API mudar, o catch abaixo
  // apenas deixa os campos em null e o app cai na tela de placar.
  await Promise.all([
    api(`/times/${TIME_ID}/partidas/proximas`, TTL.time)
      .then((d) => {
        const p = lista(d, 'partidas', 'proximas')[0]
        if (p) {
          resultado.proximo = {
            casa: nomeTime(p.time_mandante ?? p.mandante, 'Casa'),
            fora: nomeTime(p.time_visitante ?? p.visitante, 'Fora'),
            data: p.data_realizacao || p.data_realizacao_iso || null,
          }
        }
      })
      .catch(() => {}),
    api(`/times/${TIME_ID}/partidas/anteriores`, TTL.time)
      .then((d) => {
        const anteriores = lista(d, 'partidas', 'anteriores')
        const p = anteriores[anteriores.length - 1]
        if (p) resultado.anterior = resumirPartida(p)
      })
      .catch(() => {}),
  ])

  return resultado
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

// Rota única do app: tudo que as quatro telas do G2 precisam, em 1 chamada.
app.get('/contexto', async (req, res) => {
  try {
    const aoVivo = await coletarAoVivo()
    const [tabela, artilharia] = await Promise.all([
      coletarTabela().catch(() => []),
      coletarArtilharia().catch(() => []),
    ])
    const meuTime = await coletarMeuTime(tabela).catch(() => null)

    res.json({
      aoVivo,
      tabela: tabela.slice(0, 6),
      artilharia,
      meuTime,
      // O cliente respeita isso: em jogo volta rápido, fora de jogo espaça.
      proximaConsultaMs: aoVivo.length > 0 ? TTL.aoVivo + 5_000 : TTL.aoVivoOcioso,
      atualizadoEm: new Date().toISOString(),
    })
  } catch (err) {
    console.error(err)
    res.status(502).json({ erro: 'Falha ao consultar a API Futebol' })
  }
})

// Mantida por compatibilidade com a versão anterior do app.
app.get('/jogos-ao-vivo', async (req, res) => {
  try {
    res.json({ jogos: await coletarAoVivo(), atualizadoEm: new Date().toISOString() })
  } catch (err) {
    console.error(err)
    res.status(502).json({ erro: 'Falha ao consultar a API Futebol' })
  }
})

// Espelha o /v1/me da API Futebol: plano, limite e consumo da sua chave.
// Útil para calibrar os TTLs sem sair caçando na documentação.
app.get('/plano', async (req, res) => {
  try {
    const dados = await api('/me', 60 * 60_000)
    res.json({ api: dados, consumoLocal: consumo, limiteConfigurado: LIMITE_DIARIO || null })
  } catch (err) {
    res.status(502).json({ erro: err.message })
  }
})

// Healthcheck do Render/Railway.
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    rotas: ['/contexto', '/jogos-ao-vivo', '/plano'],
    campeonatoId: CAMPEONATO_ID,
    timeId: TIME_ID,
    consumoHoje: consumo,
  })
})

app.listen(PORT, () => {
  console.log(`Proxy rodando em http://localhost:${PORT}`)
})
