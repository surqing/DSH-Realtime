/**
 * Host half of the voice call bundle.
 *
 * The browser never sees the OpenAI API key. It creates a WebRTC offer for a
 * Realtime session and posts the SDP here; this plugin resolves the credential
 * from the Harness credential store, exchanges the offer for an answer with
 * OpenAI, and returns only the SDP answer. Audio never touches this process.
 *
 * Endpoints (one exact route, dispatched by method):
 *   GET  /voice-call/session  -> readiness and call settings
 *   POST /voice-call/session  -> WebRTC SDP offer (application/sdp) -> SDP answer
 */

const ROUTE_PATH = '/voice-call/session'
const MAX_BODY_BYTES = 64 * 1024
const UPSTREAM_URL = 'https://api.openai.com/v1/realtime/calls'

const DEFAULTS = {
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  apiKeyRef: 'OPENAI_API_KEY',
  announce: true,
  upstreamTimeoutMs: 20000,
  instructions: [
    'You are the voice interface of DeepSeek Harness, a coding agent that works inside the chat.',
    'The user is talking to you; your job is to relay, not to solve.',
    '- Never write code or answer programming questions yourself.',
    '- For every user request, call send_to_agent with a complete, faithful instruction in the user\'s own language, keeping file names, symbols and numbers exactly as spoken.',
    '- After send_to_agent succeeds, reply with one short confirmation such as "On it."',
    '- Use check_agent when the user asks about progress or what the agent said.',
    '- Use interrupt_agent when the user says stop, cancel, or wants to change direction.',
    '- Never read code, logs, long identifiers or file paths aloud; say the details are in the chat and summarize in at most two sentences.',
    '- Always reply in the language the user speaks, briefly and naturally.',
  ].join('\n'),
}

const TOOLS = [
  {
    type: 'function',
    name: 'send_to_agent',
    description:
      'Send the user instruction to the DeepSeek Harness coding agent in the current chat. Use this for every request instead of answering yourself.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            "The user's request, faithfully and completely, in the user's own language, without filler words.",
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'check_agent',
    description:
      'Read whether the coding agent is still working and what it last replied. Use it when the user asks about progress.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'interrupt_agent',
    description:
      "Stop the coding agent's current run when the user asks to stop, cancel, or change direction.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
]

/** Required Host services; a profile without them simply does not load this bundle. */
export const inject = ['webServer', 'credentials']

export function apply(ctx, config) {
  const settings = mergeSettings(config)

  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: (req, res) => {
      handleRequest(ctx, settings, req, res).catch((error) => {
        warn(ctx, 'voice call request failed', error)
        sendJson(res, 500, { error: 'internal-error' })
      })
    },
  })

  ctx.effect(() => dispose)
}

function mergeSettings(config) {
  const merged = { ...DEFAULTS }
  if (config && typeof config === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (config[key] !== undefined && config[key] !== null) merged[key] = config[key]
    }
  }
  merged.apiKeyRef = String(merged.apiKeyRef || 'OPENAI_API_KEY')
  merged.model = String(merged.model || DEFAULTS.model)
  merged.voice = String(merged.voice || DEFAULTS.voice)
  merged.announce = merged.announce !== false
  const timeout = Number(merged.upstreamTimeoutMs)
  merged.upstreamTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULTS.upstreamTimeoutMs
  return merged
}

async function handleRequest(ctx, settings, req, res) {
  if (req.method === 'GET') {
    if (!isSameSite(req)) {
      rejectCaller(ctx, req, res, 'forbidden-site')
      return
    }
    await sendStatus(ctx, settings, res)
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'GET, POST', 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Method not allowed')
    return
  }

  if (!isAllowedCaller(ctx, req)) {
    rejectCaller(ctx, req, res, 'forbidden-origin')
    return
  }

  const contentType = String(req.headers['content-type'] || '').toLowerCase()
  if (!contentType.startsWith('application/sdp') && !contentType.startsWith('text/plain')) {
    sendJson(res, 415, { error: 'unsupported-content-type' })
    return
  }

  let offer
  try {
    offer = await readBody(req, MAX_BODY_BYTES)
  } catch (error) {
    if (error && error.code === 'E_BODY_TOO_LARGE') {
      sendJson(res, 413, { error: 'body-too-large' })
      return
    }
    sendJson(res, 400, { error: 'unreadable-body' })
    return
  }
  offer = String(offer || '').trim()
  if (!offer) {
    sendJson(res, 400, { error: 'missing-sdp' })
    return
  }
  if (req.headers['x-vc-debug'] === 'probe-1') {
    sendJson(res, 200, { length: offer.length, head: offer.slice(0, 24), tail: offer.slice(-24) })
    return
  }
  // OpenAI's SDP parser reports a premature EOF when the final line is not newline-terminated.
  if (!offer.endsWith('\n')) offer += '\r\n'

  let credential
  try {
    credential = await ctx.credentials.resolve(settings.apiKeyRef)
  } catch (error) {
    warn(ctx, 'credential lookup failed', error)
    sendJson(res, 500, { error: 'credential-lookup-failed' })
    return
  }
  if (!credential || !credential.value) {
    sendJson(res, 412, {
      error: 'missing-credential',
      apiKeyRef: settings.apiKeyRef,
      message: `No value stored for credential ${settings.apiKeyRef}.`,
    })
    return
  }

  const session = buildSession(settings)
  const body = new FormData()
  body.set('sdp', offer)
  body.set('session', JSON.stringify(session))

  let upstream
  try {
    upstream = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential.value}` },
      body,
      signal: AbortSignal.timeout(settings.upstreamTimeoutMs),
    })
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    warn(ctx, timedOut ? 'voice call upstream timed out' : 'voice call upstream unreachable', error)
    sendJson(res, timedOut ? 504 : 502, {
      error: timedOut ? 'upstream-timeout' : 'upstream-unreachable',
    })
    return
  }

  let answer
  try {
    answer = await upstream.text()
  } catch {
    sendJson(res, 502, { error: 'upstream-unreadable' })
    return
  }

  if (!upstream.ok) {
    const detail = sanitize(answer, 600)
    warn(ctx, 'voice call upstream rejected', `${upstream.status} ${sanitize(detail, 200)}`)
    sendJson(res, proxyStatus(upstream.status), {
      error: 'openai-rejected',
      status: upstream.status,
      detail,
    })
    return
  }

  const payload = Buffer.from(answer, 'utf8')
  res.writeHead(200, {
    'Content-Type': 'application/sdp',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

async function sendStatus(ctx, settings, res) {
  let configured = false
  let source
  try {
    const info = await ctx.credentials.describe(settings.apiKeyRef)
    configured = Boolean(info && info.configured)
    source = info && info.source ? String(info.source) : undefined
  } catch {
    configured = false
  }
  sendJson(res, 200, {
    ready: configured,
    model: settings.model,
    voice: settings.voice,
    apiKeyRef: settings.apiKeyRef,
    announce: settings.announce,
    reason: configured ? null : 'missing-credential',
    source: source ?? null,
  })
}

function buildSession(settings) {
  return {
    type: 'realtime',
    model: settings.model,
    instructions: settings.instructions,
    output_modalities: ['audio'],
    // WebRTC negotiates the audio format in SDP, so audio.format stays unset.
    audio: {
      output: { voice: settings.voice },
      input: { turn_detection: { type: 'semantic_vad' } },
    },
    tools: TOOLS,
    tool_choice: 'auto',
  }
}

function isSameSite(req) {
  const site = req.headers['sec-fetch-site']
  return typeof site !== 'string' || site === 'same-origin' || site === 'none'
}

/**
 * The desktop shell loads the app from `dsh-app://app` and forwards every
 * non-asset request to this server after deleting `origin`, `cookie` and
 * `sec-fetch-site` (`forwardWebRequest` in the shell's main process), so an
 * app request legitimately arrives with no Origin header.
 *
 * A browser always sends Origin on POST (including `no-cors` and
 * `sendBeacon`), so an absent Origin still means "the desktop shell or a local
 * non-browser client"; the latter already sits inside the trust boundary of
 * the readable credential file.
 */
function isAllowedCaller(ctx, req) {
  if (!isSameSite(req)) return false
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  if (origin === 'dsh-app://app') return true
  let expected
  try {
    expected = ctx.webServer.getOrigin()
  } catch {
    return false
  }
  if (typeof expected !== 'string' || expected.length === 0) return false
  if (origin === expected) return true
  return isLoopbackOrigin(origin, expected)
}

/** Accept `localhost`, `127.0.0.1` and `[::1]` on the server's own port. */
function isLoopbackOrigin(origin, expected) {
  let parsed
  let server
  try {
    parsed = new URL(origin)
    server = new URL(expected)
  } catch {
    return false
  }
  if (parsed.protocol !== server.protocol) return false
  if (parsed.port !== server.port) return false
  return isLoopbackHost(parsed.hostname) && isLoopbackHost(server.hostname)
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

function callerObservation(ctx, req) {
  let expected = null
  try {
    expected = ctx.webServer.getOrigin() || null
  } catch {
    expected = null
  }
  return {
    origin: typeof req.headers.origin === 'string' ? req.headers.origin : null,
    secFetchSite: typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : null,
    expected,
  }
}

function rejectCaller(ctx, req, res, error) {
  const observed = callerObservation(ctx, req)
  warn(ctx, 'rejected voice call request', `${error} ${JSON.stringify(observed)}`)
  sendJson(res, 403, { error, ...observed })
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let settled = false
    let size = 0
    const chunks = []
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settle(reject, Object.assign(new Error('body too large'), { code: 'E_BODY_TOO_LARGE' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => settle(resolve, Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => settle(reject, error))
  })
}

function sendJson(res, status, value) {
  if (res.writableEnded) return
  const text = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function proxyStatus(status) {
  if (status === 401 || status === 403) return 401
  if (status === 404) return 404
  if (status === 429) return 429
  if (status >= 400 && status < 500) return 400
  return 502
}

/** Never let an upstream error echo a key-shaped value or run away in size. */
function sanitize(text, limit) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\s+/g, ' ')
    .slice(0, limit)
}

function warn(ctx, message, error) {
  const detail = error && error.message ? error.message : error
  try {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn(`[voice-call] ${message}`, detail)
      return
    }
  } catch {
    // fall through to console
  }
  // eslint-disable-next-line no-console
  console.warn(`[voice-call] ${message}`, detail)
}
