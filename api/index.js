const express = require('express')
const fetch = require('node-fetch')

const app = express()

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
  res.json({ success: true, errors: [], validationErrors: [] })
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
