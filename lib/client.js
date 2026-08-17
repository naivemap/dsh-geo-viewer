window.__ModuleLoader__.load({
	id: "dsh-geo-viewer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
		//#region src/meta.ts
		/** meta.kind 判别值。 */
		const GEO_VIEW_META_KIND = "geo-view";
		const GEO_SOURCE_KINDS = [
			"csv",
			"tsv",
			"xlsx",
			"geojson",
			"inline-csv",
			"inline-geojson",
			"addresses"
		];
		const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
		function isFeatureCollection(v) {
			if (typeof v !== "object" || v === null) return false;
			const record = v;
			return record["type"] === "FeatureCollection" && Array.isArray(record["features"]);
		}
		/**
		* 将持久化 meta 收窄为 {@link GeoViewMeta}。线上数据不可信（旧/新宿主可能
		* 记录了不同形状），不匹配时返回 undefined，调用方回退通用卡片而不是回放崩溃。
		*/
		function geoViewMetaFrom(meta) {
			if (typeof meta !== "object" || meta === null) return void 0;
			const record = meta;
			if (record["kind"] !== "geo-view") return void 0;
			const { title, sourceKind, sourceLabel, featureCount, bounds, geojson } = record;
			if (typeof title !== "string" || typeof sourceLabel !== "string") return void 0;
			if (typeof featureCount !== "number" || !Number.isInteger(featureCount)) return void 0;
			if (!GEO_SOURCE_KINDS.includes(sourceKind)) return void 0;
			if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(isFiniteNumber)) return void 0;
			if (!isFeatureCollection(geojson)) return void 0;
			for (const key of [
				"artifactPath",
				"latColumn",
				"lngColumn",
				"addressColumn",
				"note"
			]) {
				const value = record[key];
				if (value !== void 0 && typeof value !== "string") return void 0;
			}
			const out = {
				kind: GEO_VIEW_META_KIND,
				title,
				sourceKind,
				sourceLabel,
				featureCount,
				bounds,
				geojson,
				styleUrl: typeof record["styleUrl"] === "string" ? record["styleUrl"] : "https://demotiles.maplibre.org/style.json",
				maplibreCdnBase: typeof record["maplibreCdnBase"] === "string" ? record["maplibreCdnBase"] : "https://unpkg.com/maplibre-gl@5/dist",
				cardHeight: isFiniteNumber(record["cardHeight"]) ? record["cardHeight"] : 420,
				artifactPath: typeof record["artifactPath"] === "string" ? record["artifactPath"] : ""
			};
			if (Array.isArray(record["columns"]) && record["columns"].every((v) => typeof v === "string")) out.columns = record["columns"];
			for (const key of ["geocodedCount", "geocodeFailed"]) {
				const value = record[key];
				if (isFiniteNumber(value)) out[key] = value;
			}
			return out;
		}
		//#endregion
		//#region src/client/MapView.tsx
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
		/** CDN 加载缓存：base -> 已解析的 maplibregl 命名空间。 */
		const mapLibreCache = /* @__PURE__ */ new Map();
		/** 点数超过该值开启聚类。 */
		const CLUSTER_THRESHOLD = 500;
		/** 弹窗属性行数上限。 */
		const POPUP_ROWS = 15;
		function loadMapLibre(base) {
			const cached = mapLibreCache.get(base);
			if (cached !== void 0) return cached;
			const promise = new Promise((resolve, reject) => {
				const existing = window["maplibregl"];
				if (existing !== void 0) {
					resolve(existing);
					return;
				}
				const css = document.createElement("link");
				css.rel = "stylesheet";
				css.href = `${base}/maplibre-gl.css`;
				css.onerror = () => {
					reject(/* @__PURE__ */ new Error(`failed to load ${base}/maplibre-gl.css - check the dsh-geo-viewer \`maplibreCdnBase\` config`));
				};
				const script = document.createElement("script");
				script.src = `${base}/maplibre-gl.js`;
				script.async = true;
				script.onload = () => {
					const lib = window["maplibregl"];
					if (lib === void 0) {
						reject(/* @__PURE__ */ new Error("maplibre-gl script loaded but window.maplibregl is missing"));
						return;
					}
					resolve(lib);
				};
				script.onerror = () => {
					reject(/* @__PURE__ */ new Error(`failed to load ${base}/maplibre-gl.js (network blocked or CSP) - check the dsh-geo-viewer \`maplibreCdnBase\` config`));
				};
				document.head.appendChild(css);
				document.head.appendChild(script);
			});
			mapLibreCache.set(base, promise);
			return promise;
		}
		/** 宿主当前是否暗色主题（body 背景亮度探测，主题框架无关）。 */
		function isDark() {
			const bg = getComputedStyle(document.body).backgroundColor;
			const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
			if (m === null) return matchMedia("(prefers-color-scheme: dark)").matches;
			const r = Number(m[1]);
			const g = Number(m[2]);
			const b = Number(m[3]);
			return .299 * r + .587 * g + .114 * b < 128;
		}
		const LIGHT = {
			point: "#2563eb",
			line: "#2563eb",
			fill: "#3b82f6",
			cluster: [
				"#93c5fd",
				"#60a5fa",
				"#3b82f6"
			]
		};
		const DARK = {
			point: "#60a5fa",
			line: "#60a5fa",
			fill: "#60a5fa",
			cluster: [
				"#bfdbfe",
				"#93c5fd",
				"#60a5fa"
			]
		};
		/** 按主题重设各图层画笔属性。 */
		function applyPalette(map, dark) {
			const p = dark ? DARK : LIGHT;
			const stroke = dark ? "#0b1220" : "#ffffff";
			map.setPaintProperty("geo-points", "circle-color", p.point);
			map.setPaintProperty("geo-points", "circle-stroke-color", stroke);
			map.setPaintProperty("geo-lines", "line-color", p.line);
			map.setPaintProperty("geo-polygons", "fill-color", p.fill);
			map.setPaintProperty("geo-polygons-outline", "line-color", p.line);
			if (map.getLayer("geo-clusters") !== void 0) {
				map.setPaintProperty("geo-clusters", "circle-color", [
					"step",
					["get", "point_count"],
					p.cluster[0],
					10,
					p.cluster[1],
					100,
					p.cluster[2]
				]);
				map.setPaintProperty("geo-clusters", "circle-stroke-color", stroke);
			}
		}
		/** 要素属性 -> 弹窗 DOM（无 innerHTML，免转义）。 */
		function buildPopupContent(props) {
			const root = document.createElement("div");
			root.className = "dgv-pop";
			const table = document.createElement("table");
			if (props !== null) {
				let rows = 0;
				for (const [key, value] of Object.entries(props)) {
					if (rows >= POPUP_ROWS) break;
					if (value === null || value === void 0) continue;
					const text = typeof value === "object" ? JSON.stringify(value) : String(value);
					if (text === "") continue;
					const tr = document.createElement("tr");
					const k = document.createElement("td");
					k.className = "k";
					k.textContent = key;
					const v = document.createElement("td");
					v.textContent = text.length > 220 ? `${text.slice(0, 220)}…` : text;
					tr.appendChild(k);
					tr.appendChild(v);
					table.appendChild(tr);
					rows++;
				}
			}
			if (table.childElementCount === 0) {
				const empty = document.createElement("div");
				empty.textContent = "(no properties)";
				root.appendChild(empty);
			} else root.appendChild(table);
			return root;
		}
		/** 统计点要素数（决定是否聚类）。 */
		function countPoints(meta) {
			let n = 0;
			for (const f of meta.geojson.features) if (f.geometry?.type === "Point" || f.geometry?.type === "MultiPoint") n++;
			return n;
		}
		/**
		* 地图卡片。
		* @param props.meta 持久化渲染描述符（数据 + 渲染参数）。
		*/
		function MapView({ meta }) {
			const wrapRef = (0, react.useRef)(null);
			const mapRef = (0, react.useRef)(null);
			const fitRef = (0, react.useRef)(() => {});
			const [status, setStatus] = (0, react.useState)("loading");
			const [error, setError] = (0, react.useState)("");
			const [full, setFull] = (0, react.useState)(false);
			const [themeTick, setThemeTick] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				const bump = () => setThemeTick((t) => t + 1);
				const observer = new MutationObserver(bump);
				observer.observe(document.documentElement, { attributes: true });
				observer.observe(document.body, { attributes: true });
				const media = matchMedia("(prefers-color-scheme: dark)");
				media.addEventListener("change", bump);
				return () => {
					observer.disconnect();
					media.removeEventListener("change", bump);
				};
			}, []);
			(0, react.useEffect)(() => {
				if (status === "ready" && mapRef.current !== null) applyPalette(mapRef.current, isDark());
			}, [themeTick, status]);
			(0, react.useEffect)(() => {
				let disposed = false;
				let map = null;
				let popup = null;
				const fit = () => {
					const bounds = meta.bounds;
					map?.fitBounds(bounds, {
						padding: 40,
						maxZoom: 15,
						duration: 400
					});
				};
				fitRef.current = fit;
				loadMapLibre(meta.maplibreCdnBase).then((L) => {
					if (disposed || wrapRef.current === null) return;
					map = new L.Map({
						container: wrapRef.current,
						style: meta.styleUrl,
						attributionControl: { compact: true }
					});
					mapRef.current = map;
					map.addControl(new L.NavigationControl({ visualizePitch: false }), "bottom-right");
					const cluster = countPoints(meta) > CLUSTER_THRESHOLD;
					map.on("load", () => {
						if (disposed || map === null) return;
						map.addSource("geo", {
							type: "geojson",
							data: meta.geojson,
							...cluster ? {
								cluster: true,
								clusterMaxZoom: 14,
								clusterRadius: 60
							} : {}
						});
						map.addLayer({
							id: "geo-polygons",
							type: "fill",
							source: "geo",
							filter: [
								"match",
								["geometry-type"],
								["Polygon", "MultiPolygon"],
								true,
								false
							],
							paint: {
								"fill-color": LIGHT.fill,
								"fill-opacity": .18
							}
						});
						map.addLayer({
							id: "geo-polygons-outline",
							type: "line",
							source: "geo",
							filter: [
								"match",
								["geometry-type"],
								["Polygon", "MultiPolygon"],
								true,
								false
							],
							paint: {
								"line-color": LIGHT.line,
								"line-width": 1.5
							}
						});
						map.addLayer({
							id: "geo-lines",
							type: "line",
							source: "geo",
							filter: [
								"match",
								["geometry-type"],
								["LineString", "MultiLineString"],
								true,
								false
							],
							paint: {
								"line-color": LIGHT.line,
								"line-width": 2
							}
						});
						if (cluster) map.addLayer({
							id: "geo-clusters",
							type: "circle",
							source: "geo",
							filter: ["has", "point_count"],
							paint: {
								"circle-color": [
									"step",
									["get", "point_count"],
									LIGHT.cluster[0],
									10,
									LIGHT.cluster[1],
									100,
									LIGHT.cluster[2]
								],
								"circle-radius": [
									"step",
									["get", "point_count"],
									13,
									10,
									18,
									100,
									24
								],
								"circle-opacity": .9,
								"circle-stroke-width": 2,
								"circle-stroke-color": "#ffffff"
							}
						});
						map.addLayer({
							id: "geo-points",
							type: "circle",
							source: "geo",
							filter: [
								"all",
								[
									"==",
									["geometry-type"],
									"Point"
								],
								...cluster ? [["!", ["has", "point_count"]]] : []
							],
							paint: {
								"circle-color": LIGHT.point,
								"circle-radius": 5.5,
								"circle-opacity": .92,
								"circle-stroke-width": 1.5,
								"circle-stroke-color": "#ffffff"
							}
						});
						applyPalette(map, isDark());
						const interactive = cluster ? ["geo-points", "geo-clusters"] : [
							"geo-points",
							"geo-lines",
							"geo-polygons",
							"geo-polygons-outline"
						];
						map.on("click", interactive, (e) => {
							const feature = e.features?.[0];
							if (feature === void 0) return;
							if (cluster && feature["layer"] !== void 0 && feature["layer"].id === "geo-clusters") {
								const clusterId = feature["properties"]["cluster_id"];
								map.getSource("geo").getClusterExpansionZoom(clusterId, (err, zoom) => {
									const geometry = feature["geometry"];
									if (err === null && geometry?.coordinates !== void 0) map.easeTo({
										center: geometry.coordinates,
										zoom
									});
								});
								return;
							}
							const geometry = feature["geometry"];
							const lngLat = geometry?.coordinates !== void 0 && Array.isArray(geometry.coordinates) ? geometry.coordinates : e.lngLat !== void 0 ? [e.lngLat.lng, e.lngLat.lat] : void 0;
							if (lngLat === void 0) return;
							popup = new L.Popup({
								maxWidth: 360,
								closeButton: true
							}).setLngLat(lngLat).setDOMContent(buildPopupContent(feature["properties"])).addTo(map);
						});
						for (const layer of interactive) {
							map.on("mouseenter", layer, () => {
								map.getCanvas().style.cursor = "pointer";
							});
							map.on("mouseleave", layer, () => {
								map.getCanvas().style.cursor = "";
							});
						}
						fit();
						setStatus("ready");
					});
				}).catch((err) => {
					if (disposed) return;
					setError(err instanceof Error ? err.message : String(err));
					setStatus("error");
				});
				return () => {
					disposed = true;
					if (popup !== null && typeof popup === "object" && "remove" in popup) popup.remove();
					map?.remove();
					mapRef.current = null;
				};
			}, [meta]);
			(0, react.useEffect)(() => {
				const el = wrapRef.current;
				if (el === null) return;
				const observer = new ResizeObserver(() => {
					mapRef.current?.resize();
				});
				observer.observe(el);
				return () => observer.disconnect();
			}, []);
			(0, react.useEffect)(() => {
				if (!full) return;
				const previous = document.body.style.overflow;
				document.body.style.overflow = "hidden";
				const onKey = (e) => {
					if (e.key === "Escape") setFull(false);
				};
				window.addEventListener("keydown", onKey);
				return () => {
					document.body.style.overflow = previous;
					window.removeEventListener("keydown", onKey);
				};
			}, [full]);
			const sourceText = [
				meta.sourceLabel,
				meta.latColumn !== void 0 ? `lat:${meta.latColumn}` : void 0,
				meta.lngColumn !== void 0 ? `lng:${meta.lngColumn}` : void 0
			].filter((v) => v !== void 0).join(" · ");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dgv-root",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dgv-head",
					title: meta.artifactPath,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { fontWeight: 500 },
						children: meta.title
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							overflow: "hidden",
							textOverflow: "ellipsis"
						},
						children: sourceText
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: `dgv-wrap${full ? " dgv-full" : ""}`,
					style: { height: full ? void 0 : meta.cardHeight },
					children: [status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dgv-err",
						children: ["Map failed to load: ", error]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							ref: wrapRef,
							className: "dgv-map"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dgv-chip",
							children: [String(meta.featureCount), " features"]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dgv-bar",
							children: [status === "ready" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dgv-btn",
								onClick: () => fitRef.current(),
								children: "Fit"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dgv-btn",
								onClick: () => setFull((v) => !v),
								children: full ? "Exit full" : "Full"
							})]
						}),
						status === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dgv-loading",
							children: "loading map…"
						})
					] }), meta.note !== void 0 && meta.note !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dgv-note",
						children: meta.note
					})]
				})]
			});
		}
		/** 卡片样式（一次性注入）。 */
		const CLIENT_CSS = `
.dgv-root { margin: 4px 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.dgv-head { display: flex; align-items: baseline; gap: 8px; font-size: 12px; opacity: .75; margin: 2px 0 6px; white-space: nowrap; overflow: hidden; }
.dgv-wrap { position: relative; border-radius: 10px; overflow: hidden; border: 1px solid rgba(127,127,127,.25); background: rgba(127,127,127,.08); }
.dgv-map { position: absolute; inset: 0; }
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
`;
		/** 样式标签注入（幂等）。 */
		let cssInjected = false;
		function injectCss() {
			if (cssInjected || document.getElementById("dgv-style") !== null) {
				cssInjected = true;
				return;
			}
			const style = document.createElement("style");
			style.id = "dgv-style";
			style.textContent = CLIENT_CSS;
			document.head.appendChild(style);
			cssInjected = true;
		}
		injectCss();
		//#endregion
		//#region src/client/GeoCard.tsx
		/**
		* `geo_view` toolview：按调用块状态分流。
		* 运行中显示单行等待；失败或 meta 缺失回退到持久化结果文本；
		* 完好 meta 才挂载 MapView。回放稳定性由构造保证：一切绘制只来自
		* 已记录的调用切片（meta），不读工作区文件。
		*/
		const headerStyle = {
			display: "flex",
			alignItems: "baseline",
			gap: 8,
			fontSize: 12,
			opacity: .65,
			margin: "2px 0 6px",
			overflow: "hidden",
			whiteSpace: "nowrap"
		};
		/** 持久化结果内容的第一行文本（错误行展示用）。 */
		function firstResultLine(content) {
			for (const block of content) if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
				const newline = block.text.indexOf("\n");
				return newline === -1 ? block.text : block.text.slice(0, newline);
			}
			return "geo view failed";
		}
		/** geo_view 的键控 toolview 组件。 */
		function GeoCard({ block }) {
			const settled = "kind" in block;
			const isError = settled && block.isError;
			const rawMeta = settled && !block.isError ? block.meta : void 0;
			const meta = (0, react.useMemo)(() => geoViewMetaFrom(rawMeta), [rawMeta]);
			if (!settled) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: headerStyle,
				children: "Geo view · loading…"
			});
			if (isError) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: headerStyle,
				children: ["Geo view · ", firstResultLine(block.content)]
			});
			if (meta === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: headerStyle,
				children: firstResultLine(block.content)
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MapView, { meta });
		}
		//#endregion
		//#region src/client/SettingsCard.tsx
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
		/** 卡片文案的 locale 命名空间。 */
		const LOCALE_NS = "dsh-geo-viewer.settings";
		/** 中文文案（键同时是卡片组件的取词键）。 */
		const zh = {
			title: "地理可视化（dsh-geo-viewer）",
			description: "地图底图、地理编码供应商与体量护栏；保存后立即生效。",
			unsaved: "有未保存的修改",
			readOnly: "当前部署只读，设置需写入配置文件。",
			saveFailed: "保存失败：请检查取值后重试。",
			save: "保存",
			discard: "放弃",
			reset: "重置",
			overridden: "已覆盖",
			invalidNumber: "需为非负整数",
			expand: "展开",
			collapse: "收起",
			mapStyleUrl: "底图样式 URL",
			mapStyleUrlHint: "MapLibre StyleJSON 地址，如 MapTiler style URL 或自建矢量瓦片服务。",
			maplibreCdnBase: "maplibre-gl CDN 目录",
			maplibreCdnBaseHint: "maplibre-gl.js / .css 从该目录加载，可换内网镜像。",
			cardHeight: "卡片地图高度（px）",
			maxFeatures: "单次渲染要素上限",
			maxBytes: "单次渲染 GeoJSON 字节上限",
			maxGeocodeRows: "单次地理编码行数上限",
			geocodingProvider: "地理编码供应商",
			geocodingProviderHint: "国内地址选高德最佳；国际数据选 MapTiler 或 Nominatim。",
			geocodingProviderNominatim: "Nominatim（免费，限速 1 请求/秒）",
			geocodingProviderMaptiler: "MapTiler（需 key）",
			geocodingProviderAmap: "高德（需 key，GCJ-02 自动转 WGS-84）",
			geocodingKey: "供应商 API key",
			geocodingKeyHint: "maptiler / amap 必填；nominatim 忽略。",
			geocodingBaseUrl: "地理编码端点覆盖",
			geocodingBaseUrlHint: "留空用供应商默认端点；可指向自建反代或私有化实例。"
		};
		/** 英文文案。 */
		const en = {
			title: "Geo visualization (dsh-geo-viewer)",
			description: "Basemap, geocoding provider, and size guards; saves apply immediately.",
			unsaved: "Unsaved changes",
			readOnly: "This deployment is read-only; edit the config file instead.",
			saveFailed: "Save failed: check the values and retry.",
			save: "Save",
			discard: "Discard",
			reset: "Reset",
			overridden: "Overridden",
			invalidNumber: "Must be a non-negative integer",
			expand: "Expand",
			collapse: "Collapse",
			mapStyleUrl: "Basemap style URL",
			mapStyleUrlHint: "MapLibre StyleJSON URL, e.g. a MapTiler style URL or self-hosted vector tiles.",
			maplibreCdnBase: "maplibre-gl CDN base",
			maplibreCdnBaseHint: "Directory maplibre-gl.js / .css load from; point at an intranet mirror if needed.",
			cardHeight: "Card map height (px)",
			maxFeatures: "Max features per render",
			maxBytes: "Max GeoJSON bytes per render",
			maxGeocodeRows: "Max geocoded rows per call",
			geocodingProvider: "Geocoding provider",
			geocodingProviderHint: "Amap suits CN addresses best; MapTiler/Nominatim for global data.",
			geocodingProviderNominatim: "Nominatim (free, 1 req/s)",
			geocodingProviderMaptiler: "MapTiler (key required)",
			geocodingProviderAmap: "Amap (key required, GCJ-02 auto-converted)",
			geocodingKey: "Provider API key",
			geocodingKeyHint: "Required for maptiler/amap; ignored by nominatim.",
			geocodingBaseUrl: "Geocoding endpoint override",
			geocodingBaseUrlHint: "Empty keeps the provider default; point at a self-hosted proxy if needed."
		};
		/** 供应商选项（与宿主 Config schema 的 union 一致）。 */
		const PROVIDERS = [
			"nominatim",
			"maptiler",
			"amap"
		];
		/** 自由文本字段：空草稿即清空（等价于重置）。 */
		function textField(field) {
			return {
				field,
				format: (value) => typeof value === "string" ? value : "",
				parse: (text) => {
					const trimmed = text.trim();
					return trimmed === "" ? { kind: "clear" } : {
						kind: "set",
						value: trimmed
					};
				}
			};
		}
		/** 非负整数字段（Schema.natural 口径）：非法草稿阻止保存。 */
		function naturalField(field) {
			return {
				field,
				format: (value) => typeof value === "number" ? String(value) : "",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					const parsed = Number(trimmed);
					return Number.isInteger(parsed) && parsed >= 0 ? {
						kind: "set",
						value: parsed
					} : void 0;
				}
			};
		}
		/** 供应商下拉字段。 */
		function providerField(field) {
			return {
				field,
				format: (value) => typeof value === "string" && PROVIDERS.includes(value) ? value : "",
				parse: (text) => PROVIDERS.includes(text) ? {
					kind: "set",
					value: text
				} : void 0
			};
		}
		/** 卡片的全部字段（渲染顺序即此顺序）。 */
		const FIELD_SPECS = [
			textField("mapStyleUrl"),
			textField("maplibreCdnBase"),
			naturalField("cardHeight"),
			naturalField("maxFeatures"),
			naturalField("maxBytes"),
			naturalField("maxGeocodeRows"),
			providerField("geocodingProvider"),
			textField("geocodingKey"),
			textField("geocodingBaseUrl")
		];
		/** 暂存草稿模型：scope 快照 + 本地草稿的联合投影。 */
		var GeoCardForm = class {
			scope;
			specs = new Map(FIELD_SPECS.map((spec) => [spec.field, spec]));
			staged = /* @__PURE__ */ new Map();
			listeners = /* @__PURE__ */ new Set();
			saving = false;
			failed = false;
			constructor(scope) {
				this.scope = scope;
				scope.subscribe(() => this.publish());
			}
			/** 以初始投影建快照存储；此后 scope 或草稿任一变化都重算。 */
			bind(project) {
				const store = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)(project());
				this.listeners.add(() => {
					store.set(project());
				});
				return store;
			}
			/** 卡片级状态：宿主是否服务该命名空间、保存会做什么。 */
			shell() {
				const snapshot = this.scope.getSnapshot();
				const plan = this.plan();
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					dirty: plan.length > 0,
					invalid: plan.some((item) => item.run === void 0),
					saving: this.saving,
					failed: this.failed
				};
			}
			/** 单字段控件状态。 */
			field(field) {
				const staged = this.staged.get(field);
				const spec = this.specOf(field);
				if (staged === void 0) return {
					text: spec.format(this.sectionValue(field)),
					overridden: this.stored(field),
					invalid: false
				};
				const write = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
				return {
					text: staged.text,
					overridden: write?.kind === "set",
					invalid: write === void 0
				};
			}
			/** 卡片动作（注入组件）。 */
			actions() {
				return {
					edit: (field, text) => {
						this.staged.set(field, {
							text,
							clear: false
						});
						this.failed = false;
						this.publish();
					},
					resetField: (field) => {
						this.staged.set(field, {
							text: this.specOf(field).format(this.baseValue(field)),
							clear: true
						});
						this.failed = false;
						this.publish();
					},
					save: () => {
						this.save();
					},
					discard: () => {
						if (this.staged.size === 0 && !this.failed) return;
						this.staged.clear();
						this.failed = false;
						this.publish();
					}
				};
			}
			/** 逐字段写入暂存编辑，再按宿主接受结果重播种草稿。 */
			async save() {
				const plan = this.plan();
				const writes = plan.flatMap((item) => item.run === void 0 ? [] : [item.run]);
				if (plan.length === 0 || this.saving || writes.length !== plan.length) return;
				this.saving = true;
				this.failed = false;
				this.publish();
				let landed = true;
				for (const write of writes) landed = await write() && landed;
				if (landed) this.staged.clear();
				this.saving = false;
				this.failed = !landed;
				this.publish();
			}
			/** 一次保存会执行的写集；非法草稿项无 run（表单脏而不可存）。 */
			plan() {
				const plan = [];
				for (const [field, staged] of this.staged) {
					const spec = this.specOf(field);
					if (staged.clear) {
						if (this.stored(field)) plan.push({
							field,
							run: () => this.clear(field)
						});
						continue;
					}
					if (staged.text === spec.format(this.sectionValue(field))) continue;
					const write = spec.parse(staged.text);
					if (write === void 0) plan.push({
						field,
						run: void 0
					});
					else if (write.kind === "clear") {
						if (this.stored(field)) plan.push({
							field,
							run: () => this.clear(field)
						});
					} else plan.push({
						field,
						run: () => this.store(field, write.value)
					});
				}
				return plan;
			}
			async clear(field) {
				await this.scope.unset(field);
				return !this.stored(field);
			}
			async store(field, value) {
				await this.scope.set(field, value);
				return this.userLayer()?.[field] === value;
			}
			specOf(field) {
				const spec = this.specs.get(field);
				if (spec === void 0) throw new Error(`dsh-geo-viewer settings card has no field ${field}`);
				return spec;
			}
			sectionValue(field) {
				return this.scope.getSnapshot().value?.[field];
			}
			baseValue(field) {
				return this.scope.getSnapshot().base?.[field];
			}
			userLayer() {
				return this.scope.getSnapshot().user;
			}
			/** 用户层键存在性 = 已覆盖（与设置缝分层语义一致）。 */
			stored(field) {
				const user = this.userLayer();
				return user !== void 0 && Object.hasOwn(user, field);
			}
			publish() {
				for (const listener of this.listeners) listener();
			}
		};
		/** 卡片外壳与字段的内联样式（dsw 主题变量，与官方卡片同款视觉）。 */
		const styles = {
			card: {
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-3)",
				borderRadius: 12,
				listStyle: "none",
				transition: "border-color .16s, background .16s"
			},
			header: {
				appearance: "none",
				width: "100%",
				font: "inherit",
				color: "inherit",
				textAlign: "left",
				cursor: "pointer",
				background: "transparent",
				border: 0,
				borderRadius: 12,
				alignItems: "center",
				gap: 12,
				padding: "14px 16px",
				display: "flex"
			},
			headText: {
				flexDirection: "column",
				flex: 1,
				gap: 4,
				minWidth: 0,
				display: "flex"
			},
			name: {
				color: "var(--dsw-alias-label-primary)",
				fontSize: 15,
				fontWeight: 600,
				lineHeight: 1.4
			},
			description: {
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: 13,
				lineHeight: 1.5
			},
			pending: {
				whiteSpace: "nowrap",
				background: "var(--dsw-alias-bg-module-platform)",
				color: "var(--dsw-alias-label-secondary)",
				borderRadius: 999,
				flex: "none",
				padding: "1px 8px",
				fontSize: 11,
				fontWeight: 500,
				lineHeight: "17px"
			},
			chevron: {
				color: "var(--dsw-alias-label-tertiary)",
				flex: "none",
				transition: "transform .16s"
			},
			body: {
				borderTop: "1px solid var(--dsw-alias-border-l2)",
				margin: "0 16px",
				paddingBottom: 8,
				display: "flex",
				flexDirection: "column"
			},
			readOnly: {
				color: "var(--dsw-alias-label-tertiary)",
				margin: "12px 0 0",
				fontSize: 12,
				lineHeight: 1.5
			},
			field: {
				flexDirection: "column",
				gap: 6,
				padding: "12px 0",
				borderBottom: "1px solid var(--dsw-alias-border-l2)",
				display: "flex"
			},
			fieldHead: {
				alignItems: "center",
				gap: 10,
				fontSize: 12,
				fontWeight: 500,
				lineHeight: "18px",
				color: "var(--dsw-alias-label-secondary)",
				display: "inline-flex"
			},
			fieldLabel: {
				flex: 1,
				minWidth: 0
			},
			reset: {
				appearance: "none",
				font: "inherit",
				color: "var(--dsw-alias-label-tertiary)",
				cursor: "pointer",
				background: "transparent",
				border: 0,
				padding: 0,
				fontSize: 12
			},
			input: {
				boxSizing: "border-box",
				border: "1px solid var(--dsw-alias-border-l2)",
				width: "100%",
				height: 32,
				font: "inherit",
				background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-primary)",
				borderRadius: 8,
				padding: "0 10px",
				fontSize: 14,
				lineHeight: "22px"
			},
			hint: {
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: 12,
				lineHeight: "18px"
			},
			error: {
				color: "var(--dsw-alias-state-error-primary)",
				fontSize: 12,
				lineHeight: "18px"
			},
			footer: {
				borderTop: "1px solid var(--dsw-alias-border-l2)",
				justifyContent: "flex-end",
				alignItems: "center",
				gap: 8,
				padding: "12px 0 4px",
				display: "flex"
			},
			failed: {
				minWidth: 0,
				color: "var(--dsw-alias-label-error)",
				flex: 1,
				margin: 0,
				fontSize: 12,
				lineHeight: 1.5
			},
			discard: {
				appearance: "none",
				font: "inherit",
				cursor: "pointer",
				border: "1px solid var(--dsw-alias-border-l2)",
				color: "var(--dsw-alias-label-secondary)",
				background: "transparent",
				borderRadius: 8,
				padding: "5px 14px",
				fontSize: 13,
				lineHeight: 1.5
			},
			saveButton: {
				appearance: "none",
				font: "inherit",
				cursor: "pointer",
				border: "1px solid transparent",
				background: "var(--dsw-alias-label-primary)",
				color: "var(--dsw-alias-bg-layer-3)",
				borderRadius: 8,
				padding: "5px 14px",
				fontSize: 13,
				lineHeight: 1.5
			}
		};
		/** 供应商下拉的取词键。 */
		const PROVIDER_LABEL_KEYS = {
			nominatim: "geocodingProviderNominatim",
			maptiler: "geocodingProviderMaptiler",
			amap: "geocodingProviderAmap"
		};
		/** 字段标题取词键。 */
		const FIELD_LABEL_KEYS = {
			mapStyleUrl: "mapStyleUrl",
			maplibreCdnBase: "maplibreCdnBase",
			cardHeight: "cardHeight",
			maxFeatures: "maxFeatures",
			maxBytes: "maxBytes",
			maxGeocodeRows: "maxGeocodeRows",
			geocodingProvider: "geocodingProvider",
			geocodingKey: "geocodingKey",
			geocodingBaseUrl: "geocodingBaseUrl"
		};
		/** 带提示文案的字段（其余字段仅标题）。 */
		const FIELD_HINTS = {
			mapStyleUrl: "mapStyleUrlHint",
			maplibreCdnBase: "maplibreCdnBaseHint",
			geocodingProvider: "geocodingProviderHint",
			geocodingKey: "geocodingKeyHint",
			geocodingBaseUrl: "geocodingBaseUrlHint"
		};
		/** 设置卡片：可折叠外壳 + 字段控件 + 保存/放弃。 */
		function GeoSettingsCard(props) {
			const [open, setOpen] = (0, react.useState)(false);
			const { t } = props;
			const state = props.useGeoCard((snapshot) => snapshot);
			if (!state.available) return null;
			const blocked = !state.dirty || state.invalid || state.saving;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				style: styles.card,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					style: styles.header,
					"aria-expanded": open,
					"aria-label": `${t(open ? "collapse" : "expand")}: ${t("title")}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: styles.headText,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.name,
								children: t("title")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.description,
								children: t("description")
							})]
						}),
						state.dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: styles.pending,
							children: t("unsaved")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								...styles.chevron,
								transform: open ? "rotate(180deg)" : void 0
							},
							children: "▾"
						})
					]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.body,
					children: [
						!state.writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles.readOnly,
							role: "status",
							children: t("readOnly")
						}) : null,
						FIELD_SPECS.map((spec) => {
							const hintKey = FIELD_HINTS[spec.field];
							const numeric = spec.field === "cardHeight" || spec.field === "maxFeatures" || spec.field === "maxBytes" || spec.field === "maxGeocodeRows";
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.field,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: styles.fieldHead,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: styles.fieldLabel,
											children: t(FIELD_LABEL_KEYS[spec.field])
										}), state.fields[spec.field].overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: styles.reset,
											disabled: !state.writable,
											onClick: () => {
												props.resetField(spec.field);
											},
											children: t("reset")
										}) : null]
									}),
									spec.field === "geocodingProvider" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										style: styles.input,
										disabled: !state.writable,
										value: state.fields.geocodingProvider.text,
										onChange: (event) => {
											props.edit("geocodingProvider", event.target.value);
										},
										children: PROVIDERS.map((provider) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: provider,
											children: t(PROVIDER_LABEL_KEYS[provider])
										}, provider))
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: styles.input,
										disabled: !state.writable,
										value: state.fields[spec.field].text,
										inputMode: numeric ? "numeric" : void 0,
										onChange: (event) => {
											props.edit(spec.field, event.target.value);
										}
									}),
									hintKey !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: styles.hint,
										children: t(hintKey)
									}) : null,
									state.fields[spec.field].invalid ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: styles.error,
										children: t("invalidNumber")
									}) : null
								]
							}, spec.field);
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.footer,
							children: [
								state.failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: styles.failed,
									role: "status",
									children: t("saveFailed")
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: styles.discard,
									disabled: !state.dirty || state.saving,
									onClick: props.discard,
									children: t("discard")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: styles.saveButton,
									disabled: blocked,
									onClick: props.save,
									children: t("save")
								})
							]
						})
					]
				}) : null]
			});
		}
		/**
		* 卡片控制器：把 `dsh-geo-viewer` 命名空间的设置 scope 桥接到暂存表单，
		* 产出槽位注册注入的面（快照钩子 + 动作）。
		*/
		var GeoViewerCardController = class {
			form;
			store;
			/** @param scope 宿主 `dsh-geo-viewer` 设置命名空间的客户端 scope。 */
			constructor(scope) {
				this.form = new GeoCardForm(scope);
				this.store = this.form.bind(() => this.projection());
			}
			projection() {
				return {
					...this.form.shell(),
					fields: Object.fromEntries(FIELD_SPECS.map((spec) => [spec.field, this.form.field(spec.field)]))
				};
			}
			/** 槽位注册注入面：hooks.geoCard 经框架转为 useGeoCard 钩子。 */
			inject() {
				return {
					hooks: { geoCard: this.store },
					...this.form.actions()
				};
			}
		};
		//#endregion
		//#region src/client/index.tsx
		const name = "dsh-geo-viewer";
		const inject = ["slots"];
		/**
		* 注册键控 toolview 与设置卡片。等待槽位声明到位再注册，与官方注册方一致：
		* 入场应用顺序由 loader 决定，抢先注册会在声明前失败。
		* @param ctx 客户端根上下文。
		*/
		function apply(ctx) {
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "geo_view"
			}, GeoCard));
			ctx.inject(["settingsScope", "locale"], (sctx) => {
				sctx.effect(() => sctx.locale.register(LOCALE_NS, {
					zh,
					en
				}), "dsh-geo-viewer: settings card dictionaries");
				const controller = new GeoViewerCardController(sctx.settingsScope.bind({ namespace: "dsh-geo-viewer" }));
				sctx.slots.inject("settings.plugin.item", () => sctx.slots.register({
					name: "settings.plugin.item",
					key: "dsh-geo-viewer",
					locale: LOCALE_NS,
					inject: () => controller.inject()
				}, GeoSettingsCard));
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
