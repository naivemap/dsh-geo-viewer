import { afterEach, describe, expect, it, vi } from 'vitest'
import { geocodeAddresses } from '../src/geocode.ts'

/** fetch mock：可调用且暴露 vi 的 calls 记录。 */
type FetchMock = typeof fetch & { mock: { calls: Array<unknown[]> } }

/** 替换全局 fetch。 */
function mockFetch(handler: (url: string) => { status?: number, body: unknown } | undefined): FetchMock {
  const impl = vi.fn(async (...fetchArgs: Parameters<typeof fetch>): Promise<Response> => {
    const url = String(fetchArgs[0])
    const hit = handler(url)
    if (hit === undefined) throw new Error(`unexpected fetch: ${url}`)
    return new Response(JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as FetchMock
  vi.stubGlobal('fetch', impl)
  return impl
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('geocodeAddresses', () => {
  it('nominatim：解析 lat/lon/display_name', async () => {
    const fetchMock = mockFetch(url => {
      if (!url.startsWith('https://nominatim.openstreetmap.org/search')) return undefined
      return { body: [{ lat: '39.9042', lon: '116.4074', display_name: 'Beijing, China' }] }
    })
    const [p] = await geocodeAddresses(['北京市'], { provider: 'nominatim', key: '', baseUrl: undefined })
    expect(p).toEqual({ lat: 39.9042, lng: 116.4074, label: 'Beijing, China' })
    expect(fetchMock.mock.calls.length).toBe(1)
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toContain(encodeURIComponent('北京市'))
  })

  it('maptiler：解析 features[0].center', async () => {
    mockFetch(url => {
      if (!url.startsWith('https://api.maptiler.com/geocoding/')) return undefined
      expect(url).toContain('key=TEST_KEY')
      return { body: { features: [{ place_name: 'Shanghai', center: [121.4737, 31.2304] }] } }
    })
    const [p] = await geocodeAddresses(['上海'], { provider: 'maptiler', key: 'TEST_KEY', baseUrl: undefined })
    expect(p).toEqual({ lat: 31.2304, lng: 121.4737, label: 'Shanghai' })
  })

  it('amap：解析 location 并做 GCJ02->WGS84', async () => {
    mockFetch(url => {
      if (!url.startsWith('https://restapi.amap.com/v3/geocode/geo')) return undefined
      return { body: { status: '1', geocodes: [{ formatted_address: '北京市人民政府', location: '116.397428,39.90923' }] } }
    })
    const [p] = await geocodeAddresses(['北京市人民政府'], { provider: 'amap', key: 'K', baseUrl: undefined })
    expect(p).not.toBeNull()
    // GCJ02 的天安门坐标应被拉回 WGS84 原点附近（西/南偏移）。
    expect(p!.lng).toBeLessThan(116.397428)
    expect(p!.lat).toBeLessThan(39.90923)
    expect(p!.label).toBe('北京市人民政府')
  })

  it('需要 key 的供应商缺 key 响亮报错', async () => {
    await expect(geocodeAddresses(['x'], { provider: 'amap', key: '', baseUrl: undefined }))
      .rejects.toThrow(/geocodingKey/)
  })

  it('未命中降级为 null 不中断批次', async () => {
    mockFetch(url => {
      if (url.includes('q=')) return { body: [] }
      return undefined
    })
    const result = await geocodeAddresses(['a', 'b', 'c'], { provider: 'nominatim', key: '', baseUrl: undefined })
    expect(result).toEqual([null, null, null])
  })

  it('单条 HTTP 失败降级为 null', async () => {
    mockFetch(() => ({ status: 503, body: { error: 'upstream' } }))
    const result = await geocodeAddresses(['a'], { provider: 'nominatim', key: '', baseUrl: undefined })
    expect(result).toEqual([null])
  })

  it('baseUrl 覆盖默认端点', async () => {
    const fetchMock = mockFetch(url => {
      if (url.startsWith('https://geo.example.com/search')) return { body: [{ lat: '1', lon: '2', display_name: 'x' }] }
      return undefined
    })
    await geocodeAddresses(['q'], { provider: 'nominatim', key: '', baseUrl: 'https://geo.example.com/' })
    expect(fetchMock.mock.calls.length).toBe(1)
  })
})
