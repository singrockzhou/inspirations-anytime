const hub = require('../../utils/dialog')

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
    cancelText: '算了',
    confirmText: '好',
    showCancel: true,
    danger: false,
    maskClosable: false,
    confirmLoading: false,
    confirmDisabled: false,
    // 输入型（预留：重命名、填模板 ID 这类一句话输入）
    editable: false,
    inputValue: '',
    placeholder: '',
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
        cancelText: o.cancelText || '算了',
        confirmText: o.confirmText || '好',
        showCancel: o.showCancel !== false,
        danger: !!o.danger,
        maskClosable: !!o.maskClosable,
        confirmLoading: false,
        confirmDisabled: !!o.confirmDisabled,
        editable: !!o.editable,
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
