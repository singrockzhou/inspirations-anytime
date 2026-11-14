const date = require('../../utils/date')
const i18n = require('../../utils/i18n')
const stack = require('../../utils/stack')

/**
 * 多图错落堆叠的版式
 * 坐标、抖动、层高都放在 utils/stack.js：首页卡片和「做成图」长图共用一份数字，
 * 两边分头维护迟早会出现"手机上歪 3 度、图里歪 5 度"这种说不清的偏差。
 * 这里只负责把版式拼成 CSS，rpx 单位原样输出。
 */
function buildStack(item, paths) {
  const list = paths.slice(0, stack.MAX_FRAMES)
  const p = stack.plan(item.id || item.createdAt || '', list.length)

  const frames = list.map((src, i) => {
    const f = p.frames[i]
    return {
      src,
      idx: i,
      style:
        'left:' + f.x + 'rpx;' +
        'top:' + f.y + 'rpx;' +
        'width:' + stack.FRAME_W + 'rpx;' +
        'height:' + stack.FRAME_H + 'rpx;' +
        'z-index:' + f.z + ';' +
        'transform:rotate(' + f.r.toFixed(1) + 'deg);'
    }
  })

  return { frames, height: p.height }
}

/** 类型角标文案，长度和内容都在这里算好，WXML 里只做渲染 */
function badgeOf(item) {
  if (!item) return ''
  if (item.type === 'voice') return i18n.t('index:badge_voice', { n: item.duration || 0 })
  if (item.type === 'photo') {
    const n = (item.mediaPaths || []).length || (item.mediaPath ? 1 : 0)
    return n > 1 ? i18n.t('index:badge_photo', { n: n }) : i18n.t('index:badge_photo_one')
  }
  return i18n.t('index:badge_text')
}

Component({
  properties: {
    item: {
      type: Object,
      value: null
    },
    /** 是否正在播放（全局只有一条在播） */
    playing: {
      type: Boolean,
      value: false
    },
    /** 刚存下的卡片，闪一次底色 */
    highlight: {
      type: Boolean,
      value: false
    },
    /** 多选模式：点卡片变成勾选，不再进详情 */
    selectMode: {
      type: Boolean,
      value: false
    },
    checked: {
      type: Boolean,
      value: false
    }
  },

  data: {
    badge: '',
    timeLabel: '',
    needFold: false,
    expanded: false,
    edited: false,
    photoCount: 0,
    photoList: [],
    stackH: 0,
    tagList: [],
    moreTags: 0,
    /** 静态文案：组件随页面重建，语言切了自然重新取一次 */
    txt: {}
  },

  lifetimes: {
    attached() {
      this.setData({
        txt: {
          edited: i18n.t('common:edited'),
          collapse: i18n.t('index:collapse'),
          expand: i18n.t('index:expand'),
          playing: i18n.t('card:playing'),
          listen: i18n.t('card:listen')
        }
      })
    }
  },

  observers: {
    item(item) {
      if (!item) return
      const content = item.content || ''
      const tags = item.tags || []
      const paths = (item.mediaPaths && item.mediaPaths.length)
        ? item.mediaPaths
        : (item.mediaPath ? [item.mediaPath] : [])
      const stack = paths.length > 1 ? buildStack(item, paths) : null
      this.setData({
        badge: badgeOf(item),
        timeLabel: date.relative(item.createdAt),
        // 超过 6 行（约 110 字）才折叠，短句不出现"展开"，避免满屏小按钮
        needFold: item.type === 'text' && content.length > 110,
        edited: !!(item.updatedAt && item.updatedAt - item.createdAt > 60000),
        photoCount: paths.length,
        // 多图才走错落堆叠；单图仍用整幅大图
        photoList: stack ? stack.frames : [],
        stackH: stack ? stack.height : 0,
        tagList: tags.slice(0, 3),
        moreTags: tags.length > 3 ? tags.length - 3 : 0
      })
    }
  },

  methods: {
    onOpen() {
      // 长按之后松手还会补一次 tap，这里挡掉
      if (this._longPressed) {
        this._longPressed = false
        return
      }
      if (this.data.selectMode) {
        this.triggerEvent('toggle', { item: this.data.item })
        return
      }
      this.triggerEvent('open', { item: this.data.item })
    },

    onLongPress() {
      this._longPressed = true
      this.triggerEvent('action', { item: this.data.item })
    },

    toggleFold() {
      this.setData({ expanded: !this.data.expanded })
    },

    onPlay() {
      if (this.data.selectMode) {
        this.triggerEvent('toggle', { item: this.data.item })
        return
      }
      this.triggerEvent('play', { item: this.data.item })
    },

    onPreview(e) {
      if (this.data.selectMode) {
        this.triggerEvent('toggle', { item: this.data.item })
        return
      }
      // 折角堆叠里点哪张就从哪张看起
      const idx = Number(e && e.currentTarget && e.currentTarget.dataset.index) || 0
      this.triggerEvent('preview', { item: this.data.item, index: idx })
    }
  }
})
