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
import { installSettingsSection, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { geoViewTool } from './tool.ts'

export { GEO_VIEW_TOOL_NAME } from './meta.ts'

/** Cordis 插件名。 */
export const name = 'dsh-geo-viewer'

/** 依赖服务：工具注册表 + 文件系统缝。 */
export const inject = ['tools', 'fs']

/**
 * Web 设置项命名空间：注册到 `ctx.settings` 后，Web 端「设置 → 插件 →
 * 插件配置」出现本插件卡片；用户层覆盖组合层（profile 的 config 行），
 * 保存即生效，无需重启。
 */
export const SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('dsh-geo-viewer')

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

/**
 * URL 形态校验（加载期与每次设置写入时都跑）：坏配置响亮失败，
 * 不允许通过设置项把插件推入不可渲染状态。
 * @param config 待校验的已解析配置。
 */
function assertConfigUsable(config: Config): void {
  if (!URL_RE.test(config.mapStyleUrl)) {
    throw new Error(`dsh-geo-viewer: mapStyleUrl must be an http(s) URL, got ${JSON.stringify(config.mapStyleUrl)}`)
  }
  if (!URL_RE.test(config.maplibreCdnBase)) {
    throw new Error(`dsh-geo-viewer: maplibreCdnBase must be an http(s) URL, got ${JSON.stringify(config.maplibreCdnBase)}`)
  }
}

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
 * 注册 geo_view 工具并把配置挂到 Web 设置项。
 *
 * 组合层（profile `config` 行）作为设置命名空间的 base：Web 端保存的用户层
 * 覆盖其上，工具每次调用读取当前解析值，改动即时生效；无 settings 服务的
 * 部署（TUI/headless）自动回落到组合层，行为与纯 YAML 配置完全一致。
 * @param ctx 注册上下文。
 * @param config 已校验的部署配置。
 */
export function apply(ctx: Context, config: Config): void {
  assertConfigUsable(config)
  let current = () => config
  installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
    setSource: source => {
      current = source
    },
    onChange: () => {},
    validate: assertConfigUsable,
  })
  ctx.tools.register(geoViewTool(ctx, () => {
    const value = current()
    return {
      mapStyleUrl: value.mapStyleUrl,
      maplibreCdnBase: value.maplibreCdnBase.replace(/\/+$/, ''),
      cardHeight: value.cardHeight,
      maxFeatures: value.maxFeatures,
      maxBytes: value.maxBytes,
      maxGeocodeRows: value.maxGeocodeRows,
      geocodingProvider: value.geocodingProvider,
      geocodingKey: value.geocodingKey,
      geocodingBaseUrl: value.geocodingBaseUrl,
    }
  }))
}
