/**
 * 地理编码适配层（宿主半侧，Node fetch）。
 *
 * 三家供应商，各自默认端点与限速：
 * - nominatim（默认，免费无 key）：OpenStreetMap 公共实例，约定 1 req/s + 明确 UA。
 * - maptiler：与 maplibre 底图生态配套，需 key。
 * - amap（高德）：国内地址效果最好，需 key，返回 GCJ-02（统一转回 WGS-84）。
 *
 * @module dsh-geo-viewer/geocode
 */
import { gcj02ToWgs84 } from './coords.ts'

/** 供应商线名。 */
export type GeocodeProvider = 'nominatim' | 'maptiler' | 'amap'

/** 地理编码配置（来自插件 Config 的扁平键）。 */
export interface GeocodeOptions {
  provider: GeocodeProvider
  /** maptiler/amap 必填；nominatim 忽略。 */
  key: string
  /** 覆盖默认端点（自建反代/私有化实例时用）。 */
  baseUrl: string | undefined
}

/** 单条编码结果。 */
export interface GeocodedPoint {
  lat: number
  lng: number
  /** 供应商返回的可读地名。 */
  label: string
}

/** 每家供应商的行为描述。 */
interface ProviderSpec {
  requiresKey: boolean
  /** 相邻请求最小间隔（ms）。 */
  intervalMs: number
  /** 单请求超时（ms）。 */
  timeoutMs: number
  endpoint: (q: string, opts: GeocodeOptions) => { url: string, init: RequestInit }
  /** 从响应体取首个结果；未命中返回 null。 */
  pick: (body: unknown, url: string) => GeocodedPoint | null
  /** amap 返回 GCJ-02，需要坐标转换。 */
  toWgs84: boolean
}

const USER_AGENT = 'dsh-geo-viewer/0.1.0 (DeepSeek Harness plugin)'

const SPECS: Record<GeocodeProvider, ProviderSpec> = {
  nominatim: {
    requiresKey: false,
    intervalMs: 1100,
    timeoutMs: 15000,
    endpoint: (q, opts) => {
      const base = (opts.baseUrl?.trim() || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '')
      const url = `${base}/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=1&accept-language=auto`
      return { url, init: { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } } }
    },
    pick: body => {
      if (!Array.isArray(body) || body.length === 0) return null
      const hit = body[0] as Record<string, unknown>
      const lat = Number(hit['lat'])
      const lng = Number(hit['lon'])
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
      return { lat, lng, label: typeof hit['display_name'] === 'string' ? hit['display_name'] : '' }
    },
    toWgs84: false,
  },
  maptiler: {
    requiresKey: true,
    intervalMs: 250,
    timeoutMs: 15000,
    endpoint: (q, opts) => {
      const base = (opts.baseUrl?.trim() || 'https://api.maptiler.com').replace(/\/+$/, '')
      const url = `${base}/geocoding/${encodeURIComponent(q)}.json?key=${encodeURIComponent(opts.key)}&limit=1`
      return { url, init: { headers: { Accept: 'application/json' } } }
    },
    pick: body => {
      if (typeof body !== 'object' || body === null) return null
      const features = (body as Record<string, unknown>)['features']
      if (!Array.isArray(features) || features.length === 0) return null
      const hit = features[0] as Record<string, unknown>
      const center = hit['center']
      if (!Array.isArray(center) || center.length < 2) return null
      const lng = Number(center[0])
      const lat = Number(center[1])
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
      return { lat, lng, label: typeof hit['place_name'] === 'string' ? hit['place_name'] : '' }
    },
    toWgs84: false,
  },
  amap: {
    requiresKey: true,
    intervalMs: 300,
    timeoutMs: 15000,
    endpoint: (q, opts) => {
      const base = (opts.baseUrl?.trim() || 'https://restapi.amap.com').replace(/\/+$/, '')
      const url = `${base}/v3/geocode/geo?address=${encodeURIComponent(q)}&key=${encodeURIComponent(opts.key)}`
      return { url, init: { headers: { Accept: 'application/json' } } }
    },
    pick: (body, url) => {
      if (typeof body !== 'object' || body === null) return null
      const record = body as Record<string, unknown>
      if (record['status'] !== '1') return null
      const geocodes = record['geocodes']
      if (!Array.isArray(geocodes) || geocodes.length === 0) return null
      const hit = geocodes[0] as Record<string, unknown>
      const location = hit['location']
      if (typeof location !== 'string') return null
      const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(location)
      if (m === null) return null
      const gcjLng = Number(m[1])
      const gcjLat = Number(m[2])
      if (!Number.isFinite(gcjLat) || !Number.isFinite(gcjLng)) return null
      const [lng, lat] = gcj02ToWgs84(gcjLng, gcjLat)
      const label = typeof hit['formatted_address'] === 'string' ? hit['formatted_address'] : ''
      void url
      return { lat, lng, label }
    },
    toWgs84: true,
  },
}

/** 组合外部取消信号与单请求超时。 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 批量地理编码：逐条请求、按供应商约定限速、失败返回 null 不中断批次。
 *
 * @param addresses 地址/地名列表。
 * @param opts 供应商配置。
 * @param signal 外部取消信号（工具 exec.signal）。
 * @param onProgress 每条完成后的进度回调（序号从 1 起）。
 * @returns 与输入等长的结果数组（失败项为 null）。
 * @throws Error 供应商需要 key 而未配置，或外部信号取消。
 */
export async function geocodeAddresses(
  addresses: readonly string[],
  opts: GeocodeOptions,
  signal?: AbortSignal,
  onProgress?: (index: number, total: number) => void,
): Promise<(GeocodedPoint | null)[]> {
  const spec = SPECS[opts.provider]
  if (spec === undefined) throw new Error(`unknown geocoding provider: ${opts.provider}`)
  if (spec.requiresKey && opts.key.trim() === '') {
    throw new Error(
      `geocoding provider "${opts.provider}" requires a key - set the dsh-geo-viewer `
      + '`geocodingKey` config, or switch `geocodingProvider` to "nominatim" (keyless)',
    )
  }
  const out: (GeocodedPoint | null)[] = []
  for (const [i, address] of addresses.entries()) {
    if (i > 0) await sleep(spec.intervalMs, signal)
    const q = address.trim()
    if (q === '') {
      out.push(null)
      onProgress?.(i + 1, addresses.length)
      continue
    }
    const { url, init } = spec.endpoint(q, opts)
    try {
      const response = await fetch(url, { ...init, signal: withTimeout(signal, spec.timeoutMs) })
      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}`)
      }
      const body: unknown = await response.json()
      const picked = spec.pick(body, url)
      out.push(picked)
    } catch (error) {
      if (signal?.aborted) throw error
      // 单条失败降级为 null：批次的其余地址继续。
      out.push(null)
    }
    onProgress?.(i + 1, addresses.length)
  }
  return out
}
