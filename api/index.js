const express = require('express')
const fetch = require('node-fetch')
const { randomUUID } = require('crypto')

const app = express()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.use(express.json({ limit: '50mb' }))
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization')
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200)
  }
  next()
})

// 0a. Agent runs (START / FINISH)
app.post('/api/v1/agent-runs', (req, res) => {
  const { action } = req.body || {}
  if (action === 'START') {
    const generatedRunId = randomUUID()
    return res.status(200).json({ runId: generatedRunId })
  }
  if (action === 'FINISH') {
    return res.status(200).json({ success: true })
  }
  return res.status(400).json({ error: 'Invalid action. Must be START or FINISH.' })
})

// Token count stub
app.post('/api/v1/token-count', (req, res) => {
  return res.status(200).json({ count: 0 })
})

// 0b. Agent run steps
app.post('/api/v1/agent-runs/:runId/steps', (req, res) => {
  return res.json({ stepId: randomUUID() })
})

// 0c. Agent metadata (always 404 to signal not published)
app.get('/api/v1/agents/:publisherId/:agentId/:version', (req, res) => {
  return res.status(404).json({ error: 'Agent not found' })
})

const MODEL_MAP = {
  'anthropic/claude-opus-4.7': 'accounts/fireworks/models/llama-v3p1-70b-instruct',
  'openai/gpt-5.4': 'accounts/fireworks/models/llama-v3p1-70b-instruct',
}

const DEFAULT_MODEL = 'accounts/fireworks/models/llama-v3p1-70b-instruct'

function resolveModel(modelId) {
  if (MODEL_MAP[modelId]) return MODEL_MAP[modelId]
  if (modelId && modelId.startsWith('accounts/fireworks/models/')) return modelId
  return DEFAULT_MODEL
}

// 1. Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' })
})

// 1b. GitHub releases download proxy
//     GET /api/releases/download/:version/:asset
//     GET /releases/download/:version/:asset  (public alias via vercel.json)
//     Streams the asset from
//     https://github.com/Marcus-Mok-GH/codebuff-cli/releases/download/{version}/{asset}
async function releasesDownloadHandler(req, res) {
  const { version, asset } = req.params
  const upstreamUrl = `https://github.com/Marcus-Mok-GH/codebuff-cli/releases/download/${encodeURIComponent(version)}/${encodeURIComponent(asset)}`

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'fireworks-api-backend-release-proxy',
        Accept: 'application/octet-stream, */*',
      },
    })

    if (upstream.status === 404) {
      return res.status(404).json({ error: 'Release asset not found' })
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      return res.status(upstream.status).json({
        error: {
          message: `GitHub responded with ${upstream.status}${text ? `: ${text}` : ''}`,
          type: 'upstream_error',
        },
      })
    }

    const passthroughHeaders = [
      'content-type',
      'content-length',
      'content-disposition',
      'last-modified',
      'etag',
      'cache-control',
    ]
    for (const headerName of passthroughHeaders) {
      const value = upstream.headers.get(headerName)
      if (value) res.setHeader(headerName, value)
    }

    if (!upstream.headers.get('content-disposition')) {
      res.setHeader('Content-Disposition', `attachment; filename="${asset}"`)
    }

    res.status(upstream.status)

    upstream.body.on('error', (err) => {
      console.error('Release download stream error:', err)
      if (!res.headersSent) {
        res.status(502).json({ error: { message: err.message, type: 'stream_error' } })
      } else {
        res.destroy(err)
      }
    })

    upstream.body.pipe(res)
  } catch (err) {
    console.error('Release proxy error:', err)
    res.status(502).json({
      error: {
        message: err.message || 'Failed to proxy GitHub release download',
        type: 'proxy_error',
      },
    })
  }
}

app.get('/api/releases/download/:version/:asset', releasesDownloadHandler)
app.get('/releases/download/:version/:asset', releasesDownloadHandler)

// 2. Current user
app.get('/api/v1/me', (req, res) => {
  const fields = req.query.fields ? req.query.fields.split(',') : ['id', 'name']
  const profile = {
    id: 'gateway',
    name: 'Fireworks AI Gateway',
    email: 'gateway@fireworks.ai',
    discord_id: null,
  }
  const result = {}
  for (const field of fields) {
    const key = field.trim()
    result[key] = profile[key] !== undefined ? profile[key] : null
  }
  res.json(result)
})

// 3. Validate agents (always pass to unblock the CLI)
app.post('/api/agents/validate', (req, res) => {
  return res.status(200).json({ valid: true, agents: [] })
})

app.post('/api/v1/agents/validate', (req, res) => {
  return res.status(200).json({ valid: true, agents: [] })
})

// 4. Chat completions → proxy to Fireworks AI
app.post('/api/chat/completions', async (req, res) => {
  const apiKey = process.env.FIREWORKS_API_KEY
  if (!apiKey) {
    return res.status(503).json({
      error: {
        message: 'FIREWORKS_API_KEY environment variable is not set. Configure it in your Vercel project settings.',
        type: 'configuration_error',
      },
    })
  }

  const body = req.body || {}
  const proxyBody = {
    ...body,
    model: resolveModel(body.model),
  }

  try {
    const fireworksRes = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify(proxyBody),
    })

    if (!fireworksRes.ok) {
      const text = await fireworksRes.text()
      return res.status(fireworksRes.status).json({
        error: {
          message: `Fireworks API error (${fireworksRes.status}): ${text}`,
          type: 'api_error',
        },
      })
    }

    const contentType = fireworksRes.headers.get('content-type') || 'application/json'

    if (proxyBody.stream) {
      res.setHeader('Content-Type', contentType)
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      fireworksRes.body.pipe(res)
      fireworksRes.body.on('error', (err) => {
        console.error('Stream error:', err)
        if (!res.headersSent) {
          res.status(502).json({ error: { message: err.message, type: 'stream_error' } })
        }
      })
    } else {
      const data = await fireworksRes.json()
      res.json(data)
    }
  } catch (err) {
    console.error('Proxy error:', err)
    res.status(502).json({
      error: {
        message: err.message || 'Failed to proxy request to Fireworks AI',
        type: 'proxy_error',
      },
    })
  }
})

module.exports = app
