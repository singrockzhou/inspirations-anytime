const store = require('../../utils/store')
const date = require('../../utils/date')
const i18n = require('../../utils/i18n')
const audio = require('../../utils/audio')
const flip = require('../../utils/flip')
const share = require('../../utils/share')

/** 横向拖动超过这个距离才算"翻一条"，太小容易和普通点击、纵向滚动冲突 */
const SWIPE_MIN = 56
/** 拖动时的跟手比例与上限：拖到头有"到边了"的手感，但不会把整张纸拖飞 */
const SWIPE_RATIO = 0.4
const SWIPE_MAX = 96

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
 *
 * 左右滑：
 *   左滑 = 下一条（沿用「再来一条」的同一条取数路径：先走回看过的，再抽新的）
 *   右滑 = 上一条（先回退这一轮看过的，退到头按时间往前接，和详情页同一套）
 * 手势与「再来一条」共用 utils/flip.js，所以"下一条是谁"两处永远一致。
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
    curText: '0:00',
    /** 左右滑：纸的位移（px）与过渡，直接落在 .paper 的 transform 上 */
    swipeDx: 0,
    swipeTransition: 'none',
    /** 还有没有"上一条"——决定右滑的手感，也是边界提示的依据 */
    canPrev: false,
    /** 当前语言文案包 */
    t: {},
    headSub: '',
    photoAlso: ''
  },

  onLoad() {
    this._timers = []
    this._switching = false
    this._sx = 0
    this._sy = 0
    this._dx = 0
    this._axis = ''
    this.pick(true)
  },

  /**
   * 从详情页返回时重新对一次数：那一页里可能删了记录、也可能左右翻到了别处，
   * 这里只同步"总数/能不能往回翻"，纸上的内容不动（用户看见的仍是同一条）。
   */
  onShow() {
    i18n.title('nav:review')
    if (!this.data.item) {
      this.setData({ t: i18n.pack('review') })
      return
    }
    this.setData({
      t: i18n.pack('review'),
      total: flip.total(),
      canPrev: flip.canPrev(),
      headSub: this.headSub(flip.total()),
      photoAlso: i18n.t('index:badge_photo', { n: this.data.photoCount })
    })
  },

  /** 标题下那句：一条时说"就这一条"，多条时给总量 */
  headSub(total) {
    if (!total) return ''
    return total > 1 ? i18n.t('review:head_multi', { n: total }) : i18n.t('review:head_one')
  },

  /** 离开页面就闭嘴：重温是"看一眼"，不该带着背景音走出这个页面 */
  onHide() {
    this.stopAudio()
  },

  onUnload() {
    audio.release()
    this.clearTimers()
    clearTimeout(this.toastTimer)
  },

  /* ------------------------- 取数 ------------------------- */

  /** 「再来一条」：对齐到当前这条之后，沿 flip 的前进方向取一条 */
  pick(first) {
    const total = flip.total()
    if (!total) {
      this.setData({ total: 0, item: null, empty: true, photos: [], photoCount: 0, voices: [] })
      return
    }

    const current = this.data.item
    // 栈顶对齐到当前这条：第一次进来重开一轮，之后每次抽牌都接着记
    if (first || !current) flip.reset()
    else flip.enter(current.id)

    let item = flip.next()
    // 库里只有这一条：没有"别的"可翻，但这一条本身还得给他看
    if (!item && total === 1) item = current || flip.only()

    this.show(item, !first)
  },

  /**
   * 把一条记录铺到纸上。只渲染，不取数——
   * 手势那边已经从 flip 拿到条目了，不能再走一遍 flip，否则会抽成另一条。
   */
  show(item, buzz) {
    if (!item) {
      this.setData({ item: null, empty: true, canPrev: false })
      return
    }

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
      total: flip.total(),
      canPrev: flip.canPrev(),
      headSub: this.headSub(flip.total()),
      photoAlso: i18n.t('index:badge_photo', { n: photos.length }),
      timeText: date.fullTime(item.createdAt),
      agoText:
        days <= 0
          ? i18n.t('review:ago_today')
          : days === 1
          ? i18n.t('review:ago_yesterday')
          : i18n.t('review:ago_days', { n: days }),
      starred: !!item.starred,
      photos: photos,
      photoCount: photos.length,
      voices: voices,
      progress: 0,
      curText: '0:00'
    })

    if (buzz) {
      // 换卡时给一次极轻的震动，比动画更省电也更有"抽到了"的感觉
      wx.vibrateShort({ type: 'light', fail() {} })
    }
  },

  onNext() {
    this.pick(false)
  },

  /* ------------------------- 左右滑 ------------------------- */

  /** 手指与「再来一条」都汇到这里：dir > 0 下一条，dir < 0 上一条 */
  go(dir) {
    if (this._switching) return
    // 只有一条时连"上一条"都无从谈起，滑动只阻尼、不弹提示——免得每次划一下都被念一句
    if (this.data.total < 2) {
      this.release()
      return
    }

    const item = dir > 0 ? flip.next() : flip.prev()
    if (!item) {
      this.toast(dir > 0 ? i18n.t('review:toast_only_one') : i18n.t('review:toast_earliest'))
      this.setData({ canPrev: flip.canPrev() })
      this.release()
      return
    }

    this._switching = true
    // 换条之前先把声音停掉：不然上一条的录音会跟着新内容继续响
    this.stopAudio()

    // 手往左推 → 纸往左走，换来的那条从右边进；右滑反之
    const out = dir > 0 ? -SWIPE_MAX : SWIPE_MAX
    this.setData({ swipeTransition: 'transform 0.14s ease-out', swipeDx: out })
    this.push(() =>
      setTimeout(() => {
        // 先无过渡地把新内容摆到另一侧，再滑回原位，看着像"换了一张"
        this.setData({ swipeDx: -out, swipeTransition: 'none' })
        this.show(item)
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
    // 到头了（只有一条 / 已经是最早的）阻力加大，滑起来就知道没有更多
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

  /* ------------------------- 滚动 ------------------------- */

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
        this.toast(i18n.t('common:not_found_voice'))
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
    this.toast(item.starred ? i18n.t('index:toast_unstarred') : i18n.t('index:toast_starred'))
  },

  onOpen() {
    const item = this.data.item
    if (!item) return
    wx.navigateTo({ url: '/pages/detail/detail?id=' + item.id })
  },

  goWrite() {
    wx.navigateTo({ url: '/pages/record/record?mode=create&type=text' })
  },

  push(register) {
    const id = register()
    this._timers = (this._timers || []).concat(id)
  },

  clearTimers() {
    ;(this._timers || []).forEach(id => clearTimeout(id))
    this._timers = []
  },

  onShareAppMessage() {
    const item = this.data.item
    return share.card((item && item.content) || '')
  },

  toast(message) {
    clearTimeout(this.toastTimer)
    this.setData({ toastText: message })
    this.toastTimer = setTimeout(() => this.setData({ toastText: '' }), 1600)
  }
})
