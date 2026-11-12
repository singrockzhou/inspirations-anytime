/**
 * 对话框中枢
 * 页面里放一个 <dialog-view />，这里登记实例；页面调用 dialog.alert/confirm 拿 Promise。
 *
 * 为什么要有中枢：showModal 是命令式 API，随叫随到；自绘对话框必须有实例在页面上。
 * 中枢把「有没有实例」这件事兜住——没有（比如 App 启动阶段 store.js 报错）就退回系统弹窗，
 * 保证任何调用点都不会因为 UI 没挂载而丢提示。
 */
const i18n = require('./i18n')

/** 页面栈里可能同时挂着多个实例（返回上一页时），后挂载的在最上面 */
const stack = []

function bind(inst) {
  if (!inst) return
  if (stack.indexOf(inst) === -1) stack.push(inst)
}

function unbind(inst) {
  const i = stack.indexOf(inst)
  if (i > -1) stack.splice(i, 1)
}

function top() {
  return stack.length ? stack[stack.length - 1] : null
}

function isReady() {
  return !!top()
}

function normalize(opts) {
  if (typeof opts === 'string') return { text: opts }
  return opts || {}
}

function fallback(o, done) {
  wx.showModal({
    title: o.title || '',
    content: o.text || '',
    showCancel: o.showCancel !== false,
    cancelText: o.cancelText || i18n.t('dialog:cancel'),
    confirmText: o.confirmText || i18n.t('common:got_it'),
    success: r => done({ confirmed: !!r.confirm, value: '' }),
    fail: () => done({ confirmed: false, value: '' })
  })
}

/**
 * @param {object|string} raw
 * @returns {Promise<{confirmed:boolean, value:string}>}
 */
function show(raw) {
  const o = normalize(raw)
  return new Promise(resolve => {
    const done = res => {
      const payload = res || { confirmed: false, value: '' }
      resolve(payload)
      // 调用方自己的 onDone 也保留，方便做埋点之类的副作用
      if (typeof o.onDone === 'function') o.onDone(payload)
    }
    const inst = top()
    if (!inst) return fallback(o, done)
    inst.open(Object.assign({}, o, { onDone: done }))
  })
}

/** 只有一个按钮，用于"知道了" */
function alert(raw) {
  const o = Object.assign({ showCancel: false, confirmText: i18n.t('common:got_it') }, normalize(raw))
  return show(o)
}

/** 两个按钮，默认「算了 / 好」，危险操作把 danger 传 true */
function confirm(raw) {
  const o = Object.assign(
    { cancelText: i18n.t('dialog:cancel'), confirmText: i18n.t('dialog:ok') },
    normalize(raw)
  )
  return show(o)
}

module.exports = {
  bind,
  unbind,
  top,
  isReady,
  show,
  alert,
  confirm
}
