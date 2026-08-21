# dsh-geo-viewer

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）地理数据可视化插件：对话中出现地理数据时，模型调用 `geo_view` 工具，对话流中直接渲染一张基于 [MapLibre GL](https://maplibre.org/) 的交互式地图卡片。

## 功能

- **表格地理字段识别**：`.csv` / `.tsv` / `.xlsx`（含内联 CSV 文本），表头启发式识别经纬度列（`lat` / `lng` / `latitude` / `longitude` / `经度` / `纬度` / `x,y` 配对 / `坐标` 单列合并格式），采样数值范围校验，列头与数值角色装反时按值自动互换；支持 `latColumn` / `lngColumn` 显式覆盖
- **GeoJSON 识别**：`FeatureCollection` / `Feature` / `Geometry` / 数组形态自动规范化，点、线、面分层渲染
- **地址地理编码**：地址列表直接绘图，或表格无坐标列时按 `addressColumn` 兜底定位；支持 Nominatim（免费）/ MapTiler / 高德（GCJ-02 自动转 WGS-84）
- **对话内交互卡片**：缩放平移、点击要素查看属性、超 500 点自动聚合、Fit 视野、页内全屏（Esc 退出）、明暗主题跟随；会话回放按字节重现
- **制品导出**：每次渲染在工作区导出 `geo/<slug>-<hash>.geojson`，可直接复用
- **体量护栏**：`maxFeatures` / `maxBytes` / `maxGeocodeRows` 三重上限，超限响亮报错并给出调参指引

## 安装

前置条件：Node.js >= 22.19，已安装 dsh CLI（`npm i -g @deepseek-ai/dsh`）。

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:naivemap/dsh-geo-viewer
# 可用 #<tag|branch> 锁定版本，如 github:naivemap/dsh-geo-viewer#main
```

### 从本地目录安装

```sh
git clone https://github.com/naivemap/dsh-geo-viewer.git
dsh plugin --profile web add /path/to/dsh-geo-viewer
```

### 从 tarball 安装（离线分发）

```sh
pnpm pack                                # 生成 dsh-geo-viewer-0.1.0.tgz
dsh plugin --profile web add ./dsh-geo-viewer-0.1.0.tgz
```

未全局安装 dsh 时，可改用 `npx @deepseek-ai/dsh plugin --profile web add <规格>` 一次性执行；`add` 接受的包规格与 pnpm 一致（npm / Git / 本地路径 / `file:` / `link:`）。

### 生效与验证

```sh
# 重启后生效（dsh web 正在运行则重启并刷新页面）
dsh --profile web

# 确认插件进入最终配置
dsh --profile web --dump-config
```

构建产物（`lib/`）已随仓库提交，以上安装方式均无需额外构建。

## 使用

直接用自然语言让模型画图，例如：

| 说法 | 触发路径 |
|---|---|
| 「把 examples/cities.csv 画到地图上」 | CSV 文件 → 中文列头经纬度检测 |
| 「可视化 examples/demo.geojson」 | GeoJSON → 面/线/点混合渲染 |
| 「在地图上标出北京市、上海市、杭州市」 | 地址列表 → 地理编码 |
| 「这张表没有坐标，只有地址列，帮我定位」 | 表格 + `addressColumn` → 逐行地理编码 |

模型侧的工具参数（一般无需手写）：`path` / `data` / `addresses` 三选一，可选 `latColumn`、`lngColumn`、`addressColumn`、`title`、`styleUrl`。

## 配置

在 profile 的 `cordis.patch.yml`（或 home 级 `$DSH_HOME/cordis.patch.yml`）中覆盖配置行：

```yaml
- replace:
  - id: dsh-geo-viewer
    name: 'dsh-geo-viewer'
    config:
      mapStyleUrl: 'https://api.maptiler.com/maps/basic-v2/style.json?key=<你的MapTiler_KEY>'
      geocodingProvider: 'amap'
      geocodingKey: '<你的高德KEY>'
      cardHeight: 480
```

### 配置项

| 键 | 默认值 | 说明 |
|---|---|---|
| `mapStyleUrl` | `https://demotiles.maplibre.org/style.json` | MapLibre StyleJSON 底图地址；可换 MapTiler / Mapbox 兼容 / 自建矢量瓦片服务的 style URL |
| `maplibreCdnBase` | `https://unpkg.com/maplibre-gl@5/dist` | maplibre-gl 静态资源（JS/CSS）CDN 目录，按需换成 jsdelivr 或内网镜像 |
| `cardHeight` | `420` | 卡片内地图高度（px） |
| `maxFeatures` | `10000` | 单次渲染要素数上限 |
| `maxBytes` | `4000000` | 单次渲染 GeoJSON 字节上限 |
| `maxGeocodeRows` | `100` | 单次地理编码行数上限（保护供应商配额） |
| `geocodingProvider` | `nominatim` | `nominatim` / `maptiler` / `amap` |
| `geocodingKey` | `''` | 供应商 API key（maptiler / amap 必填，nominatim 忽略） |
| `geocodingBaseUrl` | `''` | 覆盖供应商默认端点（自建反代 / 私有化实例） |

### Web 设置项

上述配置同时注册为 `dsh-geo-viewer` 设置命名空间：Web 端「设置 -> 插件 -> 插件配置」会出现本插件的卡片，全部键都可在页面上编辑，保存即生效（无需重启）。

- 组合层（上述 `cordis.patch.yml` 的 `config` 行）是命名空间的 base；页面保存写入用户层，按键覆盖 base。
- 「重置」清除该键的用户层覆盖，回落到 `cordis.patch.yml` 的取值；卡片上以「已覆盖」标注。
- URL 形态校验（`mapStyleUrl` / `maplibreCdnBase` 必须是 `http(s)`）在加载期和每次保存时执行，坏值会被宿主拒绝。
- 无 settings 服务的部署（TUI / headless）不受影响，行为与纯 YAML 配置完全一致。

### 地理编码供应商

| 供应商 | key | 限速 | 适用 |
|---|---|---|---|
| Nominatim（默认） | 不需要 | 1 请求/秒（插件已内置） | 国际数据；免费公共实例 |
| MapTiler | 需要 | 宽松 | 与 MapTiler 底图配套；国际数据 |
| amap（高德） | 需要 | 内置 300ms 间隔 | 国内地址效果最好；结果自动 GCJ-02 → WGS-84 |

key 缺失时首次地理编码即报错并提示对应配置项，不会静默失败。

## 工作原理

DSH 插件双半侧架构：

- **宿主半侧**（`lib/index.js`，Node）：注册 `geo_view` 工具；解析输入 → 转标准 GeoJSON → 连同渲染参数写入持久化 `tool/result` meta（`presentationMeta`）→ 工作区导出制品
- **浏览器半侧**（`lib/client.js`，由 DSH Web UI 经 `__ModuleLoader__` 注入）：以键控 toolview 注册 `geo_view` 卡片，按 meta 从 CDN 动态加载 maplibre-gl 渲染地图；不读工作区文件，回放稳定
- TUI / headless 客户端无浏览器半侧，自动回退为通用工具卡片文本，工具仍可用

## 开发

```sh
pnpm install
pnpm run check      # typecheck（双侧）+ vitest + 构建
pnpm run test       # 仅测试
pnpm run build      # 仅构建 lib/
```

修改源码后需重新 `pnpm run build`（`lib/` 随仓库提交），再在 profile 中重新加载或重启 dsh。

## 限制

- 仅渲染 GeoJSON 支持的几何（点/线/面及其 Multi 形态），不支持 WKT / Shapefile（可先转换）
- 地理编码走宿主侧网络；离线环境请配置 `geocodingBaseUrl` 指向内网服务
- 大数据集受 `maxFeatures` / `maxBytes` 护栏约束，超大 GeoJSON 请先降采样

## License

MIT
