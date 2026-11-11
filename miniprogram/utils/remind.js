/**
 * 每日提醒
 *
 * 事实：微信的订阅消息必须由**服务端**下发，小程序端只能完成前半段
 * （用户点授权 → wx.requestSubscribeMessage 返回 accept），
 * 到点真正弹出那条通知，需要自己的服务端/云函数按 openid + 模板去发。
 *
 * 所以这个模块只做诚实的那一半：
 *   1) 保存用户的提醒开关与时间；
 *   2) 拿到并记录授权结果；
 *   3) 没有配置模板 ID 时明确报错，绝不假装"已开启"。
 *
 * 想真正跑通，三步：
 *   a. mp 后台 → 功能 → 订阅消息 → 选用「记录提醒」模板，拿到模板 ID；
 *   b. 把下面的 TMPL_ID 填上；
 *   c. 服务端按 subscriber 表在设定时间调 subscribeMessage.send。
 * 在 c 完成之前，用户看到的会是"已请求授权，还需要服务端配合"的说明。
 */
const store = require('./store')

/** 在 mp 后台创建订阅消息模板后填这里 */
const TMPL_ID = ''

function canAsk() {
  return typeof wx.requestSubscribeMessage === 'function'
}

function configured() {
  return !!TMPL_ID
}

/** 提醒设置 + 能力状态，给页面一次性读 */
function status() {
  const prefs = store.getPrefs()
  return {
    on: prefs.remindOn,
    hour: prefs.remindHour,
    minute: prefs.remindMinute,
    timeText: clockText(prefs.remindHour, prefs.remindMinute),
    canAsk: canAsk(),
    configured: configured()
  }
}

function clockText(hour, minute) {
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return pad(hour) + ':' + pad(minute)
}

/**
 * 打开提醒：先请求订阅授权，拿到 accept 才记成"已开"。
 * @returns {Promise<{on:boolean, granted:boolean}>}
 */
function enable() {
  return new Promise((resolve, reject) => {
    if (!configured()) {
      reject({ code: 'no-template', message: '还没配订阅消息模板' })
      return
    }
    if (!canAsk()) {
      reject({ code: 'unsupported', message: '当前微信版本不支持订阅消息' })
      return
    }

    wx.requestSubscribeMessage({
      tmplIds: [TMPL_ID],
      success: res => {
        const accepted = res && res[TMPL_ID] === 'accept'
        if (accepted) store.savePrefs({ remindOn: true })
        resolve({ on: accepted, granted: accepted })
      },
      fail: err => {
        const msg = String((err && err.errMsg) || '')
        reject({ code: msg.indexOf('cancel') >= 0 ? 'cancel' : 'fail', message: msg })
      }
    })
  })
}

function disable() {
  store.savePrefs({ remindOn: false })
  return status()
}

function setTime(hour, minute) {
  store.savePrefs({ remindHour: hour, remindMinute: minute })
  return status()
}

module.exports = {
  TMPL_ID,
  configured,
  canAsk,
  status,
  enable,
  disable,
  setTime,
  clockText
}
