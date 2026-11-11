const date = require('../../utils/date')

/**
 * 多图错落堆叠的版式
 * 单位统一 rpx：卡片内容区宽约 624rpx，照片框 350×270rpx，
 * 容器高度在 wxss 里写死 450rpx —— 图片加载与否都不改变盒子尺寸，所以不会跳动。
 * 所有尺寸走 rpx，屏幕变宽/换设备时整组等比缩放，桌面端和手机端表现一致。
 */
const FRAME_W = 330
const FRAME_H = 254
const MAX_FRAMES = 4

/** 基础错落位（x 偏移 / y 偏移 / 旋转角度 / 层级） */
const LAYOUTS = {
  2: [
    { x: 16, y: 26, r: -6, z: 1 },
    { x: 250, y: 140, r: 4.5, z: 2 }
  ],
  3: [
    { x: 12, y: 46, r: -7.5, z: 1 },
    { x: 268, y: 4, r: 4, z: 2 },
    { x: 112, y: 186, r: -2, z: 3 }
  ],
  4: [
    { x: 2, y: 20, r: -9, z: 1 },
    { x: 268, y: 0, r: 6, z: 2 },
    { x: 36, y: 188, r: 5, z: 3 },
    { x: 250, y: 160, r: -4, z: 4 }
  ]
}

/** 字符串散列：同一张卡片每次渲染拿到同一组抖动值，换设备也不变 */
function hash(str) {
  let h = 2166136261
  const s = String(str || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

function buildStack(item, paths) {
  const list = paths.slice(0, MAX_FRAMES)
  const base = LAYOUTS[list.length] || LAYOUTS[4]
  const seed = hash(item.id || item.createdAt || '')
  let bottom = 0
  const frames = list.map((src, i) => {
    const p = base[i]
    // 每张照片再用 id 散列做 ±5rpx、±1.2° 的轻微抖动：同一卡片稳定，不同卡片不雷同
    const jx = ((seed >>> (i * 3)) % 11) - 5
    const jy = ((seed >>> (i * 5 + 2)) % 13) - 6
    const jr = (((seed >>> (i * 4 + 1)) % 25) - 12) / 10
    const rot = p.r + jr
    // 旋转会让包围盒高出一点，按角度补余量，避免压到下面的正文
    const over = Math.abs(Math.sin((rot * Math.PI) / 180)) * FRAME_W * 0.5
    bottom = Math.max(bottom, p.y + jy + FRAME_H + over)
    return {
      src,
      idx: i,
      style:
        'left:' + (p.x + jx) + 'rpx;' +
        'top:' + (p.y + jy) + 'rpx;' +
        'width:' + FRAME_W + 'rpx;' +
        'height:' + FRAME_H + 'rpx;' +
        'z-index:' + p.z + ';' +
        'transform:rotate(' + rot.toFixed(1) + 'deg);'
    }
  })
  // 容器高度按实际最底边收口：2/3/4 张的下方留白一样多，卡片节奏才整齐
  return { frames, height: Math.ceil(bottom + 8) }
}

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
    photoList: [],
    stackH: 0,
    tagList: [],
    moreTags: 0
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
