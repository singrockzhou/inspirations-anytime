const date = require('../../utils/date')

/** 类型角标文案，长度和内容都在这里算好，WXML 里只做渲染 */
function badgeOf(item) {
  if (!item) return ''
  if (item.type === 'voice') return '语音 ' + (item.duration || 0) + '″'
  if (item.type === 'photo') {
    const n = (item.mediaPaths || []).length || (item.mediaPath ? 1 : 0)
    return n > 1 ? '照片 ' + n + ' 张' : '照片'
  }
  return '文字'
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
    tagList: [],
    moreTags: 0
  },

  observers: {
    item(item) {
      if (!item) return
      const content = item.content || ''
      const tags = item.tags || []
      this.setData({
        badge: badgeOf(item),
        timeLabel: date.relative(item.createdAt),
        // 超过 6 行（约 110 字）才折叠，短句不出现"展开"，避免满屏小按钮
        needFold: item.type === 'text' && content.length > 110,
        edited: !!(item.updatedAt && item.updatedAt - item.createdAt > 60000),
        photoCount: (item.mediaPaths || []).length || (item.mediaPath ? 1 : 0),
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

    onPreview() {
      if (this.data.selectMode) {
        this.triggerEvent('toggle', { item: this.data.item })
        return
      }
      this.triggerEvent('preview', { item: this.data.item })
    }
  }
})
