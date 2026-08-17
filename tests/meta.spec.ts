import { describe, expect, it } from 'vitest'
import { geoViewMetaFrom, type GeoViewMeta } from '../src/meta.ts'

/** 造一份完整 meta。 */
function sampleMeta(): GeoViewMeta {
  return {
    kind: 'geo-view',
    title: 'Demo',
    sourceKind: 'csv',
    sourceLabel: 'data.csv',
    featureCount: 3,
    bounds: [116, 39, 117, 41],
    geojson: { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { a: 1 } },
    ] },
    styleUrl: 'https://demotiles.maplibre.org/style.json',
    maplibreCdnBase: 'https://unpkg.com/maplibre-gl@5/dist',
    cardHeight: 420,
    artifactPath: 'geo/demo-12345678.geojson',
    columns: ['lat', 'lng'],
  }
}

describe('geoViewMetaFrom', () => {
  it('完好 meta 往返', () => {
    const meta = sampleMeta()
    const out = geoViewMetaFrom(meta)
    expect(out).toEqual(meta)
  })

  it('kind 不符返回 undefined', () => {
    expect(geoViewMetaFrom({ kind: 'other' })).toBeUndefined()
    expect(geoViewMetaFrom(null)).toBeUndefined()
    expect(geoViewMetaFrom('x')).toBeUndefined()
  })

  it('缺少必需字段返回 undefined', () => {
    const meta = sampleMeta() as unknown as Record<string, unknown>
    delete meta['bounds']
    expect(geoViewMetaFrom(meta)).toBeUndefined()
    const meta2 = sampleMeta() as unknown as Record<string, unknown>
    meta2['featureCount'] = 'many'
    expect(geoViewMetaFrom(meta2)).toBeUndefined()
    const meta3 = sampleMeta() as unknown as Record<string, unknown>
    meta3['geojson'] = { type: 'Point', coordinates: [1, 2] }
    expect(geoViewMetaFrom(meta3)).toBeUndefined()
  })

  it('渲染参数缺失时回退默认值（跨版本回放容错）', () => {
    const meta = sampleMeta() as unknown as Record<string, unknown>
    delete meta['styleUrl']
    delete meta['cardHeight']
    const out = geoViewMetaFrom(meta)
    expect(out?.styleUrl).toBe('https://demotiles.maplibre.org/style.json')
    expect(out?.cardHeight).toBe(420)
  })

  it('sourceKind 不在枚举内返回 undefined', () => {
    const meta = sampleMeta() as unknown as Record<string, unknown>
    meta['sourceKind'] = 'shapefile'
    expect(geoViewMetaFrom(meta)).toBeUndefined()
  })
})
