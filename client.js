/**
 * Browser half of the voice call bundle.
 *
 * The composer gains a phone button. A call opens a WebRTC peer connection to
 * the OpenAI Realtime API (the Host exchanges the SDP so the API key never
 * reaches this page), and the realtime model relays speech into the current
 * chat session through send_to_agent.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-voice-call',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useSyncExternalStore, useEffect, useState } = React

    const ROUTE = '/voice-call/session'
    const MAX_INSTRUCTION = 4000
    const MAX_SPEECH = 1400

    const ANNOUNCE_INSTRUCTIONS = [
      'You are the voice interface of DeepSeek Harness, a coding agent.',
      'The agent just finished a reply that the user can already read in the chat.',
      'Say a short spoken summary in the user language: what changed and what to do next, at most two sentences.',
      'Never read code, logs, file paths or long identifiers aloud; say the details are in the chat.',
      'Do not call any tool.',
    ].join(' ')

    const STRINGS = {
      en: {
        start: 'Voice call',
        startHint: 'Start a voice call with the agent',
        end: 'End call',
        cancel: 'Cancel',
        retry: 'Try again',
        close: 'Close',
        checking: 'Checking setup…',
        mic: 'Waiting for the microphone…',
        connecting: 'Connecting the call…',
        ready: 'Ready',
        listening: 'Listening…',
        thinking: 'The agent is working…',
        speaking: 'The agent finished; speaking a summary…',
        liveHint: 'Speak naturally — your words become chat messages.',
        mute: 'Mute the microphone',
        unmute: 'Unmute the microphone',
        setupTitle: 'OpenAI API key needed',
        setupBody:
          'Save an OpenAI API key to start a voice call. It is stored in the Harness credential store and never written into the chat.',
        keyLabel: 'OpenAI API key',
        keyPlaceholder: 'sk-…',
        emptyKey: 'Enter the key first.',
        save: 'Save key',
        saving: 'Saving…',
        privacy: 'Audio is sent to OpenAI and billed to your OpenAI account.',
        errorTitle: 'The voice call could not start',
        errMic: 'Microphone access was denied, or no input device is available.',
        errHost: 'The local voice route is unreachable. Restart the app and try again.',
        errCredential: 'OpenAI rejected this API key.',
        errRate: 'OpenAI rate limit reached. Wait a little and retry.',
        errForbidden: 'The local voice service rejected this request (origin check). Restart the app and try again.',
        errOpenAI: 'OpenAI rejected this voice session.',
        errNetwork: 'OpenAI could not be reached. Check the network.',
        errSession: 'The chat session could not be attached to the call.',
        errGeneric: 'Something went wrong.',
        autoplay: 'The browser blocked the sound. Enable audio to keep the call.',
        enableSound: 'Enable sound',
        attachFailed: 'Call connected, but chat relay is unavailable. Reconnect to use voice input.',
        timeLimit: 'OpenAI calls last at most 60 minutes; this call closes at the limit.',
      },
      zh: {
        start: '语音通话',
        startHint: '与 agent 开始语音通话',
        end: '挂断',
        cancel: '取消',
        retry: '重试',
        close: '关闭',
        checking: '正在检查配置…',
        mic: '正在等待麦克风…',
        connecting: '正在接通…',
        ready: '就绪',
        listening: '正在聆听…',
        thinking: 'Agent 正在执行…',
        speaking: 'Agent 已完成，正在播报摘要…',
        liveHint: '直接说话即可，你的话会变成聊天消息。',
        mute: '静音麦克风',
        unmute: '取消静音',
        setupTitle: '需要 OpenAI API Key',
        setupBody: '保存一个 OpenAI API Key 即可开始语音通话。它只存在 Harness 凭据库中，不会写进聊天。',
        keyLabel: 'OpenAI API Key',
        keyPlaceholder: 'sk-…',
        emptyKey: '请先输入 API Key。',
        save: '保存',
        saving: '正在保存…',
        privacy: '音频会发送给 OpenAI，并按你的 OpenAI 账号计费。',
        errorTitle: '语音通话未能启动',
        errMic: '麦克风权限被拒绝，或没有可用的输入设备。',
        errHost: '本地语音路由不可达，请重启应用后重试。',
        errCredential: 'OpenAI 拒绝了这个 API Key。',
        errRate: '触发了 OpenAI 限流，请稍后重试。',
        errForbidden: '本地语音服务拒绝了这次请求（来源校验失败），请重启应用后重试。',
        errOpenAI: 'OpenAI 拒绝了这个语音会话。',
        errNetwork: '无法连接 OpenAI，请检查网络。',
        errSession: '聊天会话无法接入通话。',
        errGeneric: '出现了一个错误。',
        autoplay: '浏览器拦截了声音，请点击启用音频。',
        enableSound: '启用声音',
        attachFailed: '通话已接通，但聊天转发不可用；请重连后再用语音输入。',
        timeLimit: 'OpenAI 通话最长 60 分钟，到点会自动挂断。',
      },
    }

    // ---------------------------------------------------------------- module state

    const calls = new Map()
    const engines = new Map()
    const listeners = new Set()
    const runtime = { ctx: null, t: (key) => STRINGS.en[key] ?? key }

    function emit() {
      for (const listener of Array.from(listeners)) {
        try {
          listener()
        } catch {
          // a broken subscriber must not break the call
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function snapshot(sessionId) {
      return sessionId ? calls.get(sessionId) ?? null : null
    }

    function patch(sessionId, next) {
      const current = calls.get(sessionId) ?? { sessionId, phase: 'idle' }
      const merged = { ...current, ...next, sessionId }
      calls.set(sessionId, merged)
      emit()
      return merged
    }

    function isActive(phase) {
      return phase === 'checking' || phase === 'mic' || phase === 'connecting' || phase === 'live'
    }

    function messageOf(error) {
      if (!error) return ''
      if (typeof error === 'string') return error
      if (typeof error.message === 'string') return error.message
      return String(error)
    }

    // ---------------------------------------------------------------- call lifecycle

    async function startCall(sessionId) {
      if (!sessionId) return
      const previous = engines.get(sessionId)
      if (previous) {
        engines.delete(sessionId)
        closeEngine(previous)
      }

      const engine = {
        sessionId,
        closed: false,
        pc: null,
        dc: null,
        mic: null,
        audio: null,
        ref: null,
        binding: null,
        bindingPromise: null,
        unsubs: [],
        remote: null,
        running: false,
        responding: false,
        userSpeaking: false,
        pendingAnnounce: false,
        lastReply: '',
        announceTimer: null,
      }
      engines.set(sessionId, engine)
      patch(sessionId, {
        phase: 'checking',
        error: null,
        detail: '',
        notice: '',
        startedAt: 0,
        muted: false,
        running: false,
        speaking: false,
        userSpeaking: false,
      })

      let status
      try {
        const response = await fetch(ROUTE, { method: 'GET', headers: { Accept: 'application/json' } })
        status = response.ok ? await response.json() : null
      } catch {
        status = null
      }
      if (engine.closed) return
      if (!status) {
        failCall(engine, 'host', '')
        return
      }
      engine.remote = status
      if (!status.ready) {
        closeEngine(engine)
        patch(sessionId, {
          phase: 'setup',
          error: null,
          detail: '',
          apiKeyRef: status.apiKeyRef || 'OPENAI_API_KEY',
        })
        return
      }

      patch(sessionId, { phase: 'mic' })
      let mic
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
      } catch (error) {
        if (engine.closed) return
        failCall(engine, 'mic', messageOf(error))
        return
      }
      if (engine.closed) {
        stopStream(mic)
        return
      }
      engine.mic = mic

      try {
        await connect(engine)
      } catch (error) {
        if (!engine.closed) failCall(engine, 'network', messageOf(error))
      }
    }

    async function connect(engine) {
      const { sessionId } = engine
      patch(sessionId, { phase: 'connecting' })

      const audio = new Audio()
      audio.autoplay = true
      audio.setAttribute('playsinline', '')
      engine.audio = audio

      const pc = new RTCPeerConnection()
      engine.pc = pc

      pc.ontrack = (event) => {
        if (engine.closed) return
        const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track])
        try {
          audio.srcObject = stream
          const played = audio.play()
          if (played && typeof played.catch === 'function') {
            played.catch(() => patch(sessionId, { notice: 'autoplay' }))
          }
        } catch {
          patch(sessionId, { notice: 'autoplay' })
        }
      }

      pc.addEventListener('connectionstatechange', () => {
        if (engine.closed) return
        const state = pc.connectionState
        if (state === 'failed') failCall(engine, 'network', 'connection failed')
        else if (state === 'disconnected') patch(sessionId, { notice: 'network-warning', detail: 'connection lost' })
      })

      const dc = pc.createDataChannel('oai-events')
      engine.dc = dc
      dc.addEventListener('message', (event) => {
        let data
        try {
          data = JSON.parse(event.data)
        } catch {
          return
        }
        handleServerEvent(engine, data)
      })
      dc.addEventListener('close', () => {
        if (!engine.closed) endCall(sessionId)
      })
      dc.addEventListener('open', () => {
        if (engine.closed) return
        patch(sessionId, { phase: 'live', startedAt: Date.now(), notice: '' })
        attachSession(engine)
      })

      for (const track of engine.mic.getAudioTracks()) pc.addTrack(track, engine.mic)

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitForIce(pc)

      const sdp = pc.localDescription && pc.localDescription.sdp
      if (!sdp) throw new Error('missing local SDP')

      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: sdp,
      })

      if (!response.ok) {
        const info = await readErrorBody(response)
        if (info.error === 'missing-credential' || info.code === 'missing-credential') {
          closeEngine(engine)
          patch(sessionId, {
            phase: 'setup',
            error: null,
            apiKeyRef: info.apiKeyRef || (engine.remote && engine.remote.apiKeyRef) || 'OPENAI_API_KEY',
          })
          return
        }
        const code = String(info.error || info.code || '')
        const observed =
          info.origin || info.secFetchSite
            ? `${code} (origin=${info.origin ?? 'none'}, sec-fetch-site=${info.secFetchSite ?? 'none'})`
            : code
        const detail = String(info.detail || info.message || observed || `HTTP ${response.status}`)
        failCall(engine, classifyFailure(response.status, code), detail)
        return
      }

      const answer = await response.text()
      if (!answer) throw new Error('empty SDP answer')
      await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    }

    function handleServerEvent(engine, event) {
      if (engine.closed || !event || typeof event.type !== 'string') return
      const { sessionId } = engine
      switch (event.type) {
        case 'input_audio_buffer.speech_started':
          engine.userSpeaking = true
          engine.pendingAnnounce = false
          patch(sessionId, { userSpeaking: true })
          break
        case 'input_audio_buffer.speech_stopped':
          engine.userSpeaking = false
          patch(sessionId, { userSpeaking: false })
          break
        case 'response.created':
          engine.responding = true
          patch(sessionId, { speaking: true })
          break
        case 'response.done': {
          engine.responding = false
          const response = event.response || {}
          if (response.status && response.status !== 'completed' && response.status !== 'cancelled') {
            patch(sessionId, { notice: 'response-failed', detail: String(response.status) })
          }
          patch(sessionId, { speaking: false })
          void finishResponse(engine, response)
          break
        }
        case 'error': {
          const message = event.error && (event.error.message || event.error.code)
          patch(sessionId, { notice: 'api-error', detail: String(message || 'unknown error') })
          break
        }
        default:
          break
      }
    }

    async function finishResponse(engine, response) {
      if (response && response.status === 'cancelled') return
      const outputs = []
      const items = response && Array.isArray(response.output) ? response.output : []
      for (const item of items) {
        if (!item || item.type !== 'function_call') continue
        const args = parseJson(item.arguments)
        let result
        try {
          result = await executeTool(engine, item.name, args)
        } catch (error) {
          result = { ok: false, error: messageOf(error) || 'tool-failed' }
        }
        outputs.push({ call_id: item.call_id, output: JSON.stringify(result) })
      }
      if (engine.closed) return
      if (outputs.length > 0) {
        for (const output of outputs) {
          send(engine, {
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: output.call_id, output: output.output },
          })
        }
        send(engine, { type: 'response.create' })
        return
      }
      if (engine.pendingAnnounce && !engine.userSpeaking) {
        engine.pendingAnnounce = false
        announce(engine)
      }
    }

    async function executeTool(engine, name, args) {
      const { sessionId } = engine
      if (name === 'send_to_agent') {
        const text = String((args && args.text) || '').trim().slice(0, MAX_INSTRUCTION)
        if (!text) return { ok: false, error: 'empty-instruction' }
        const result = await promptSession(engine, text)
        if (!result.ok) return { ok: false, error: result.error }
        patch(sessionId, { lastInstruction: text, notice: '' })
        return { ok: true, status: 'queued' }
      }
      if (name === 'check_agent') {
        return {
          running: Boolean(engine.running),
          lastReply: compactForSpeech(engine.lastReply || '').slice(0, 600),
        }
      }
      if (name === 'interrupt_agent') {
        const result = await cancelSession(engine)
        return result.ok ? { ok: true, status: 'interrupted' } : { ok: false, error: result.error }
      }
      return { ok: false, error: 'unknown-tool' }
    }

    async function promptSession(engine, text) {
      const binding = await ensureBinding(engine)
      if (!binding) return { ok: false, error: 'session-not-ready' }
      try {
        const result = await binding.session.prompt([{ type: 'text', text }], 'queue')
        return normalizeResult(result)
      } catch (error) {
        return { ok: false, error: messageOf(error) || 'prompt-failed' }
      }
    }

    async function cancelSession(engine) {
      const binding = await ensureBinding(engine)
      if (!binding) return { ok: false, error: 'session-not-ready' }
      try {
        const result = await binding.session.cancel()
        return normalizeResult(result)
      } catch (error) {
        return { ok: false, error: messageOf(error) || 'cancel-failed' }
      }
    }

    async function ensureBinding(engine) {
      if (engine.binding) return engine.binding
      if (!engine.bindingPromise) return null
      try {
        await Promise.race([
          engine.bindingPromise,
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ])
      } catch {
        return null
      }
      return engine.binding || null
    }

    function normalizeResult(result) {
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok) return { ok: true }
        const error = result.error || {}
        return { ok: false, error: String(error.message || error.code || 'rejected') }
      }
      return { ok: true }
    }

    // ---------------------------------------------------------------- session bridge

    function attachSession(engine) {
      const { sessionId } = engine
      let ref
      try {
        ref = runtime.ctx.sessions.retain(sessionId, { source: 'voiceCall' })
      } catch {
        patch(sessionId, { notice: 'attach-failed' })
        return
      }
      engine.ref = ref
      const ready = Promise.resolve(ref.ready)
      engine.bindingPromise = ready

      ready
        .then((binding) => {
          if (engine.closed) {
            try {
              ref.release()
            } catch {
              // ignore
            }
            return
          }
          engine.binding = binding
          const face = binding.session
          const readRunning = () => {
            try {
              return Boolean(face.getSnapshot().running)
            } catch {
              return false
            }
          }
          engine.running = readRunning()
          patch(sessionId, { running: engine.running })

          engine.unsubs.push(
            face.subscribe(() => {
              const next = readRunning()
              if (next === engine.running) return
              const was = engine.running
              engine.running = next
              patch(sessionId, { running: next })
              if (was && !next) onAgentSettled(engine)
            }),
          )

          const events = binding.eventSource
          const readEvents = () => {
            try {
              const window = events.getSnapshot()
              if (!window || !Array.isArray(window.entries)) return
              const entries =
                window.entries.length > 200 ? window.entries.slice(window.entries.length - 200) : window.entries
              const text = lastAssistantText({ entries })
              if (text) engine.lastReply = text
            } catch {
              // ignore a reader race
            }
          }
          readEvents()
          engine.unsubs.push(events.subscribe(readEvents))
        })
        .catch(() => {
          if (!engine.closed) patch(sessionId, { notice: 'attach-failed' })
        })
    }

    function lastAssistantText(window) {
      if (!window || !Array.isArray(window.entries)) return ''
      for (let index = window.entries.length - 1; index >= 0; index -= 1) {
        const entry = window.entries[index]
        if (!entry || entry.type !== 'event') continue
        const event = entry.event
        if (!event || event.type !== 'assistant/message') continue
        const content = event.data && event.data.message && event.data.message.content
        if (!Array.isArray(content)) continue
        const text = content
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
          .trim()
        if (text) return text
      }
      return ''
    }

    function onAgentSettled(engine) {
      if (!engine.remote || engine.remote.announce === false) return
      if (engine.userSpeaking) return
      if (engine.responding) {
        engine.pendingAnnounce = true
        return
      }
      announce(engine)
    }

    function announce(engine) {
      const text = compactForSpeech(engine.lastReply || '')
      if (!text) return
      const sent = send(engine, {
        type: 'response.create',
        response: {
          conversation: 'none',
          output_modalities: ['audio'],
          tools: [],
          instructions: ANNOUNCE_INSTRUCTIONS,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: `The agent replied:\n\n${text}\n\nSpeak the short summary now.` }],
            },
          ],
        },
      })
      if (sent) engine.pendingAnnounce = false
    }

    function compactForSpeech(text) {
      return String(text || '')
        .replace(/```[\s\S]*?```/g, ' (code is in the chat) ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_SPEECH)
    }

    // ---------------------------------------------------------------- primitives

    function send(engine, payload) {
      if (!engine || engine.closed || !engine.dc || engine.dc.readyState !== 'open') return false
      try {
        engine.dc.send(JSON.stringify(payload))
        return true
      } catch {
        return false
      }
    }

    function parseJson(text) {
      try {
        const value = JSON.parse(String(text || '{}'))
        return value && typeof value === 'object' ? value : {}
      } catch {
        return {}
      }
    }

    async function readErrorBody(response) {
      try {
        const data = await response.json()
        return data && typeof data === 'object' ? data : {}
      } catch {
        return {}
      }
    }

    /** Map the host's machine-readable error to the bar's error kind. */
    function classifyFailure(status, code) {
      if (code === 'forbidden-origin' || code === 'forbidden-site') return 'forbidden'
      if (code === 'openai-rejected') return 'openai'
      if (code === 'upstream-unreachable' || code === 'upstream-timeout' || code === 'upstream-unreadable') {
        return 'network'
      }
      if (status === 401) return 'credential'
      if (status === 429) return 'rate'
      return 'network'
    }

    function waitForIce(pc) {
      if (pc.iceGatheringState === 'complete') return Promise.resolve()
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pc.removeEventListener('icegatheringstatechange', onState)
          reject(new Error('ICE gathering timed out'))
        }, 10000)
        function onState() {
          if (pc.iceGatheringState !== 'complete') return
          clearTimeout(timeout)
          pc.removeEventListener('icegatheringstatechange', onState)
          resolve()
        }
        pc.addEventListener('icegatheringstatechange', onState)
        onState()
      })
    }

    function stopStream(stream) {
      if (!stream || typeof stream.getTracks !== 'function') return
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {
          // ignore
        }
      }
    }

    function closeEngine(engine) {
      if (!engine || engine.closed) return
      engine.closed = true
      for (const off of engine.unsubs.splice(0)) {
        try {
          off()
        } catch {
          // ignore
        }
      }
      if (engine.announceTimer) {
        clearTimeout(engine.announceTimer)
        engine.announceTimer = null
      }
      try {
        if (engine.dc) engine.dc.close()
      } catch {
        // ignore
      }
      try {
        if (engine.pc) engine.pc.close()
      } catch {
        // ignore
      }
      stopStream(engine.mic)
      if (engine.audio) {
        try {
          engine.audio.pause()
        } catch {
          // ignore
        }
        try {
          engine.audio.srcObject = null
        } catch {
          // ignore
        }
      }
      if (engine.ref) {
        try {
          engine.ref.release()
        } catch {
          // ignore
        }
        engine.ref = null
      }
      engine.binding = null
      engine.dc = null
      engine.pc = null
      engine.mic = null
      engine.audio = null
    }

    function endCall(sessionId) {
      const engine = engines.get(sessionId)
      if (engine) {
        engines.delete(sessionId)
        closeEngine(engine)
      }
      if (calls.delete(sessionId)) emit()
    }

    function failCall(engine, error, detail) {
      const { sessionId } = engine
      closeEngine(engine)
      patch(sessionId, { phase: 'error', error, detail: String(detail || ''), notice: '' })
    }

    function toggleMute(sessionId) {
      const engine = engines.get(sessionId)
      const current = calls.get(sessionId)
      if (!engine || !current || !engine.mic) return
      const next = !current.muted
      for (const track of engine.mic.getAudioTracks()) track.enabled = !next
      patch(sessionId, { muted: next })
    }

    function enableAudio(sessionId) {
      const engine = engines.get(sessionId)
      if (!engine || !engine.audio) return
      try {
        const played = engine.audio.play()
        if (played && typeof played.catch === 'function') {
          played.catch(() => {})
        }
        patch(sessionId, { notice: '' })
      } catch {
        // ignore
      }
    }

    async function saveKey(sessionId, value) {
      const key = String(value || '').trim()
      if (!key) return { ok: false, error: 'empty-key' }
      const current = calls.get(sessionId)
      const apiKeyRef = (current && current.apiKeyRef) || 'OPENAI_API_KEY'
      try {
        await runtime.ctx.remote.credentials.set(apiKeyRef, key)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: messageOf(error) || 'save-failed' }
      }
    }

    // ---------------------------------------------------------------- components

    const CSS = `
.dshvc-button{position:relative;display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .15s ease,background .15s ease}
.dshvc-button:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dshvc-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshvc-button[data-state="live"]{color:var(--dsw-alias-state-success-primary)}
.dshvc-button[data-state="checking"],.dshvc-button[data-state="mic"],.dshvc-button[data-state="connecting"]{color:var(--dsw-alias-brand-primary)}
.dshvc-button[data-state="error"]{color:var(--dsw-alias-state-error-primary)}
.dshvc-button[data-state="setup"]{color:var(--dsw-alias-state-warn-primary)}
.dshvc-dot{position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-success-primary);animation:dshvc-pulse 1.4s ease-in-out infinite}
.dshvc-button[data-state="error"] .dshvc-dot{background:var(--dsw-alias-state-error-primary);animation:none}
@keyframes dshvc-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.72)}}
.dshvc-bar{display:flex;align-items:flex-start;gap:12px;width:100%;box-sizing:border-box;margin:0 0 8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45}
.dshvc-led{flex:none;width:8px;height:8px;margin-top:5px;border-radius:999px;background:var(--dsw-alias-state-idle-primary)}
.dshvc-led[data-phase="live"]{background:var(--dsw-alias-state-success-primary);animation:dshvc-pulse 1.4s ease-in-out infinite}
.dshvc-led[data-phase="checking"],.dshvc-led[data-phase="mic"],.dshvc-led[data-phase="connecting"]{background:var(--dsw-alias-brand-primary);animation:dshvc-pulse 1.4s ease-in-out infinite}
.dshvc-led[data-phase="error"]{background:var(--dsw-alias-state-error-primary)}
.dshvc-led[data-phase="setup"]{background:var(--dsw-alias-state-warn-primary)}
.dshvc-main{flex:1;min-width:0}
.dshvc-line{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dshvc-title{font-weight:600}
.dshvc-timer{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dshvc-sub{margin-top:2px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dshvc-sub[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.dshvc-sub[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.dshvc-actions{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.dshvc-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;font-size:12px;line-height:18px;cursor:pointer}
.dshvc-btn:hover{border-color:var(--dsw-alias-border-l2)}
.dshvc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshvc-btn[data-kind="primary"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:transparent}
.dshvc-btn[data-kind="danger"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:transparent}
.dshvc-btn[disabled]{opacity:.55;cursor:default}
.dshvc-form{display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap}
.dshvc-input{flex:1;min-width:180px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 8px;font-size:12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dshvc-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshvc-note{margin-top:6px;color:var(--dsw-alias-label-secondary);font-size:11px}
.dshvc-note[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.dshvc-note[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
`

    function PhoneIcon(props) {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M6.6 3.6h2.9l1.5 3.9-1.9 1.5a12.4 12.4 0 0 0 6 6l1.5-1.9 3.9 1.5v2.9a2 2 0 0 1-2.2 2A17.6 17.6 0 0 1 4.6 5.8a2 2 0 0 1 2-2.2Z',
        }),
      )
    }

    function VoiceCallButton(props) {
      const sessionId = props && props.sessionId
      const call = useSyncExternalStore(
        subscribe,
        () => snapshot(sessionId),
        () => null,
      )
      const phase = call ? call.phase : 'idle'
      const active = isActive(phase)
      const label = active ? runtime.t('end') : runtime.t('start')
      const onClick = () => {
        if (active) endCall(sessionId)
        else startCall(sessionId)
      }
      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, CSS),
        h(
          'button',
          {
            key: 'button',
            type: 'button',
            className: 'dshvc-button',
            'data-state': phase,
            title: active ? label : runtime.t('startHint'),
            'aria-label': label,
            'aria-pressed': active ? 'true' : 'false',
            onClick,
          },
          h(PhoneIcon),
          active || phase === 'error' || phase === 'setup'
            ? h('span', { className: 'dshvc-dot', 'aria-hidden': 'true' })
            : null,
        ),
      )
    }

    function formatElapsed(startedAt) {
      if (!startedAt) return '0:00'
      const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return `${minutes}:${String(seconds).padStart(2, '0')}`
    }

    function subtitleFor(call) {
      if (!call) return ''
      if (call.notice === 'attach-failed') return runtime.t('attachFailed')
      switch (call.phase) {
        case 'checking':
          return runtime.t('checking')
        case 'mic':
          return runtime.t('mic')
        case 'connecting':
          return runtime.t('connecting')
        case 'setup':
          return runtime.t('setupBody')
        case 'error':
          return detailFor(call)
        case 'live':
          if (call.userSpeaking) return runtime.t('listening')
          if (call.running) return runtime.t('thinking')
          if (call.speaking) return runtime.t('speaking')
          return runtime.t('liveHint')
        default:
          return ''
      }
    }

    function detailFor(call) {
      switch (call.error) {
        case 'mic':
          return runtime.t('errMic')
        case 'host':
          return runtime.t('errHost')
        case 'credential':
          return runtime.t('errCredential')
        case 'rate':
          return runtime.t('errRate')
        case 'forbidden':
          return runtime.t('errForbidden')
        case 'openai':
          return runtime.t('errOpenAI')
        case 'network':
          return runtime.t('errNetwork')
        case 'session':
          return runtime.t('errSession')
        default:
          return call.detail || runtime.t('errGeneric')
      }
    }

    function noticeText(call) {
      if (!call) return ''
      if (call.notice === 'time-limit') return runtime.t('timeLimit')
      if (call.notice === 'autoplay') return runtime.t('autoplay')
      if (call.notice === 'attach-failed') return runtime.t('attachFailed')
      return String(call.detail || call.notice || '')
    }

    function VoiceCallBar(props) {
      const sessionId = props && props.sessionId
      const call = useSyncExternalStore(
        subscribe,
        () => snapshot(sessionId),
        () => null,
      )
      const [tick, setTick] = useState(0)
      const [draft, setDraft] = useState('')
      const [saving, setSaving] = useState(false)
      const [saveError, setSaveError] = useState('')

      const phase = call ? call.phase : 'idle'
      const startedAt = call && call.startedAt ? call.startedAt : 0
      const live = phase === 'live'

      useEffect(() => {
        if (!live || !startedAt) return undefined
        const timer = setInterval(() => {
          setTick((value) => value + 1)
          const elapsed = Date.now() - startedAt
          if (elapsed >= 60 * 60 * 1000) {
            endCall(sessionId)
            return
          }
          if (elapsed >= 55 * 60 * 1000) {
            const current = calls.get(sessionId)
            if (current && current.notice !== 'time-limit') patch(sessionId, { notice: 'time-limit' })
          }
        }, 1000)
        return () => clearInterval(timer)
      }, [live, startedAt, sessionId])

      useEffect(() => {
        if (phase !== 'setup') return
        setSaveError('')
      }, [phase])

      if (!sessionId || !call) return null

      const muted = Boolean(call.muted)
      const notice = call.notice

      const onSave = async () => {
        if (saving) return
        setSaving(true)
        setSaveError('')
        const result = await saveKey(sessionId, draft)
        setSaving(false)
        if (!result.ok) {
          setSaveError(result.error === 'empty-key' ? runtime.t('emptyKey') : result.error)
          return
        }
        setDraft('')
        startCall(sessionId)
      }

      const actions = []
      if (phase === 'setup') {
        actions.push(
          h(
            'button',
            { key: 'save', type: 'button', className: 'dshvc-btn', 'data-kind': 'primary', disabled: saving, onClick: onSave },
            saving ? runtime.t('saving') : runtime.t('save'),
          ),
          h(
            'button',
            { key: 'cancel', type: 'button', className: 'dshvc-btn', onClick: () => endCall(sessionId) },
            runtime.t('cancel'),
          ),
        )
      } else if (phase === 'error') {
        actions.push(
          h(
            'button',
            { key: 'retry', type: 'button', className: 'dshvc-btn', 'data-kind': 'primary', onClick: () => startCall(sessionId) },
            runtime.t('retry'),
          ),
          h(
            'button',
            { key: 'close', type: 'button', className: 'dshvc-btn', onClick: () => endCall(sessionId) },
            runtime.t('close'),
          ),
        )
      } else {
        if (notice === 'autoplay') {
          actions.push(
            h(
              'button',
              { key: 'sound', type: 'button', className: 'dshvc-btn', 'data-kind': 'primary', onClick: () => enableAudio(sessionId) },
              runtime.t('enableSound'),
            ),
          )
        }
        if (live) {
          actions.push(
            h(
              'button',
              {
                key: 'mute',
                type: 'button',
                className: 'dshvc-btn',
                'aria-pressed': muted ? 'true' : 'false',
                onClick: () => toggleMute(sessionId),
              },
              muted ? runtime.t('unmute') : runtime.t('mute'),
            ),
          )
        }
        actions.push(
          h(
            'button',
            { key: 'end', type: 'button', className: 'dshvc-btn', 'data-kind': 'danger', onClick: () => endCall(sessionId) },
            runtime.t('end'),
          ),
        )
      }

      const tone =
        phase === 'error'
          ? 'error'
          : notice === 'autoplay' || notice === 'attach-failed' || notice === 'network-warning'
            ? 'warn'
            : ''

      const title =
        phase === 'setup'
          ? runtime.t('setupTitle')
          : phase === 'error'
            ? runtime.t('errorTitle')
            : runtime.t('start')

      return h(
        'div',
        { className: 'dshvc-bar', role: 'status', 'aria-live': 'polite' },
        h('style', null, CSS),
        h('span', { className: 'dshvc-led', 'data-phase': phase, 'aria-hidden': 'true' }),
        h(
          'div',
          { className: 'dshvc-main' },
          h(
            'div',
            { className: 'dshvc-line' },
            h('span', { className: 'dshvc-title' }, title),
            live && startedAt ? h('span', { className: 'dshvc-timer' }, formatElapsed(startedAt)) : null,
          ),
          h('div', { className: 'dshvc-sub', 'data-tone': tone }, subtitleFor(call)),
          phase === 'error' && call.detail
            ? h('div', { className: 'dshvc-note', 'data-tone': 'error' }, String(call.detail).slice(0, 300))
            : null,
          phase === 'setup'
            ? h(
                'div',
                { className: 'dshvc-form' },
                h('input', {
                  className: 'dshvc-input',
                  type: 'password',
                  autoComplete: 'off',
                  spellCheck: false,
                  'aria-label': runtime.t('keyLabel'),
                  placeholder: runtime.t('keyPlaceholder'),
                  value: draft,
                  disabled: saving,
                  onChange: (event) => setDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void onSave()
                    }
                  },
                }),
              )
            : null,
          saveError ? h('div', { className: 'dshvc-note', 'data-tone': 'error' }, saveError) : null,
          live && call.lastInstruction
            ? h('div', { className: 'dshvc-note' }, `“${String(call.lastInstruction).slice(0, 160)}”`)
            : null,
          phase === 'setup' || live ? h('div', { className: 'dshvc-note' }, runtime.t('privacy')) : null,
          notice && notice !== 'autoplay' && notice !== 'attach-failed'
            ? h('div', { className: 'dshvc-note', 'data-tone': 'warn' }, noticeText(call))
            : null,
        ),
        h('div', { className: 'dshvc-actions' }, actions),
      )
    }

    // ---------------------------------------------------------------- plugin

    function setupLocale(ctx) {
      const fallback = (key) => STRINGS.en[key] ?? key
      try {
        for (const [id, dict] of Object.entries(STRINGS)) ctx.locale.register('voice-call', id, dict)
        const bound = ctx.locale.bind('voice-call')
        return (key) => {
          try {
            const value = bound(key)
            return typeof value === 'string' && value ? value : fallback(key)
          } catch {
            return fallback(key)
          }
        }
      } catch {
        return fallback
      }
    }

    return {
      inject: ['slots', 'sessions', 'locale'],
      apply(ctx) {
        runtime.ctx = ctx
        runtime.t = setupLocale(ctx)

        const disposers = [
          ctx.slots.inject('conversation.input.right', () =>
            ctx.slots.register({ name: 'conversation.input.right', id: 'voice-call', order: -20 }, VoiceCallButton),
          ),
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register({ name: 'conversation.input.dock', id: 'voice-call-bar', order: 20 }, VoiceCallBar),
          ),
        ]

        ctx.effect(() => () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // ignore
            }
          }
          for (const sessionId of Array.from(engines.keys())) {
            try {
              endCall(sessionId)
            } catch {
              // ignore
            }
          }
          listeners.clear()
          runtime.ctx = null
        })
      },
    }
  },
})
