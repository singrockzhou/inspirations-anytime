/**
 * 正文里的 #标签 展示处理。
 *
 * 记录里 #标签 既是正文的一部分，又会被 store.parseTags 抽成 tags 字段，
 * 详情页、首页摘要、做成图都要用 tags 再画一次。如果正文原样渲染，
 * 同一条标签会在同一屏里出现两次（正文一处、胶囊一处）。
 *
 * 这里只在「整行只有标签」时把那一行从展示文本里去掉：
 *   #灵感                      ← 独占一行，去掉
 *   每一个灵感都是财富          ← 保留
 *
 * 句中出现的标签不动（「今天想到 #灵感 这件事」原样保留），
 * 否则句子会被切成两截。数据本身不改，编辑页看到的仍是原文。
 */

/** 整行由一到多个 #标签 组成，行内不许有别的字 */
const TAG_LINE_RE = /^\s*(?:#[^\s#，。,.!！?？、;；:：()（）[\]【】"'“”]{1,12}\s*)+$/

/**
 * 去掉「独占一行」的标签行，顺带压掉因此产生的连续空行。
 * @param {string} text
 * @returns {string} 剥完的文本；整条只有标签时返回空串
 */
function stripTagLines(text) {
  if (typeof text !== 'string' || !text) return ''

  const kept = []
  let prevBlank = true
  text.split('\n').forEach(line => {
    if (TAG_LINE_RE.test(line)) return
    const blank = !line.trim()
    // 剥离后可能留下两行空行，压成一个；开头的空行直接丢掉
    if (blank && prevBlank) return
    kept.push(blank ? '' : line.replace(/\s+$/, ''))
    prevBlank = blank
  })
  while (kept.length && kept[kept.length - 1] === '') kept.pop()
  return kept.join('\n')
}

module.exports = {
  TAG_LINE_RE,
  stripTagLines
}
