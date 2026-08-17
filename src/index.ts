/**
 * dsh-geo-viewer，宿主半侧：在 ctx.tools 上注册 `geo_view` 工具。
 * 浏览器半侧（src/client/）以同名键注册键控 toolview 卡片；不具备该半侧的
 * 客户端（TUI/headless）按渲染意图回退到通用卡片文本，工具仍然可用。
 *
 * 配置约定（Harness 规范）：凡是不同部署可能取不同值的参数都必须是配置字段，
 * 且用 Schemastery 表达完备约束，坏配置在加载期响亮失败。
 *
 * @module dsh-geo-viewer
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { geoViewTool } from './tool.ts'

export { GEO_VIEW_TOOL_NAME } from './meta.ts'

/** Cordis 插件名。 */
export const name = 'dsh-geo-viewer'

/** 依赖服务：工具注册表 + 文件系统缝。 */
export const inject = ['tools', 'fs']

/** 部署配置。 */
export interface Config {
  /** MapLibre StyleJSON URL（底图）。 */
  mapStyleUrl: string
  /** maplibre-gl 静态资源 CDN 目录（JS/CSS 拼接其后）。 */
  maplibreCdnBase: string
  /** 卡片内地图高度（px）。 */
  cardHeight: number
  /** 单次渲染的要素数上限。 */
  maxFeatures: number
  /** 单次渲染的 GeoJSON 字节上限（meta 与规范值各持久化一份）。 */
  maxBytes: number
  /** 地理编码行数上限（供应商配额保护）。 */
  maxGeocodeRows: number
  /** 地理编码供应商。 */
  geocodingProvider: 'nominatim' | 'maptiler' | 'amap'
  /** 供应商 key（nominatim 留空）。 */
  geocodingKey: string
  /** 覆盖供应商默认端点（自建反代/私有化实例）。 */
  geocodingBaseUrl: string
}

const URL_RE = /^https?:\/\//

/** Loader 校验用的 Schemastery schema，默认值即推荐部署值。 */
export const Config: Schema<Config> = Schema.object({
  mapStyleUrl: Schema.string()
    .default('https://demotiles.maplibre.org/style.json')
    .description('MapLibre StyleJSON URL for the basemap, e.g. a MapTiler style URL with its key or demotiles.'),
  maplibreCdnBase: Schema.string()
    .default('https://unpkg.com/maplibre-gl@5/dist')
    .description('CDN directory of maplibre-gl assets (maplibre-gl.js / maplibre-gl.css are loaded from it).'),
  cardHeight: Schema.natural()
    .default(420)
    .description('Map height inside the conversation card, in pixels.'),
  maxFeatures: Schema.natural()
    .default(10000)
    .description('Maximum features rendered per geo_view call.'),
  maxBytes: Schema.natural()
    .default(4000000)
    .description('Maximum serialized GeoJSON bytes per geo_view call.'),
  maxGeocodeRows: Schema.natural()
    .default(100)
    .description('Maximum rows/addresses geocoded per geo_view call (protects provider quota).'),
  geocodingProvider: Schema.union(['nominatim', 'maptiler', 'amap'] as const)
    .default('nominatim')
    .description('Geocoding provider used for addresses / address columns.'),
  geocodingKey: Schema.string()
    .default('')
    .description('Provider API key (maptiler/amap require it; nominatim ignores it).'),
  geocodingBaseUrl: Schema.string()
    .default('')
    .description('Optional provider endpoint override, e.g. a self-hosted Nominatim mirror.'),
})

/**
 * 注册 geo_view 工具。
 * @param ctx 注册上下文。
 * @param config 已校验的部署配置。
 */
export function apply(ctx: Context, config: Config): void {
  if (!URL_RE.test(config.mapStyleUrl)) {
    throw new Error(`dsh-geo-viewer: mapStyleUrl must be an http(s) URL, got ${JSON.stringify(config.mapStyleUrl)}`)
  }
  if (!URL_RE.test(config.maplibreCdnBase)) {
    throw new Error(`dsh-geo-viewer: maplibreCdnBase must be an http(s) URL, got ${JSON.stringify(config.maplibreCdnBase)}`)
  }
  ctx.tools.register(geoViewTool(ctx, {
    mapStyleUrl: config.mapStyleUrl,
    maplibreCdnBase: config.maplibreCdnBase.replace(/\/+$/, ''),
    cardHeight: config.cardHeight,
    maxFeatures: config.maxFeatures,
    maxBytes: config.maxBytes,
    maxGeocodeRows: config.maxGeocodeRows,
    geocodingProvider: config.geocodingProvider,
    geocodingKey: config.geocodingKey,
    geocodingBaseUrl: config.geocodingBaseUrl,
  }))
}
