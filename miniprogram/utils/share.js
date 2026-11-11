/**
 * 转发卡片的标题与路径（唯一出口）
 *
 * 转发是"把一句话递给别人"的最小通路：把正文塞进 path 的 query，
 * 对方打开首页时由 handleInbox 确认后存成自己的一条。
 *
 * 为什么要卡在 120 字：
 *   path 里放的是 encodeURIComponent 之后的中文，一个汉字会膨胀成 9 个字符
 *   （%E4%BB%8A 这样）。原来写 400 字，实际 path 长度约 3600 字符，超过微信的
 *   路径上限后会被截断在 %XX 中间，接收端 decodeURIComponent 抛错，
 *   正文就变成一串 "%E4%BB%8A"。120 字 ≈ 1080 字符，留了安全余量。
 *
 * 截断对用户是可见的：发送前标题就是前 30 字，接收端存下的也是同一段，
 * 不存在"发出去 400 字、收到 120 字"的静默丢失。
 */
const MAX_IN_PATH = 120

/**
 * @param {string} text 要带走的正文
 * @returns {{title:string, path:string}}
 */
function card(text) {
  // 换行在 query 里没有意义，还会让标题难看，统一压成空格
  const src = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!src) {
    return { title: '灵感随时记 · 想到什么就记一句', path: '/pages/index/index' }
  }

  const kept = src.slice(0, MAX_IN_PATH)
  return {
    title: kept.slice(0, 30),
    path: '/pages/index/index?inbox=' + encodeURIComponent(kept)
  }
}

module.exports = { MAX_IN_PATH, card }
