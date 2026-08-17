/**
 * 模型可见的 `geo_view` 工具：识别对话中的地理数据并在对话流渲染交互式
 * 地图卡片。三种输入互斥（执行期校验"恰好其一"）：
 *
 * - `path`：工作区文件（.csv/.tsv/.xlsx/.geojson/.json），自动识别经纬度列；
 * - `data`：内联数据（CSV 文本或 GeoJSON JSON 字符串）；
 * - `addresses`：地名/地址列表，走插件配置的地理编码供应商。
 *
 * 表格来源在未检出经纬度列时，若模型给了 `addressColumn`（或表头含明确
 * 地址列），可用地理编码兜底定位。结果 FeatureCollection 同时进入：
 * - 规范值（模型/Code Mode 可编程访问）；
 * - presentationMeta（浏览器半侧卡片渲染 + 会话回放按字节重现）；
 * - 工作区导出 geo/<slug>-<hash>.geojson（用户可取用的制品）。
 *
 * @module dsh-geo-viewer/tool
 */
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
// 仅类型：引入 ctx.get('sandboxPolicy') 的 Context 合并声明。
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import Papa from 'papaparse'
// exceljs 为 CJS 包：ESM 下命名导入在 Node 运行时不可靠（cjs-module-lexer 探测
// 不到），必须走默认导入再取命名空间。
import ExcelJS from 'exceljs'
import { GEO_VIEW_TOOL_NAME, type GeoJsonFeature, type GeoJsonFeatureCollection, type GeoSourceKind } from './meta.ts'
import {
  boundsOfFeatureCollection,
  detectGeoColumns,
  normalizeGeoJson,
  rowsToFeatureCollection,
  type TableRow,
} from './geodata.ts'
import { geocodeAddresses, type GeocodeProvider } from './geocode.ts'

/** 工具执行所需的插件配置投影。 */
export interface GeoToolOptions {
  mapStyleUrl: string
  maplibreCdnBase: string
  cardHeight: number
  maxFeatures: number
  maxBytes: number
  maxGeocodeRows: number
  geocodingProvider: GeocodeProvider
  geocodingKey: string
  geocodingBaseUrl: string
}

const DESCRIPTION =
  'Render geographic data as an interactive map card in the conversation. Call this '
  + 'whenever the user mentions plotting/mapping geographic data - latitude/longitude '
  + 'tables, GeoJSON, or place names. Sources (pick exactly one): `path` for a workspace '
  + 'file (.csv/.tsv/.xlsx/.geojson/.json - coordinate columns are auto-detected from '
  + 'headers like lat/lng/latitude/longitude/经度/纬度/x/y/坐标), `data` for inline CSV '
  + 'text or GeoJSON JSON, or `addresses` for a list of place names to geocode and plot. '
  + 'For tables whose rows have no coordinates but an address column, pass `addressColumn` '
  + 'to geocode them (needs the provider key configured in the plugin). Use '
  + '`latColumn`/`lngColumn` when auto-detection picks the wrong columns. The card '
  + 'supports zoom/pan, feature inspection, and fullscreen; a .geojson copy is exported '
  + 'to the workspace.'

/**
 * 构造 geo_view 工具定义。
 * @param ctx 注册上下文（提供 ctx.fs 与 sandboxPolicy 解析）。
 * @param options 插件配置投影。
 * @returns 注册到 ctx.tools 的工具定义。
 */
export function geoViewTool(ctx: Context, options: GeoToolOptions): ToolDefinition {
  return defineTool({
    name: GEO_VIEW_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      path: {
        type: 'string',
        description: 'Workspace file path (.csv/.tsv/.xlsx/.geojson/.json). Mutually exclusive with `data` and `addresses`.',
      },
      data: {
        type: 'string',
        description: 'Inline data: either GeoJSON JSON (starts with { or [) or CSV text. Mutually exclusive with `path` and `addresses`.',
      },
      addresses: {
        type: 'array',
        items: { type: 'string' },
        description: 'Place names or addresses to geocode and plot as points. Mutually exclusive with `path` and `data`.',
      },
      latColumn: { type: 'string', description: 'Explicit latitude column name for table sources (overrides auto-detection).' },
      lngColumn: { type: 'string', description: 'Explicit longitude column name for table sources (overrides auto-detection).' },
      addressColumn: { type: 'string', description: 'Column containing addresses to geocode, for tables without coordinates.' },
      title: { type: 'string', description: 'Concise card title.' },
      styleUrl: { type: 'string', description: 'One-off MapLibre StyleJSON URL overriding the plugin default for this card.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          sourceKind: { type: 'string', required: true, enum: ['csv', 'tsv', 'xlsx', 'geojson', 'inline-csv', 'inline-geojson', 'addresses'] },
          sourceLabel: { type: 'string', required: true },
          featureCount: { type: 'integer', required: true },
          skippedRows: { type: 'integer', required: true },
          columns: { type: 'array', required: true, items: { type: 'string' } },
          latColumn: { type: 'string' },
          lngColumn: { type: 'string' },
          addressColumn: { type: 'string' },
          geocodedCount: { type: 'integer' },
          geocodeFailed: { type: 'integer' },
          bounds: { type: 'array', required: true, items: { type: 'number' } },
          artifactPath: { type: 'string', required: true },
          geojson: { type: 'object', required: true, additionalProperties: true },
          note: { type: 'string' },
        },
      },
      // 面向模型的文本只做一行摘要：geojson 本体已在规范值与 meta 中，复读会
      // 双倍上下文成本。
      render: (_args, value) => [{
        type: 'text',
        text: `Rendered ${String(value.featureCount)} features from ${value.sourceLabel}`
          + `${value.skippedRows > 0 ? ` (${String(value.skippedRows)} rows skipped: no valid coordinates)` : ''}`
          + `${value.note !== undefined && value.note !== '' ? ` - ${value.note}` : ''}`
          + `. Interactive map card is in the conversation; GeoJSON copy exported to ${value.artifactPath}.`,
      }],
      presentationMeta: (_args, value) => ({
        kind: 'geo-view',
        title: value.title,
        sourceKind: value.sourceKind,
        sourceLabel: value.sourceLabel,
        featureCount: value.featureCount,
        bounds: value.bounds,
        geojson: value.geojson,
        styleUrl: options.mapStyleUrl,
        maplibreCdnBase: options.maplibreCdnBase,
        cardHeight: options.cardHeight,
        artifactPath: value.artifactPath,
        columns: value.columns,
        ...value.latColumn !== undefined ? { latColumn: value.latColumn } : {},
        ...value.lngColumn !== undefined ? { lngColumn: value.lngColumn } : {},
        ...value.addressColumn !== undefined ? { addressColumn: value.addressColumn } : {},
        ...value.geocodedCount !== undefined ? { geocodedCount: value.geocodedCount } : {},
        ...value.geocodeFailed !== undefined ? { geocodeFailed: value.geocodeFailed } : {},
        ...value.note !== undefined && value.note !== '' ? { note: value.note } : {},
      }),
    },
    // 读取源文件为只读；制品按内容寻址写入，并发同参写同一字节，安全。
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const provided = [args.path, args.data, args.addresses].filter(v => v !== undefined).length
      if (provided !== 1) {
        throw new Error(
          provided === 0
            ? 'invalid geo_view call: provide exactly one of `path`, `data`, or `addresses`'
            : 'invalid geo_view call: `path`, `data`, and `addresses` are mutually exclusive - pass exactly one',
        )
      }

      // 会话工作区根（与官方 fs 工具一致的解析路径）。
      const sandboxPolicy = ctx.get('sandboxPolicy')?.resolve({
        ...exec.agent ? { session: exec.agent.session } : {},
      })
      const cwd = sandboxPolicy?.workspaceRoot ?? exec.agent?.session.header.cwd
      const resolveOpts = { ...cwd !== undefined ? { cwd } : {}, signal: exec.signal }

      const title = args.title?.trim() || 'Geo view'

      let sourceKind: GeoSourceKind
      let sourceLabel: string
      let fc: GeoJsonFeatureCollection
      let skippedRows = 0
      let columns: string[] = []
      let latColumn: string | undefined
      let lngColumn: string | undefined
      let addressColumn: string | undefined
      let geocodedCount: number | undefined
      let geocodeFailed: number | undefined
      let note: string | undefined

      if (args.addresses !== undefined) {
        if (!Array.isArray(args.addresses) || args.addresses.length === 0) {
          throw new Error('invalid geo_view call: `addresses` must be a non-empty array')
        }
        sourceKind = 'addresses'
        sourceLabel = `${String(args.addresses.length)} addresses`
        const geo = await geocodeRows(args.addresses, options)
        geocodedCount = geo.geocodedCount
        geocodeFailed = geo.geocodeFailed
        fc = geo.fc
      } else if (args.path !== undefined) {
        const target = await ctx.fs.resolve(args.path, resolveOpts)
        const ext = target.displayPath.toLowerCase().replace(/^.*\.([a-z0-9]+)$/, '$1')
        if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') {
          const bytes = await ctx.fs.readBytes(target, exec.signal, 64 * 1024 * 1024)
          const rows = await rowsFromXlsx(bytes)
          const table = await tableToFeatures(rows, args, options)
          sourceKind = 'xlsx'
          sourceLabel = target.displayPath
          ;({ fc, skippedRows } = table)
          columns = table.columns
          latColumn = table.latColumn
          lngColumn = table.lngColumn
          addressColumn = table.addressColumn
          geocodedCount = table.geocodedCount
          geocodeFailed = table.geocodeFailed
          note = table.note
        } else {
          const text = await ctx.fs.readText(target, exec.signal)
          const parsed = await parseTextualSource(text, ext, args, options, target.displayPath)
          sourceKind = parsed.sourceKind
          sourceLabel = target.displayPath
          ;({ fc, skippedRows } = parsed)
          columns = parsed.columns
          latColumn = parsed.latColumn
          lngColumn = parsed.lngColumn
          addressColumn = parsed.addressColumn
          geocodedCount = parsed.geocodedCount
          geocodeFailed = parsed.geocodeFailed
          note = parsed.note
        }
      } else {
        const data = args.data ?? ''
        if (data.trim() === '') throw new Error('invalid geo_view call: `data` is empty')
        const parsed = await parseTextualSource(data, '', args, options, 'inline data')
        sourceKind = parsed.sourceKind
        sourceLabel = 'inline data'
        ;({ fc, skippedRows } = parsed)
        columns = parsed.columns
        latColumn = parsed.latColumn
        lngColumn = parsed.lngColumn
        addressColumn = parsed.addressColumn
        geocodedCount = parsed.geocodedCount
        geocodeFailed = parsed.geocodeFailed
        note = parsed.note
      }

      // 体量护栏：meta 与规范值各持久化一份 geojson，超限响亮失败。
      const bytes = Buffer.byteLength(JSON.stringify(fc), 'utf8')
      if (bytes > options.maxBytes) {
        throw new Error(
          `GeoJSON is ${String(bytes)} bytes, over the ${String(options.maxBytes)}-byte limit - `
          + 'downsample the data (fewer features or properties), or raise the dsh-geo-viewer `maxBytes` config',
        )
      }

      const bounds = boundsOfFeatureCollection(fc)
      if (bounds === undefined) {
        throw new Error('no finite coordinates found in the data - nothing to render')
      }

      // 工作区制品：内容寻址命名，同内容复用同名。
      const artifactPath = `geo/${slugOf(title)}-${fnv1a(JSON.stringify(fc))}.geojson`
      const artifactTarget = await ctx.fs.resolve(artifactPath, resolveOpts)
      await ctx.fs.writeText(artifactTarget, `${JSON.stringify(fc, null, 2)}\n`, undefined, exec.signal, sandboxPolicy)

      return {
        title,
        sourceKind,
        sourceLabel,
        featureCount: fc.features.length,
        skippedRows,
        columns,
        ...latColumn !== undefined ? { latColumn } : {},
        ...lngColumn !== undefined ? { lngColumn } : {},
        ...addressColumn !== undefined ? { addressColumn } : {},
        ...geocodedCount !== undefined ? { geocodedCount } : {},
        ...geocodeFailed !== undefined ? { geocodeFailed } : {},
        bounds,
        artifactPath: artifactTarget.displayPath,
        geojson: fc as unknown as Record<string, JsonValue>,
        ...note !== undefined ? { note } : {},
      }
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Geo view',
      kind: 'other',
    }),
    // 完成态标题取自持久化 meta（回放时 args 缺失也不猜）。无能力 UI 回退通用卡片。
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = result.meta
      if (typeof meta !== 'object' || meta === null || (meta as Record<string, unknown>)['kind'] !== 'geo-view') {
        return undefined
      }
      const title = (meta as Record<string, unknown>)['title']
      const count = (meta as Record<string, unknown>)['featureCount']
      if (typeof title !== 'string' || typeof count !== 'number') return undefined
      return { card: 'generic', title: `Map · ${title} (${String(count)} features)` }
    },
  })
}

/** 文本来源解析结果。 */
interface ParsedSource {
  sourceKind: GeoSourceKind
  fc: GeoJsonFeatureCollection
  skippedRows: number
  columns: string[]
  latColumn?: string
  lngColumn?: string
  addressColumn?: string
  geocodedCount?: number
  geocodeFailed?: number
  note?: string
}

/** Geo 参数子集（工具参数投影）。 */
interface GeoArgs {
  latColumn?: string
  lngColumn?: string
  addressColumn?: string
}

/**
 * 解析文本来源（文件或内联）：JSON 走 GeoJSON 规范化，其余按 CSV/TSV 表格。
 * 内联数据以首个非空白字符判断形态；文件来源以扩展名判断。
 */
async function parseTextualSource(
  text: string,
  ext: string,
  args: GeoArgs,
  options: GeoToolOptions,
  label: string,
): Promise<ParsedSource> {
  const looksJson = text.trimStart().startsWith('{') || text.trimStart().startsWith('[')
  if (ext === 'geojson' || ext === 'json' || (ext === '' && looksJson)) {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error) {
      throw new Error(`invalid GeoJSON in ${label}: ${(error instanceof Error ? error.message : String(error))}`)
    }
    const fc = normalizeGeoJson(value, options.maxFeatures)
    return { sourceKind: ext === '' ? 'inline-geojson' : 'geojson', fc, skippedRows: 0, columns: [] }
  }
  const delimiter = ext === 'tsv' ? '\t' : undefined
  const rows = csvToRows(text, delimiter)
  const table = await tableToFeatures(rows, args, options)
  const sourceKind: GeoSourceKind = ext === '' ? 'inline-csv' : ext === 'tsv' ? 'tsv' : 'csv'
  return { sourceKind, ...table }
}

/** CSV/TSV 文本 -> 行记录（表头作键；空行跳过）。 */
function csvToRows(text: string, delimiter?: string): TableRow[] {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    ...(delimiter !== undefined ? { delimiter } : {}),
  })
  const rows: TableRow[] = []
  for (const row of parsed.data) {
    if (row === null || typeof row !== 'object') continue
    rows.push(row as TableRow)
  }
  return rows
}

/**
 * XLSX 字节 -> 行记录（首个工作表；首行为表头；单元格文本化）。
 */
async function rowsFromXlsx(bytes: Uint8Array): Promise<TableRow[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer)
  const sheet = workbook.worksheets[0]
  if (sheet === undefined) throw new Error('the workbook has no worksheet')
  const rows: TableRow[] = []
  let headers: string[] | undefined
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = []
    row.eachCell({ includeEmpty: true }, (cell) => {
      values.push(cellText(cell.value))
    })
    if (headers === undefined) {
      headers = values.map((v, i) => v.trim() !== '' ? v.trim() : `column${String(i + 1)}`)
      return
    }
    const record: Record<string, string> = {}
    for (const [i, h] of headers.entries()) {
      const v = values[i]
      if (v !== undefined && v !== '') record[h] = v
    }
    rows.push(record)
  })
  return rows
}

/** exceljs 单元格值文本化（公式取结果、富文本取拼接、日期取 ISO）。 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('result' in record) return cellText(record['result'])
    if ('richText' in record && Array.isArray(record['richText'])) {
      return record['richText'].map(part => String((part as Record<string, unknown>)['text'] ?? '')).join('')
    }
    if ('text' in record) return String(record['text'])
    if (value instanceof Date) return value.toISOString()
    if ('error' in record) return ''
    return String(record)
  }
  return String(value)
}

/** 表格 -> 要素（含地理列检测与可选地址地理编码）。 */
async function tableToFeatures(
  rows: readonly TableRow[],
  args: GeoArgs,
  options: GeoToolOptions,
): Promise<{
  fc: GeoJsonFeatureCollection
  skippedRows: number
  columns: string[]
  latColumn?: string
  lngColumn?: string
  addressColumn?: string
  geocodedCount?: number
  geocodeFailed?: number
  note?: string
}> {
  if (rows.length === 0) throw new Error('the table has no data rows')
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))]

  const detection = detectGeoColumns(rows, args)
  if (detection !== undefined) {
    const { fc, skipped } = rowsToFeatureCollection(rows, detection, options.maxFeatures)
    return {
      fc,
      skippedRows: skipped,
      columns,
      ...(detection.kind === 'latlng'
        ? {
            latColumn: detection.latColumn,
            lngColumn: detection.lngColumn,
            ...detection.swapped
              ? { note: `columns looked swapped by value; used "${detection.lngColumn}" as latitude and "${detection.latColumn}" as longitude` }
              : {},
          }
        : {}),
    }
  }

  // 无经纬度列：尝试地址列地理编码。
  const addressCol = args.addressColumn ?? detectAddressColumn(columns)
  if (addressCol !== undefined && columns.includes(addressCol)) {
    const addresses: string[] = []
    for (const row of rows) {
      const v = row[addressCol]
      if (v !== undefined && String(v).trim() !== '') addresses.push(String(v).trim())
    }
    if (addresses.length > options.maxGeocodeRows) {
      throw new Error(
        `${String(addresses.length)} rows need geocoding, over the maxGeocodeRows limit of ${String(options.maxGeocodeRows)} - `
        + 'geocode fewer rows or raise the dsh-geo-viewer `maxGeocodeRows` config',
      )
    }
    const geo = await geocodeRows(addresses, options)
    if (geo.geocodedCount === 0) {
      throw new Error(
        `geocoded 0 of ${String(addresses.length)} addresses in column "${addressCol}" - `
        + 'check the provider/key configuration or the address values',
      )
    }
    const rowByAddress = new Map<string, TableRow>()
    for (const row of rows) {
      const v = row[addressCol]
      if (v !== undefined) rowByAddress.set(String(v).trim(), row)
    }
    for (const feature of geo.fc.features) {
      const original = rowByAddress.get(String(feature.properties?.['address'] ?? ''))
      if (original !== undefined && feature.properties !== null) {
        feature.properties = { ...original, ...feature.properties }
      }
    }
    return {
      fc: geo.fc,
      skippedRows: rows.length - geo.geocodedCount,
      columns,
      addressColumn: addressCol,
      geocodedCount: geo.geocodedCount,
      geocodeFailed: geo.geocodeFailed,
    }
  }

  throw new Error(
    'no geographic columns detected in the table (headers: '
    + `${columns.join(', ')}) - pass \`latColumn\`/\`lngColumn\` explicitly, or \`addressColumn\` `
    + 'to geocode addresses',
  )
}

/** 明确的地址列表头线索（保守，避免把 location 之类误当地址）。 */
function detectAddressColumn(columns: readonly string[]): string | undefined {
  return columns.find(h => {
    const n = h.trim().toLowerCase().replace(/[\s_\-]/g, '')
    return n === 'address' || n === 'addr' || n === '地址' || n === 'locationtext'
      || n === 'fulladdress' || n === '详细地址'
  })
}

/** 地址列表 -> 地理编码要素。 */
async function geocodeRows(
  addresses: readonly string[],
  options: GeoToolOptions,
): Promise<{ fc: GeoJsonFeatureCollection, geocodedCount: number, geocodeFailed: number }> {
  if (addresses.length > options.maxGeocodeRows) {
    throw new Error(
      `${String(addresses.length)} addresses exceed the maxGeocodeRows limit of ${String(options.maxGeocodeRows)} - `
      + 'geocode fewer addresses or raise the dsh-geo-viewer `maxGeocodeRows` config',
    )
  }
  const points = await geocodeAddresses(
    addresses,
    {
      provider: options.geocodingProvider,
      key: options.geocodingKey,
      baseUrl: options.geocodingBaseUrl.trim() === '' ? undefined : options.geocodingBaseUrl.trim(),
    },
  )
  const features: GeoJsonFeature[] = []
  let geocodedCount = 0
  let geocodeFailed = 0
  for (const [i, address] of addresses.entries()) {
    const point = points[i]
    if (point === null || point === undefined) {
      geocodeFailed++
      continue
    }
    geocodedCount++
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
      properties: { address, label: point.label },
    })
  }
  if (features.length === 0) {
    throw new Error('geocoding resolved none of the addresses - check the provider configuration and address values')
  }
  return {
    fc: { type: 'FeatureCollection', features },
    geocodedCount,
    geocodeFailed,
  }
}

/** 标题转 ASCII slug（与 dsh-visualize 同款规则）。 */
function slugOf(title: string): string {
  const slug = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 48)
  return slug.length > 0 ? slug : 'geo-view'
}

/** FNV-1a 8 位十六进制内容散列。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
