const store = require('../../utils/store')
const poster = require('../../utils/poster')
const dialog = require('../../utils/dialog')

Page({
  data: {
    ready: false,
    error: '',
    imgPath: '',
    cssW: 750,
    cssH: 520,
    toastText: ''
  },

  onLoad(query) {
    this.id = (query && query.id) || ''
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
      this.setData({ error: '这条已经不在了' })
      return
    }

    wx.createSelectorQuery()
      .in(this)
      .select('#poster')
      .fields({ node: true, size: true })
      .exec(res => {
        const node = res && res[0] && res[0].node
        if (!node) {
          this.setData({ error: '当前环境不支持画布' })
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

          poster.paint(ctx, rec, layout, { image: image, footer: '灵感随时记' })

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
        this.setData({ error: '生成失败了，再试一次' })
      }
    })
  },

  onSave() {
    const path = this.data.imgPath
    if (!path) return
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () => this.toast('存到相册了'),
      fail: err => {
        const msg = String((err && err.errMsg) || '')
        if (msg.indexOf('cancel') >= 0) return
        if (msg.indexOf('auth') >= 0 || msg.indexOf('deny') >= 0) {
          dialog
            .confirm({
              title: '需要相册权限',
              text: '保存图片要写入相册，去设置里打开一下？',
              confirmText: '去设置'
            })
            .then(r => {
              if (r.confirmed) wx.openSetting({})
            })
          return
        }
        this.toast('没存上，试试「发给朋友」')
      }
    })
  },

  onShareImage() {
    const path = this.data.imgPath
    if (!path) return
    if (typeof wx.showShareImageMenu !== 'function') {
      this.toast('当前微信版本不支持直接分享图片')
      return
    }
    wx.showShareImageMenu({
      path: path,
      fail: err => {
        const msg = String((err && err.errMsg) || '')
        if (msg.indexOf('cancel') >= 0) return
        this.toast('没发出去，再试一次')
      }
    })
  },

  onCopy() {
    const rec = this.record
    const text = (rec && rec.content) || ''
    if (!text) {
      this.toast('这条没有文字可复制')
      return
    }
    wx.setClipboardData({ data: text, success: () => this.toast('复制了') })
  },

  toast(message) {
    clearTimeout(this.toastTimer)
    this.setData({ toastText: message })
    this.toastTimer = setTimeout(() => this.setData({ toastText: '' }), 1600)
  }
})
