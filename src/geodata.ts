/**
 * 地理数据检测与转换（纯模块，无 I/O、无平台依赖，宿主与测试共用）。
 *
 * - detectGeoColumns: 表头启发式识别经纬度列（含显式覆盖、x/y 配对、
 *   单列合并坐标、经纬度互换纠正、范围校验）。
 * - rowsToFeatureCollection: 行记录 -> Point FeatureCollection。
 * - normalizeGeoJson: FeatureCollection/Feature/Geometry/数组 -> 规范 FC。
 * - boundsOfFeatureCollection: 深扫坐标求 [w, s, e, n]。
 *
 * @module dsh-geo-viewer/geodata
 */
import type { GeoJsonFeature, GeoJsonFeatureCollection, GeoJsonGeometry } from './meta.ts'

/** 一行表格记录：列名 -> 原始值（字符串或数字）。 */
export type TableRow = Readonly<Record<string, string | number>>

/** 地理编码器接口（由 geocode.ts 提供实现，这里只依赖形状以便测试）。 */
export interface RowGeocoder {
  (rows: readonly TableRow[], addressColumn: string, limit: number): Promise<{
    features: GeoJsonFeature[]
    geocodedCount: number
    geocodeFailed: number
  }>
}

/** 检测结果之一：分离的纬度/经度两列。 */
export interface LatLngColumns {
  kind: 'latlng'
  latColumn: string
  lngColumn: string
  /** 检测到列头与数值范围暗示的角色互换，已按数值纠正。 */
  swapped: boolean
}

/** 检测结果之一：单列合并坐标（"lat,lng" 或 "lng,lat" 文本）。 */
export interface CombinedColumn {
  kind: 'combined'
  column: string
  order: 'lat-first' | 'lng-first'
}

export type GeoColumnDetection = LatLngColumns | CombinedColumn

/** 归一化列名：小写、去空白与分隔符。 */
function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_\-().（）]/g, '')
}

/** 纬度列头线索。 */
function isLatHeader(h: string): boolean {
  const n = normHeader(h)
  return n === 'lat' || n === 'latitude' || n === '纬度' || n === 'glat'
    || (n.startsWith('lat') && n.length <= 12)
}

/** 经度列头线索。 */
function isLngHeader(h: string): boolean {
  const n = normHeader(h)
  return n === 'lng' || n === 'lon' || n === 'long' || n === 'longitude'
    || n === '经度' || n === 'glng' || n === '东经'
    || ((n.startsWith('lon') || n.startsWith('lng')) && n.length <= 12)
}

/** 合并坐标列头线索。 */
function isCombinedHeader(h: string): boolean {
  const n = normHeader(h)
  return n === 'coordinates' || n === 'coordinate' || n === 'coords' || n === 'coord'
    || n === '坐标' || n === 'latlng' || n === 'latlong' || n === '位置坐标'
}

/** 解析数值（容忍度分秒残渣不处理；空串/NaN -> undefined）。 */
function num(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  const t = v.trim()
  if (t === '') return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** 采样行数上限：检测只需统计证据，不必全量。 */
const SAMPLE_LIMIT = 200

/** 数值合法率门槛：低于它认为这不是地理列。 */
const PASS_RATE = 0.7

/** 合法率：通过数值占采样中非空数值的比例。 */
function rate(ok: number, total: number): number {
  return total === 0 ? 0 : ok / total
}

/**
 * 在表格中检测地理列。显式覆盖优先；随后按表头线索 + 采样数值校验。
 * 数值校验能发现"lat 列头装的其实是经度"并自动互换。
 *
 * @param rows 已解析的行记录（含表头作为键）。
 * @param hints 显式指定的列名（可只给其一，另一列仍自动检测）。
 * @returns 检测结果；未检出返回 undefined。
 */
export function detectGeoColumns(
  rows: readonly TableRow[],
  hints?: { latColumn?: string, lngColumn?: string },
): GeoColumnDetection | undefined {
  if (rows.length === 0) return undefined
  const columns = collectColumns(rows)
  if (columns.length === 0) return undefined

  // 1) 显式覆盖：列存在且数值合法即接受（用户/模型的明确意志）。
  const hLat = hints?.latColumn
  const hLng = hints?.lngColumn
  if (hLat !== undefined && hLng !== undefined && columns.includes(hLat) && columns.includes(hLng)) {
    const ok = validatePair(rows, hLat, hLng)
    if (ok !== undefined) return { kind: 'latlng', latColumn: hLat, lngColumn: hLng, swapped: false }
    // 显式给反了：按数值互换再试一次。
    const swapped = validatePair(rows, hLng, hLat)
    if (swapped !== undefined) return { kind: 'latlng', latColumn: hLng, lngColumn: hLat, swapped: true }
    return undefined
  }

  // 2) 表头线索配对。
  const latCandidates = columns.filter(isLatHeader)
  const lngCandidates = columns.filter(isLngHeader)
  for (const lat of latCandidates) {
    for (const lng of lngCandidates) {
      if (lat === lng) continue
      if (validatePair(rows, lat, lng) !== undefined) {
        return { kind: 'latlng', latColumn: lat, lngColumn: lng, swapped: false }
      }
      if (validatePair(rows, lng, lat) !== undefined) {
        // 列头角色与数值相反：以数值为准。
        return { kind: 'latlng', latColumn: lng, lngColumn: lat, swapped: true }
      }
    }
  }

  // 3) x/y 配对（测绘惯例：x=东=经度，y=北=纬度）。
  const x = columns.find(h => normHeader(h) === 'x' || normHeader(h) === 'easting')
  const y = columns.find(h => normHeader(h) === 'y' || normHeader(h) === 'northing')
  if (x !== undefined && y !== undefined && x !== y) {
    // 常见两类：投影坐标（数值巨大，超出经纬度范围，拒收）；经纬度裸用 x/y。
    if (validatePair(rows, y, x) !== undefined) {
      return { kind: 'latlng', latColumn: y, lngColumn: x, swapped: false }
    }
  }

  // 4) 合并坐标单列。
  for (const col of columns.filter(isCombinedHeader)) {
    const order = validateCombined(rows, col)
    if (order !== undefined) return { kind: 'combined', column: col, order }
  }

  return undefined
}

/** 收集出现过的列名（保持首见顺序）。 */
function collectColumns(rows: readonly TableRow[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const row of rows.slice(0, SAMPLE_LIMIT)) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        out.push(key)
      }
    }
  }
  return out
}

/**
 * 校验 (latCol, lngCol) 是否能当纬度/经度用。
 * 通过返回 true-ish；不通过返回 undefined。
 */
function validatePair(rows: readonly TableRow[], latCol: string, lngCol: string): true | undefined {
  const sample = rows.slice(0, SAMPLE_LIMIT)
  let parsed = 0
  let ok = 0
  for (const row of sample) {
    const lat = num(row[latCol])
    const lng = num(row[lngCol])
    if (lat === undefined || lng === undefined) continue
    parsed++
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) ok++
  }
  if (parsed < 2) return undefined
  if (rate(ok, parsed) < PASS_RATE) return undefined
  // 全部行两列都落在 [-90,90] 且数值相同（对称数据）也算通过；
  // 但若 lat 列存在 |v|>90 的值则说明角色反了，由调用方的互换分支处理。
  return true
}

/** 校验合并坐标列并推断分量顺序。 */
function validateCombined(rows: readonly TableRow[], column: string): 'lat-first' | 'lng-first' | undefined {
  const sample = rows.slice(0, SAMPLE_LIMIT)
  let parsed = 0
  let latFirst = 0
  let lngFirst = 0
  const re = /^\s*(-?\d+(?:\.\d+)?)\s*[,;，；/]\s*(-?\d+(?:\.\d+)?)\s*$/
  for (const row of sample) {
    const raw = row[column]
    if (raw === undefined) continue
    const m = re.exec(String(raw))
    if (m === null) continue
    const a = Number(m[1])
    const b = Number(m[2])
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    parsed++
    const aIsLat = a >= -90 && a <= 90
    const bIsLat = b >= -90 && b <= 90
    // 第二分量 >90 只能是经度 => 前面是纬度。
    if (aIsLat && (b > 90 || b < -90)) latFirst++
    else if (bIsLat && (a > 90 || a < -90)) lngFirst++
    else if (aIsLat && bIsLat) latFirst++ // 完全歧义时按"纬度,经度"惯例
  }
  if (parsed < 2) return undefined
  if (lngFirst > latFirst) return 'lng-first'
  return 'lat-first'
}

/** 合并坐标文本拆分。 */
function splitCombined(raw: string | number): [number, number] | undefined {
  if (typeof raw !== 'string') return undefined
  const re = /^\s*(-?\d+(?:\.\d+)?)\s*[,;，；/]\s*(-?\d+(?:\.\d+)?)\s*$/
  const m = re.exec(raw)
  if (m === null) return undefined
  const a = Number(m[1])
  const b = Number(m[2])
  return [a, b]
}

/**
 * 行记录转 Point FeatureCollection。
 *
 * @param rows 行记录。
 * @param detection 地理列检测结果。
 * @param maxFeatures 要素数上限（含未跳过行）。
 * @returns FeatureCollection 与被跳过行数（无有效坐标的行）。
 * @throws Error 当有效行数超过 maxFeatures。
 */
export function rowsToFeatureCollection(
  rows: readonly TableRow[],
  detection: GeoColumnDetection,
  maxFeatures: number,
): { fc: GeoJsonFeatureCollection, skipped: number } {
  const features: GeoJsonFeature[] = []
  let skipped = 0
  for (const row of rows) {
    let lat: number | undefined
    let lng: number | undefined
    if (detection.kind === 'latlng') {
      lat = num(row[detection.latColumn])
      lng = num(row[detection.lngColumn])
    } else {
      const parts = splitCombined(row[detection.column] ?? '')
      if (parts !== undefined) {
        if (detection.order === 'lat-first') {
          lat = parts[0]
          lng = parts[1]
        } else {
          lng = parts[0]
          lat = parts[1]
        }
      }
    }
    if (lat === undefined || lng === undefined
      || !(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) {
      skipped++
      continue
    }
    // (0,0) 是常见占位脏数据：与真实数据混合时跳过。
    if (lat === 0 && lng === 0 && rows.length > 1) {
      skipped++
      continue
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: sanitizeProperties(row),
    })
  }
  if (features.length === 0) {
    throw new Error('no rows produced a valid coordinate: check the lat/lng columns (values must be numbers in range)')
  }
  if (features.length > maxFeatures) {
    throw new Error(
      `${features.length} mappable rows exceed the maxFeatures limit of ${maxFeatures} - `
      + 'filter the rows first, or raise the dsh-geo-viewer `maxFeatures` config',
    )
  }
  return { fc: { type: 'FeatureCollection', features }, skipped }
}

/** 行属性清洗：去空串/未定义键，数值保持数值。 */
function sanitizeProperties(row: TableRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue
    if (typeof value === 'string') {
      const t = value.trim()
      if (t === '') continue
      out[key] = t
      continue
    }
    out[key] = value
  }
  return out
}

/** 支持的 GeoJSON 几何类型。 */
const GEOMETRY_TYPES: readonly string[] = [
  'Point', 'MultiPoint', 'LineString', 'MultiLineString',
  'Polygon', 'MultiPolygon', 'GeometryCollection',
]

function isGeometryLike(v: unknown): v is GeoJsonGeometry {
  if (typeof v !== 'object' || v === null) return false
  const record = v as Record<string, unknown>
  return typeof record['type'] === 'string' && GEOMETRY_TYPES.includes(record['type'])
}

function isFeatureLike(v: unknown): v is GeoJsonFeature {
  if (typeof v !== 'object' || v === null) return false
  const record = v as Record<string, unknown>
  return record['type'] === 'Feature'
    && (record['geometry'] === null || isGeometryLike(record['geometry']))
    && (record['properties'] === undefined || record['properties'] === null
      || typeof record['properties'] === 'object')
}

/**
 * 将各种常见 GeoJSON 形态规范化为 FeatureCollection。
 *
 * @param value JSON.parse 的结果。
 * @returns 规范 FeatureCollection。
 * @throws Error 形态无法识别或要素数超限。
 */
export function normalizeGeoJson(value: unknown, maxFeatures: number): GeoJsonFeatureCollection {
  const features: GeoJsonFeature[] = []
  const pushItem = (item: unknown, where: string): void => {
    if (isFeatureLike(item)) {
      features.push({
        type: 'Feature',
        geometry: item.geometry,
        properties: (item.properties ?? null) as Record<string, unknown> | null,
      })
      return
    }
    if (isGeometryLike(item)) {
      features.push({ type: 'Feature', geometry: item, properties: null })
      return
    }
    throw new Error(`unrecognized GeoJSON: ${where} must be Features or Geometries`)
  }
  if (Array.isArray(value)) {
    for (const item of value) pushItem(item, 'array items')
  } else if (typeof value === 'object' && value !== null && (value as Record<string, unknown>)['type'] === 'FeatureCollection') {
    const raw = (value as Record<string, unknown>)['features']
    if (!Array.isArray(raw)) throw new Error('unrecognized GeoJSON: FeatureCollection.features must be an array')
    for (const item of raw) pushItem(item, 'features[] items')
  } else {
    pushItem(value, 'the top-level value')
  }
  if (features.length === 0) throw new Error('empty GeoJSON: no features to render')
  if (features.length > maxFeatures) {
    throw new Error(
      `${features.length} features exceed the maxFeatures limit of ${maxFeatures} - `
      + 'simplify the data first, or raise the dsh-geo-viewer `maxFeatures` config',
    )
  }
  return { type: 'FeatureCollection', features }
}

/**
 * 深扫 FeatureCollection 全部坐标，求 [w, s, e, n]。
 * @returns bounds；无有效坐标时 undefined。
 */
export function boundsOfFeatureCollection(fc: GeoJsonFeatureCollection): [number, number, number, number] | undefined {
  let w: number | undefined
  let s: number | undefined
  let e: number | undefined
  let n: number | undefined
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      if (node.length >= 2 && node.every(v => typeof v === 'number')) {
        const [lng, lat] = node as [number, number]
        if (Number.isFinite(lng) && Number.isFinite(lat) && (lng !== 0 || lat !== 0)) {
          w = w === undefined ? lng : Math.min(w, lng)
          e = e === undefined ? lng : Math.max(e, lng)
          s = s === undefined ? lat : Math.min(s, lat)
          n = n === undefined ? lat : Math.max(n, lat)
        }
        return
      }
      for (const child of node) visit(child)
      return
    }
    if (typeof node === 'object' && node !== null) {
      for (const child of Object.values(node)) {
        if (typeof child === 'object' && child !== null) visit(child)
      }
    }
  }
  for (const feature of fc.features) {
    if (feature.geometry !== null) visit(feature.geometry)
  }
  if (w === undefined || s === undefined || e === undefined || n === undefined) return undefined
  // 单点或极小范围：外扩出可见视野。
  const pad = Math.max((e - w) * 0.1, (n - s) * 0.1, 0.01)
  return [w - pad, s - pad, e + pad, n + pad]
}
