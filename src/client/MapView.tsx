/**
 * 交互式地图卡片主体。
 *
 * - maplibre-gl 按配置的 CDN 目录动态加载（JS+CSS），Promise 按 base 缓存，
 *   多卡片并发只加载一次；加载失败（网络/CSP）给出可操作的错误提示。
 * - 数据作为单一 geojson source；点要素超过阈值时开启聚类（三层半径，
 *   不用文本层，避免底图 StyleJSON 的字体依赖）。
 * - 全屏 = 同一容器切换 position:fixed 类 + resize，无 DOM 迁移、无新页签，
 *   不受弹窗拦截与 CSP 影响；Esc 退出。
 * - 配色跟随宿主明暗主题（body 背景亮度探测 + 属性变化监听）。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { GeoViewMeta } from '../meta.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type MapLibreModule = any
type MapLibreMap = any

/** CDN 加载缓存：base -> 已解析的 maplibregl 命名空间。 */
const mapLibreCache = new Map<string, Promise<MapLibreModule>>()

/** 点数超过该值开启聚类。 */
const CLUSTER_THRESHOLD = 500

/** 弹窗属性行数上限。 */
const POPUP_ROWS = 15

function loadMapLibre(base: string): Promise<MapLibreModule> {
  const cached = mapLibreCache.get(base)
  if (cached !== undefined) return cached
  const promise = new Promise<MapLibreModule>((resolve, reject) => {
    const existing = (window as unknown as Record<string, unknown>)['maplibregl']
    if (existing !== undefined) {
      resolve(existing as MapLibreModule)
      return
    }
    const css = document.createElement('link')
    css.rel = 'stylesheet'
    css.href = `${base}/maplibre-gl.css`
    css.onerror = () => {
      reject(new Error(`failed to load ${base}/maplibre-gl.css - check the dsh-geo-viewer \`maplibreCdnBase\` config`))
    }
    const script = document.createElement('script')
    script.src = `${base}/maplibre-gl.js`
    script.async = true
    script.onload = () => {
      const lib = (window as unknown as Record<string, unknown>)['maplibregl']
      if (lib === undefined) {
        reject(new Error('maplibre-gl script loaded but window.maplibregl is missing'))
        return
      }
      resolve(lib as MapLibreModule)
    }
    script.onerror = () => {
      reject(new Error(
        `failed to load ${base}/maplibre-gl.js (network blocked or CSP) - `
        + 'check the dsh-geo-viewer \`maplibreCdnBase\` config',
      ))
    }
    document.head.appendChild(css)
    document.head.appendChild(script)
  })
  mapLibreCache.set(base, promise)
  return promise
}

/** 宿主当前是否暗色主题（body 背景亮度探测，主题框架无关）。 */
function isDark(): boolean {
  const bg = getComputedStyle(document.body).backgroundColor
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg)
  if (m === null) return matchMedia('(prefers-color-scheme: dark)').matches
  const r = Number(m[1])
  const g = Number(m[2])
  const b = Number(m[3])
  return 0.299 * r + 0.587 * g + 0.114 * b < 128
}

/** 明暗两套画笔色。 */
interface Palette { point: string, line: string, fill: string, cluster: string[] }
const LIGHT: Palette = { point: '#2563eb', line: '#2563eb', fill: '#3b82f6', cluster: ['#93c5fd', '#60a5fa', '#3b82f6'] }
const DARK: Palette = { point: '#60a5fa', line: '#60a5fa', fill: '#60a5fa', cluster: ['#bfdbfe', '#93c5fd', '#60a5fa'] }

/** 按主题重设各图层画笔属性。 */
function applyPalette(map: MapLibreMap, dark: boolean): void {
  const p = dark ? DARK : LIGHT
  const stroke = dark ? '#0b1220' : '#ffffff'
  map.setPaintProperty('geo-points', 'circle-color', p.point)
  map.setPaintProperty('geo-points', 'circle-stroke-color', stroke)
  map.setPaintProperty('geo-lines', 'line-color', p.line)
  map.setPaintProperty('geo-polygons', 'fill-color', p.fill)
  map.setPaintProperty('geo-polygons-outline', 'line-color', p.line)
  if (map.getLayer('geo-clusters') !== undefined) {
    map.setPaintProperty('geo-clusters', 'circle-color', ['step', ['get', 'point_count'], p.cluster[0], 10, p.cluster[1], 100, p.cluster[2]] as never)
    map.setPaintProperty('geo-clusters', 'circle-stroke-color', stroke)
  }
}

/** 要素属性 -> 弹窗 DOM（无 innerHTML，免转义）。 */
function buildPopupContent(props: Record<string, unknown> | null): HTMLElement {
  const root = document.createElement('div')
  root.className = 'dgv-pop'
  const table = document.createElement('table')
  if (props !== null) {
    let rows = 0
    for (const [key, value] of Object.entries(props)) {
      if (rows >= POPUP_ROWS) break
      if (value === null || value === undefined) continue
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
      if (text === '') continue
      const tr = document.createElement('tr')
      const k = document.createElement('td')
      k.className = 'k'
      k.textContent = key
      const v = document.createElement('td')
      v.textContent = text.length > 220 ? `${text.slice(0, 220)}…` : text
      tr.appendChild(k)
      tr.appendChild(v)
      table.appendChild(tr)
      rows++
    }
  }
  if (table.childElementCount === 0) {
    const empty = document.createElement('div')
    empty.textContent = '(no properties)'
    root.appendChild(empty)
  } else {
    root.appendChild(table)
  }
  return root
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  fontSize: 12,
  opacity: 0.75,
  margin: '2px 0 6px',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
}

/** 统计点要素数（决定是否聚类）。 */
function countPoints(meta: GeoViewMeta): number {
  let n = 0
  for (const f of meta.geojson.features) {
    if (f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint') n++
  }
  return n
}

/**
 * 地图卡片。
 * @param props.meta 持久化渲染描述符（数据 + 渲染参数）。
 */
export function MapView({ meta }: { meta: GeoViewMeta }) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const fitRef = useRef<() => void>(() => {})
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string>('')
  const [full, setFull] = useState(false)

  // 主题 tick：宿主根/body 属性变化或系统外观翻转时重算画笔。
  const [themeTick, setThemeTick] = useState(0)
  useEffect(() => {
    const bump = () => setThemeTick(t => t + 1)
    const observer = new MutationObserver(bump)
    observer.observe(document.documentElement, { attributes: true })
    observer.observe(document.body, { attributes: true })
    const media = matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', bump)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', bump)
    }
  }, [])
  useEffect(() => {
    if (status === 'ready' && mapRef.current !== null) applyPalette(mapRef.current, isDark())
  }, [themeTick, status])

  // 建图（meta 引用由 GeoCard 层 memo 保证稳定）。
  useEffect(() => {
    let disposed = false
    let map: MapLibreMap | null = null
    let popup: unknown = null
    const fit = (): void => {
      const bounds: [number, number, number, number] = meta.bounds
      map?.fitBounds(bounds, { padding: 40, maxZoom: 15, duration: 400 })
    }
    fitRef.current = fit
    loadMapLibre(meta.maplibreCdnBase).then((L: MapLibreModule) => {
      if (disposed || wrapRef.current === null) return
      map = new L.Map({
        container: wrapRef.current,
        style: meta.styleUrl,
        attributionControl: { compact: true },
      })
      mapRef.current = map
      map.addControl(new L.NavigationControl({ visualizePitch: false }), 'bottom-right')
      const cluster = countPoints(meta) > CLUSTER_THRESHOLD
      map.on('load', () => {
        if (disposed || map === null) return
        map.addSource('geo', {
          type: 'geojson',
          data: meta.geojson,
          ...(cluster ? { cluster: true, clusterMaxZoom: 14, clusterRadius: 60 } : {}),
        })
        map.addLayer({
          id: 'geo-polygons',
          type: 'fill',
          source: 'geo',
          filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
          paint: { 'fill-color': LIGHT.fill, 'fill-opacity': 0.18 },
        })
        map.addLayer({
          id: 'geo-polygons-outline',
          type: 'line',
          source: 'geo',
          filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
          paint: { 'line-color': LIGHT.line, 'line-width': 1.5 },
        })
        map.addLayer({
          id: 'geo-lines',
          type: 'line',
          source: 'geo',
          filter: ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
          paint: { 'line-color': LIGHT.line, 'line-width': 2 },
        })
        if (cluster) {
          map.addLayer({
            id: 'geo-clusters',
            type: 'circle',
            source: 'geo',
            filter: ['has', 'point_count'],
            paint: {
              'circle-color': ['step', ['get', 'point_count'], LIGHT.cluster[0], 10, LIGHT.cluster[1], 100, LIGHT.cluster[2]] as never,
              'circle-radius': ['step', ['get', 'point_count'], 13, 10, 18, 100, 24] as never,
              'circle-opacity': 0.9,
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
            },
          })
        }
        map.addLayer({
          id: 'geo-points',
          type: 'circle',
          source: 'geo',
          filter: ['all',
            ['==', ['geometry-type'], 'Point'],
            ...(cluster ? [['!', ['has', 'point_count']]] as never[] : [])],
          paint: {
            'circle-color': LIGHT.point,
            'circle-radius': 5.5,
            'circle-opacity': 0.92,
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#ffffff',
          },
        })
        applyPalette(map, isDark())

        // 要素点击 -> 属性弹窗；聚类点击 -> 展开缩放。
        const interactive = cluster ? ['geo-points', 'geo-clusters'] : ['geo-points', 'geo-lines', 'geo-polygons', 'geo-polygons-outline']
        map.on('click', interactive, (e: unknown) => {
          const event = e as { features?: Array<Record<string, unknown>> }
          const feature = event.features?.[0]
          if (feature === undefined) return
          if (cluster && feature['layer'] !== undefined && (feature['layer'] as { id?: string }).id === 'geo-clusters') {
            const clusterId = (feature['properties'] as Record<string, unknown>)['cluster_id']
            const source = map.getSource('geo')
            source.getClusterExpansionZoom(clusterId, (err: unknown, zoom: number) => {
              const geometry = feature['geometry'] as { coordinates?: [number, number] } | null
              if (err === null && geometry?.coordinates !== undefined) {
                map.easeTo({ center: geometry.coordinates, zoom })
              }
            })
            return
          }
          const geometry = feature['geometry'] as { coordinates?: [number, number] } | null
          const lngLat = geometry?.coordinates !== undefined && Array.isArray(geometry.coordinates)
            ? geometry.coordinates
            : (e as { lngLat?: { lng: number, lat: number } }).lngLat !== undefined
              ? [(e as { lngLat: { lng: number, lat: number } }).lngLat.lng, (e as { lngLat: { lng: number, lat: number } }).lngLat.lat]
              : undefined
          if (lngLat === undefined) return
          popup = new L.Popup({ maxWidth: 360, closeButton: true })
            .setLngLat(lngLat)
            .setDOMContent(buildPopupContent(feature['properties'] as Record<string, unknown> | null))
            .addTo(map)
        })
        for (const layer of interactive) {
          map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer' })
          map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = '' })
        }
        fit()
        setStatus('ready')
      })
    }).catch((err: unknown) => {
      if (disposed) return
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    })
    return () => {
      disposed = true
      if (popup !== null && typeof popup === 'object' && 'remove' in popup) {
        ;(popup as { remove: () => void }).remove()
      }
      map?.remove()
      mapRef.current = null
    }
  }, [meta])

  // 容器尺寸变化（含全屏切换）时同步 WebGL 视口。
  useEffect(() => {
    const el = wrapRef.current
    if (el === null) return
    const observer = new ResizeObserver(() => { mapRef.current?.resize() })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 全屏期间锁定页面滚动；Esc 退出。
  useEffect(() => {
    if (!full) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setFull(false) }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [full])

  const sourceBits = [meta.sourceLabel, meta.latColumn !== undefined ? `lat:${meta.latColumn}` : undefined, meta.lngColumn !== undefined ? `lng:${meta.lngColumn}` : undefined]
  const sourceText = sourceBits.filter(v => v !== undefined).join(' · ')

  return (
    <div className="dgv-root">
      <div className="dgv-head" title={meta.artifactPath}>
        <span style={{ fontWeight: 500 }}>{meta.title}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{sourceText}</span>
      </div>
      <div
        className={`dgv-wrap${full ? ' dgv-full' : ''}`}
        style={{ height: full ? undefined : meta.cardHeight }}
      >
        {status === 'error'
          ? <div className="dgv-err">Map failed to load: {error}</div>
          : (
            <>
              <div ref={wrapRef} className="dgv-map" />
              <div className="dgv-chip">{String(meta.featureCount)} features</div>
              <div className="dgv-bar">
                {status === 'ready' && <button type="button" className="dgv-btn" onClick={() => fitRef.current()}>Fit</button>}
                <button type="button" className="dgv-btn" onClick={() => setFull(v => !v)}>{full ? 'Exit full' : 'Full'}</button>
              </div>
              {status === 'loading' && <div className="dgv-loading">loading map…</div>}
            </>
          )}
        {meta.note !== undefined && meta.note !== '' && <div className="dgv-note">{meta.note}</div>}
      </div>
    </div>
  )
}

/** 卡片样式（一次性注入）。 */
const CLIENT_CSS = `
.dgv-root { margin: 4px 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.dgv-head { display: flex; align-items: baseline; gap: 8px; font-size: 12px; opacity: .75; margin: 2px 0 6px; white-space: nowrap; overflow: hidden; }
.dgv-wrap { position: relative; border-radius: 10px; overflow: hidden; border: 1px solid rgba(127,127,127,.25); background: rgba(127,127,127,.08); }
.dgv-map { height: 100%; }
.dgv-wrap.dgv-full { position: fixed; inset: 0; z-index: 2147483000; border: none; border-radius: 0; }
.dgv-bar { position: absolute; top: 8px; right: 8px; display: flex; gap: 6px; z-index: 2; }
.dgv-chip { position: absolute; top: 8px; left: 8px; z-index: 2; font-size: 11px; padding: 2px 9px; border-radius: 999px; background: rgba(127,127,127,.35); color: #fff; backdrop-filter: blur(4px); pointer-events: none; }
.dgv-btn { font: 12px system-ui; padding: 3px 11px; border-radius: 999px; border: 1px solid rgba(127,127,127,.4); background: rgba(255,255,255,.82); color: #1f2937; cursor: pointer; backdrop-filter: blur(4px); }
.dgv-btn:hover { background: #fff; }
.dgv-err { padding: 10px 12px; font-size: 12px; color: #b91c1c; }
.dgv-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; opacity: .6; pointer-events: none; z-index: 1; }
.dgv-note { position: absolute; bottom: 8px; left: 8px; right: 8px; z-index: 2; font-size: 11px; padding: 3px 9px; border-radius: 8px; background: rgba(127,127,127,.3); color: #fff; backdrop-filter: blur(4px); pointer-events: none; max-width: max-content; max-width: -moz-max-content; }
.dgv-pop table { border-collapse: collapse; font-size: 12px; max-width: 320px; }
.dgv-pop td { padding: 2px 8px 2px 0; vertical-align: top; }
.dgv-pop td.k { opacity: .6; white-space: nowrap; }
`

/** 样式标签注入（幂等）。 */
let cssInjected = false
function injectCss(): void {
  if (cssInjected || document.getElementById('dgv-style') !== null) {
    cssInjected = true
    return
  }
  const style = document.createElement('style')
  style.id = 'dgv-style'
  style.textContent = CLIENT_CSS
  document.head.appendChild(style)
  cssInjected = true
}

// 模块加载即注入（与 dsh 客户端插件"CSS 内联注入"约定一致）。
injectCss()
