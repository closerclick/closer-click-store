# @gatoseya/closer-click-store

Almacén compartido de hilos de mensajes para el ecosistema [Closer Click](https://github.com/seyacat).

Mismo patrón que [closer-click-identity](https://github.com/seyacat/closer-click-identity): un iframe oculto servido desde `store.closer.click` mantiene los datos en su propio `localStorage`. Cualquier app del ecosistema (web messenger, extensión Chrome, futura app móvil PWA) que cargue este iframe en el mismo navegador comparte los mismos hilos.

## Por qué un subdominio aparte

- Los mensajes son volumen mucho mayor que las claves/contactos. Mantenerlos fuera del vault de identidad evita saturar ese localStorage.
- Cada origen tiene su propia cuota (~5-10 MB en navegadores típicos). Subdominios distintos = sumar cuotas.
- Permite evolucionar el schema de mensajería sin tocar el de identidad (más estable).

## API

```js
import { Store } from '@gatoseya/closer-click-store'

const store = await Store.connect()  // singleton — carga el iframe oculto

// El threadKey lo decide la app (típicamente la pubkey del contacto)
await store.appendMessage(contactPubkey, {
  dir: 'out',
  text: 'hola',
  ts: Date.now()
  // id se autogenera si no lo pasas
})

const entries = await store.listThread(contactPubkey, { limit: 50 })

const summaries = await store.getThreadSummaries()
// → { [pubkey]: { lastEntry, count } }   para sidebar de conversaciones

await store.removeThread(contactPubkey)
await store.clearAll()                    // borrar todo el almacén

const stats = await store.getStats()
// → { totalBytes, threadCount, threads: { [k]: { count, bytes } } }
```

## Garantías

- **Per-thread cap**: 1000 mensajes por defecto, configurable con `setMaxPerThread(n)`. El más antiguo se descarta al añadir uno nuevo si pasa el cap.
- **Eviction global ante `QuotaExceededError`**: el iframe descarta el 20% más antiguo a través de todos los hilos y reintenta hasta 8 veces.
- **No sale del navegador**: nunca se hace fetch, no hay servidor, no hay analytics.

## Deploy

GitHub Actions despliega a `store.closer.click` cuando cambia algo en `store/`. El bundle del iframe es estático (HTML + JS, sin build).

## Schema en localStorage

```
key: cc.store.threads.v1
value: JSON { [threadKey: string]: ThreadEntry[] }
```

Las entradas son objetos opacos para el store; solo se les pide `id` y `ts` para deduplicación y ordenamiento.

## Auto-sync con Google Drive (0.2.0+)

Backup cifrado y sync multi-dispositivo de los hilos contra `appDataFolder` de Google Drive. Mismo modelo y API que [`@gatoseya/closer-click-identity`](https://github.com/seyacat/closer-click-identity#auto-sync-con-google-drive-080) — los mensajes se cifran con AES-256-GCM (clave derivada por PBKDF2 600 000 iter de la passphrase) antes de subirse, así que Google solo ve bytes opacos.

```js
await store.syncConnect(clientId)              // OAuth popup (scope: drive.appdata)
await store.syncUnlock('mi-passphrase')        // ≥12 chars
store.onSync(ev => console.log(ev.status))    // syncing | synced | offline | conflict | error
await store.syncNow()                          // forzar pull+push
```

**Merge de hilos**: unión por `id`, dedup, last-writer por `ts`, ordena ascendente, aplica `maxPerThread` después del merge. Append-only así que el merge es trivial — si dos dispositivos añaden mensajes a la vez, el resultado contiene los dos sets sin pérdida.

Nuevos métodos también para export/import manual:

```js
const { threads } = await store.exportThreads()
await store.importThreads(threads, 'merge')   // o 'replace'
```
