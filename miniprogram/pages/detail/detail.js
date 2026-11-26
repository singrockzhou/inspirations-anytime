const store = require('../../utils/store')
const date = require('../../utils/date')
const audio = require('../../utils/audio')
const dialog = require('../../utils/dialog')
const flip = require('../../utils/flip')
const stack = require('../../utils/stack')
const share = require('../../utils/share')
const tagtext = require('../../utils/tagtext')
const i18n = require('../../utils/i18n')

/** 类型标签随语言变，不能做成模块级常量（模块只执行一次） */
function typeLabel(type) {
  if (type === 'voice') return i18n.t('common:type_voice')
  if (type === 'photo') return i18n.t('common:type_photo')
  return i18n.t('common:type_text')
}

/**
 * 多图错落堆叠：版式与首页卡片、「做成图」共用 utils/stack.js 的一份数字，
 * 避免"手机上歪 3 度、图里歪 5 度"这种说不清的偏差。
 *
 * 与卡片唯一的差别：这里把所有组都铺开（卡片只摆一组 + 角标 "+N"），
 * 因为进详情页就是来看图的，不该藏起来。
 */
function buildClusters(rec, paths) {
  const plan = stack.planAll(rec.id || rec.createdAt || '', paths.length)
  if (!plan || plan.single) return []
  let offset = 0
  return plan.clusters.map((c, ci) => {
    const frames = c.frames.map((f, i) => ({
      src: paths[offset + i],
      idx: offset + i,
      style:
        'left:' +
        f.x +
        'rpx;top:' +
        f.y +
        'rpx;width:' +
        stack.FRAME_W +
        'rpx;height:' +
        stack.FRAME_H +
        'rpx;z-index:' +
        f.z +
        ';transform:rotate(' +
        f.r.toFixed(1) +
        'deg);'
    }))
    offset += c.size
    return { frames: frames, height: c.height, gap: ci ? stack.CLUSTER_GAP : 0 }
  })
}

/** 横向拖动超过这个距离才算"翻页"，太小容易和普通点击、长按冲突 */
const SWIPE_MIN = 56
/** 拖动时的跟手比例与上限：拖到头有个"到边了"的手感，但不会把整页拖飞 */
const SWIPE_RATIO = 0.4
const SWIPE_MAX = 96

Page({
  data: {
    id: '',
    record: null,
    /** 剥掉独占一行的 #标签 之后用来显示的正文档子 */
    bodyText: '',
    missing: false,
    typeLabel: '',
    timeText: '',
    updatedText: '',
    playing: false,
    photos: [],
    /** 多图走错落堆叠（与首页卡片同款版式），单图仍是一整幅 */
    multi: false,
    clusterList: [],
    starred: false,
    archived: false,
    needText: false,
    toastText: '',
    /** 左右翻：拖动位移（px）与过渡，交给根节点 transform */
    swipeDx: 0,
    swipeTransition: 'none',
    /** 记录总数 > 1 才显示翻页条；canPrev 决定"上一条"是否置灰 */
    total: 0,
    canPrev: false,
    t: {}
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
    this.setData({ t: i18n.pack('detail') })
    i18n.title('nav:detail')
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
    const paths = (rec.mediaPaths && rec.mediaPaths.length)
      ? rec.mediaPaths
      : (rec.mediaPath ? [rec.mediaPath] : [])
    this.setData({
      record: rec,
      missing: false,
      // 正文展示用：去掉「独占一行」的 #标签（下面那排胶囊已经画了）。
      // 数据里的 content 一个字没动，编辑页看到的还是原文。
      bodyText: tagtext.stripTagLines(rec.content || ''),
      typeLabel: typeLabel(rec.type),
      timeText: date.fullTime(rec.createdAt),
      // 只有真的改过（超过 1 分钟再保存）才显示修改时间
      updatedText: rec.updatedAt - rec.createdAt > 60000 ? date.fullTime(rec.updatedAt) : '',
      metaCreated: i18n.t('detail:meta_created', { t: date.fullTime(rec.createdAt) }),
      metaUpdated:
        rec.updatedAt - rec.createdAt > 60000
          ? i18n.t('detail:meta_updated', { t: date.fullTime(rec.updatedAt) })
          : '',
      photos: paths,
      multi: paths.length > 1,
      clusterList: buildClusters(rec, paths),
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
      this.toast(i18n.t('index:toast_no_text'))
      return
    }
    wx.setClipboardData({
      data: text,
      success: () => this.toast(i18n.t('common:copy_ok'))
    })
  },

  onDelete() {
    dialog
      .confirm({
        title: i18n.t('detail:del_title'),
        text: i18n.t('detail:del_text'),
        cancelText: i18n.t('detail:del_cancel'),
        confirmText: i18n.t('detail:del_ok'),
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
    this.toast(next ? i18n.t('index:toast_starred') : i18n.t('index:toast_unstarred'))
  },

  onToggleArchive() {
    const next = !this.data.archived
    if (!store.setArchive(this.id, next)) return
    this.setData({ archived: next })
    this.toast(next ? i18n.t('index:toast_archived') : i18n.t('index:toast_unarchived'))
  },

  /* ------------------------- 做成图 ------------------------- */

  onPoster() {
    wx.navigateTo({ url: '/pages/poster/poster?id=' + this.id })
  },

  /** 点堆叠里的某一张：从那张开始看大图 */
  onPreviewPhoto(e) {
    const list = (this.data.photos || []).filter(Boolean)
    if (!list.length) return
    const i = Number((e.currentTarget && e.currentTarget.dataset.i) || 0)
    wx.previewImage({ current: list[i] || list[0], urls: list })
  },

  /* ------------------------- 补文字 ------------------------- */

  /** 语音/照片没有文字时，补一句就能被搜索命中 */
  onAddText() {
    dialog
      .show({
        title: i18n.t('detail:add_title'),
        editable: true,
        placeholder: i18n.t('detail:add_placeholder'),
        cancelText: i18n.t('common:cancel'),
        confirmText: i18n.t('detail:add_ok')
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
        this.toast(i18n.t('detail:add_done'))
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
        this.toast(i18n.t('common:not_found_voice'))
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
      this.toast(dir > 0 ? i18n.t('detail:toast_no_next') : i18n.t('detail:toast_no_prev'))
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
    return share.card((this.data.record && this.data.record.content) || '')
  },

  toast(message) {
    clearTimeout(this.toastTimer)
    this.setData({ toastText: message })
    this.toastTimer = setTimeout(() => this.setData({ toastText: '' }), 1600)
  }
})
