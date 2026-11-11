Component({
  properties: {
    visible: {
      type: Boolean,
      value: false
    },
    title: {
      type: String,
      value: ''
    },
    /** [{ key, label, desc, danger }] */
    items: {
      type: Array,
      value: []
    },
    cancelText: {
      type: String,
      value: '取消'
    }
  },

  methods: {
    onSelect(e) {
      this.triggerEvent('select', { key: e.currentTarget.dataset.key })
    },
    onClose() {
      this.triggerEvent('close')
    },
    /** 吃掉蒙层上的滑动，避免透传到下面的列表 */
    noop() {}
  }
})
