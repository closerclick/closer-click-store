export interface ThreadEntry {
  id?: string
  ts?: number
  [k: string]: any
}

export interface StoreOptions {
  storeUrl?: string
  timeoutMs?: number
}

export interface ThreadSummary {
  lastEntry: ThreadEntry | null
  count: number
}

export interface ThreadStats {
  count: number
  bytes: number
}

export interface StoreStats {
  totalBytes: number
  threadCount: number
  threads: Record<string, ThreadStats>
}

export class Store {
  constructor (options?: StoreOptions)
  static connect (options?: StoreOptions): Promise<Store>
  static current (): Store | null
  ready (): Promise<Store>
  destroy (): void
  ping (): Promise<{ pong: true; version: string }>
  setMaxPerThread (max: number): Promise<{ maxPerThread: number }>
  appendMessage (threadKey: string, entry: ThreadEntry): Promise<ThreadEntry>
  listThread (
    threadKey: string,
    opts?: { limit?: number; before?: number }
  ): Promise<ThreadEntry[]>
  listThreadKeys (): Promise<string[]>
  getThreadSummaries (): Promise<Record<string, ThreadSummary>>
  removeThread (threadKey: string): Promise<{ removed: number }>
  removeMessage (threadKey: string, id: string): Promise<{ removed: number }>
  clearAll (): Promise<{ ok: true }>
  getStats (): Promise<StoreStats>
}
