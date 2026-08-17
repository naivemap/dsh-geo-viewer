import Schema from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/meta.d.ts
/**
 * geo_view 工具的线协议契约（纯模块，无 I/O、无 DOM）：
 * 宿主半侧在 presentationMeta 里产出，浏览器半侧与测试用它收窄。
 * 所有渲染参数（style URL、CDN base、卡片高度）都在执行期由插件配置解析后
 * 随 meta 持久化，浏览器半侧不读会话状态，回放按字节重现。
 *
 * @module dsh-geo-viewer/meta
 */
/** 工具线名；键控 toolview 与之同名。 */
declare const GEO_VIEW_TOOL_NAME = "geo_view";
//#endregion
//#region src/index.d.ts
/** Cordis 插件名。 */
declare const name = "dsh-geo-viewer";
/** 依赖服务：工具注册表 + 文件系统缝。 */
declare const inject: string[];
/** 部署配置。 */
interface Config {
  /** MapLibre StyleJSON URL（底图）。 */
  mapStyleUrl: string;
  /** maplibre-gl 静态资源 CDN 目录（JS/CSS 拼接其后）。 */
  maplibreCdnBase: string;
  /** 卡片内地图高度（px）。 */
  cardHeight: number;
  /** 单次渲染的要素数上限。 */
  maxFeatures: number;
  /** 单次渲染的 GeoJSON 字节上限（meta 与规范值各持久化一份）。 */
  maxBytes: number;
  /** 地理编码行数上限（供应商配额保护）。 */
  maxGeocodeRows: number;
  /** 地理编码供应商。 */
  geocodingProvider: 'nominatim' | 'maptiler' | 'amap';
  /** 供应商 key（nominatim 留空）。 */
  geocodingKey: string;
  /** 覆盖供应商默认端点（自建反代/私有化实例）。 */
  geocodingBaseUrl: string;
}
/** Loader 校验用的 Schemastery schema，默认值即推荐部署值。 */
declare const Config: Schema<Config>;
/**
 * 注册 geo_view 工具。
 * @param ctx 注册上下文。
 * @param config 已校验的部署配置。
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, GEO_VIEW_TOOL_NAME, apply, inject, name };