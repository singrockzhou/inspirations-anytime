/**
 * 照片缩略图网格
 *
 * 排布规则（只按张数决定列数，不做断点）：
 *   1 张  → 整幅单图（crop：按 3:2 裁切；auto：按原比例撑高，长截图不被切）
 *   2 张  → 两列一行
 *   3 张  → 三列一行
 *   4 张  → 2×2（比"三列 + 落单一张"更整）
 *   5+ 张 → 三列九宫格，最多 9 格，第 9 格折成 +N
 *
 * 为什么不会抖：格子用 padding-top 百分比撑高（正方形），图片绝对定位铺满，
 * 无论图片多大、解码快慢，盒子在加载前就已经是最终尺寸。
 * 为什么两端都适配：宽度是百分比、高度是宽度的百分比，屏多宽格子就多宽，
 * 不写断点、不用 vw，PC 大窗口和手机窄屏是同一套规则。
 */
const i18n = require('../../utils/i18n')

const MAX_TILES = 9

function colsOf(n) {
  if (n <= 1) return 1
  if (n === 2 || n === 4) return 2
  return 3
}

Component({
  properties: {
    paths: {
      type: Array,
      value: [],
      observer(list) {
        this.build(list)
      }
    },
    /** 单张时的呈现：crop 裁切铺满 / auto 原比例 */
    single: {
      type: String,
      value: 'crop'
    }
  },

  data: {
    cols: 1,
    list: [],
    more: 0,
    txt: {}
  },

  lifetimes: {
    attached() {
      this.setData({
        txt: {
          missing: i18n.t('media:photo_missing'),
          lost: i18n.t('media:photo_lost')
        }
      })
      this.build(this.data.paths)
    }
  },

  methods: {
    build(raw) {
      const all = (raw || []).filter(Boolean)
      const list = all.slice(0, MAX_TILES).map((src, i) => ({ i: i, src: src, broken: false }))
      this.setData({
        cols: colsOf(all.length),
        list: list,
        more: all.length > MAX_TILES ? all.length - MAX_TILES : 0
      })
    },

    /** 点哪张从哪张开始全屏预览；多选勾选之类的业务拦截由父级自己接 _tap */
    onTap(e) {
      const urls = (this.data.paths || []).filter(Boolean)
      if (!urls.length) return
      const i = Number((e.currentTarget && e.currentTarget.dataset.i) || 0)
      this.triggerEvent('pick', { index: i, item: urls[i] })
      wx.previewImage({ current: urls[i] || urls[0], urls: urls })
    },

    /** 文件被系统清掉时不留白洞，换成一块"照片不在了"的占位 */
    onError(e) {
      const i = Number(e.currentTarget.dataset.i)
      this.setData({ ['list[' + i + '].broken']: true })
    }
  }
})
