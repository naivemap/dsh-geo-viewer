import { describe, expect, it } from 'vitest'
import { gcj02ToWgs84, wgs84ToGcj02 } from '../src/coords.ts'

describe('coords', () => {
  it('北京天安门偏移量约数百米且往返闭合', () => {
    const [lng, lat] = [116.397428, 39.90923]
    const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat)
    // 偏移在 100m~1km（约 0.001~0.01 度）量级。
    expect(Math.abs(gcjLng - lng)).toBeGreaterThan(0.0005)
    expect(Math.abs(gcjLng - lng)).toBeLessThan(0.01)
    expect(Math.abs(gcjLat - lat)).toBeGreaterThan(0.0005)
    expect(Math.abs(gcjLat - lat)).toBeLessThan(0.01)
    // 逆变换应回到原点附近（亚米级）。
    const [backLng, backLat] = gcj02ToWgs84(gcjLng, gcjLat)
    expect(Math.abs(backLng - lng)).toBeLessThan(0.00001)
    expect(Math.abs(backLat - lat)).toBeLessThan(0.00001)
  })

  it('上海陆家嘴往返闭合', () => {
    const [lng, lat] = [121.5055, 31.2453]
    const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat)
    const [backLng, backLat] = gcj02ToWgs84(gcjLng, gcjLat)
    expect(Math.abs(backLng - lng)).toBeLessThan(0.00001)
    expect(Math.abs(backLat - lat)).toBeLessThan(0.00001)
  })

  it('境外坐标原样返回（无偏移）', () => {
    const [lng, lat] = [-0.1276, 51.5072] // 伦敦
    expect(wgs84ToGcj02(lng, lat)).toEqual([lng, lat])
    expect(gcj02ToWgs84(lng, lat)).toEqual([lng, lat])
  })
})
