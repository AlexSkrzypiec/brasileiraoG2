// Proxy mínimo para o app do Even G2.
//
// Por quê isso existe: o WebView dos óculos chama fetch() como qualquer
// navegador. Se a API Futebol não devolver cabeçalhos CORS liberando seu
// domínio, a chamada falha do mesmo jeito que falhou no navegador comum —
// o whitelist de rede do app.json do Even Hub é uma permissão do lado do
// Even, não um bypass de CORS. Este servidor guarda sua chave da API
// Futebol, faz a chamada real do lado do servidor (onde CORS não existe)
// e devolve só o que o óculos precisa, já em texto simplificado.
//
// Deploy: Render, Railway, Fly.io, ou uma função serverless (Vercel/Cloudflare
// Workers) funcionam. Qualquer um deles te dá um domínio HTTPS para colocar
// no whitelist do app.json.

import express from 'express'
import cors from 'cors'

const app = express()
const PORT = process.env.PORT || 3000
const API_FUTEBOL_KEY = process.env.API_FUTEBOL_KEY
const CAMPEONATO_ID = 10 // Brasileirão Série A

if (!API_FUTEBOL_KEY) {
  console.error('Defina API_FUTEBOL_KEY nas variáveis de ambiente antes de rodar.')
  process.exit(1)
}

app.use(cors()) // libera para o WebView do Even Hub chamar este servidor

// Formata cada partida num resumo curto, pensado para caber no display do G2.
function formatarLinha(jogo) {
  const casa = jogo.time_mandante?.nome_popular || jogo.mandante || 'Casa'
  const fora = jogo.time_visitante?.nome_popular || jogo.visitante || 'Fora'
  const placarCasa = jogo.placar_mandante ?? jogo.placarMandante ?? 0
  const placarFora = jogo.placar_visitante ?? jogo.placarVisitante ?? 0
  const status = (jogo.status || '').toLowerCase()
  const encerrado = status.includes('encerr') || status.includes('finaliz')
  const minuto = encerrado ? 'FIM' : (jogo.minuto ? `${jogo.minuto}'` : 'AO VIVO')

  const ultimoLance = (jogo.eventos || jogo.timeline || []).slice(-1)[0]
  const lance = ultimoLance
    ? `${ultimoLance.minuto ?? ultimoLance.min ?? ''}' ${ultimoLance.descricao || ultimoLance.tipo || ''}`.trim()
    : null

  return {
    casa,
    fora,
    placarCasa,
    placarFora,
    minuto,
    encerrado,
    ultimoLance: lance,
  }
}

app.get('/jogos-ao-vivo', async (req, res) => {
  try {
    const resposta = await fetch('https://api.api-futebol.com.br/v1/ao-vivo', {
      headers: { Authorization: `Bearer ${API_FUTEBOL_KEY}` },
    })

    if (!resposta.ok) {
      return res.status(resposta.status).json({ erro: `API Futebol respondeu ${resposta.status}` })
    }

    const dados = await resposta.json()
    const jogos = (Array.isArray(dados) ? dados : dados.jogos || dados.partidas || [])
      .filter((j) => !j.campeonato_id || j.campeonato_id === CAMPEONATO_ID)
      .map(formatarLinha)

    res.json({ jogos, atualizadoEm: new Date().toISOString() })
  } catch (err) {
    console.error(err)
    res.status(502).json({ erro: 'Falha ao consultar a API Futebol' })
  }
})

// Rota simples pra confirmar que o serviço está de pé (útil pro healthcheck
// do Render/Railway e pra você testar a URL pública no navegador).
app.get('/', (req, res) => {
  res.json({ status: 'ok', endpoint: '/jogos-ao-vivo' })
})

app.listen(PORT, () => {
  console.log(`Proxy rodando em http://localhost:${PORT}`)
})
