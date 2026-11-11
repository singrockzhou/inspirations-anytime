/**
 * 左滑露出删除按钮的容器
 *
 * 为什么不用 catchtouchmove：那会连带把页面的纵向滚动一起吃掉。
 * 这里只在判定为横向手势后接管位移，竖向滑动仍然交给页面。
 * 同一时刻只允许一条打开 —— 由页面通过 open 属性统一调度。
 */
const BTN_PX = 88

Component({
  properties: {
    /** 记录 id，随事件回传给页面 */
    itemId: {
      type: String,
      value: ''
    },
    /** 由页面根据 openId 下发，保证同时只有一条处于打开状态 */
    open: {
      type: Boolean,
      value: false,
      observer(next) {
        if (this._dragging) return
        this.slideTo(next ? -BTN_PX : 0, true)
      }
    }
  },

  data: {
    x: 0,
    animating: false
  },

  methods: {
    slideTo(x, animate) {
      this.setData({ x: x, animating: !!animate })
      if (animate) {
        clearTimeout(this._animTimer)
        this._animTimer = setTimeout(() => this.setData({ animating: false }), 220)
      }
    },

    onStart(e) {
      const t = e.touches && e.touches[0]
      if (!t) return
      this._startX = t.clientX
      this._startY = t.clientY
      this._startAt = Date.now()
      this._baseX = this.data.x
      this._axis = '' // '' 未定 | 'x' 横向 | 'y' 纵向
      this._moved = 0
      this.setData({ animating: false })
    },

    onMove(e) {
      const t = e.touches && e.touches[0]
      if (!t || this._startX == null) return

      const dx = t.clientX - this._startX
      const dy = t.clientY - this._startY

      // 前 6px 不判定方向，避免手指轻微抖动就锁死成横向
      if (!this._axis) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
        this._axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      }
      if (this._axis !== 'x') return

      this._dragging = true
      this._moved = Math.abs(dx)

      let next = this._baseX + dx
      if (next > 0) next = 0
      // 超过删除按钮宽度后加阻尼，滑到头有"拽不动"的手感
      if (next < -BTN_PX) next = -BTN_PX + (next + BTN_PX) * 0.25
      this.setData({ x: next })
    },

    onEnd() {
      const axis = this._axis
      const moved = this._moved
      this._dragging = false
      this._startX = null
      this._axis = ''

      if (axis !== 'x') return

      const x = this.data.x
      const opened = x < -BTN_PX * 0.45
      this.slideTo(opened ? -BTN_PX : 0, true)

      // 短促轻扫也算一次有效手势，避免"划一半弹回去"的挫败感
      if (opened && moved < 24) {
        this.triggerEvent('open', { id: this.data.itemId })
        return
      }
      this.triggerEvent(opened ? 'open' : 'close', { id: this.data.itemId })
    },

    onDelete() {
      this.triggerEvent('delete', { id: this.data.itemId })
    }
  }
})
