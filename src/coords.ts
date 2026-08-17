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
const A = 6378245
const EE = 0.00669342162296594323

/** 中国大陆粗略范围（含偏移影响的外扩边界）。 */
function inChina(lng: number, lat: number): boolean {
  return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271
}

function transformLat(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
  ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3
  ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3
  return ret
}

function transformLng(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
  ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3
  ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3
  return ret
}

/** 单点偏移量（WGS-84 -> GCJ-02 的 delta）。 */
function delta(lng: number, lat: number): [number, number] {
  let dLat = transformLat(lng - 105, lat - 35)
  let dLng = transformLng(lng - 105, lat - 35)
  const radLat = (lat / 180) * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180) / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI)
  dLng = (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return [dLng, dLat]
}

/** WGS-84 -> GCJ-02。境外坐标按惯例原样返回。 */
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (!inChina(lng, lat)) return [lng, lat]
  const [dLng, dLat] = delta(lng, lat)
  return [lng + dLng, lat + dLat]
}

/** GCJ-02 -> WGS-84：一次正变换求 delta 后反向扣除（近似逆解，误差远小于偏移本身）。 */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (!inChina(lng, lat)) return [lng, lat]
  // 用 GCJ 点近似估 delta：先用原始点正变换，再用正变换结果回代一次以收敛。
  let [dLng, dLat] = delta(lng, lat)
  let wgsLng = lng - dLng
  let wgsLat = lat - dLat
  for (let i = 0; i < 2; i++) {
    ;[dLng, dLat] = delta(wgsLng, wgsLat)
    wgsLng = lng - dLng
    wgsLat = lat - dLat
  }
  return [wgsLng, wgsLat]
}
