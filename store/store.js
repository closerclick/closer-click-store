// Closer Click — Message Store iframe.
//
// Persistencia en `localStorage` de este origen, así todas las instancias
// del messenger en el mismo navegador (web, extensión, otra pestaña) ven
// los mismos hilos.
//
// Esquema:
//   `cc.store.threads`  → JSON `{ [threadKey: string]: ThreadEntry[] }`
//
// El threadKey lo decide la app que llama (típicamente la pubkey JWK del
// contacto). Las entradas son objetos opacos para este store; solo se le
// pide tener `id` y `ts` para deduplicación y sort.

import { createSync } from './sync.js'

const KEY = 'cc.store.threads.v1'
const MAX_PER_THREAD_DEFAULT = 1000
let maxPerThread = MAX_PER_THREAD_DEFAULT
let sync = null

// ----- helpers -----

function loadAll () {
  try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : {} }
  catch { return {} }
}
function isQuotaError (e) {
  return e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014 || /quota/i.test(e.message || ''))
}
function bytesOfString (s) { return new Blob([s]).size }
function dropOldest (data, fraction = 0.2) {
  // Aplana todas las entradas, ordena por ts asc, descarta los primeros N%
  const flat = []
  for (const [k, arr] of Object.entries(data)) {
    for (const e of arr) flat.push({ k, ts: e.ts || 0, id: e.id })
  }
  if (flat.length === 0) return false
  flat.sort((a, b) => a.ts - b.ts)
  const toDrop = Math.max(1, Math.floor(flat.length * fraction))
  const drop = new Set(flat.slice(0, toDrop).map(x => x.k + '|' + x.id))
  for (const k of Object.keys(data)) {
    data[k] = data[k].filter(e => !drop.has(k + '|' + e.id))
    if (data[k].length === 0) delete data[k]
  }
  return true
}
function persist (data, { silent = false } = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data))
      if (!silent && sync) sync.markDirty()
      return true
    }
    catch (e) {
      if (!isQuotaError(e)) { console.warn('[store] persist failed:', e); return false }
      if (!dropOldest(data, 0.2)) { console.warn('[store] quota — nothing left to evict'); return false }
    }
  }
  console.warn('[store] persist gave up after 8 eviction rounds'); return false
}

// ----- merge for sync -----

function mergeThreads (localThreads, remoteThreads) {
  const out = { ...localThreads }
  let changed = false
  const allKeys = new Set([...Object.keys(localThreads || {}), ...Object.keys(remoteThreads || {})])
  for (const k of allKeys) {
    const a = localThreads[k] || []
    const b = remoteThreads[k] || []
    if (b.length === 0) continue
    if (a.length === 0) { out[k] = [...b].sort((x, y) => (x.ts || 0) - (y.ts || 0)); changed = true; continue }
    const byId = new Map()
    for (const e of a) if (e?.id) byId.set(e.id, e)
    let added = 0
    for (const e of b) {
      if (!e?.id) continue
      const prev = byId.get(e.id)
      if (!prev) { byId.set(e.id, e); added++ }
      else if ((e.ts || 0) > (prev.ts || 0)) { byId.set(e.id, e); added++ }
    }
    if (added > 0) {
      const merged = Array.from(byId.values()).sort((x, y) => (x.ts || 0) - (y.ts || 0))
      if (merged.length > maxPerThread) merged.splice(0, merged.length - maxPerThread)
      out[k] = merged
      changed = true
    }
  }
  return { merged: out, changed }
}

async function exportLocalForSync () {
  return { threads: loadAll() }
}

async function applyMergedFromSync (mergedState) {
  if (mergedState && mergedState.threads) {
    persist(mergedState.threads, { silent: true })
  }
}

async function mergeForSync (local, remote) {
  if (!remote) return { merged: local, changed: false }
  const { merged, changed } = mergeThreads(local.threads || {}, remote.threads || {})
  return { merged: { threads: merged }, changed }
}
function trimThread (arr, cap) {
  if (arr.length > cap) arr.splice(0, arr.length - cap)
}

// ----- handlers -----

const handlers = {
  async ping () { return { pong: true, version: '0.2.0' } },

  // ----- export / import (used by sync, also exposed to apps) -----

  async exportThreads () { return { threads: loadAll() } },
  async importThreads ({ threads, mode = 'merge' }) {
    if (!threads || typeof threads !== 'object') throw new Error('threads required')
    if (mode === 'replace') { persist(threads); return { mode, count: Object.keys(threads).length } }
    const local = loadAll()
    const { merged } = mergeThreads(local, threads)
    persist(merged)
    return { mode, count: Object.keys(merged).length }
  },

  // ----- Drive sync -----

  async syncConnect ({ clientId }) {
    if (!sync) throw new Error('sync not ready')
    return sync.connectGoogle(clientId)
  },
  async syncDisconnect () { if (sync) return sync.disconnectGoogle() },
  async syncUnlock ({ passphrase }) {
    if (!sync) throw new Error('sync not ready')
    return sync.unlock(passphrase)
  },
  async syncLock () { if (sync) return sync.lock() },
  async syncStatus () { return sync ? sync.getStatus() : { connected: false, unlocked: false, dirty: false } },
  async syncNow () {
    if (!sync) throw new Error('sync not ready')
    await sync.pull(); await sync.push(); return sync.getStatus()
  },


  async setMaxPerThread ({ max }) {
    maxPerThread = Math.max(1, Math.min(50000, Number(max) || MAX_PER_THREAD_DEFAULT))
    return { maxPerThread }
  },

  async appendMessage ({ threadKey, entry }) {
    if (!threadKey || typeof threadKey !== 'string') throw new Error('threadKey required')
    if (!entry || typeof entry !== 'object') throw new Error('entry required')
    if (!entry.id) entry.id = crypto.randomUUID()
    if (!entry.ts) entry.ts = Date.now()
    const data = loadAll()
    if (!data[threadKey]) data[threadKey] = []
    // Dedup por id
    const existing = data[threadKey].findIndex(e => e.id === entry.id)
    if (existing >= 0) data[threadKey][existing] = { ...data[threadKey][existing], ...entry }
    else data[threadKey].push(entry)
    trimThread(data[threadKey], maxPerThread)
    persist(data)
    return entry
  },

  async listThread ({ threadKey, limit, before }) {
    if (!threadKey) return []
    const data = loadAll()
    let arr = data[threadKey] || []
    if (typeof before === 'number') arr = arr.filter(e => (e.ts || 0) < before)
    if (typeof limit === 'number' && limit > 0) arr = arr.slice(-limit)
    return arr
  },

  async listThreadKeys () {
    return Object.keys(loadAll())
  },

  /**
   * Devuelve { [threadKey]: { lastEntry, count } } para construir la sidebar
   * de la app sin tener que pedir cada hilo entero.
   */
  async getThreadSummaries () {
    const data = loadAll()
    const out = {}
    for (const [k, arr] of Object.entries(data)) {
      out[k] = {
        lastEntry: arr.length ? arr[arr.length - 1] : null,
        count: arr.length
      }
    }
    return out
  },

  async removeThread ({ threadKey }) {
    if (!threadKey) return { removed: 0 }
    const data = loadAll()
    const removed = data[threadKey]?.length || 0
    delete data[threadKey]
    persist(data)
    return { removed }
  },

  async removeMessage ({ threadKey, id }) {
    if (!threadKey || !id) return { removed: 0 }
    const data = loadAll()
    const arr = data[threadKey] || []
    const before = arr.length
    data[threadKey] = arr.filter(e => e.id !== id)
    if (data[threadKey].length === 0) delete data[threadKey]
    persist(data)
    return { removed: before - (data[threadKey]?.length || 0) }
  },

  async clearAll () {
    localStorage.removeItem(KEY)
    return { ok: true }
  },

  /** Tamaño total + por hilo. Útil para mostrar "uso de almacenamiento". */
  async getStats () {
    const raw = localStorage.getItem(KEY) || ''
    const totalBytes = bytesOfString(raw)
    const data = loadAll()
    const threads = {}
    for (const [k, arr] of Object.entries(data)) {
      threads[k] = {
        count: arr.length,
        bytes: bytesOfString(JSON.stringify(arr))
      }
    }
    return { totalBytes, threadCount: Object.keys(data).length, threads }
  }
}

// ----- bootstrap -----

sync = createSync({
  fileName: 'closerclick-store-backup.json',
  kind: 'store',
  exportLocal: exportLocalForSync,
  applyMerged: applyMergedFromSync,
  mergeFn: mergeForSync
})

sync.onStatus((payload) => {
  if (window.parent && window.parent !== window) {
    try { window.parent.postMessage({ _ccs: true, type: 'event', event: 'sync', payload }, '*') } catch {}
  }
})

window.addEventListener('message', async (event) => {
  const msg = event.data
  if (!msg || msg._ccs !== true || msg.type !== 'request') return
  const { id, method, params } = msg
  const reply = (payload) => event.source?.postMessage(
    { _ccs: true, type: 'response', id, ...payload },
    event.origin
  )
  const handler = handlers[method]
  if (!handler) return reply({ error: `Unknown method: ${method}` })
  try { reply({ result: await handler(params || {}) }) }
  catch (e) { reply({ error: e?.message || String(e) }) }
})

// Notify parent we are ready
if (window.parent && window.parent !== window) {
  window.parent.postMessage({ _ccs: true, type: 'ready', version: '0.1.0' }, '*')
}
