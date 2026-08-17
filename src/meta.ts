/**
 * geo_view 工具的线协议契约（纯模块，无 I/O、无 DOM）：
 * 宿主半侧在 presentationMeta 里产出，浏览器半侧与测试用它收窄。
 * 所有渲染参数（style URL、CDN base、卡片高度）都在执行期由插件配置解析后
 * 随 meta 持久化，浏览器半侧不读会话状态，回放按字节重现。
 *
 * @module dsh-geo-viewer/meta
 */

/** 工具线名；键控 toolview 与之同名。 */
export const GEO_VIEW_TOOL_NAME = 'geo_view'

/** meta.kind 判别值。 */
export const GEO_VIEW_META_KIND = 'geo-view'

/** 数据来源形态。 */
export type GeoSourceKind =
  | 'csv'
  | 'tsv'
  | 'xlsx'
  | 'geojson'
  | 'inline-csv'
  | 'inline-geojson'
  | 'addresses'

/** GeoJSON FeatureCollection（宽松 JSON 视图；浏览器半侧交给 maplibre 收紧）。 */
export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJsonFeature[]
}

export interface GeoJsonFeature {
  type: 'Feature'
  geometry: GeoJsonGeometry | null
  properties: Record<string, unknown> | null
}

export interface GeoJsonGeometry {
  type: string
  coordinates: unknown
  geometries?: unknown
}

/**
 * 持久化在 tool/result meta 上的卡片描述符。
 */
export interface GeoViewMeta {
  /** 判别值。 */
  kind: typeof GEO_VIEW_META_KIND
  /** 卡片标题。 */
  title: string
  /** 数据来源形态。 */
  sourceKind: GeoSourceKind
  /** 来源展示（文件路径 / "inline data" / "addresses"）。 */
  sourceLabel: string
  /** 要素总数。 */
  featureCount: number
  /** [西, 南, 东, 北] 初始视野范围。 */
  bounds: [number, number, number, number]
  /** 要渲染的 FeatureCollection。 */
  geojson: GeoJsonFeatureCollection
  /** 执行期解析后的底图 StyleJSON URL。 */
  styleUrl: string
  /** 执行期解析后的 maplibre-gl CDN 目录。 */
  maplibreCdnBase: string
  /** 卡片内地图高度（px）。 */
  cardHeight: number
  /** 工作区导出文件路径（会话相对或绝对）。 */
  artifactPath: string
  /** 表格来源的列名（表格来源时存在）。 */
  columns?: readonly string[]
  /** 检测/指定的纬度列。 */
  latColumn?: string
  /** 检测/指定的经度列。 */
  lngColumn?: string
  /** 检测/指定的地址列（地理编码用）。 */
  addressColumn?: string
  /** 地理编码成功数。 */
  geocodedCount?: number
  /** 地理编码失败数。 */
  geocodeFailed?: number
  /** 提示性附注（如经纬度列疑似互换后纠正）。 */
  note?: string
}

const GEO_SOURCE_KINDS: readonly GeoSourceKind[] = [
  'csv', 'tsv', 'xlsx', 'geojson', 'inline-csv', 'inline-geojson', 'addresses',
]

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function isFeatureCollection(v: unknown): v is GeoJsonFeatureCollection {
  if (typeof v !== 'object' || v === null) return false
  const record = v as Record<string, unknown>
  return record['type'] === 'FeatureCollection' && Array.isArray(record['features'])
}

/**
 * 将持久化 meta 收窄为 {@link GeoViewMeta}。线上数据不可信（旧/新宿主可能
 * 记录了不同形状），不匹配时返回 undefined，调用方回退通用卡片而不是回放崩溃。
 */
export function geoViewMetaFrom(meta: unknown): GeoViewMeta | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const record = meta as Record<string, unknown>
  if (record['kind'] !== GEO_VIEW_META_KIND) return undefined
  const { title, sourceKind, sourceLabel, featureCount, bounds, geojson } = record
  if (typeof title !== 'string' || typeof sourceLabel !== 'string') return undefined
  if (typeof featureCount !== 'number' || !Number.isInteger(featureCount)) return undefined
  if (!GEO_SOURCE_KINDS.includes(sourceKind as GeoSourceKind)) return undefined
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(isFiniteNumber)) return undefined
  if (!isFeatureCollection(geojson)) return undefined
  const optionalStrings = ['artifactPath', 'latColumn', 'lngColumn', 'addressColumn', 'note'] as const
  for (const key of optionalStrings) {
    const value = record[key]
    if (value !== undefined && typeof value !== 'string') return undefined
  }
  const out: GeoViewMeta = {
    kind: GEO_VIEW_META_KIND,
    title,
    sourceKind: sourceKind as GeoSourceKind,
    sourceLabel,
    featureCount,
    bounds: bounds as [number, number, number, number],
    geojson,
    styleUrl: typeof record['styleUrl'] === 'string' ? record['styleUrl'] : 'https://demotiles.maplibre.org/style.json',
    maplibreCdnBase: typeof record['maplibreCdnBase'] === 'string' ? record['maplibreCdnBase'] : 'https://unpkg.com/maplibre-gl@5/dist',
    cardHeight: isFiniteNumber(record['cardHeight']) ? record['cardHeight'] : 420,
    artifactPath: typeof record['artifactPath'] === 'string' ? record['artifactPath'] : '',
  }
  if (Array.isArray(record['columns']) && record['columns'].every(v => typeof v === 'string')) {
    out.columns = record['columns'] as readonly string[]
  }
  for (const key of ['geocodedCount', 'geocodeFailed'] as const) {
    const value = record[key]
    if (isFiniteNumber(value)) out[key] = value
  }
  return out
}
