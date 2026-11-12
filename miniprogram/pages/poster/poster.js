const store = require('../../utils/store')
const poster = require('../../utils/poster')
const dialog = require('../../utils/dialog')
const i18n = require('../../utils/i18n')

Page({
  data: {
    ready: false,
    error: '',
    imgPath: '',
    cssW: 750,
    cssH: 520,
    toastText: '',
    t: {}
  },

  onLoad(query) {
    this.id = (query && query.id) || ''
    this.setData({ t: i18n.pack('poster') })
    i18n.title('nav:poster')
  },

  onReady() {
    this.build()
  },

  /**
   * 三步：拿 canvas 节点 → 量高 → 按真实高度重建上下文再画。
   * 顺序不能反：canvas 2d 每次改 width/height 都会把上下文状态清掉。
   */
  build() {
    const rec = store.get(this.id)
    if (!rec) {
      this.setData({ error: i18n.t('poster:err_gone') })
      return
    }

    wx.createSelectorQuery()
      .in(this)
      .select('#poster')
      .fields({ node: true, size: true })
      .exec(res => {
        const node = res && res[0] && res[0].node
        if (!node) {
          this.setData({ error: i18n.t('poster:err_canvas') })
          return
        }

        const canvas = node
        // 导出时必须把这个节点回传给 canvasToTempFilePath，否则 2d 画布取不到
        this.canvasNode = canvas
        const ctx = canvas.getContext('2d')
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        const dpr = Math.min((info && info.pixelRatio) || 2, 3)

        const src = rec.type === 'photo' ? (rec.mediaPaths || [])[0] || '' : ''
        poster.loadImage(canvas, src).then(image => {
          // 先给一个够大的临时画布，量出真实高度
          canvas.width = poster.WIDTH * dpr
          canvas.height = 1600 * dpr
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.scale(dpr, dpr)

          const layout = poster.measure(ctx, rec, { image: image })
          const H = layout.height

          canvas.width = poster.WIDTH * dpr
          canvas.height = H * dpr
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.scale(dpr, dpr)

          poster.paint(ctx, rec, layout, { image: image, footer: i18n.t('poster:slogan') })

          this.record = rec
          this.layout = layout
          this.dpr = dpr

          // 部分机型绘制是异步落盘的，给一帧再导出
          setTimeout(() => this.export(H), 80)
        })
      })
  },

  export(H) {
    const dpr = this.dpr
    wx.canvasToTempFilePath({
      canvas: this.canvasNode || undefined,
      x: 0,
      y: 0,
      width: poster.WIDTH,
      height: H,
      destWidth: poster.WIDTH * dpr,
      destHeight: H * dpr,
      fileType: 'jpg',
      quality: 0.92,
      success: res => {
        this.setData({ ready: true, imgPath: res.tempFilePath, cssH: H })
      },
      fail: err => {
        console.warn('[poster] 导出失败', err)
        this.setData({ error: i18n.t('poster:err_fail') })
      }
    })
  },

  onSave() {
    const path = this.data.imgPath
    if (!path) return
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () => this.toast(i18n.t('poster:toast_saved')),
      fail: err => {
        const msg = String((err && err.errMsg) || '')
        if (msg.indexOf('cancel') >= 0) return
        if (msg.indexOf('auth') >= 0 || msg.indexOf('deny') >= 0) {
          dialog
            .confirm({
              title: i18n.t('poster:perm_title'),
              text: i18n.t('poster:perm_text'),
              confirmText: i18n.t('poster:perm_go')
            })
            .then(r => {
              if (r.confirmed) wx.openSetting({})
            })
          return
        }
        this.toast(i18n.t('poster:toast_save_fail'))
      }
    })
  },

  onShareImage() {
    const path = this.data.imgPath
    if (!path) return
    if (typeof wx.showShareImageMenu !== 'function') {
      this.toast(i18n.t('poster:toast_share_unsupported'))
      return
    }
    wx.showShareImageMenu({
      path: path,
      fail: err => {
        const msg = String((err && err.errMsg) || '')
        if (msg.indexOf('cancel') >= 0) return
        this.toast(i18n.t('poster:toast_share_fail'))
      }
    })
  },

  onCopy() {
    const rec = this.record
    const text = (rec && rec.content) || ''
    if (!text) {
      this.toast(i18n.t('poster:toast_no_text'))
      return
    }
    wx.setClipboardData({ data: text, success: () => this.toast(i18n.t('common:copy_ok')) })
  },

  toast(message) {
    clearTimeout(this.toastTimer)
    this.setData({ toastText: message })
    this.toastTimer = setTimeout(() => this.setData({ toastText: '' }), 1600)
  }
})
