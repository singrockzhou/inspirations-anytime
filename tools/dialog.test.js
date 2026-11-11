/**
 * 对话框行为测试（27 条断言）
 * 用法：node tools/dialog.test.js
 * 用 stub 顶掉 wx / Component，直接驱动组件方法，不需要开发者工具。
 */
const path = require('path')
const base = path.resolve(__dirname, '..', 'miniprogram')
const calls = []
let def = null

global.wx = {
  showModal(o) { calls.push(o); if (o.success) o.success({ confirm: true }) }
}
global.Component = d => { def = d }

const hub = require(path.join(base, 'utils', 'dialog.js'))
require(path.join(base, 'components', 'dialog', 'dialog.js'))

function mk() {
  const inst = Object.assign({
    data: JSON.parse(JSON.stringify(def.data)),
    setData(p) { Object.assign(this.data, p) }
  }, def.methods)
  return inst
}
const wait = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + JSON.stringify(extra) : '')) }
}

;(async () => {
  console.log('1) 没有实例时退回系统弹窗')
  ok('isReady=false', hub.isReady() === false)
  const fb = await hub.alert('兜底一句')
  ok('wx.showModal 被调用', calls.length === 1)
  ok('默认单键+知道了', calls[0].showCancel === false && calls[0].confirmText === '知道了')
  ok('文案透传', calls[0].content === '兜底一句')
  ok('resolve confirmed=true', fb.confirmed === true)

  console.log('2) 挂载后走自绘')
  const inst = mk()
  hub.bind(inst)
  ok('isReady=true', hub.isReady() === true)
  const p = hub.confirm({ title: '删了？', text: '5 秒内可撤回', danger: true })
  ok('盒子已显示', inst.data.visible === true && inst.data.title === '删了？')
  ok('危险色生效', inst.data.danger === true)
  inst.onCancel()
  const r1 = await p
  ok('取消后 confirmed=false', r1.confirmed === false)
  ok('取消后关闭', inst.data.visible === false)

  console.log('3) 异步确认：自动 loading，成功后关闭')
  const s = mk()
  hub.bind(s)
  let finished = false
  const pr = hub.show({
    title: '打包中', confirmText: '开始',
    onConfirm: () => new Promise(res => setTimeout(() => res(true), 30)),
    onDone: () => { finished = true }
  })
  s.onConfirm()
  ok('进入 loading', s.data.confirmLoading === true)
  await wait(60)
  ok('异步完成后退出 loading', s.data.confirmLoading === false)
  await wait(200)
  ok('关闭并回调一次', s.data.visible === false && finished === true)
  const r2 = await pr
  ok('确认结果 confirmed=true', r2.confirmed === true)

  console.log('4) 异步确认返回 false：留在原地')
  const t = mk()
  hub.unbind(s); hub.bind(t)
  let done4 = false
  const p4 = hub.show({ title: '校验', onConfirm: () => Promise.resolve(false), onDone: () => { done4 = true } })
  t.onConfirm()
  await wait(240)
  ok('盒子仍开着', t.data.visible === true && t.data.confirmLoading === false)
  ok('未回调', done4 === false)
  t.onCancel()
  await p4
  ok('取消后能关', t.data.visible === false)

  console.log('5) 遮罩与防重复')
  const u = mk()
  hub.unbind(t); hub.bind(u)
  const p5 = hub.show({ title: '点遮罩' })
  u.onMask()
  ok('默认遮罩点不掉', u.data.visible === true)
  const p5b = Promise.resolve(p5)
  u.setData({ maskClosable: true })
  u.onMask()
  await p5b
  ok('允许后可关', u.data.visible === false)

  console.log('6) 加载中禁止取消/遮罩')
  const v = mk()
  hub.unbind(u); hub.bind(v)
  const p6 = hub.show({ title: '提交中', maskClosable: true, onConfirm: () => new Promise(res => setTimeout(() => res(true), 30)) })
  v.onConfirm()
  v.onCancel(); v.onMask()
  ok('加载中不响应取消', v.data.visible === true && v.data.confirmLoading === true)
  await wait(260)
  ok('异步完成后正常关闭', v.data.visible === false)
  await p6

  console.log('7) 输入型：值随结果带回')
  const w = mk()
  hub.unbind(v); hub.bind(w)
  const p7 = hub.show({ title: '补一句', editable: true })
  ok('输入型渲染', w.data.editable === true)
  w.onInputFocus()
  ok('聚焦态', w.data.inputFocused === true)
  w.onInputBlur()
  w.onInput({ detail: { value: '一段备注' } })
  w.onConfirm()
  const r7 = await p7
  ok('带回输入值', r7.confirmed === true && r7.value === '一段备注')

  console.log('8) 栈顺序')
  const a = mk(), b = mk()
  hub.unbind(w)
  hub.bind(a); hub.bind(b)
  ok('后挂载的在上', hub.top() === b)
  hub.unbind(b)
  ok('关掉后回落到上一个', hub.top() === a)
  hub.unbind(a)
  hub.unbind(inst)
  ok('全关后 isReady=false', hub.isReady() === false)

  console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
})()
