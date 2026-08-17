import Schema from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import Papa from "papaparse";
import ExcelJS from "exceljs";
//#region src/meta.ts
/**
* geo_view 工具的线协议契约（纯模块，无 I/O、无 DOM）：
* 宿主半侧在 presentationMeta 里产出，浏览器半侧与测试用它收窄。
* 所有渲染参数（style URL、CDN base、卡片高度）都在执行期由插件配置解析后
* 随 meta 持久化，浏览器半侧不读会话状态，回放按字节重现。
*
* @module dsh-geo-viewer/meta
*/
/** 工具线名；键控 toolview 与之同名。 */
const GEO_VIEW_TOOL_NAME = "geo_view";
//#endregion
//#region src/geodata.ts
/** 归一化列名：小写、去空白与分隔符。 */
function normHeader(h) {
	return h.trim().toLowerCase().replace(/[\s_\-().（）]/g, "");
}
/** 纬度列头线索。 */
function isLatHeader(h) {
	const n = normHeader(h);
	return n === "lat" || n === "latitude" || n === "纬度" || n === "glat" || n.startsWith("lat") && n.length <= 12;
}
/** 经度列头线索。 */
function isLngHeader(h) {
	const n = normHeader(h);
	return n === "lng" || n === "lon" || n === "long" || n === "longitude" || n === "经度" || n === "glng" || n === "东经" || (n.startsWith("lon") || n.startsWith("lng")) && n.length <= 12;
}
/** 合并坐标列头线索。 */
function isCombinedHeader(h) {
	const n = normHeader(h);
	return n === "coordinates" || n === "coordinate" || n === "coords" || n === "coord" || n === "坐标" || n === "latlng" || n === "latlong" || n === "位置坐标";
}
/** 解析数值（容忍度分秒残渣不处理；空串/NaN -> undefined）。 */
function num(v) {
	if (v === void 0) return void 0;
	if (typeof v === "number") return Number.isFinite(v) ? v : void 0;
	const t = v.trim();
	if (t === "") return void 0;
	const n = Number(t);
	return Number.isFinite(n) ? n : void 0;
}
/** 采样行数上限：检测只需统计证据，不必全量。 */
const SAMPLE_LIMIT = 200;
/** 数值合法率门槛：低于它认为这不是地理列。 */
const PASS_RATE = .7;
/** 合法率：通过数值占采样中非空数值的比例。 */
function rate(ok, total) {
	return total === 0 ? 0 : ok / total;
}
/**
* 在表格中检测地理列。显式覆盖优先；随后按表头线索 + 采样数值校验。
* 数值校验能发现"lat 列头装的其实是经度"并自动互换。
*
* @param rows 已解析的行记录（含表头作为键）。
* @param hints 显式指定的列名（可只给其一，另一列仍自动检测）。
* @returns 检测结果；未检出返回 undefined。
*/
function detectGeoColumns(rows, hints) {
	if (rows.length === 0) return void 0;
	const columns = collectColumns(rows);
	if (columns.length === 0) return void 0;
	const hLat = hints?.latColumn;
	const hLng = hints?.lngColumn;
	if (hLat !== void 0 && hLng !== void 0 && columns.includes(hLat) && columns.includes(hLng)) {
		if (validatePair(rows, hLat, hLng) !== void 0) return {
			kind: "latlng",
			latColumn: hLat,
			lngColumn: hLng,
			swapped: false
		};
		if (validatePair(rows, hLng, hLat) !== void 0) return {
			kind: "latlng",
			latColumn: hLng,
			lngColumn: hLat,
			swapped: true
		};
		return;
	}
	const latCandidates = columns.filter(isLatHeader);
	const lngCandidates = columns.filter(isLngHeader);
	for (const lat of latCandidates) for (const lng of lngCandidates) {
		if (lat === lng) continue;
		if (validatePair(rows, lat, lng) !== void 0) return {
			kind: "latlng",
			latColumn: lat,
			lngColumn: lng,
			swapped: false
		};
		if (validatePair(rows, lng, lat) !== void 0) return {
			kind: "latlng",
			latColumn: lng,
			lngColumn: lat,
			swapped: true
		};
	}
	const x = columns.find((h) => normHeader(h) === "x" || normHeader(h) === "easting");
	const y = columns.find((h) => normHeader(h) === "y" || normHeader(h) === "northing");
	if (x !== void 0 && y !== void 0 && x !== y) {
		if (validatePair(rows, y, x) !== void 0) return {
			kind: "latlng",
			latColumn: y,
			lngColumn: x,
			swapped: false
		};
	}
	for (const col of columns.filter(isCombinedHeader)) {
		const order = validateCombined(rows, col);
		if (order !== void 0) return {
			kind: "combined",
			column: col,
			order
		};
	}
}
/** 收集出现过的列名（保持首见顺序）。 */
function collectColumns(rows) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const row of rows.slice(0, SAMPLE_LIMIT)) for (const key of Object.keys(row)) if (!seen.has(key)) {
		seen.add(key);
		out.push(key);
	}
	return out;
}
/**
* 校验 (latCol, lngCol) 是否能当纬度/经度用。
* 通过返回 true-ish；不通过返回 undefined。
*/
function validatePair(rows, latCol, lngCol) {
	const sample = rows.slice(0, SAMPLE_LIMIT);
	let parsed = 0;
	let ok = 0;
	for (const row of sample) {
		const lat = num(row[latCol]);
		const lng = num(row[lngCol]);
		if (lat === void 0 || lng === void 0) continue;
		parsed++;
		if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) ok++;
	}
	if (parsed < 2) return void 0;
	if (rate(ok, parsed) < PASS_RATE) return void 0;
	return true;
}
/** 校验合并坐标列并推断分量顺序。 */
function validateCombined(rows, column) {
	const sample = rows.slice(0, SAMPLE_LIMIT);
	let parsed = 0;
	let latFirst = 0;
	let lngFirst = 0;
	const re = /^\s*(-?\d+(?:\.\d+)?)\s*[,;，；/]\s*(-?\d+(?:\.\d+)?)\s*$/;
	for (const row of sample) {
		const raw = row[column];
		if (raw === void 0) continue;
		const m = re.exec(String(raw));
		if (m === null) continue;
		const a = Number(m[1]);
		const b = Number(m[2]);
		if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
		parsed++;
		const aIsLat = a >= -90 && a <= 90;
		const bIsLat = b >= -90 && b <= 90;
		if (aIsLat && (b > 90 || b < -90)) latFirst++;
		else if (bIsLat && (a > 90 || a < -90)) lngFirst++;
		else if (aIsLat && bIsLat) latFirst++;
	}
	if (parsed < 2) return void 0;
	if (lngFirst > latFirst) return "lng-first";
	return "lat-first";
}
/** 合并坐标文本拆分。 */
function splitCombined(raw) {
	if (typeof raw !== "string") return void 0;
	const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,;，；/]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw);
	if (m === null) return void 0;
	return [Number(m[1]), Number(m[2])];
}
/**
* 行记录转 Point FeatureCollection。
*
* @param rows 行记录。
* @param detection 地理列检测结果。
* @param maxFeatures 要素数上限（含未跳过行）。
* @returns FeatureCollection 与被跳过行数（无有效坐标的行）。
* @throws Error 当有效行数超过 maxFeatures。
*/
function rowsToFeatureCollection(rows, detection, maxFeatures) {
	const features = [];
	let skipped = 0;
	for (const row of rows) {
		let lat;
		let lng;
		if (detection.kind === "latlng") {
			lat = num(row[detection.latColumn]);
			lng = num(row[detection.lngColumn]);
		} else {
			const parts = splitCombined(row[detection.column] ?? "");
			if (parts !== void 0) {
				if (detection.order === "lat-first") {
					lat = parts[0];
					lng = parts[1];
				} else {
					lng = parts[0];
					lat = parts[1];
				}
			}
		}
		if (lat === void 0 || lng === void 0 || !(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) {
			skipped++;
			continue;
		}
		if (lat === 0 && lng === 0 && rows.length > 1) {
			skipped++;
			continue;
		}
		features.push({
			type: "Feature",
			geometry: {
				type: "Point",
				coordinates: [lng, lat]
			},
			properties: sanitizeProperties(row)
		});
	}
	if (features.length === 0) throw new Error("no rows produced a valid coordinate: check the lat/lng columns (values must be numbers in range)");
	if (features.length > maxFeatures) throw new Error(`${features.length} mappable rows exceed the maxFeatures limit of ${maxFeatures} - filter the rows first, or raise the dsh-geo-viewer \`maxFeatures\` config`);
	return {
		fc: {
			type: "FeatureCollection",
			features
		},
		skipped
	};
}
/** 行属性清洗：去空串/未定义键，数值保持数值。 */
function sanitizeProperties(row) {
	const out = {};
	for (const [key, value] of Object.entries(row)) {
		if (value === void 0) continue;
		if (typeof value === "string") {
			const t = value.trim();
			if (t === "") continue;
			out[key] = t;
			continue;
		}
		out[key] = value;
	}
	return out;
}
/** 支持的 GeoJSON 几何类型。 */
const GEOMETRY_TYPES = [
	"Point",
	"MultiPoint",
	"LineString",
	"MultiLineString",
	"Polygon",
	"MultiPolygon",
	"GeometryCollection"
];
function isGeometryLike(v) {
	if (typeof v !== "object" || v === null) return false;
	const record = v;
	return typeof record["type"] === "string" && GEOMETRY_TYPES.includes(record["type"]);
}
function isFeatureLike(v) {
	if (typeof v !== "object" || v === null) return false;
	const record = v;
	return record["type"] === "Feature" && (record["geometry"] === null || isGeometryLike(record["geometry"])) && (record["properties"] === void 0 || record["properties"] === null || typeof record["properties"] === "object");
}
/**
* 将各种常见 GeoJSON 形态规范化为 FeatureCollection。
*
* @param value JSON.parse 的结果。
* @returns 规范 FeatureCollection。
* @throws Error 形态无法识别或要素数超限。
*/
function normalizeGeoJson(value, maxFeatures) {
	const features = [];
	const pushItem = (item, where) => {
		if (isFeatureLike(item)) {
			features.push({
				type: "Feature",
				geometry: item.geometry,
				properties: item.properties ?? null
			});
			return;
		}
		if (isGeometryLike(item)) {
			features.push({
				type: "Feature",
				geometry: item,
				properties: null
			});
			return;
		}
		throw new Error(`unrecognized GeoJSON: ${where} must be Features or Geometries`);
	};
	if (Array.isArray(value)) for (const item of value) pushItem(item, "array items");
	else if (typeof value === "object" && value !== null && value["type"] === "FeatureCollection") {
		const raw = value["features"];
		if (!Array.isArray(raw)) throw new Error("unrecognized GeoJSON: FeatureCollection.features must be an array");
		for (const item of raw) pushItem(item, "features[] items");
	} else pushItem(value, "the top-level value");
	if (features.length === 0) throw new Error("empty GeoJSON: no features to render");
	if (features.length > maxFeatures) throw new Error(`${features.length} features exceed the maxFeatures limit of ${maxFeatures} - simplify the data first, or raise the dsh-geo-viewer \`maxFeatures\` config`);
	return {
		type: "FeatureCollection",
		features
	};
}
/**
* 深扫 FeatureCollection 全部坐标，求 [w, s, e, n]。
* @returns bounds；无有效坐标时 undefined。
*/
function boundsOfFeatureCollection(fc) {
	let w;
	let s;
	let e;
	let n;
	const visit = (node) => {
		if (Array.isArray(node)) {
			if (node.length >= 2 && node.every((v) => typeof v === "number")) {
				const [lng, lat] = node;
				if (Number.isFinite(lng) && Number.isFinite(lat) && (lng !== 0 || lat !== 0)) {
					w = w === void 0 ? lng : Math.min(w, lng);
					e = e === void 0 ? lng : Math.max(e, lng);
					s = s === void 0 ? lat : Math.min(s, lat);
					n = n === void 0 ? lat : Math.max(n, lat);
				}
				return;
			}
			for (const child of node) visit(child);
			return;
		}
		if (typeof node === "object" && node !== null) {
			for (const child of Object.values(node)) if (typeof child === "object" && child !== null) visit(child);
		}
	};
	for (const feature of fc.features) if (feature.geometry !== null) visit(feature.geometry);
	if (w === void 0 || s === void 0 || e === void 0 || n === void 0) return void 0;
	const pad = Math.max((e - w) * .1, (n - s) * .1, .01);
	return [
		w - pad,
		s - pad,
		e + pad,
		n + pad
	];
}
//#endregion
//#region src/coords.ts
/**
* WGS-84 与 GCJ-02（火星坐标系）互转（纯函数）。
* 高德等国内服务商返回 GCJ-02 坐标，直接叠加 WGS-84 底图会有数百米偏移，
* 因此地理编码结果落图前统一转回 WGS-84。
*
* 算法为业界通行的近似实现（误差约 1m 量级，对制图可视化足够）。
*
* @module dsh-geo-viewer/coords
*/
/** 克拉索夫斯基椭球参数。 */
const A = 6378245;
const EE = .006693421622965943;
/** 中国大陆粗略范围（含偏移影响的外扩边界）。 */
function inChina(lng, lat) {
	return lng >= 72.004 && lng <= 137.8347 && lat >= .8293 && lat <= 55.8271;
}
function transformLat(x, y) {
	let ret = -100 + 2 * x + 3 * y + .2 * y * y + .1 * x * y + .2 * Math.sqrt(Math.abs(x));
	ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
	ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
	ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
	return ret;
}
function transformLng(x, y) {
	let ret = 300 + x + 2 * y + .1 * x * x + .1 * x * y + .1 * Math.sqrt(Math.abs(x));
	ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
	ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
	ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
	return ret;
}
/** 单点偏移量（WGS-84 -> GCJ-02 的 delta）。 */
function delta(lng, lat) {
	let dLat = transformLat(lng - 105, lat - 35);
	let dLng = transformLng(lng - 105, lat - 35);
	const radLat = lat / 180 * Math.PI;
	let magic = Math.sin(radLat);
	magic = 1 - EE * magic * magic;
	const sqrtMagic = Math.sqrt(magic);
	dLat = dLat * 180 / (A * .9933065783770341 / (magic * sqrtMagic) * Math.PI);
	dLng = dLng * 180 / (A / sqrtMagic * Math.cos(radLat) * Math.PI);
	return [dLng, dLat];
}
/** GCJ-02 -> WGS-84：一次正变换求 delta 后反向扣除（近似逆解，误差远小于偏移本身）。 */
function gcj02ToWgs84(lng, lat) {
	if (!inChina(lng, lat)) return [lng, lat];
	let [dLng, dLat] = delta(lng, lat);
	let wgsLng = lng - dLng;
	let wgsLat = lat - dLat;
	for (let i = 0; i < 2; i++) {
		[dLng, dLat] = delta(wgsLng, wgsLat);
		wgsLng = lng - dLng;
		wgsLat = lat - dLat;
	}
	return [wgsLng, wgsLat];
}
//#endregion
//#region src/geocode.ts
/**
* 地理编码适配层（宿主半侧，Node fetch）。
*
* 三家供应商，各自默认端点与限速：
* - nominatim（默认，免费无 key）：OpenStreetMap 公共实例，约定 1 req/s + 明确 UA。
* - maptiler：与 maplibre 底图生态配套，需 key。
* - amap（高德）：国内地址效果最好，需 key，返回 GCJ-02（统一转回 WGS-84）。
*
* @module dsh-geo-viewer/geocode
*/
const USER_AGENT = "dsh-geo-viewer/0.1.0 (DeepSeek Harness plugin)";
const SPECS = {
	nominatim: {
		requiresKey: false,
		intervalMs: 1100,
		timeoutMs: 15e3,
		endpoint: (q, opts) => {
			return {
				url: `${(opts.baseUrl?.trim() || "https://nominatim.openstreetmap.org").replace(/\/+$/, "")}/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=1&accept-language=auto`,
				init: { headers: {
					"User-Agent": USER_AGENT,
					Accept: "application/json"
				} }
			};
		},
		pick: (body) => {
			if (!Array.isArray(body) || body.length === 0) return null;
			const hit = body[0];
			const lat = Number(hit["lat"]);
			const lng = Number(hit["lon"]);
			if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
			return {
				lat,
				lng,
				label: typeof hit["display_name"] === "string" ? hit["display_name"] : ""
			};
		},
		toWgs84: false
	},
	maptiler: {
		requiresKey: true,
		intervalMs: 250,
		timeoutMs: 15e3,
		endpoint: (q, opts) => {
			return {
				url: `${(opts.baseUrl?.trim() || "https://api.maptiler.com").replace(/\/+$/, "")}/geocoding/${encodeURIComponent(q)}.json?key=${encodeURIComponent(opts.key)}&limit=1`,
				init: { headers: { Accept: "application/json" } }
			};
		},
		pick: (body) => {
			if (typeof body !== "object" || body === null) return null;
			const features = body["features"];
			if (!Array.isArray(features) || features.length === 0) return null;
			const hit = features[0];
			const center = hit["center"];
			if (!Array.isArray(center) || center.length < 2) return null;
			const lng = Number(center[0]);
			const lat = Number(center[1]);
			if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
			return {
				lat,
				lng,
				label: typeof hit["place_name"] === "string" ? hit["place_name"] : ""
			};
		},
		toWgs84: false
	},
	amap: {
		requiresKey: true,
		intervalMs: 300,
		timeoutMs: 15e3,
		endpoint: (q, opts) => {
			return {
				url: `${(opts.baseUrl?.trim() || "https://restapi.amap.com").replace(/\/+$/, "")}/v3/geocode/geo?address=${encodeURIComponent(q)}&key=${encodeURIComponent(opts.key)}`,
				init: { headers: { Accept: "application/json" } }
			};
		},
		pick: (body, url) => {
			if (typeof body !== "object" || body === null) return null;
			const record = body;
			if (record["status"] !== "1") return null;
			const geocodes = record["geocodes"];
			if (!Array.isArray(geocodes) || geocodes.length === 0) return null;
			const hit = geocodes[0];
			const location = hit["location"];
			if (typeof location !== "string") return null;
			const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(location);
			if (m === null) return null;
			const gcjLng = Number(m[1]);
			const gcjLat = Number(m[2]);
			if (!Number.isFinite(gcjLat) || !Number.isFinite(gcjLng)) return null;
			const [lng, lat] = gcj02ToWgs84(gcjLng, gcjLat);
			return {
				lat,
				lng,
				label: typeof hit["formatted_address"] === "string" ? hit["formatted_address"] : ""
			};
		},
		toWgs84: true
	}
};
/** 组合外部取消信号与单请求超时。 */
function withTimeout(signal, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
}
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? /* @__PURE__ */ new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? /* @__PURE__ */ new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/**
* 批量地理编码：逐条请求、按供应商约定限速、失败返回 null 不中断批次。
*
* @param addresses 地址/地名列表。
* @param opts 供应商配置。
* @param signal 外部取消信号（工具 exec.signal）。
* @param onProgress 每条完成后的进度回调（序号从 1 起）。
* @returns 与输入等长的结果数组（失败项为 null）。
* @throws Error 供应商需要 key 而未配置，或外部信号取消。
*/
async function geocodeAddresses(addresses, opts, signal, onProgress) {
	const spec = SPECS[opts.provider];
	if (spec === void 0) throw new Error(`unknown geocoding provider: ${opts.provider}`);
	if (spec.requiresKey && opts.key.trim() === "") throw new Error(`geocoding provider "${opts.provider}" requires a key - set the dsh-geo-viewer \`geocodingKey\` config, or switch \`geocodingProvider\` to "nominatim" (keyless)`);
	const out = [];
	for (const [i, address] of addresses.entries()) {
		if (i > 0) await sleep(spec.intervalMs, signal);
		const q = address.trim();
		if (q === "") {
			out.push(null);
			onProgress?.(i + 1, addresses.length);
			continue;
		}
		const { url, init } = spec.endpoint(q, opts);
		try {
			const response = await fetch(url, {
				...init,
				signal: withTimeout(signal, spec.timeoutMs)
			});
			if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
			const body = await response.json();
			const picked = spec.pick(body, url);
			out.push(picked);
		} catch (error) {
			if (signal?.aborted) throw error;
			out.push(null);
		}
		onProgress?.(i + 1, addresses.length);
	}
	return out;
}
//#endregion
//#region src/tool.ts
const DESCRIPTION = "Render geographic data as an interactive map card in the conversation. Call this whenever the user mentions plotting/mapping geographic data - latitude/longitude tables, GeoJSON, or place names. Sources (pick exactly one): `path` for a workspace file (.csv/.tsv/.xlsx/.geojson/.json - coordinate columns are auto-detected from headers like lat/lng/latitude/longitude/经度/纬度/x/y/坐标), `data` for inline CSV text or GeoJSON JSON, or `addresses` for a list of place names to geocode and plot. For tables whose rows have no coordinates but an address column, pass `addressColumn` to geocode them (needs the provider key configured in the plugin). Use `latColumn`/`lngColumn` when auto-detection picks the wrong columns. The card supports zoom/pan, feature inspection, and fullscreen; a .geojson copy is exported to the workspace.";
/**
* 构造 geo_view 工具定义。
* @param ctx 注册上下文（提供 ctx.fs 与 sandboxPolicy 解析）。
* @param options 插件配置投影的实时来源：每次调用/呈现时读取，使 Web 设置项
*   的修改无需重启即可生效。
* @returns 注册到 ctx.tools 的工具定义。
*/
function geoViewTool(ctx, options) {
	return defineTool({
		name: GEO_VIEW_TOOL_NAME,
		description: DESCRIPTION,
		parameters: {
			path: {
				type: "string",
				description: "Workspace file path (.csv/.tsv/.xlsx/.geojson/.json). Mutually exclusive with `data` and `addresses`."
			},
			data: {
				type: "string",
				description: "Inline data: either GeoJSON JSON (starts with { or [) or CSV text. Mutually exclusive with `path` and `addresses`."
			},
			addresses: {
				type: "array",
				items: { type: "string" },
				description: "Place names or addresses to geocode and plot as points. Mutually exclusive with `path` and `data`."
			},
			latColumn: {
				type: "string",
				description: "Explicit latitude column name for table sources (overrides auto-detection)."
			},
			lngColumn: {
				type: "string",
				description: "Explicit longitude column name for table sources (overrides auto-detection)."
			},
			addressColumn: {
				type: "string",
				description: "Column containing addresses to geocode, for tables without coordinates."
			},
			title: {
				type: "string",
				description: "Concise card title."
			},
			styleUrl: {
				type: "string",
				description: "One-off MapLibre StyleJSON URL overriding the plugin default for this card."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					title: {
						type: "string",
						required: true
					},
					sourceKind: {
						type: "string",
						required: true,
						enum: [
							"csv",
							"tsv",
							"xlsx",
							"geojson",
							"inline-csv",
							"inline-geojson",
							"addresses"
						]
					},
					sourceLabel: {
						type: "string",
						required: true
					},
					featureCount: {
						type: "integer",
						required: true
					},
					skippedRows: {
						type: "integer",
						required: true
					},
					columns: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					latColumn: { type: "string" },
					lngColumn: { type: "string" },
					addressColumn: { type: "string" },
					geocodedCount: { type: "integer" },
					geocodeFailed: { type: "integer" },
					bounds: {
						type: "array",
						required: true,
						items: { type: "number" }
					},
					artifactPath: {
						type: "string",
						required: true
					},
					geojson: {
						type: "object",
						required: true,
						additionalProperties: true
					},
					note: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Rendered ${String(value.featureCount)} features from ${value.sourceLabel}${value.skippedRows > 0 ? ` (${String(value.skippedRows)} rows skipped: no valid coordinates)` : ""}${value.note !== void 0 && value.note !== "" ? ` - ${value.note}` : ""}. Interactive map card is in the conversation; GeoJSON copy exported to ${value.artifactPath}.`
			}],
			presentationMeta: (_args, value) => {
				const current = options();
				return {
					kind: "geo-view",
					title: value.title,
					sourceKind: value.sourceKind,
					sourceLabel: value.sourceLabel,
					featureCount: value.featureCount,
					bounds: value.bounds,
					geojson: value.geojson,
					styleUrl: current.mapStyleUrl,
					maplibreCdnBase: current.maplibreCdnBase,
					cardHeight: current.cardHeight,
					artifactPath: value.artifactPath,
					columns: value.columns,
					...value.latColumn !== void 0 ? { latColumn: value.latColumn } : {},
					...value.lngColumn !== void 0 ? { lngColumn: value.lngColumn } : {},
					...value.addressColumn !== void 0 ? { addressColumn: value.addressColumn } : {},
					...value.geocodedCount !== void 0 ? { geocodedCount: value.geocodedCount } : {},
					...value.geocodeFailed !== void 0 ? { geocodeFailed: value.geocodeFailed } : {},
					...value.note !== void 0 && value.note !== "" ? { note: value.note } : {}
				};
			}
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const opts = options();
			const provided = [
				args.path,
				args.data,
				args.addresses
			].filter((v) => v !== void 0).length;
			if (provided !== 1) throw new Error(provided === 0 ? "invalid geo_view call: provide exactly one of `path`, `data`, or `addresses`" : "invalid geo_view call: `path`, `data`, and `addresses` are mutually exclusive - pass exactly one");
			const sandboxPolicy = ctx.get("sandboxPolicy")?.resolve({ ...exec.agent ? { session: exec.agent.session } : {} });
			const cwd = sandboxPolicy?.workspaceRoot ?? exec.agent?.session.header.cwd;
			const resolveOpts = {
				...cwd !== void 0 ? { cwd } : {},
				signal: exec.signal
			};
			const title = args.title?.trim() || "Geo view";
			let sourceKind;
			let sourceLabel;
			let fc;
			let skippedRows = 0;
			let columns = [];
			let latColumn;
			let lngColumn;
			let addressColumn;
			let geocodedCount;
			let geocodeFailed;
			let note;
			if (args.addresses !== void 0) {
				if (!Array.isArray(args.addresses) || args.addresses.length === 0) throw new Error("invalid geo_view call: `addresses` must be a non-empty array");
				sourceKind = "addresses";
				sourceLabel = `${String(args.addresses.length)} addresses`;
				const geo = await geocodeRows(args.addresses, opts);
				geocodedCount = geo.geocodedCount;
				geocodeFailed = geo.geocodeFailed;
				fc = geo.fc;
			} else if (args.path !== void 0) {
				const target = await ctx.fs.resolve(args.path, resolveOpts);
				const ext = target.displayPath.toLowerCase().replace(/^.*\.([a-z0-9]+)$/, "$1");
				if (ext === "xlsx" || ext === "xls" || ext === "xlsm") {
					const table = await tableToFeatures(await rowsFromXlsx(await ctx.fs.readBytes(target, exec.signal, 67108864)), args, opts);
					sourceKind = "xlsx";
					sourceLabel = target.displayPath;
					({fc, skippedRows} = table);
					columns = table.columns;
					latColumn = table.latColumn;
					lngColumn = table.lngColumn;
					addressColumn = table.addressColumn;
					geocodedCount = table.geocodedCount;
					geocodeFailed = table.geocodeFailed;
					note = table.note;
				} else {
					const parsed = await parseTextualSource(await ctx.fs.readText(target, exec.signal), ext, args, opts, target.displayPath);
					sourceKind = parsed.sourceKind;
					sourceLabel = target.displayPath;
					({fc, skippedRows} = parsed);
					columns = parsed.columns;
					latColumn = parsed.latColumn;
					lngColumn = parsed.lngColumn;
					addressColumn = parsed.addressColumn;
					geocodedCount = parsed.geocodedCount;
					geocodeFailed = parsed.geocodeFailed;
					note = parsed.note;
				}
			} else {
				const data = args.data ?? "";
				if (data.trim() === "") throw new Error("invalid geo_view call: `data` is empty");
				const parsed = await parseTextualSource(data, "", args, opts, "inline data");
				sourceKind = parsed.sourceKind;
				sourceLabel = "inline data";
				({fc, skippedRows} = parsed);
				columns = parsed.columns;
				latColumn = parsed.latColumn;
				lngColumn = parsed.lngColumn;
				addressColumn = parsed.addressColumn;
				geocodedCount = parsed.geocodedCount;
				geocodeFailed = parsed.geocodeFailed;
				note = parsed.note;
			}
			const bytes = Buffer.byteLength(JSON.stringify(fc), "utf8");
			if (bytes > opts.maxBytes) throw new Error(`GeoJSON is ${String(bytes)} bytes, over the ${String(opts.maxBytes)}-byte limit - downsample the data (fewer features or properties), or raise the dsh-geo-viewer \`maxBytes\` config`);
			const bounds = boundsOfFeatureCollection(fc);
			if (bounds === void 0) throw new Error("no finite coordinates found in the data - nothing to render");
			const artifactPath = `geo/${slugOf(title)}-${fnv1a(JSON.stringify(fc))}.geojson`;
			const artifactTarget = await ctx.fs.resolve(artifactPath, resolveOpts);
			await ctx.fs.writeText(artifactTarget, `${JSON.stringify(fc, null, 2)}\n`, void 0, exec.signal, sandboxPolicy);
			return {
				title,
				sourceKind,
				sourceLabel,
				featureCount: fc.features.length,
				skippedRows,
				columns,
				...latColumn !== void 0 ? { latColumn } : {},
				...lngColumn !== void 0 ? { lngColumn } : {},
				...addressColumn !== void 0 ? { addressColumn } : {},
				...geocodedCount !== void 0 ? { geocodedCount } : {},
				...geocodeFailed !== void 0 ? { geocodeFailed } : {},
				bounds,
				artifactPath: artifactTarget.displayPath,
				geojson: fc,
				...note !== void 0 ? { note } : {}
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "Geo view",
			kind: "other"
		}),
		presentResult(_args, result) {
			if (result.isError) return void 0;
			const meta = result.meta;
			if (typeof meta !== "object" || meta === null || meta["kind"] !== "geo-view") return;
			const title = meta["title"];
			const count = meta["featureCount"];
			if (typeof title !== "string" || typeof count !== "number") return void 0;
			return {
				card: "generic",
				title: `Map · ${title} (${String(count)} features)`
			};
		}
	});
}
/**
* 解析文本来源（文件或内联）：JSON 走 GeoJSON 规范化，其余按 CSV/TSV 表格。
* 内联数据以首个非空白字符判断形态；文件来源以扩展名判断。
*/
async function parseTextualSource(text, ext, args, options, label) {
	const looksJson = text.trimStart().startsWith("{") || text.trimStart().startsWith("[");
	if (ext === "geojson" || ext === "json" || ext === "" && looksJson) {
		let value;
		try {
			value = JSON.parse(text);
		} catch (error) {
			throw new Error(`invalid GeoJSON in ${label}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const fc = normalizeGeoJson(value, options.maxFeatures);
		return {
			sourceKind: ext === "" ? "inline-geojson" : "geojson",
			fc,
			skippedRows: 0,
			columns: []
		};
	}
	const table = await tableToFeatures(csvToRows(text, ext === "tsv" ? "	" : void 0), args, options);
	return {
		sourceKind: ext === "" ? "inline-csv" : ext === "tsv" ? "tsv" : "csv",
		...table
	};
}
/** CSV/TSV 文本 -> 行记录（表头作键；空行跳过）。 */
function csvToRows(text, delimiter) {
	const parsed = Papa.parse(text, {
		header: true,
		skipEmptyLines: "greedy",
		...delimiter !== void 0 ? { delimiter } : {}
	});
	const rows = [];
	for (const row of parsed.data) {
		if (row === null || typeof row !== "object") continue;
		rows.push(row);
	}
	return rows;
}
/**
* XLSX 字节 -> 行记录（首个工作表；首行为表头；单元格文本化）。
*/
async function rowsFromXlsx(bytes) {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(bytes);
	const sheet = workbook.worksheets[0];
	if (sheet === void 0) throw new Error("the workbook has no worksheet");
	const rows = [];
	let headers;
	sheet.eachRow({ includeEmpty: false }, (row) => {
		const values = [];
		row.eachCell({ includeEmpty: true }, (cell) => {
			values.push(cellText(cell.value));
		});
		if (headers === void 0) {
			headers = values.map((v, i) => v.trim() !== "" ? v.trim() : `column${String(i + 1)}`);
			return;
		}
		const record = {};
		for (const [i, h] of headers.entries()) {
			const v = values[i];
			if (v !== void 0 && v !== "") record[h] = v;
		}
		rows.push(record);
	});
	return rows;
}
/** exceljs 单元格值文本化（公式取结果、富文本取拼接、日期取 ISO）。 */
function cellText(value) {
	if (value === null || value === void 0) return "";
	if (typeof value === "object") {
		const record = value;
		if ("result" in record) return cellText(record["result"]);
		if ("richText" in record && Array.isArray(record["richText"])) return record["richText"].map((part) => String(part["text"] ?? "")).join("");
		if ("text" in record) return String(record["text"]);
		if (value instanceof Date) return value.toISOString();
		if ("error" in record) return "";
		return String(record);
	}
	return String(value);
}
/** 表格 -> 要素（含地理列检测与可选地址地理编码）。 */
async function tableToFeatures(rows, args, options) {
	if (rows.length === 0) throw new Error("the table has no data rows");
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	const detection = detectGeoColumns(rows, args);
	if (detection !== void 0) {
		const { fc, skipped } = rowsToFeatureCollection(rows, detection, options.maxFeatures);
		return {
			fc,
			skippedRows: skipped,
			columns,
			...detection.kind === "latlng" ? {
				latColumn: detection.latColumn,
				lngColumn: detection.lngColumn,
				...detection.swapped ? { note: `columns looked swapped by value; used "${detection.lngColumn}" as latitude and "${detection.latColumn}" as longitude` } : {}
			} : {}
		};
	}
	const addressCol = args.addressColumn ?? detectAddressColumn(columns);
	if (addressCol !== void 0 && columns.includes(addressCol)) {
		const addresses = [];
		for (const row of rows) {
			const v = row[addressCol];
			if (v !== void 0 && String(v).trim() !== "") addresses.push(String(v).trim());
		}
		if (addresses.length > options.maxGeocodeRows) throw new Error(`${String(addresses.length)} rows need geocoding, over the maxGeocodeRows limit of ${String(options.maxGeocodeRows)} - geocode fewer rows or raise the dsh-geo-viewer \`maxGeocodeRows\` config`);
		const geo = await geocodeRows(addresses, options);
		if (geo.geocodedCount === 0) throw new Error(`geocoded 0 of ${String(addresses.length)} addresses in column "${addressCol}" - check the provider/key configuration or the address values`);
		const rowByAddress = /* @__PURE__ */ new Map();
		for (const row of rows) {
			const v = row[addressCol];
			if (v !== void 0) rowByAddress.set(String(v).trim(), row);
		}
		for (const feature of geo.fc.features) {
			const original = rowByAddress.get(String(feature.properties?.["address"] ?? ""));
			if (original !== void 0 && feature.properties !== null) feature.properties = {
				...original,
				...feature.properties
			};
		}
		return {
			fc: geo.fc,
			skippedRows: rows.length - geo.geocodedCount,
			columns,
			addressColumn: addressCol,
			geocodedCount: geo.geocodedCount,
			geocodeFailed: geo.geocodeFailed
		};
	}
	throw new Error(`no geographic columns detected in the table (headers: ${columns.join(", ")}) - pass \`latColumn\`/\`lngColumn\` explicitly, or \`addressColumn\` to geocode addresses`);
}
/** 明确的地址列表头线索（保守，避免把 location 之类误当地址）。 */
function detectAddressColumn(columns) {
	return columns.find((h) => {
		const n = h.trim().toLowerCase().replace(/[\s_\-]/g, "");
		return n === "address" || n === "addr" || n === "地址" || n === "locationtext" || n === "fulladdress" || n === "详细地址";
	});
}
/** 地址列表 -> 地理编码要素。 */
async function geocodeRows(addresses, options) {
	if (addresses.length > options.maxGeocodeRows) throw new Error(`${String(addresses.length)} addresses exceed the maxGeocodeRows limit of ${String(options.maxGeocodeRows)} - geocode fewer addresses or raise the dsh-geo-viewer \`maxGeocodeRows\` config`);
	const points = await geocodeAddresses(addresses, {
		provider: options.geocodingProvider,
		key: options.geocodingKey,
		baseUrl: options.geocodingBaseUrl.trim() === "" ? void 0 : options.geocodingBaseUrl.trim()
	});
	const features = [];
	let geocodedCount = 0;
	let geocodeFailed = 0;
	for (const [i, address] of addresses.entries()) {
		const point = points[i];
		if (point === null || point === void 0) {
			geocodeFailed++;
			continue;
		}
		geocodedCount++;
		features.push({
			type: "Feature",
			geometry: {
				type: "Point",
				coordinates: [point.lng, point.lat]
			},
			properties: {
				address,
				label: point.label
			}
		});
	}
	if (features.length === 0) throw new Error("geocoding resolved none of the addresses - check the provider configuration and address values");
	return {
		fc: {
			type: "FeatureCollection",
			features
		},
		geocodedCount,
		geocodeFailed
	};
}
/** 标题转 ASCII slug（与 dsh-visualize 同款规则）。 */
function slugOf(title) {
	const slug = title.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-+|-+$/gu, "").slice(0, 48);
	return slug.length > 0 ? slug : "geo-view";
}
/** FNV-1a 8 位十六进制内容散列。 */
function fnv1a(text) {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
//#endregion
//#region src/index.ts
/** Cordis 插件名。 */
const name = "dsh-geo-viewer";
/** 依赖服务：工具注册表 + 文件系统缝。 */
const inject = ["tools", "fs"];
/**
* Web 设置项命名空间：注册到 `ctx.settings` 后，Web 端「设置 → 插件 →
* 插件配置」出现本插件卡片；用户层覆盖组合层（profile 的 config 行），
* 保存即生效，无需重启。
*/
const SETTINGS_NAMESPACE = settingsNamespace("dsh-geo-viewer");
const URL_RE = /^https?:\/\//;
/**
* URL 形态校验（加载期与每次设置写入时都跑）：坏配置响亮失败，
* 不允许通过设置项把插件推入不可渲染状态。
* @param config 待校验的已解析配置。
*/
function assertConfigUsable(config) {
	if (!URL_RE.test(config.mapStyleUrl)) throw new Error(`dsh-geo-viewer: mapStyleUrl must be an http(s) URL, got ${JSON.stringify(config.mapStyleUrl)}`);
	if (!URL_RE.test(config.maplibreCdnBase)) throw new Error(`dsh-geo-viewer: maplibreCdnBase must be an http(s) URL, got ${JSON.stringify(config.maplibreCdnBase)}`);
}
/** Loader 校验用的 Schemastery schema，默认值即推荐部署值。 */
const Config = Schema.object({
	mapStyleUrl: Schema.string().default("https://demotiles.maplibre.org/style.json").description("MapLibre StyleJSON URL for the basemap, e.g. a MapTiler style URL with its key or demotiles."),
	maplibreCdnBase: Schema.string().default("https://unpkg.com/maplibre-gl@5/dist").description("CDN directory of maplibre-gl assets (maplibre-gl.js / maplibre-gl.css are loaded from it)."),
	cardHeight: Schema.natural().default(420).description("Map height inside the conversation card, in pixels."),
	maxFeatures: Schema.natural().default(1e4).description("Maximum features rendered per geo_view call."),
	maxBytes: Schema.natural().default(4e6).description("Maximum serialized GeoJSON bytes per geo_view call."),
	maxGeocodeRows: Schema.natural().default(100).description("Maximum rows/addresses geocoded per geo_view call (protects provider quota)."),
	geocodingProvider: Schema.union([
		"nominatim",
		"maptiler",
		"amap"
	]).default("nominatim").description("Geocoding provider used for addresses / address columns."),
	geocodingKey: Schema.string().default("").description("Provider API key (maptiler/amap require it; nominatim ignores it)."),
	geocodingBaseUrl: Schema.string().default("").description("Optional provider endpoint override, e.g. a self-hosted Nominatim mirror.")
});
/**
* 注册 geo_view 工具并把配置挂到 Web 设置项。
*
* 组合层（profile `config` 行）作为设置命名空间的 base：Web 端保存的用户层
* 覆盖其上，工具每次调用读取当前解析值，改动即时生效；无 settings 服务的
* 部署（TUI/headless）自动回落到组合层，行为与纯 YAML 配置完全一致。
* @param ctx 注册上下文。
* @param config 已校验的部署配置。
*/
function apply(ctx, config) {
	assertConfigUsable(config);
	let current = () => config;
	installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: () => {},
		validate: assertConfigUsable
	});
	ctx.tools.register(geoViewTool(ctx, () => {
		const value = current();
		return {
			mapStyleUrl: value.mapStyleUrl,
			maplibreCdnBase: value.maplibreCdnBase.replace(/\/+$/, ""),
			cardHeight: value.cardHeight,
			maxFeatures: value.maxFeatures,
			maxBytes: value.maxBytes,
			maxGeocodeRows: value.maxGeocodeRows,
			geocodingProvider: value.geocodingProvider,
			geocodingKey: value.geocodingKey,
			geocodingBaseUrl: value.geocodingBaseUrl
		};
	}));
}
//#endregion
export { Config, GEO_VIEW_TOOL_NAME, SETTINGS_NAMESPACE, apply, inject, name };
