/**
 * dsh-geo-viewer，浏览器半侧：
 * - `geo_view` 工具的键控 toolview 卡片（对话流地图渲染）；
 * - 「设置 -> 插件 -> 插件配置」里的本插件设置卡片（`settings.plugin.item`
 *   键控槽位，键即宿主注册的 `dsh-geo-viewer` 设置命名空间）。
 *
 * 设置卡片经 `settingsScope` 服务绑定命名空间，仅当部署提供该服务（Web
 * bundle）时挂载；toolview 注册不依赖它，TUI/headless 客户端不受影响。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// 仅类型：引入 `tool.call.toolview` SlotMap 声明。
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// 仅类型：引入 `ctx.settingsScope` 服务声明（dsh-client-ui-settings 提供）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 仅类型：引入 `ctx.locale` 服务声明（dsh-client-locale 提供）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { GeoCard } from './GeoCard.tsx'
import { GeoSettingsCard, GeoViewerCardController, LOCALE_NS, en, zh } from './SettingsCard.tsx'

export const name = 'dsh-geo-viewer'
export const inject = ['slots']

/**
 * 注册键控 toolview 与设置卡片。等待槽位声明到位再注册，与官方注册方一致：
 * 入场应用顺序由 loader 决定，抢先注册会在声明前失败。
 * @param ctx 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'geo_view' },
    GeoCard,
  ))
  // 设置卡片按需挂载：settingsScope/locale 缺席的客户端跳过，不影响 toolview。
  ctx.inject(['settingsScope', 'locale'], sctx => {
    sctx.effect(() => sctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-geo-viewer: settings card dictionaries')
    const controller = new GeoViewerCardController(sctx.settingsScope.bind({ namespace: 'dsh-geo-viewer' }))
    sctx.slots.inject('settings.plugin.item', () => sctx.slots.register(
      { name: 'settings.plugin.item', key: 'dsh-geo-viewer', locale: LOCALE_NS, inject: () => controller.inject() },
      GeoSettingsCard,
    ))
  })
}
