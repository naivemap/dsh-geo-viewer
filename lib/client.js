window.__ModuleLoader__.load({
	id: "dsh-geo-viewer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
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
		//#region src/client/index.tsx
		const name = "dsh-geo-viewer";
		const inject = ["slots"];
		/**
		* 注册键控 toolview。等待槽位声明到位再注册，与官方注册方一致：
		* 入场应用顺序由 loader 决定，抢先注册会在声明前失败。
		* @param ctx 客户端根上下文。
		*/
		function apply(ctx) {
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "geo_view"
			}, GeoCard));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
