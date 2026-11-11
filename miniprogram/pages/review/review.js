const store = require('../../utils/store')
const date = require('../../utils/date')
const audio = require('../../utils/audio')

/** 秒 → 0:08 / 1:24，不依赖 padStart（低版本基础库没有） */
function mmss(sec) {
  const s = Math.max(0, Math.round(sec || 0))
  const m = Math.floor(s / 60)
  const r = s % 60
  return m + ':' + (r < 10 ? '0' : '') + r
}

/**
 * 随机重温
 * 只做一件小事：从旧记录里抽一条给你看。
 * 抽的时候刻意偏向"7 天以上"的记录——昨天刚写的再看一遍没有意义，
 * 半年前那句才可能让人"啊，原来是这么想的"。
 */
Page({
  data: {
    item: null,
    empty: false,
    timeText: '',
    agoText: '',
    starred: false,
    total: 0,
    toastText: '',
    // 照片：交给 photo-grid 排，这里只负责把路径理顺
    photos: [],
    photoCount: 0,
    // 语音：以行为单位列出来，同一时刻只响一条
    voices: [],
    playingId: '',
    paused: false,
    // 换一条时把内层滚动位置收回顶部（scroll-top 只有值变化才生效，所以先同步再归零）
    scrollTop: 0,
    progress: 0,
    curText: '0:00'
  },

  onLoad() {
    this.pick(true)
  },

  /** 离开页面就闭嘴：重温是"看一眼"，不该带着背景音走出这个页面 */
  onHide() {
    this.stopAudio()
  },

  onUnload() {
    audio.release()
  },

  pick(first) {
    const all = store.list({ includeArchived: true })
    this.setData({ total: all.length })

    if (!all.length) {
      this.setData({ item: null, empty: true })
      return
    }

    const current = this.data.item
    let pool = all.filter(r => !current || r.id !== current.id)
    if (!pool.length) pool = all

    // 优先给"放了一阵子的"，没有就退回全量
    const old = pool.filter(r => Date.now() - r.createdAt > 7 * 86400000)
    const source = old.length ? old : pool
    const item = source[Math.floor(Math.random() * source.length)]

    const days = date.dayDiff(item.createdAt, Date.now())
    const photos = (item.mediaPaths || []).filter(Boolean)
    const voices =
      item.type === 'voice' && item.mediaPath
        ? [
            {
              id: item.id,
              src: item.mediaPath,
              seconds: item.duration || 0,
              durText: item.duration ? mmss(item.duration) : '—'
            }
          ]
        : []

    this.stopAudio()
    this.resetScroll()
    this._lastSec = -1

    this.setData({
      item: item,
      empty: false,
      timeText: date.fullTime(item.createdAt),
      agoText: days <= 0 ? '今天刚记的' : days === 1 ? '昨天记的' : days + ' 天前记的',
      starred: !!item.starred,
      photos: photos,
      photoCount: photos.length,
      voices: voices,
      progress: 0,
      curText: '0:00'
    })

    if (!first) {
      // 换卡时给一次极轻的震动，比动画更省电也更有"抽到了"的感觉
      wx.vibrateShort({ type: 'light', fail() {} })
    }
  },

  onNext() {
    this.pick(false)
  },

  onScroll(e) {
    // 只用实例变量记，不进 data：进 data 就会每次滚动都触发一次渲染
    this._scrollTop = (e.detail && e.detail.scrollTop) || 0
  },

  resetScroll() {
    if (!this._scrollTop) return
    const from = this._scrollTop
    this._scrollTop = 0
    this.setData({ scrollTop: from }, () => {
      setTimeout(() => this.setData({ scrollTop: 0 }), 30)
    })
  },

  /* ------------------------- 语音 ------------------------- */

  onToggleAudio(e) {
    const id = e.currentTarget.dataset.id
    const v = (this.data.voices || []).filter(x => x.id === id)[0]
    if (!v) return

    if (this.data.playingId === id) {
      if (this.data.paused) {
        audio.resume()
        this.setData({ paused: false })
      } else {
        audio.pause()
        this.setData({ paused: true })
      }
      return
    }

    this._lastSec = -1
    this.setData({ playingId: id, paused: false, progress: 0, curText: '0:00' })
    audio.play(v.src, {
      time: t => this.onTime(id, t),
      end: () => this.setData({ playingId: '', paused: false, progress: 0, curText: '0:00' }),
      error: () => {
        this.setData({ playingId: '', paused: false, progress: 0, curText: '0:00' })
        this.toast('这段录音找不到了')
      }
    })
  },

  /** onTimeUpdate 每 250ms 一次，只在整秒变化时 setData，省得白渲染 */
  onTime(id, t) {
    if (this.data.playingId !== id) return
    const cur = (t && t.currentTime) || 0
    const sec = Math.floor(cur)
    if (sec === this._lastSec) return
    this._lastSec = sec

    const v = (this.data.voices || []).filter(x => x.id === id)[0]
    const held = (v && v.seconds) || 0
    const dur = (t && t.duration) || held || 0
    this.setData({
      curText: mmss(sec),
      progress: dur ? Math.min(100, (cur / dur) * 100) : 0
    })
  },

  stopAudio() {
    this._lastSec = -1
    if (this.data.playingId) audio.stop()
    this.setData({ playingId: '', paused: false, progress: 0, curText: '0:00' })
  },

  /* ------------------------- 其它 ------------------------- */

  onStar() {
    const item = this.data.item
    if (!item) return
    store.setStar(item.id, !item.starred)
    this.setData({ starred: !item.starred, 'item.starred': item.starred ? 0 : 1 })
    this.toast(item.starred ? '从星标里拿下来了' : '加星了')
  },

  onOpen() {
    const item = this.data.item
    if (!item) return
    wx.navigateTo({ url: '/pages/detail/detail?id=' + item.id })
  },

  goWrite() {
    wx.navigateTo({ url: '/pages/record/record?mode=create&type=text' })
  },

  onShareAppMessage() {
    const item = this.data.item
    const text = item ? (item.content || '').slice(0, 400) : ''
    return {
      title: text ? text.slice(0, 30) : '灵感随时记',
      path: text ? '/pages/index/index?inbox=' + encodeURIComponent(text) : '/pages/index/index'
    }
  },

  toast(message) {
    clearTimeout(this.toastTimer)
    this.setData({ toastText: message })
    this.toastTimer = setTimeout(() => this.setData({ toastText: '' }), 1600)
  }
})
