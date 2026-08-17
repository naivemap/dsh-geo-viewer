/**
 * `geo_view` toolview：按调用块状态分流。
 * 运行中显示单行等待；失败或 meta 缺失回退到持久化结果文本；
 * 完好 meta 才挂载 MapView。回放稳定性由构造保证：一切绘制只来自
 * 已记录的调用切片（meta），不读工作区文件。
 */
import { useMemo, type CSSProperties } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { geoViewMetaFrom } from '../meta.ts'
import { MapView } from './MapView.tsx'

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  fontSize: 12,
  opacity: 0.65,
  margin: '2px 0 6px',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
}

/** 持久化结果内容的第一行文本（错误行展示用）。 */
function firstResultLine(content: readonly { type: string, text?: string }[]): string {
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      const newline = block.text.indexOf('\n')
      return newline === -1 ? block.text : block.text.slice(0, newline)
    }
  }
  return 'geo view failed'
}

/** geo_view 的键控 toolview 组件。 */
export function GeoCard({ block }: ToolCallViewProps) {
  const settled = 'kind' in block
  const isError = settled && block.isError
  const rawMeta = settled && !block.isError ? block.meta : undefined
  // memo：rawMeta 引用来自会话状态（稳定），窄化产生的新对象不应触发地图重建。
  const meta = useMemo(() => geoViewMetaFrom(rawMeta), [rawMeta])

  if (!settled) {
    return <div style={headerStyle}>Geo view · loading…</div>
  }
  if (isError) {
    return <div style={headerStyle}>Geo view · {firstResultLine(block.content)}</div>
  }
  if (meta === undefined) {
    // 旧日志或外部宿主记录的调用：显示持久化结果文本而不是猜渲染。
    return <div style={headerStyle}>{firstResultLine(block.content)}</div>
  }
  return <MapView meta={meta} />
}
