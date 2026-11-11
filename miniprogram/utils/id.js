/** 记录 id：时间戳 base36 + 随机串，既可读又基本不会撞 */
function uuid() {
  const t = Date.now().toString(36)
  let rand = ''
  while (rand.length < 6) {
    rand += Math.random().toString(36).slice(2)
  }
  return 'r' + t + rand.slice(0, 6)
}

module.exports = { uuid }
