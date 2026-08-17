/**
 * dsh-geo-viewer 的 Web 设置卡片：注册进「设置 -> 插件 -> 插件配置」的
 * `settings.plugin.item` 键控槽位（键即宿主注册的设置命名空间）。
 *
 * 官方约束（dsh-client-ui-settings-plugins）：外部插件不得以值导入该包的
 * 卡片外观与表单模型（客户端纯度门禁），因此本文件自带暂存草稿与版本围栏：
 * 编辑只进本地草稿，保存时逐字段写入宿主 settings 命名空间，每笔写携带
 * 读取时的 revision，过期即被宿主拒绝并重读。字段是否「已覆盖」以用户层
 * 的键存在性为准（与设置缝的分层语义一致），重置即清除该键回落组合层。
 */
import { useState, type CSSProperties } from 'react'
import { createSnapshotStore, type SettingsScope, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** 卡片文案的 locale 命名空间。 */
export const LOCALE_NS = 'dsh-geo-viewer.settings'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-geo-viewer 设置卡片文案（zh/en 键集一致）。 */
    'dsh-geo-viewer.settings': keyof typeof zh
  }
  interface SlotMap {
    /**
     * Plugins 设置页的可配置插件卡片槽位，按宿主设置命名空间键控分发
     * （运行时由 dsh-client-ui-settings-plugins 声明）。npm 发布的
     * rc.6 类型仍是旧的 list 形态，这里按实际运行时契约本地声明。
     */
    'settings.plugin.item': {
      kind: 'keyed'
      scope: 'root'
      owner: { children?: never }
    }
  }
}

/** 中文文案（键同时是卡片组件的取词键）。 */
export const zh = {
  title: '地理可视化（dsh-geo-viewer）',
  description: '地图底图、地理编码供应商与体量护栏；保存后立即生效。',
  unsaved: '有未保存的修改',
  readOnly: '当前部署只读，设置需写入配置文件。',
  saveFailed: '保存失败：请检查取值后重试。',
  save: '保存',
  discard: '放弃',
  reset: '重置',
  overridden: '已覆盖',
  invalidNumber: '需为非负整数',
  expand: '展开',
  collapse: '收起',
  mapStyleUrl: '底图样式 URL',
  mapStyleUrlHint: 'MapLibre StyleJSON 地址，如 MapTiler style URL 或自建矢量瓦片服务。',
  maplibreCdnBase: 'maplibre-gl CDN 目录',
  maplibreCdnBaseHint: 'maplibre-gl.js / .css 从该目录加载，可换内网镜像。',
  cardHeight: '卡片地图高度（px）',
  maxFeatures: '单次渲染要素上限',
  maxBytes: '单次渲染 GeoJSON 字节上限',
  maxGeocodeRows: '单次地理编码行数上限',
  geocodingProvider: '地理编码供应商',
  geocodingProviderHint: '国内地址选高德最佳；国际数据选 MapTiler 或 Nominatim。',
  geocodingProviderNominatim: 'Nominatim（免费，限速 1 请求/秒）',
  geocodingProviderMaptiler: 'MapTiler（需 key）',
  geocodingProviderAmap: '高德（需 key，GCJ-02 自动转 WGS-84）',
  geocodingKey: '供应商 API key',
  geocodingKeyHint: 'maptiler / amap 必填；nominatim 忽略。',
  geocodingBaseUrl: '地理编码端点覆盖',
  geocodingBaseUrlHint: '留空用供应商默认端点；可指向自建反代或私有化实例。',
} as const

/** 英文文案。 */
export const en = {
  title: 'Geo visualization (dsh-geo-viewer)',
  description: 'Basemap, geocoding provider, and size guards; saves apply immediately.',
  unsaved: 'Unsaved changes',
  readOnly: 'This deployment is read-only; edit the config file instead.',
  saveFailed: 'Save failed: check the values and retry.',
  save: 'Save',
  discard: 'Discard',
  reset: 'Reset',
  overridden: 'Overridden',
  invalidNumber: 'Must be a non-negative integer',
  expand: 'Expand',
  collapse: 'Collapse',
  mapStyleUrl: 'Basemap style URL',
  mapStyleUrlHint: 'MapLibre StyleJSON URL, e.g. a MapTiler style URL or self-hosted vector tiles.',
  maplibreCdnBase: 'maplibre-gl CDN base',
  maplibreCdnBaseHint: 'Directory maplibre-gl.js / .css load from; point at an intranet mirror if needed.',
  cardHeight: 'Card map height (px)',
  maxFeatures: 'Max features per render',
  maxBytes: 'Max GeoJSON bytes per render',
  maxGeocodeRows: 'Max geocoded rows per call',
  geocodingProvider: 'Geocoding provider',
  geocodingProviderHint: 'Amap suits CN addresses best; MapTiler/Nominatim for global data.',
  geocodingProviderNominatim: 'Nominatim (free, 1 req/s)',
  geocodingProviderMaptiler: 'MapTiler (key required)',
  geocodingProviderAmap: 'Amap (key required, GCJ-02 auto-converted)',
  geocodingKey: 'Provider API key',
  geocodingKeyHint: 'Required for maptiler/amap; ignored by nominatim.',
  geocodingBaseUrl: 'Geocoding endpoint override',
  geocodingBaseUrlHint: 'Empty keeps the provider default; point at a self-hosted proxy if needed.',
} as const

/** 供应商选项（与宿主 Config schema 的 union 一致）。 */
const PROVIDERS = ['nominatim', 'maptiler', 'amap'] as const

/** 卡片可编辑的字段名。 */
type GeoField =
  | 'mapStyleUrl'
  | 'maplibreCdnBase'
  | 'cardHeight'
  | 'maxFeatures'
  | 'maxBytes'
  | 'maxGeocodeRows'
  | 'geocodingProvider'
  | 'geocodingKey'
  | 'geocodingBaseUrl'

/** 一条草稿会被解析成：清空回落 / 写入新值 / 非法（阻止保存）。 */
type FieldWrite = { kind: 'clear' } | { kind: 'set', value: string | number }

/** 字段转换规格：section 值 <-> 控件文本。 */
interface FieldSpec {
  field: GeoField
  format: (value: unknown) => string
  parse: (text: string) => FieldWrite | undefined
}

/** 自由文本字段：空草稿即清空（等价于重置）。 */
function textField(field: GeoField): FieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: text => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/** 非负整数字段（Schema.natural 口径）：非法草稿阻止保存。 */
function naturalField(field: GeoField): FieldSpec {
  return {
    field,
    format: value => typeof value === 'number' ? String(value) : '',
    parse: text => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isInteger(parsed) && parsed >= 0 ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/** 供应商下拉字段。 */
function providerField(field: GeoField): FieldSpec {
  return {
    field,
    format: value => typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value) ? value : '',
    parse: text => (PROVIDERS as readonly string[]).includes(text) ? { kind: 'set', value: text } : undefined,
  }
}

/** 卡片的全部字段（渲染顺序即此顺序）。 */
const FIELD_SPECS: readonly FieldSpec[] = [
  textField('mapStyleUrl'),
  textField('maplibreCdnBase'),
  naturalField('cardHeight'),
  naturalField('maxFeatures'),
  naturalField('maxBytes'),
  naturalField('maxGeocodeRows'),
  providerField('geocodingProvider'),
  textField('geocodingKey'),
  textField('geocodingBaseUrl'),
]

/** 单字段控件状态：草稿文本 + 是否会留下覆盖 + 是否非法。 */
export interface FieldState {
  text: string
  overridden: boolean
  invalid: boolean
}

/** 卡片整体状态（注入组件的快照）。 */
export interface GeoCardState {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
  fields: Record<GeoField, FieldState>
}

/** 暂存草稿模型：scope 快照 + 本地草稿的联合投影。 */
class GeoCardForm {
  private readonly specs = new Map(FIELD_SPECS.map(spec => [spec.field, spec]))
  private readonly staged = new Map<GeoField, { text: string, clear: boolean }>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  constructor(private readonly scope: SettingsScope<unknown>) {
    scope.subscribe(() => this.publish())
  }

  /** 以初始投影建快照存储；此后 scope 或草稿任一变化都重算。 */
  bind(project: () => GeoCardState): SnapshotStore<GeoCardState> {
    const store = createSnapshotStore(project())
    this.listeners.add(() => {
      store.set(project())
    })
    return store
  }

  /** 卡片级状态：宿主是否服务该命名空间、保存会做什么。 */
  shell(): Pick<GeoCardState, 'available' | 'writable' | 'dirty' | 'invalid' | 'saving' | 'failed'> {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.run === undefined),
      saving: this.saving,
      failed: this.failed,
    }
  }

  /** 单字段控件状态。 */
  field(field: GeoField): FieldState {
    const staged = this.staged.get(field)
    const spec = this.specOf(field)
    if (staged === undefined) {
      return {
        text: spec.format(this.sectionValue(field)),
        overridden: this.stored(field),
        invalid: false,
      }
    }
    const write = staged.clear ? { kind: 'clear' } as const : spec.parse(staged.text)
    return {
      text: staged.text,
      overridden: write?.kind === 'set',
      invalid: write === undefined,
    }
  }

  /** 卡片动作（注入组件）。 */
  actions() {
    return {
      edit: (field: GeoField, text: string) => {
        this.staged.set(field, { text, clear: false })
        this.failed = false
        this.publish()
      },
      resetField: (field: GeoField) => {
        this.staged.set(field, { text: this.specOf(field).format(this.baseValue(field)), clear: true })
        this.failed = false
        this.publish()
      },
      save: () => {
        void this.save()
      },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  /** 逐字段写入暂存编辑，再按宿主接受结果重播种草稿。 */
  private async save(): Promise<void> {
    const plan = this.plan()
    const writes = plan.flatMap(item => item.run === undefined ? [] : [item.run])
    if (plan.length === 0 || this.saving || writes.length !== plan.length) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const write of writes) landed = await write() && landed
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  /** 一次保存会执行的写集；非法草稿项无 run（表单脏而不可存）。 */
  private plan(): Array<{ field: GeoField, run: (() => Promise<boolean>) | undefined }> {
    const plan: Array<{ field: GeoField, run: (() => Promise<boolean>) | undefined }> = []
    for (const [field, staged] of this.staged) {
      const spec = this.specOf(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, run: () => this.clear(field) })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) {
        plan.push({ field, run: undefined })
      } else if (write.kind === 'clear') {
        if (this.stored(field)) plan.push({ field, run: () => this.clear(field) })
      } else {
        plan.push({ field, run: () => this.store(field, write.value) })
      }
    }
    return plan
  }

  private async clear(field: GeoField): Promise<boolean> {
    await this.scope.unset(field)
    return !this.stored(field)
  }

  private async store(field: GeoField, value: string | number): Promise<boolean> {
    await this.scope.set(field, value)
    return this.userLayer()?.[field] === value
  }

  private specOf(field: GeoField): FieldSpec {
    const spec = this.specs.get(field)
    if (spec === undefined) throw new Error(`dsh-geo-viewer settings card has no field ${field}`)
    return spec
  }

  private sectionValue(field: GeoField): unknown {
    return (this.scope.getSnapshot().value as Record<string, unknown> | undefined)?.[field]
  }

  private baseValue(field: GeoField): unknown {
    return (this.scope.getSnapshot().base as Record<string, unknown> | undefined)?.[field]
  }

  private userLayer(): Record<string, unknown> | undefined {
    return this.scope.getSnapshot().user as Record<string, unknown> | undefined
  }

  /** 用户层键存在性 = 已覆盖（与设置缝分层语义一致）。 */
  private stored(field: GeoField): boolean {
    const user = this.userLayer()
    return user !== undefined && Object.hasOwn(user, field)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

/** 卡片注入面：hooks.geoCard 经框架转为 useGeoCard 选择器钩子。 */
export interface GeoCardInjected {
  hooks: {
    geoCard: SnapshotStore<GeoCardState>
  }
  edit: (field: GeoField, text: string) => void
  resetField: (field: GeoField) => void
  save: () => void
  discard: () => void
}

/** 卡片组件 props：locale 的 t 座 + 注入面（框架同款推导，类型零漂移）。 */
export type GeoSettingsCardProps = PropsLocale<typeof LOCALE_NS> & InjectFace<GeoCardInjected>

/** 卡片外壳与字段的内联样式（dsw 主题变量，与官方卡片同款视觉）。 */
const styles = {
  card: {
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-3)',
    borderRadius: 12,
    listStyle: 'none',
    transition: 'border-color .16s, background .16s',
  } satisfies CSSProperties,
  header: {
    appearance: 'none',
    width: '100%',
    font: 'inherit',
    color: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    background: 'transparent',
    border: 0,
    borderRadius: 12,
    alignItems: 'center',
    gap: 12,
    padding: '14px 16px',
    display: 'flex',
  } satisfies CSSProperties,
  headText: { flexDirection: 'column', flex: 1, gap: 4, minWidth: 0, display: 'flex' } satisfies CSSProperties,
  name: { color: 'var(--dsw-alias-label-primary)', fontSize: 15, fontWeight: 600, lineHeight: 1.4 } satisfies CSSProperties,
  description: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: 1.5 } satisfies CSSProperties,
  pending: {
    whiteSpace: 'nowrap',
    background: 'var(--dsw-alias-bg-module-platform)',
    color: 'var(--dsw-alias-label-secondary)',
    borderRadius: 999,
    flex: 'none',
    padding: '1px 8px',
    fontSize: 11,
    fontWeight: 500,
    lineHeight: '17px',
  } satisfies CSSProperties,
  chevron: { color: 'var(--dsw-alias-label-tertiary)', flex: 'none', transition: 'transform .16s' } satisfies CSSProperties,
  body: { borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '0 16px', paddingBottom: 8, display: 'flex', flexDirection: 'column' } satisfies CSSProperties,
  readOnly: { color: 'var(--dsw-alias-label-tertiary)', margin: '12px 0 0', fontSize: 12, lineHeight: 1.5 } satisfies CSSProperties,
  field: { flexDirection: 'column', gap: 6, padding: '12px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)', display: 'flex' } satisfies CSSProperties,
  fieldHead: { alignItems: 'center', gap: 10, fontSize: 12, fontWeight: 500, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', display: 'inline-flex' } satisfies CSSProperties,
  fieldLabel: { flex: 1, minWidth: 0 } satisfies CSSProperties,
  reset: {
    appearance: 'none',
    font: 'inherit',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
    background: 'transparent',
    border: 0,
    padding: 0,
    fontSize: 12,
  } satisfies CSSProperties,
  input: {
    boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)',
    width: '100%',
    height: 32,
    font: 'inherit',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    borderRadius: 8,
    padding: '0 10px',
    fontSize: 14,
    lineHeight: '22px',
  } satisfies CSSProperties,
  hint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px' } satisfies CSSProperties,
  error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: '18px' } satisfies CSSProperties,
  footer: { borderTop: '1px solid var(--dsw-alias-border-l2)', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '12px 0 4px', display: 'flex' } satisfies CSSProperties,
  failed: { minWidth: 0, color: 'var(--dsw-alias-label-error)', flex: 1, margin: 0, fontSize: 12, lineHeight: 1.5 } satisfies CSSProperties,
  discard: {
    appearance: 'none',
    font: 'inherit',
    cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l2)',
    color: 'var(--dsw-alias-label-secondary)',
    background: 'transparent',
    borderRadius: 8,
    padding: '5px 14px',
    fontSize: 13,
    lineHeight: 1.5,
  } satisfies CSSProperties,
  saveButton: {
    appearance: 'none',
    font: 'inherit',
    cursor: 'pointer',
    border: '1px solid transparent',
    background: 'var(--dsw-alias-label-primary)',
    color: 'var(--dsw-alias-bg-layer-3)',
    borderRadius: 8,
    padding: '5px 14px',
    fontSize: 13,
    lineHeight: 1.5,
  } satisfies CSSProperties,
} as const

/** 本卡片文案键（zh/en 键集一致）。 */
type GeoLocaleKey = keyof typeof zh

/** 供应商下拉的取词键。 */
const PROVIDER_LABEL_KEYS: Record<(typeof PROVIDERS)[number], GeoLocaleKey> = {
  nominatim: 'geocodingProviderNominatim',
  maptiler: 'geocodingProviderMaptiler',
  amap: 'geocodingProviderAmap',
}

/** 字段标题取词键。 */
const FIELD_LABEL_KEYS: Record<GeoField, GeoLocaleKey> = {
  mapStyleUrl: 'mapStyleUrl',
  maplibreCdnBase: 'maplibreCdnBase',
  cardHeight: 'cardHeight',
  maxFeatures: 'maxFeatures',
  maxBytes: 'maxBytes',
  maxGeocodeRows: 'maxGeocodeRows',
  geocodingProvider: 'geocodingProvider',
  geocodingKey: 'geocodingKey',
  geocodingBaseUrl: 'geocodingBaseUrl',
}

/** 带提示文案的字段（其余字段仅标题）。 */
const FIELD_HINTS: Partial<Record<GeoField, GeoLocaleKey>> = {
  mapStyleUrl: 'mapStyleUrlHint',
  maplibreCdnBase: 'maplibreCdnBaseHint',
  geocodingProvider: 'geocodingProviderHint',
  geocodingKey: 'geocodingKeyHint',
  geocodingBaseUrl: 'geocodingBaseUrlHint',
}

/** 设置卡片：可折叠外壳 + 字段控件 + 保存/放弃。 */
export function GeoSettingsCard(props: GeoSettingsCardProps) {
  const [open, setOpen] = useState(false)
  const { t } = props
  const state = props.useGeoCard(snapshot => snapshot)
  if (!state.available) return null
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <li style={styles.card}>
      <button
        type="button"
        style={styles.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span style={styles.headText}>
          <span style={styles.name}>{t('title')}</span>
          <span style={styles.description}>{t('description')}</span>
        </span>
        {state.dirty ? <span style={styles.pending}>{t('unsaved')}</span> : null}
        <span style={{ ...styles.chevron, transform: open ? 'rotate(180deg)' : undefined }}>▾</span>
      </button>
      {open ? (
        <div style={styles.body}>
          {!state.writable ? <p style={styles.readOnly} role="status">{t('readOnly')}</p> : null}
          {FIELD_SPECS.map(spec => {
            const hintKey = FIELD_HINTS[spec.field]
            const numeric = spec.field === 'cardHeight' || spec.field === 'maxFeatures' || spec.field === 'maxBytes' || spec.field === 'maxGeocodeRows'
            return (
            <div key={spec.field} style={styles.field}>
              <span style={styles.fieldHead}>
                <span style={styles.fieldLabel}>{t(FIELD_LABEL_KEYS[spec.field])}</span>
                {state.fields[spec.field].overridden ? (
                  <button
                    type="button"
                    style={styles.reset}
                    disabled={!state.writable}
                    onClick={() => { props.resetField(spec.field) }}
                  >
                    {t('reset')}
                  </button>
                ) : null}
              </span>
              {spec.field === 'geocodingProvider' ? (
                <select
                  style={styles.input}
                  disabled={!state.writable}
                  value={state.fields.geocodingProvider.text}
                  onChange={event => { props.edit('geocodingProvider', event.target.value) }}
                >
                  {PROVIDERS.map(provider => (
                    <option key={provider} value={provider}>{t(PROVIDER_LABEL_KEYS[provider])}</option>
                  ))}
                </select>
              ) : (
                <input
                  style={styles.input}
                  disabled={!state.writable}
                  value={state.fields[spec.field].text}
                  inputMode={numeric ? 'numeric' : undefined}
                  onChange={event => { props.edit(spec.field, event.target.value) }}
                />
              )}
              {hintKey !== undefined ? <span style={styles.hint}>{t(hintKey)}</span> : null}
              {state.fields[spec.field].invalid ? <span style={styles.error}>{t('invalidNumber')}</span> : null}
            </div>
            )
          })}
          <div style={styles.footer}>
            {state.failed ? <p style={styles.failed} role="status">{t('saveFailed')}</p> : null}
            <button type="button" style={styles.discard} disabled={!state.dirty || state.saving} onClick={props.discard}>
              {t('discard')}
            </button>
            <button type="button" style={styles.saveButton} disabled={blocked} onClick={props.save}>
              {t('save')}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/**
 * 卡片控制器：把 `dsh-geo-viewer` 命名空间的设置 scope 桥接到暂存表单，
 * 产出槽位注册注入的面（快照钩子 + 动作）。
 */
export class GeoViewerCardController {
  private readonly form: GeoCardForm
  private readonly store: SnapshotStore<GeoCardState>

  /** @param scope 宿主 `dsh-geo-viewer` 设置命名空间的客户端 scope。 */
  constructor(scope: SettingsScope<unknown>) {
    this.form = new GeoCardForm(scope)
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): GeoCardState {
    return {
      ...this.form.shell(),
      fields: Object.fromEntries(FIELD_SPECS.map(spec => [spec.field, this.form.field(spec.field)])) as Record<GeoField, FieldState>,
    }
  }

  /** 槽位注册注入面：hooks.geoCard 经框架转为 useGeoCard 钩子。 */
  inject(): GeoCardInjected {
    return {
      hooks: { geoCard: this.store },
      ...this.form.actions(),
    }
  }
}
