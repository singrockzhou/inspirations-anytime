const store = require('../../utils/store')
const date = require('../../utils/date')
const audio = require('../../utils/audio')
const dialog = require('../../utils/dialog')
const flip = require('../../utils/flip')

const TYPE_LABEL = { text: '文字', voice: '语音', photo: '照片' }

/** 横向拖动超过这个距离才算"翻页"，太小容易和普通点击、长按冲突 */
const SWIPE_MIN = 56
/** 拖动时的跟手比例与上限：拖到头有个"到边了"的手感，但不会把整页拖飞 */
const SWIPE_RATIO = 0.4
const SWIPE_MAX = 96

Page({
  data: {
    id: '',
    record: null,
    missing: false,
    typeLabel: '',
    timeText: '',
    updatedText: '',
    playing: false,
    photos: [],
    starred: false,
    archived: false,
    needText: false,
    toastText: '',
    /** 左右翻：拖动位移（px）与过渡，交给根节点 transform */
    swipeDx: 0,
    swipeTransition: 'none',
    /** 记录总数 > 1 才显示翻页条；canPrev 决定"上一条"是否置灰 */
    total: 0,
    canPrev: false
  },

  onLoad(options) {
    const id = options.id || ''
    this.setData({ id: id })
    this.id = id
    // 从重温页进来接着用那一轮的历史，右滑能回到刚看过的那条
    flip.enter(id)
    this._timers = []
    this._switching = false
    this._sx = 0
    this._sy = 0
    this._dx = 0
    this._axis = ''
  },

  /** 从编辑页返回时重新读一次，页面内容与库保持一致 */
  onShow() {
    this.load()
  },

  onUnload() {
    audio.release()
    this.clearTimers()
    clearTimeout(this.toastTimer)
  },

  load() {
    const rec = store.get(this.id)
    if (!rec) {
      this.setData({ record: null, missing: true })
      return
    }
    this.setData({
      record: rec,
      missing: false,
      typeLabel: TYPE_LABEL[rec.type] || '文字',
      timeText: date.fullTime(rec.createdAt),
      // 只有真的改过（超过 1 分钟再保存）才显示修改时间
      updatedText: rec.updatedAt - rec.createdAt > 60000 ? date.fullTime(rec.updatedAt) : '',
      photos: rec.mediaPaths || [],
      starred: !!rec.starred,
      archived: !!rec.archivedAt,
      // 语音/照片没有文字时，给一个"补一句"的口子，补上就能被搜到
      needText: rec.type !== 'text' && !(rec.content || '').trim(),
      // 翻页条：只有一条记录时左右滑没有意义，直接不显示
      total: flip.total(),
      canPrev: flip.canPrev()
    })
  },

  onEdit() {
    wx.navigateTo({ url: '/pages/record/record?mode=edit&id=' + this.id })
  },

  onCopy() {
    const text = ((this.data.record && this.data.record.content) || '').trim()
    if (!text) {
      this.toast('这条没有文字可复制')
      return
    }
    wx.setClipboardData({
      data: text,
      success: () => this.toast('复制了')
    })
  },

  onDelete() {
    dialog
      .confirm({
        title: '删了？',
        text: '删掉之后回到列表，5 秒内还能撤回。',
        cancelText: '留着',
        confirmText: '删',
        danger: true
      })
      .then(res => {
        if (!res.confirmed) return
        if (store.remove(this.id)) wx.navigateBack()
      })
  },

  /* ------------------------- 星标 / 归档 ------------------------- */

  onToggleStar() {
    const next = !this.data.starred
    if (!store.setStar(this.id, next)) return
    this.setData({ starred: next })
    this.toast(next ? '加星了' : '从星标里拿下来了')
  },

  onToggleArchive() {
    const next = !this.data.archived
    if (!store.setArchive(this.id, next)) return
    this.setData({ archived: next })
    this.toast(next ? '收进归档了' : '回到主列表了')
  },

  /* ------------------------- 做成图 ------------------------- */

  onPoster() {
    wx.navigateTo({ url: '/pages/poster/poster?id=' + this.id })
  },

  /* ------------------------- 补文字 ------------------------- */

  /** 语音/照片没有文字时，补一句就能被搜索命中 */
  onAddText() {
    dialog
      .show({
        title: '补一句',
        editable: true,
        placeholder: '这段讲的是什么？',
        cancelText: '算了',
        confirmText: '存下'
      })
      .then(res => {
        if (!res.confirmed) return
        const text = (res.value || '').trim()
        if (!text) {
          // 一个字没填就退回编辑页去写，不硬拦
          this.onEdit()
          return
        }
        if (!store.update(this.id, { content: text })) return
        this.load()
        this.toast('补上了，现在能搜到')
      })
  },

  /* ------------------------- 媒体 ------------------------- */

  onPlay() {
    const rec = this.data.record
    if (!rec || !rec.mediaPath) return

    if (this.data.playing) {
      audio.stop()
      this.setData({ playing: false })
      return
    }

    audio.play(rec.mediaPath, {
      end: () => this.setData({ playing: false }),
      error: () => {
        this.setData({ playing: false })
        this.toast('这段录音找不到了')
      }
    })
    this.setData({ playing: true })
  },

  /* ------------------------- 左右翻一条 ------------------------- */

  /** 手指或箭头只调这一个入口：方向 +1 下一条，-1 上一条 */
  go(dir) {
    if (this._switching) return
    // 只有一条时连翻页条都不显示，滑动只阻尼、不弹提示——免得每次划一下都被念一句
    if (this.data.total < 2) {
      this.release()
      return
    }

    const rec = dir > 0 ? flip.next() : flip.prev()
    if (!rec) {
      this.toast(dir > 0 ? '没有别的灵感了' : '已经是最早的一条了')
      this.setData({ canPrev: flip.canPrev() })
      this.release()
      return
    }

    this._switching = true
    // 换条之前先把声音停掉：不然上一条的录音会跟着新内容继续响
    this.stopPlaying()

    const out = dir > 0 ? -SWIPE_MAX : SWIPE_MAX
    this.setData({ swipeTransition: 'transform 0.14s ease-out', swipeDx: out })
    this.push(() =>
      setTimeout(() => {
        this.id = rec.id
        // 先无过渡地把新内容摆到另一侧，再滑回原位，看着像"换了一张"
        this.setData({ id: rec.id, swipeDx: -out, swipeTransition: 'none' })
        this.load()
        if (typeof wx.pageScrollTo === 'function') {
          wx.pageScrollTo({ scrollTop: 0, duration: 0 })
        }
        this.push(() =>
          setTimeout(() => {
            this.setData({ swipeTransition: 'transform 0.18s ease-out', swipeDx: 0 })
            this._switching = false
          }, 30)
        )
      }, 150)
    )
  },

  onPrev() {
    this.go(-1)
  },

  onNext() {
    this.go(1)
  },

  /* 手势：横向拖动接管，纵向仍然交给页面滚动 */

  onTouchStart(e) {
    const t = e.touches && e.touches[0]
    if (!t) return
    this._sx = t.clientX
    this._sy = t.clientY
    this._dx = 0
    this._axis = ''
  },

  onTouchMove(e) {
    if (this._switching || !this._sx) return
    const t = e.touches && e.touches[0]
    if (!t) return

    const dx = t.clientX - this._sx
    const dy = t.clientY - this._sy

    // 前 10px 不判方向：免得手指一开始的抖动就把纵向滚动抢成横向翻页
    if (!this._axis) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
      this._axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y'
      if (this._axis === 'x') this.setData({ swipeTransition: 'none' })
    }
    if (this._axis !== 'x') return

    this._dx = dx
    // 到头了（没有上一条/下一条）阻力加大，滑起来就知道没有更多
    const ends = (dx < 0 && this.data.total < 2) || (dx > 0 && !this.data.canPrev)
    const d = Math.max(-SWIPE_MAX, Math.min(SWIPE_MAX, dx * (ends ? 0.12 : SWIPE_RATIO)))
    this.setData({ swipeDx: d })
  },

  onTouchEnd() {
    if (this._axis !== 'x') {
      this._axis = ''
      this._sx = 0
      return
    }
    const dx = this._dx
    this._axis = ''
    this._sx = 0
    this._dx = 0

    if (Math.abs(dx) >= SWIPE_MIN) {
      this.go(dx < 0 ? 1 : -1)
      return
    }
    this.release()
  },

  /** 没到阈值、或者翻不动：滑回原位 */
  release() {
    this.setData({ swipeTransition: 'transform 0.18s ease-out', swipeDx: 0 })
  },

  stopPlaying() {
    if (!this.data.playing) return
    audio.stop()
    this.setData({ playing: false })
  },

  push(register) {
    const id = register()
    this._timers = (this._timers || []).concat(id)
  },

  clearTimers() {
    ;(this._timers || []).forEach(id => clearTimeout(id))
    this._timers = []
  },

  goBack() {
    wx.navigateBack()
  },

  onShareAppMessage() {
    const text = ((this.data.record && this.data.record.content) || '').slice(0, 400)
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
