import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { geoViewTool, type GeoToolOptions } from '../src/tool.ts'

/** 完整插件配置投影（默认值同 src/index.ts）。 */
const OPTIONS: GeoToolOptions = {
  mapStyleUrl: 'https://demotiles.maplibre.org/style.json',
  maplibreCdnBase: 'https://unpkg.com/maplibre-gl@5/dist',
  cardHeight: 420,
  maxFeatures: 10000,
  maxBytes: 4000000,
  maxGeocodeRows: 100,
  geocodingProvider: 'nominatim',
  geocodingKey: '',
  geocodingBaseUrl: '',
}

/** 内存文件系统 mock。 */
function makeCtx(files: Map<string, string | Uint8Array>): { ctx: Context, written: Array<[string, string]> } {
  const written: Array<[string, string]> = []
  const target = (p: string): FsTarget => ({ displayPath: p } as FsTarget)
  const ctx = {
    fs: {
      resolve: async (p: string) => target(p),
      readText: async (t: FsTarget) => {
        const v = files.get(t.displayPath)
        if (typeof v !== 'string') throw new Error(`no text file: ${t.displayPath}`)
        return v
      },
      readBytes: async (t: FsTarget) => {
        const v = files.get(t.displayPath)
        if (!(v instanceof Uint8Array)) throw new Error(`no binary file: ${t.displayPath}`)
        return v
      },
      writeText: async (t: FsTarget, content: string) => {
        written.push([t.displayPath, content])
      },
    },
    get: () => undefined,
  } as unknown as Context
  return { ctx, written }
}

/** 最小 exec：无 agent（cwd 未定）、可中止信号。 */
function makeExec(): never {
  return { signal: new AbortController().signal } as never
}

/** 以宽松类型调用 execute（ToolDefinition 的外部形状是 unknown，测试只做运行时断言）。 */
async function run(tool: ReturnType<typeof geoViewTool>, args: Record<string, unknown>): Promise<any> {
  return await tool.execute(args as never, makeExec())
}

describe('geo_view execute', () => {
  it('内联 CSV：检测经纬度列并产出要素与制品', async () => {
    const { ctx, written } = makeCtx(new Map())
    const tool = geoViewTool(ctx, () => OPTIONS)
    const value = await run(tool, { data: 'name,纬度,经度\n甲,39.9,116.4\n乙,31.2,121.5\n', title: '内联示例' })
    expect(value.featureCount).toBe(2)
    expect(value.sourceKind).toBe('inline-csv')
    expect(value.latColumn).toBe('纬度')
    expect(value.lngColumn).toBe('经度')
    expect(value.bounds[0]).toBeLessThanOrEqual(116.4)
    expect(value.bounds[2]).toBeGreaterThanOrEqual(121.5)
    expect(written).toHaveLength(1)
    expect(written[0]?.[0]).toMatch(/^geo\/.+-[0-9a-f]{8}\.geojson$/)
    expect(written[0]?.[1]).toContain('"FeatureCollection"')
  })

  it('规范值携带 GeoJSON（presentationMeta 的投影源，回放契约）', async () => {
    const { ctx } = makeCtx(new Map())
    const tool = geoViewTool(ctx, () => OPTIONS)
    const value = await run(tool, { data: 'lat,lng\n10,20\n-5,30\n' })
    expect(value.geojson).toMatchObject({ type: 'FeatureCollection' })
    expect(value.sourceKind).toBe('inline-csv')
  })

  it('CSV 文件路径来源', async () => {
    const files = new Map([['data.csv', 'city,lat,lng\n北京,39.9,116.4\n上海,31.2,121.5\n杭州,30.3,120.2\n']])
    const { ctx, written } = makeCtx(files)
    const tool = geoViewTool(ctx, () => OPTIONS)
    const value = await run(tool, { path: 'data.csv' })
    expect(value.featureCount).toBe(3)
    expect(value.sourceKind).toBe('csv')
    expect(value.sourceLabel).toBe('data.csv')
    expect(written[0]?.[1]).toContain('"FeatureCollection"')
  })

  it('XLSX 文件来源（真实 exceljs 产物）', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sheet1')
    sheet.addRow(['名称', '纬度', '经度'])
    sheet.addRow(['甲', 39.9, 116.4])
    sheet.addRow(['乙', 31.2, 121.5])
    const buffer = await workbook.xlsx.writeBuffer()
    const files = new Map([['points.xlsx', new Uint8Array(buffer)]])
    const { ctx } = makeCtx(files)
    const tool = geoViewTool(ctx, () => OPTIONS)
    const value = await run(tool, { path: 'points.xlsx' })
    expect(value.sourceKind).toBe('xlsx')
    expect(value.featureCount).toBe(2)
    expect(value.latColumn).toBe('纬度')
    expect(value.geojson.features[0]?.properties).toMatchObject({ 名称: '甲' })
  })

  it('GeoJSON 文件来源', async () => {
    const files = new Map([['area.geojson', JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[116, 39], [117, 39], [116.5, 40], [116, 39]]] }, properties: { name: 'demo' } },
      ],
    })]])
    const { ctx } = makeCtx(files)
    const tool = geoViewTool(ctx, () => OPTIONS)
    const value = await run(tool, { path: 'area.geojson' })
    expect(value.sourceKind).toBe('geojson')
    expect(value.featureCount).toBe(1)
  })

  it('参数互斥校验', async () => {
    const { ctx } = makeCtx(new Map())
    const tool = geoViewTool(ctx, () => OPTIONS)
    await expect(run(tool, {})).rejects.toThrow(/exactly one/)
    await expect(run(tool, { path: 'a.csv', data: 'lat,lng\n1,2' })).rejects.toThrow(/mutually exclusive/)
  })

  it('无地理列表头时给出可操作报错', async () => {
    const files = new Map([['plain.csv', 'name,score\na,1\nb,2\n']])
    const { ctx } = makeCtx(files)
    const tool = geoViewTool(ctx, () => OPTIONS)
    await expect(run(tool, { path: 'plain.csv' })).rejects.toThrow(/latColumn/)
  })

  it('地址列走地理编码：amap 缺 key 响亮报错', async () => {
    const files = new Map([['addr.csv', 'name,address\na,北京市\nb,上海市\n']])
    const { ctx } = makeCtx(files)
    const tool = geoViewTool(ctx, () => ({ ...OPTIONS, geocodingProvider: 'amap', geocodingKey: '' }))
    await expect(run(tool, { path: 'addr.csv' })).rejects.toThrow(/geocodingKey/)
  })
})
