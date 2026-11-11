const store = require('./utils/store')

App({
  globalData: {
    // 保存成功后由记录页写入，首页读一次即清空，用于新卡片的一次性高亮
    flashId: '',
    // 「我的 → 归档」这类跨页跳筛选，用一个一次性信使，不走 url 参数
    pendingFilter: ''
  },

  onLaunch() {
    // 启动时清掉超过撤销窗口的软删记录，避免本地存储越积越大
    store.purge()
  },

  onHide() {
    // 切后台时也做一次清理，成本很低（一次同步读取）
    store.purge()
  }
})
