/**
 * 多图错落堆叠的版式（唯一出处）
 *
 * 首页卡片和「做成图」长图都要这个版式，两边各自的数字一旦分头维护，
 * 迟早会出现"手机上歪 3 度、图里歪 5 度"这种说不清的偏差。
 * 所以坐标、抖动、层高都放在这里，卡片拼成 CSS、海报画进 canvas，只取一份数据。
 *
 * 单位是 rpx（= 750 设计宽下的 1/750）。长图恰好也是 750 宽，所以同一组数字
 * 在两边可以直接用：rpx 当 px 花，不用换算。
 *
 * 为什么是 2/3/4 三套而不是"通用算法"：手工摆的三组位比任何公式都自然，
 * 传 2 张和传 4 张时视觉密度是对的；再多就按组切，一组不超过 4 张。
 */

/** 相纸外框（含 10rpx 白边） */
const FRAME_W = 330
const FRAME_H = 254
/** 白边宽度：照片比外框小一圈，才有"相纸"的厚度感 */
const FRAME_PAD = 10
const FRAME_RADIUS = 18
const IMAGE_RADIUS = 12

/** 一组最多几张 */
const MAX_FRAMES = 4
/** 组与组之间的竖向间距 */
const CLUSTER_GAP = 28
/** 单张照片的高度（沿用原来的整幅配图） */
const SINGLE_H = 420

/** 基础错落位（x 偏移 / y 偏移 / 旋转角度 / 层级） */
const LAYOUTS = {
  2: [
    { x: 16, y: 26, r: -6, z: 1 },
    { x: 250, y: 140, r: 4.5, z: 2 }
  ],
  3: [
    { x: 12, y: 46, r: -7.5, z: 1 },
    { x: 268, y: 4, r: 4, z: 2 },
    { x: 112, y: 186, r: -2, z: 3 }
  ],
  4: [
    { x: 2, y: 20, r: -9, z: 1 },
    { x: 268, y: 0, r: 6, z: 2 },
    { x: 36, y: 188, r: 5, z: 3 },
    { x: 250, y: 160, r: -4, z: 4 }
  ]
}

/** 字符串散列：同一条记录每次渲染拿到同一组抖动值，换设备也不变 */
function hash(str) {
  let h = 2166136261
  const s = String(str || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/**
 * 按张数切成若干组。
 * 唯一要避开的是一组只放 1 张——那张会退化成"整幅大图"，夹在一堆相纸里很突兀，
 * 所以 5 张切成 3+2、7 张切成 4+3，而不是 4+1。
 * @param {number} n
 * @returns {number[]} 每组张数，如 9 → [3,3,3]
 */
function clusters(n) {
  const total = Math.max(0, Math.floor(n || 0))
  if (!total) return []
  if (total <= MAX_FRAMES) return [total]
  const groups = Math.ceil(total / MAX_FRAMES)
  const base = Math.floor(total / groups)
  const rest = total % groups
  const out = []
  for (let i = 0; i < groups; i++) out.push(base + (i < rest ? 1 : 0))
  return out
}

/**
 * 一组照片的版式
 * @param {string|number} seedKey 记录 id（或创建时间），决定抖动
 * @param {number} n 这一组的张数，2–4
 * @returns {{frames: Array<{x:number,y:number,r:number,z:number}>, height:number}}
 */
function plan(seedKey, n) {
  const count = Math.min(Math.max(Math.floor(n || 0), 2), MAX_FRAMES)
  const base = LAYOUTS[count] || LAYOUTS[MAX_FRAMES]
  const seed = hash(seedKey)
  const frames = []
  let bottom = 0

  for (let i = 0; i < count; i++) {
    const p = base[i]
    // 每张再按 id 散列做 ±5rpx、±1.2° 的轻微抖动：同一张卡片稳定，不同卡片不雷同
    const jx = ((seed >>> (i * 3)) % 11) - 5
    const jy = ((seed >>> (i * 5 + 2)) % 13) - 6
    const jr = (((seed >>> (i * 4 + 1)) % 25) - 12) / 10
    const rot = p.r + jr
    // 旋转会让包围盒高出一点，按角度补余量，避免压到下面的正文
    const over = Math.abs(Math.sin((rot * Math.PI) / 180)) * FRAME_W * 0.5
    bottom = Math.max(bottom, p.y + jy + FRAME_H + over)
    frames.push({ x: p.x + jx, y: p.y + jy, r: rot, z: p.z })
  }

  // 高度按实际最底边收口：2/3/4 张的下方留白一样多，节奏才整齐
  return { frames: frames, height: Math.ceil(bottom + 8) }
}

/**
 * 整组照片（可能切成多组）的版式，供长图使用
 * @param {string|number} seedKey
 * @param {number} n
 * @returns {null | {single:boolean, clusters:Array, height:number, sizes:number[]}}
 */
function planAll(seedKey, n) {
  const sizes = clusters(n)
  if (!sizes.length) return null
  if (sizes.length === 1 && sizes[0] === 1) {
    return { single: true, clusters: [], height: SINGLE_H, sizes: sizes }
  }

  const list = []
  let height = 0
  sizes.forEach((size, i) => {
    // 第一组用记录 id 本身，和首页卡片逐像素一致；后面几组换个种子，免得三组一模一样
    const seed = i ? String(seedKey) + '#' + i : seedKey
    const p = plan(seed, size)
    if (i) height += CLUSTER_GAP
    list.push({ frames: p.frames, height: p.height, size: size })
    height += p.height
  })

  return { single: false, clusters: list, height: height, sizes: sizes }
}

module.exports = {
  FRAME_W,
  FRAME_H,
  FRAME_PAD,
  FRAME_RADIUS,
  IMAGE_RADIUS,
  MAX_FRAMES,
  CLUSTER_GAP,
  SINGLE_H,
  LAYOUTS,
  hash,
  clusters,
  plan,
  planAll
}
