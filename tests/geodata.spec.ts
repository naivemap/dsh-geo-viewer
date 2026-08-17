import { describe, expect, it } from 'vitest'
import {
  boundsOfFeatureCollection,
  detectGeoColumns,
  normalizeGeoJson,
  rowsToFeatureCollection,
} from '../src/geodata.ts'

/** 造一组带经纬度列的行。 */
function rows(overrides: Record<string, Array<string | number>>): Array<Record<string, string | number>> {
  const count = Math.max(...Object.values(overrides).map(v => v.length))
  const out: Array<Record<string, string | number>> = []
  for (let i = 0; i < count; i++) {
    const row: Record<string, string | number> = {}
    for (const [key, values] of Object.entries(overrides)) {
      const v = values[i]
      if (v !== undefined) row[key] = v
    }
    out.push(row)
  }
  return out
}

describe('detectGeoColumns', () => {
  it('识别英文 lat/lng 列头', () => {
    const r = rows({ name: ['a', 'b'], latitude: [39.9, 31.2], longitude: [116.4, 121.5] })
    const d = detectGeoColumns(r)
    expect(d).toEqual({ kind: 'latlng', latColumn: 'latitude', lngColumn: 'longitude', swapped: false })
  })

  it('识别中文经纬度列头', () => {
    const r = rows({ 名称: ['甲', '乙'], 纬度: [39.9, 31.2], 经度: [116.4, 121.5] })
    const d = detectGeoColumns(r)
    expect(d).toEqual({ kind: 'latlng', latColumn: '纬度', lngColumn: '经度', swapped: false })
  })

  it('识别 lon/long 变体', () => {
    const r = rows({ lat: [10, 20], lon: [100, 110] })
    expect(detectGeoColumns(r)).toMatchObject({ latColumn: 'lat', lngColumn: 'lon' })
    const r2 = rows({ lat: [10, 20], long: [100, 110] })
    expect(detectGeoColumns(r2)).toMatchObject({ lngColumn: 'long' })
  })

  it('识别 x/y 配对（x=经度，y=纬度）', () => {
    const r = rows({ x: [116.4, 121.5], y: [39.9, 31.2] })
    const d = detectGeoColumns(r)
    expect(d).toEqual({ kind: 'latlng', latColumn: 'y', lngColumn: 'x', swapped: false })
  })

  it('列头装反时按数值互换', () => {
    // 列头写着 lat 但值是经度（>90），写着 lng 但值是纬度。
    const r = rows({ lat: [116.4, 121.5], lng: [39.9, 31.2] })
    const d = detectGeoColumns(r)
    expect(d).toEqual({ kind: 'latlng', latColumn: 'lng', lngColumn: 'lat', swapped: true })
  })

  it('识别合并坐标列并按第二分量>90判定经度在后', () => {
    const r = rows({ 坐标: ['39.9,116.4', '31.2,121.5'] })
    const d = detectGeoColumns(r)
    expect(d).toEqual({ kind: 'combined', column: '坐标', order: 'lat-first' })
  })

  it('合并坐标列经度在前', () => {
    const r = rows({ coords: ['116.4,39.9', '121.5,31.2'] })
    const d = detectGeoColumns(r)
    expect(d).toEqual({ kind: 'combined', column: 'coords', order: 'lng-first' })
  })

  it('显式覆盖优先', () => {
    const r = rows({ 纬度: [39.9, 31.2], 经度: [116.4, 121.5], 别的: [1, 2] })
    const d = detectGeoColumns(r, { latColumn: '纬度', lngColumn: '经度' })
    expect(d).toMatchObject({ kind: 'latlng', latColumn: '纬度', lngColumn: '经度', swapped: false })
  })

  it('无地理列返回 undefined', () => {
    const r = rows({ name: ['a', 'b'], value: [1, 2] })
    expect(detectGeoColumns(r)).toBeUndefined()
  })

  it('数值脏样本低于门槛判为非地理列', () => {
    const r = rows({ lat: ['abc', 'def'], lng: ['x', 'y'] })
    expect(detectGeoColumns(r)).toBeUndefined()
  })
})

describe('rowsToFeatureCollection', () => {
  it('生成 Point 要素并保留行属性', () => {
    const r = rows({ name: ['甲', '乙'], lat: [39.9, 31.2], lng: [116.4, 121.5] })
    const { fc, skipped } = rowsToFeatureCollection(
      r,
      { kind: 'latlng', latColumn: 'lat', lngColumn: 'lng', swapped: false },
      100,
    )
    expect(skipped).toBe(0)
    expect(fc.features).toHaveLength(2)
    expect(fc.features[0]?.geometry).toEqual({ type: 'Point', coordinates: [116.4, 39.9] })
    expect(fc.features[0]?.properties).toEqual({ name: '甲', lat: 39.9, lng: 116.4 })
  })

  it('跳过无效行并计数', () => {
    const r = rows({ lat: [39.9, 'bad', 31.2], lng: [116.4, 121.5, ''] })
    const { fc, skipped } = rowsToFeatureCollection(
      r,
      { kind: 'latlng', latColumn: 'lat', lngColumn: 'lng', swapped: false },
      100,
    )
    expect(fc.features).toHaveLength(1)
    expect(skipped).toBe(2)
  })

  it('超限抛错并提示配置', () => {
    const r = rows({ lat: [39.9, 31.2], lng: [116.4, 121.5] })
    expect(() => rowsToFeatureCollection(
      r,
      { kind: 'latlng', latColumn: 'lat', lngColumn: 'lng', swapped: false },
      1,
    )).toThrow(/maxFeatures/)
  })

  it('合并坐标列按顺序拆分', () => {
    const r = rows({ 坐标: ['39.9,116.4', '31.2,121.5'] })
    const { fc } = rowsToFeatureCollection(r, { kind: 'combined', column: '坐标', order: 'lat-first' }, 100)
    expect(fc.features[0]?.geometry?.coordinates).toEqual([116.4, 39.9])
  })

  it('(0,0) 占位行在多行数据中被跳过', () => {
    const r = rows({ lat: [39.9, 0], lng: [116.4, 0] })
    const { fc, skipped } = rowsToFeatureCollection(
      r,
      { kind: 'latlng', latColumn: 'lat', lngColumn: 'lng', swapped: false },
      100,
    )
    expect(fc.features).toHaveLength(1)
    expect(skipped).toBe(1)
  })
})

describe('normalizeGeoJson', () => {
  it('FeatureCollection 原样规范化', () => {
    const fc = normalizeGeoJson({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { a: 1 } }],
    }, 100)
    expect(fc.features).toHaveLength(1)
  })

  it('单个 Feature / Geometry 包装为 FC', () => {
    expect(normalizeGeoJson({ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: null }, 10).features).toHaveLength(1)
    expect(normalizeGeoJson({ type: 'Point', coordinates: [1, 2] }, 10).features).toHaveLength(1)
  })

  it('Geometry 数组包装为 FC', () => {
    const fc = normalizeGeoJson([
      { type: 'Point', coordinates: [1, 2] },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { k: 'v' } },
    ], 10)
    expect(fc.features).toHaveLength(2)
    expect(fc.features[1]?.properties).toEqual({ k: 'v' })
  })

  it('超限抛错', () => {
    const fc = { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: null },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [3, 4] }, properties: null },
    ] }
    expect(() => normalizeGeoJson(fc, 1)).toThrow(/maxFeatures/)
  })

  it('不识别形态抛错', () => {
    expect(() => normalizeGeoJson({ hello: 'world' }, 10)).toThrow(/unrecognized/)
    expect(() => normalizeGeoJson({ type: 'FeatureCollection', features: {} }, 10)).toThrow(/features/)
  })
})

describe('boundsOfFeatureCollection', () => {
  it('混合几何深扫求范围并外扩', () => {
    const fc = {
      type: 'FeatureCollection' as const,
      features: [
        { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [116.4, 39.9] }, properties: null },
        { type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [[[121, 31], [122, 30], [121.5, 29.5], [121, 31]]] }, properties: null },
      ],
    }
    const b = boundsOfFeatureCollection(fc)
    expect(b).toBeDefined()
    expect(b?.[0]).toBeLessThan(116.4)
    expect(b?.[1]).toBeLessThan(29.5)
    expect(b?.[2]).toBeGreaterThan(122)
    expect(b?.[3]).toBeGreaterThan(39.9)
  })

  it('无坐标返回 undefined', () => {
    const fc = { type: 'FeatureCollection' as const, features: [
      { type: 'Feature' as const, geometry: null, properties: null },
    ] }
    expect(boundsOfFeatureCollection(fc)).toBeUndefined()
  })
})
