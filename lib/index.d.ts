import Schema from "@deepseek-ai/schemastery";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
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
/**
 * Web 设置项命名空间：注册到 `ctx.settings` 后，Web 端「设置 → 插件 →
 * 插件配置」出现本插件卡片；用户层覆盖组合层（profile 的 config 行），
 * 保存即生效，无需重启。
 */
declare const SETTINGS_NAMESPACE: SettingsNamespace;
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
 * 注册 geo_view 工具并把配置挂到 Web 设置项。
 *
 * 组合层（profile `config` 行）作为设置命名空间的 base：Web 端保存的用户层
 * 覆盖其上，工具每次调用读取当前解析值，改动即时生效；无 settings 服务的
 * 部署（TUI/headless）自动回落到组合层，行为与纯 YAML 配置完全一致。
 * @param ctx 注册上下文。
 * @param config 已校验的部署配置。
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, GEO_VIEW_TOOL_NAME, SETTINGS_NAMESPACE, apply, inject, name };