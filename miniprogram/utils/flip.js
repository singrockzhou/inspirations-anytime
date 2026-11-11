/**
 * 「翻一条」的唯一出口
 *
 * 重温页的「再来一条」和详情页的左右滑动都从这里取数：
 * 抽样规则只有一份，走过哪几条也只有一份，所以两处的"下一条是谁"永远一致。
 *
 * 规则（沿用重温页原来的算法，一行未改）：
 *   - 从全部未删除的记录里抽（含归档），先排除当前这条
 *   - 优先 7 天以上的记录，没有就退回全量
 *   - 随机取一条
 *
 * 时间上的两种方向：
 *   next()  左滑 / 再来一条 —— 栈里还有"前一条"就先走回去（右滑过之后能原路返回），
 *           走到头再按上面的规则抽一张新的
 *   prev()  右滑 —— 先回退这一轮看过的上一条；本轮到头时，按时间接一条更早的，
 *            并把历史补在左边，所以再左滑还能回到刚才那条。
 *            一条记录都没有更早的时候才返回 null，由页面如实提示。
 *
 * 这一层只认 store，不认页面，也不认 UI。
 */
const store = require('./store')

const WEEK = 7 * 86400000

/** 走过的记录 id，从旧到新；cur 指向当前这条 */
let stack = []
let cur = -1

function all() {
  return store.list({ includeArchived: true })
}

function pool(excludeId) {
  const list = all()
  // 除开当前这条一条都没有 → 池子就是空的。
  // 这里绝不能退回"含自己的全量"：那会让 next() 把当前这条再发一次，
  // 页面表现为"滑了但什么也没发生"，比明确说"没别的了"更让人困惑。
  const rest = list.filter(r => r.id !== excludeId)
  if (!rest.length) return []
  const old = rest.filter(r => Date.now() - r.createdAt > WEEK)
  return old.length ? old : rest
}

/**
 * 进入一条记录。
 * 从重温页点进详情时栈顶正好是这条，于是接着用这一轮的历史；
 * 从列表/搜索点进来则重开一轮。
 */
function enter(id) {
  if (!id) {
    stack = []
    cur = -1
    return
  }
  if (stack[cur] === id) return
  stack = [id]
  cur = 0
}

function next() {
  // 先走栈里已经有的"前一条"：从列表右滑到更早的一条后，左滑能原路回到刚才那条
  while (cur + 1 < stack.length) {
    cur += 1
    const rec = store.get(stack[cur])
    if (rec) return rec
  }

  const list = pool(stack[cur])
  if (!list.length) return null
  const rec = list[Math.floor(Math.random() * list.length)]
  stack = stack.slice(0, cur + 1)
  stack.push(rec.id)
  cur = stack.length - 1
  return rec
}

/** 时间上更早的一条，到最早就返回 null */
function olderThan(id) {
  const list = all() // 已是新 → 旧
  const i = list.findIndex(r => r.id === id)
  if (i < 0) return null
  return list[i + 1] || null
}

function prev() {
  while (cur > 0) {
    cur -= 1
    const rec = store.get(stack[cur])
    // 上一条被删了就继续往前找，不把"这条已经不在了"甩给页面
    if (rec) return rec
  }
  const older = olderThan(stack[0] || '')
  if (!older) return null
  stack.unshift(older.id)
  cur = 0
  return older
}

/** 还能不能往回翻（右滑那一下的手感与箭头是否置灰都用它） */
function canPrev() {
  if (cur > 0) return true
  return !!olderThan(stack[0] || '')
}

/** 记录总数，页面上判断"要不要显示翻页条"用 */
function total() {
  return all().length
}

/**
 * 库里只有一条时，这一条就是全部。
 * next() 在这种情况下会如实返回 null（没别的可翻），
 * 但首次进页面总得有东西可看，所以单独给一个"就这一条"的入口。
 */
function only() {
  const list = all()
  if (list.length !== 1) return null
  stack = [list[0].id]
  cur = 0
  return list[0]
}

function reset() {
  stack = []
  cur = -1
}

module.exports = {
  enter,
  next,
  prev,
  canPrev,
  total,
  only,
  reset
}
