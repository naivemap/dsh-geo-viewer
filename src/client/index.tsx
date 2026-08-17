/**
 * dsh-geo-viewer，浏览器半侧：`geo_view` 工具的键控 toolview 卡片。
 * 宿主半侧把渲染参数与数据随 tool/result meta 持久化，这里纯函数收窄后
 * 交给 MapView 渲染交互式地图；不具备该半侧的客户端按渲染意图回退通用卡片。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// 仅类型：引入 `tool.call.toolview` SlotMap 声明。
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { GeoCard } from './GeoCard.tsx'

export const name = 'dsh-geo-viewer'
export const inject = ['slots']

/**
 * 注册键控 toolview。等待槽位声明到位再注册，与官方注册方一致：
 * 入场应用顺序由 loader 决定，抢先注册会在声明前失败。
 * @param ctx 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'geo_view' },
    GeoCard,
  ))
}
