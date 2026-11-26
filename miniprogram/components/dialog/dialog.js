const hub = require('../../utils/dialog')
const i18n = require('../../utils/i18n')

/**
 * 统一对话框
 * 视觉完全走 app.wxss 的 token（纸白 / 陶土橙 / 墨色 / 米线），
 * 不用系统 wx.showModal，避免深色遮罩 + 系统字体在暖白界面里突兀。
 *
 * 五态：默认 / 按下（hover-class）/ 聚焦（输入框）/ 禁用 / 加载。
 * 异步确认：opts.onConfirm 返回 Promise 时自动进 loading，resolve(false) 不关闭。
 */
Component({
  lifetimes: {
    attached() {
      hub.bind(this)
      this.setData({ processingText: i18n.t('common:processing') })
    },
    detached() {
      hub.unbind(this)
    }
  },

  data: {
    visible: false,
    closing: false,
    title: '',
    text: '',
    /**
     * 留空而不是写死「算了 / 好」。
     * 这两个值在 open() 里一定会被 i18n.t() 覆盖，写死的中文永远显示不出来，
     * 但它是一个模块级中文常量——哪天有人不经过 open() 直接改 data，
     * 或者加一处 showCancel 的旁路，英文界面就会冒出中文按钮。
     */
    cancelText: '',
    confirmText: '',
    showCancel: true,
    danger: false,
    maskClosable: false,
    confirmLoading: false,
    confirmDisabled: false,
    // 输入型（重命名、填模板 ID 这类一句话输入）
    editable: false,
    /**
     * 多行：粘贴长文时用。
     * 为什么不用 wx.showModal({editable:true})：那个参数 2.17.1 才有，
     * 而且「某个机型上到底支持不支持」得靠 wx.canIUse 判断——判断串写错一次，
     * 整条兜底路径就静默死掉（v1.8.5 就是这么翻车的）。自绘 textarea 没有这个问题。
     */
    multiline: false,
    inputValue: '',
    placeholder: '',
    processingText: '',
    maxlength: 200,
    inputFocused: false
  },

  methods: {
    /** 由 utils/dialog 调用 */
    open(opts) {
      const o = opts || {}
      this._opts = o
      this._done = false
      this.setData({
        visible: true,
        closing: false,
        title: o.title || '',
        text: o.text || '',
        cancelText: o.cancelText || i18n.t('common:cancel'),
        confirmText: o.confirmText || i18n.t('common:ok'),
        showCancel: o.showCancel !== false,
        danger: !!o.danger,
        maskClosable: !!o.maskClosable,
        confirmLoading: false,
        confirmDisabled: !!o.confirmDisabled,
        editable: !!o.editable,
        multiline: !!o.multiline,
        inputValue: o.inputValue || '',
        placeholder: o.placeholder || '',
        maxlength: o.maxlength || 200,
        inputFocused: false
      })
    },

    noop() {},

    onMask() {
      // 加载中不允许点遮罩关掉，避免"点了一下什么都没发生"的错觉
      if (!this.data.maskClosable || this.data.confirmLoading) return
      this.finish(false)
    },

    onCancel() {
      if (this.data.confirmLoading) return
      this.finish(false)
    },

    onConfirm() {
      if (this.data.confirmLoading || this.data.confirmDisabled) return

      const hook = this._opts && this._opts.onConfirm
      if (!hook) return this.finish(true)

      let ret
      try {
        ret = hook(this.data.inputValue)
      } catch (e) {
        ret = false
      }

      if (ret && typeof ret.then === 'function') {
        this.setData({ confirmLoading: true })
        ret
          .then(ok => {
            if (!this.data.visible) return
            this.setData({ confirmLoading: false })
            // resolve(false) 表示"还没做完/校验没过"，留在原地
            if (ok !== false) this.finish(true)
          })
          .catch(() => {
            if (this.data.visible) this.setData({ confirmLoading: false })
          })
        return
      }

      if (ret === false) return
      this.finish(true)
    },

    onInput(e) {
      this.setData({ inputValue: e.detail.value })
    },

    onInputFocus() {
      this.setData({ inputFocused: true })
    },

    onInputBlur() {
      this.setData({ inputFocused: false })
    },

    /** 关闭：先播 160ms 退场，再真正隐藏，最后只回调一次 */
    finish(confirmed) {
      if (this._done) return
      this._done = true
      const payload = { confirmed: confirmed, value: this.data.inputValue }
      this.setData({ closing: true })
      setTimeout(() => {
        this.setData({ visible: false, closing: false, confirmLoading: false })
        const cb = this._opts && this._opts.onDone
        this._opts = null
        if (cb) cb(payload)
      }, 160)
    }
  }
})
