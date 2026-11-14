/**
 * 中英文双语（唯一出口）
 *
 * 三条规矩：
 *
 * 1) 语言只在一处决定：先看用户手动选过没有（lg.lang.v1），没选过就看系统语言。
 *    一旦手动选过，就不再跟随系统——用户的选择必须比系统设置更有权威。
 *
 * 2) 系统语言不是中文/英文时回退中文。理由不是"作者是中国人"，而是这个小程序
 *    里的内容基本都是中文记录：一个说日语的人看到的记录也是中文，界面回退到
 *    内容语言，比回退到一屏他更看不懂的第三种语言更有用。
 *
 * 3) 取词必须发生在"渲染那一刻"，不能写成模块级常量。
 *    切换语言用的是 wx.reLaunch：页面会重建，但**js 模块不会重新执行**，
 *    模块级常量（比如 COLLECT_ERR 这种表）会一直停在旧语言上。
 *    所以凡是文案表，都写成函数或在 onLoad/onShow 里现取。
 *
 * 命名空间用 `page:key`，页面通过 pack('page') 只取自己那一份，
 * 避免把几百个键全塞进 setData。
 */
const KEY_LANG = 'lg.lang.v1'
const ZH = 'zh'
const EN = 'en'
/** 系统语言不支持时的回退语言 */
const FALLBACK = ZH

let cached = null

/* ------------------------------ 系统语言 ------------------------------ */

/** 把 zh_CN / zh-TW / en_US / en 之类统一成 zh / en，其余一律回退 */
function normalize(raw) {
  const s = String(raw || '').toLowerCase().replace(/-/g, '_')
  if (s.indexOf('zh') === 0) return ZH
  if (s.indexOf('en') === 0) return EN
  return FALLBACK
}

/**
 * 读系统语言。getAppBaseInfo 是新接口（基础库 2.20.1+），
 * 老基础库上它是 undefined，退回 getSystemInfoSync。
 * Node 环境下没有 wx，直接回退——测试与构建脚本里也能安全 require。
 */
function systemLang() {
  if (typeof wx === 'undefined') return FALLBACK
  let raw = ''
  try {
    if (typeof wx.getAppBaseInfo === 'function') {
      const info = wx.getAppBaseInfo()
      raw = info && info.language
    }
  } catch (e) {
    raw = ''
  }
  if (!raw) {
    try {
      raw = wx.getSystemInfoSync().language || ''
    } catch (e) {
      raw = ''
    }
  }
  return normalize(raw)
}

/* ------------------------------ 语言读写 ------------------------------ */

function readSaved() {
  if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') return ''
  try {
    return wx.getStorageSync(KEY_LANG) || ''
  } catch (e) {
    return ''
  }
}

/** 当前语言：用户选过的优先，否则跟系统 */
function lang() {
  if (cached) return cached
  const saved = readSaved()
  cached = saved ? normalize(saved) : systemLang()
  return cached
}

/** 手动切换。写盘失败也让本次会话生效，不因为配额问题卡住界面 */
function setLang(next) {
  const l = normalize(next)
  cached = l
  if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') {
    try {
      wx.setStorageSync(KEY_LANG, l)
    } catch (e) {
      // 写不进去就只在本次会话生效，下次启动仍跟系统
    }
  }
  return l
}

function isEn() {
  return lang() === EN
}

/** 测试用：清掉内存里的语言缓存 */
function reset() {
  cached = null
}

/* ------------------------------- 取词 ------------------------------- */

/**
 * t('me:hero_unit') → 当前语言的文案
 * t('nudge:text_gap', { n: 3 }) → 占位符 {n} 被替换
 * 英文缺键时回退中文，中文也缺就原样返回键名（便于在设计检查里一眼发现）
 */
function t(key, params) {
  const l = lang()
  const table = l === EN ? EN_DICT : ZH_DICT
  let s = table[key]
  if (s === undefined) s = ZH_DICT[key]
  if (s === undefined) return key
  if (!params) return s
  return s.replace(/\{(\w+)\}/g, function (m, k) {
    return params[k] === undefined ? m : params[k]
  })
}

/**
 * 给 wxml 用：pack('me') 返回 { hero_unit: '条灵感', ... }
 * 以中文字典的键为全集，保证两种语言渲染出的字段集合完全一致（不会因为
 * 某个键只在英文里存在而让 wxml 拿到 undefined）。
 */
function pack(prefix) {
  const l = lang()
  const table = l === EN ? EN_DICT : ZH_DICT
  const p = prefix ? prefix + ':' : ''
  const out = {}
  Object.keys(ZH_DICT).forEach(function (k) {
    if (p && k.indexOf(p) !== 0) return
    const name = p ? k.slice(p.length) : k
    out[name] = table[k] === undefined ? ZH_DICT[k] : table[k]
  })
  return out
}

/**
 * 错误码表：把 { code: '文案' } 变成"读的时候才去取词"的表。
 *
 * 为什么不能写成普通对象：页面模块只会执行一次，语言切换走的是 reLaunch，
 * 模块不会重新执行，模块级常量会一直停在旧语言上。getter 每次读都现取，
 * 调用方写法和以前完全一样（ERR[code]），不需要改任何一处。
 *
 * @param {string} prefix 命名空间，如 'index'
 * @param {string[]} keys 短码，如 ['nofile', 'read']
 * @param {string} [kind] 短码前面的那一节：'err' → index:err_nofile，
 *                        'skip' → index:skip_type；不给就是 prefix:code
 */
function table(prefix, keys, kind) {
  const head = prefix + ':' + (kind ? kind + '_' : '')
  const out = {}
  keys.forEach(function (k) {
    Object.defineProperty(out, k, {
      enumerable: true,
      get: function () {
        return t(head + k)
      }
    })
  })
  return out
}

/**
 * 改导航栏标题。
 *
 * 标题写在 pages/xx/xx.json 里，只能是死的一种语言，所以进页面时按当前语言覆盖一次。
 * 包一层的原因有两个：测试里的假 wx 没有这个方法（不该为了一句标题让测试崩），
 * 以及"没有 wx 也能 require"这条约束要一直成立。
 */
function title(key, params) {
  if (typeof wx === 'undefined' || !wx || typeof wx.setNavigationBarTitle !== 'function') return
  wx.setNavigationBarTitle({ title: t(key, params) })
}

/* ------------------------------ 中文字典 ------------------------------ */
const ZH_DICT = {
  /* —— 通用 —— */
  'common:cancel': '算了',
  'common:cancel_plain': '取消',
  'common:edited': '改过',
  'common:ok': '好',
  'common:got_it': '知道了',
  'common:delete': '删了',
  'common:copy': '复制',
  'common:retry': '再试一次看看。',
  'common:packing': '打包中',
  'common:processing': '处理中',
  'common:reading': '正在读',
  'common:copy_ok': '复制了',
  'common:contact_copied': '联系方式已复制',
  'common:type_text': '文字',
  'common:type_voice': '语音',
  'common:type_photo': '照片',
  'common:unit_item': '条',
  'common:unit_day': '天',
  'common:not_found_voice': '这段录音找不到了',

  /* —— 导航栏标题（json 里只能是静态中文，进页面时按当前语言覆盖） —— */
  'nav:detail': '这一条',
  'nav:record': '记一条',
  'nav:review': '重温',
  'nav:search': '找一找',
  'nav:poster': '做成图',
  'nav:me': '我的',

  /* —— 日期 —— */
  'date:week0': '周日',
  'date:week1': '周一',
  'date:week2': '周二',
  'date:week3': '周三',
  'date:week4': '周四',
  'date:week5': '周五',
  'date:week6': '周六',
  'date:just_now': '刚刚',
  'date:min_ago': '{n} 分钟前',
  'date:today_at': '今天 {t}',
  'date:yesterday_at': '昨天 {t}',
  'date:month_day': '{m}月{d}日',
  'date:year_month_day': '{y}年{m}月{d}日',
  'date:full': '{y}年{m}月{d}日 {t}',
  'date:today': '今天',
  'date:yesterday': '昨天',
  'date:before_yesterday': '前天',
  'date:this_week': '本周',
  'date:this_month': '本月',
  'date:this_year': '今年',
  'date:year': '{y}年',
  'date:anni_last': '去年的今天',
  'date:anni_n': '{n} 年前的今天',

  /* —— 打开即提醒 —— */
  'nudge:label': '今天还没记一句',
  'nudge:tip': '记一句 ›',
  'nudge:keep': '连续 {n} 天了，今天补一句就不断',
  'nudge:yesterday': '昨天那句还热着，今天也留一句',
  'nudge:gap_short': '隔了 {n} 天，随手一句就能接上',
  'nudge:gap_long': '隔了 {n} 天，现在想点什么？',

  /* —— 备份提醒 —— */
  'backup:only_local': '只在这台手机上',
  'backup:first': '已记 {n} 条 · {s}',
  'backup:first_tip': '备份一份 ›',
  'backup:again': '上次备份是 {n} 天前',
  'backup:again_tip': '再备一份 ›',

  /* —— 我的 —— */
  'me:hero_unit': '条灵感',
  'me:unit_item': '条',
  'me:unit_media': '个文件',
  'me:streak_unit': '天连续',
  'me:heat_title': '最近 14 周',
  'me:heat_sub': '最多一天 {n} 条',
  'me:heat_less': '少',
  'me:heat_more': '多',
  'me:row_first': '开始记录',
  'me:row_last': '最近一条',
  'me:row_types': '文字 / 语音 / 照片',
  'me:row_flags': '加星 / 归档 / 带标签',
  'me:sec_organize': '整理',
  'me:row_archive': '归档',
  'me:row_archive_sub': '收起来但仍然留着的内容',
  'me:sec_move': '换手机',
  'me:row_backup': '上次备份',
  'me:row_backup_sub': '删小程序、换手机都会没',
  'me:row_export': '导出到文件',
  'me:row_export_sub': '文字、图片、录音一起打包',
  'me:row_import': '从文件导入',
  'me:row_import_sub': '从聊天里选 .json 备份',
  'me:row_about': '关于小程序',
  'me:row_about_sub': '作者与联系方式',
  'me:row_index': '记录索引',
  'me:row_index_sub': '文字与设置，已用 {n}%',
  'me:row_media': '图片与录音',
  'me:row_media_sub': '本机文件，单独计配额',
  'me:sec_lang': '语言',
  'me:row_lang': '语言 / Language',
  'me:row_lang_sub': '切换后立即生效',
  'me:note':
    '记录只存在这台手机上，不上传、不联网。删掉小程序、清理微信存储或换手机，本机记录会一起被清掉，且无法找回。\n所以换手机前先用「导出到文件」带走，到新手机上导入即可。\n导入只做新增，同一条记录不会重复，也不会覆盖新手机上刚记的内容。',
  'me:clear': '清空全部记录',
  'me:not_started': '还没有开始',
  'me:never_backed': '还没备份过',
  'me:today': '今天',
  'me:days_ago': '{n} 天前',
  'me:backup_meta': '{t} · {n} 条',
  'me:warn_index': '记录索引快到上限了，建议先导出备份，再清掉一些旧记录。',
  'me:warn_media': '图片和录音快占满本机文件配额了，建议导出后清理。',
  'me:no_archive': '还没有归档的',
  'me:no_records': '还没有记录',
  'me:export_title': '导出完成',
  'me:export_count': '共 {n} 条',
  'me:export_media': '含 {n} 个图片/录音',
  'me:export_dropped': '{n} 个媒体超过 2MB 未打包',
  'me:export_share': '文件已生成，转发给「文件传输助手」。到新手机上从聊天里选它导入。',
  'me:export_saved': '文件已保存到电脑，拷到新手机后再导入。',
  'me:export_fail': '没导出成',
  'me:import_title': '导入完成',
  'me:import_ask_title': '从备份导入？',
  'me:import_ask_text': '会从聊天记录里选一个 .json 备份。导入只做新增，不会覆盖本机已有的记录。',
  'me:import_ask_cancel': '算了',
  'me:import_ask_ok': '去选文件',
  'me:import_added': '导入 {n} 条',
  'me:import_none': '没有新增记录',
  'me:import_skipped': '{n} 条已存在或超出上限，已跳过',
  'me:import_media': '还原 {n} 个图片/录音',
  'me:import_media_fail': '{n} 个媒体还原失败',
  'me:import_fail': '没导入成',
  'me:clear_ask_title': '清空全部灵感？',
  'me:clear_ask_text': '共 {n} 条，清掉之后找不回来。',
  'me:clear_ask_cancel': '算了',
  'me:clear_ask_ok': '清空',
  'me:clear_empty': '已经是空的了',
  'me:clear_done': '清干净了',
  'me:about_title': '关于小程序',
  'me:about_cancel': '知道了',
  'me:about_confirm': '复制联系方式',
  'me:about_version': '灵感随时记 v{v}',
  'me:about_privacy': '所有记录只保存在这台手机上，不上传、不联网、不需要登录。换手机时用上面的「导出到文件」带走。',
  'me:about_author': '作者：{v}',
  'me:about_wechat': '公众号：{v}',
  'me:about_email': '邮箱：{v}',
  'me:storage_title': '本机占用怎么看',
  'me:storage_index': '记录索引：{used}，上限 {limit}。',
  'me:storage_index_sub': '存的是文字、标签和设置，不含照片、录音。',
  'me:storage_media': '图片与录音：{size}，{n} 个文件。',
  'me:storage_media_sub': '它们作为文件放在本机，不占上面这份额度。',
  'me:storage_full': '索引满了只会写不进新记录，已有的不会自动丢。稳妥做法是先「导出到文件」备份，再清掉不要的。',
  'me:err_nofile': '没选到文件。',
  'me:err_choose': '没能打开选择器，再试一次。',
  'me:err_read': '文件读不出来，可能已经损坏。',
  'me:err_parse': '这个文件不是有效的 JSON。',
  'me:err_format': '这不是「灵感随时记」导出的备份文件。',
  'me:err_unsupported': '当前环境不支持导入，请用手机微信打开。',

  /* —— 首页 · 界面 —— */
  'index:title': '我的灵感',
  'index:count': '{n} 条',
  'index:collect': '从聊天存',
  'index:cancel': '取消',
  'index:select': '多选',
  'index:mine': '我的',
  'index:composer': '今天想到什么？',
  'index:chip_all': '全部',
  'index:chip_star': '星标',
  'index:chip_archive': '归档',
  'index:anni_open': '点开看看 ›',
  'index:review_label': '随便翻一条',
  'index:review_tip': '从 {n} 条里抽 ›',
  'index:review_text': '半年前那句，可能正是现在想要的',
  'index:grp_today': '今天',
  'index:grp_count': '{n} 条',
  'index:collapse': '收起',
  'index:expand': '展开',
  'index:group_delete': '删整组',
  'index:more_in_group': '还有 {n} 条',
  'index:more_hint': '继续往下滑',
  'index:end_hint': '到底了 · 左滑删一条，长按还能改',
  'index:empty_btn_first': '记下第一条',
  'index:empty_btn_all': '看全部灵感',
  'index:empty_link': '或从聊天里存一条 →',
  'index:sel_count': '已选 {n} 条',
  'index:sel_copy': '复制',
  'index:sel_export': '导出',
  'index:sel_delete': '删了',
  'index:entry_text': '写一句',
  'index:entry_voice': '说一段',
  'index:entry_photo': '拍一张',
  'index:undo_text': '{label} · {n} 秒内可以撤回',
  'index:undo_btn': '撤回',

  /* —— 首页 · 逻辑 —— */
  'index:err_unsupported': '当前环境打不开聊天文件，请用手机微信再试。',
  'index:err_nofile': '没选到文件。',
  'index:err_choose': '没能打开选择器，再试一次。',
  'index:err_read': '这些文件读不出内容。截图发过来、或者长按复制文字，这两条路更稳。',
  'index:err_empty': '剪贴板里没有文字，先在聊天里长按复制一段。',
  'index:err_denied': '没有读到剪贴板的权限，去「设置」里允许后再试。',
  'index:err_full': '攒满了，先清几条再收。',
  'index:skip_type': '看不出是什么文件',
  'index:skip_read': '读不出内容',
  'index:skip_save': '没能存进来，可能是空间不够',
  'index:skip_unknown_name': '一个认不出的文件',
  'index:skip_line': '· {name}（{reason}）',
  'index:skipped_etc': ' 等 {n} 个',
  'index:skipped_unknown': '{n} 个认不出名字的文件',
  'index:sum_voice': '一段 {n} 秒的录音',
  'index:sum_photo': '{n} 张照片',
  'index:badge_text': '文字',
  'index:badge_voice': '语音 {n}″',
  'index:badge_photo': '照片 {n} 张',
  'index:badge_photo_one': '照片',
  'index:empty_default': '想到什么，就说一句',
  'index:empty_sub': '不用起标题，也不用选分类',
  'index:empty_star': '还没有加星的',
  'index:empty_star_sub': '长按一条，选「加星」就钉在这里',
  'index:empty_archive': '归档里是空的',
  'index:empty_archive_sub': '长按一条，选「归档」就收进来',
  'index:empty_tag': '#{tag} 下还没有',
  'index:empty_tag_sub': '正文里写 #{tag} 就会自动归到这个标签',
  'index:toast_backup_done': '已生成备份，转发给文件传输助手',
  'index:dialog_export_fail': '没导出成',
  'index:toast_snooze': '7 天内不再提，备份还在「我的」',
  'index:collect_title': '从聊天收一条',
  'index:collect_file': '选图片 / 文件',
  'index:collect_file_desc': '图片、txt、md、csv 都行，最多 9 个',
  'index:collect_paste': '粘贴刚复制的文字',
  'index:collect_paste_desc': '在聊天里长按复制，回来点这里',
  'index:received_title': '收到',
  'index:received_first': '已存下 {n} 条，就在最上面。',
  'index:received_compressed': '{n} 张照片压到 300KB 以内，省下 {b}。',
  'index:received_shells': '{n} 个文件只留下了名字（PDF、Word 这类打不开文字），可以自己补一句。',
  'index:received_skipped': '还有 {n} 个没存下：{list}。',
  'index:received_partial': '有 {n} 条没写进去，可能已经满 {m} 条了。',
  'index:all_failed_title': '这次没存成',
  'index:all_failed_head': '选中的 {n} 个文件都没能存下来。',
  'index:all_failed_tail': '换成截图，或者在聊天里长按复制文字，这两种更稳。',
  'index:fail_title': '没存成',
  'index:clip_trunc_title': '只收了前半段',
  'index:clip_trunc_text': '这段有 {n} 字，一条最多存 {m} 字，先收了前 {k} 字。剩下的可以再复制一段存进来。',
  'index:clip_saved': '存下了，就在最上面',
  'index:clip_empty': '剪贴板里没有文字',
  'index:clip_fail_title': '没读成',
  'index:undo_one': '删了 1 条',
  'index:group_del_title': '删掉「{name}」整组？',
  'index:group_del_text': '共 {n} 条，删了之后 5 秒内可以撤回。',
  'index:group_del_ok': '删整组',
  'index:del_fail': '没删掉，再试一次',
  'index:undo_group': '删了「{name}」{n} 条',
  'index:undo_group_plain': '删了 {n} 条',
  'index:back_count': '{n} 条回来了',
  'index:back_one': '回来了',
  'index:menu_edit': '改一改',
  'index:menu_edit_desc': '只改这句话，不重新写',
  'index:menu_copy': '复制',
  'index:menu_copy_desc': '把文字复制到剪贴板',
  'index:menu_star': '加星',
  'index:menu_unstar': '取消加星',
  'index:menu_star_desc': '钉在「星标」里，不容易被时间流冲走',
  'index:menu_unstar_desc': '从星标里拿下来',
  'index:menu_archive': '归档',
  'index:menu_unarchive': '移出归档',
  'index:menu_archive_desc': '不删除，但从主列表收起来',
  'index:menu_unarchive_desc': '回到主列表',
  'index:menu_poster': '做成图',
  'index:menu_poster_desc': '排成一张图，可以存下来或发出去',
  'index:menu_select': '多选',
  'index:menu_select_desc': '勾几条一起复制、导出或删掉',
  'index:menu_delete': '删了',
  'index:menu_delete_desc': '5 秒内可以撤回',
  'index:toast_starred': '加星了',
  'index:toast_unstarred': '从星标里拿下来了',
  'index:toast_archived': '收进归档了',
  'index:toast_unarchived': '回到主列表了',
  'index:toast_no_text': '这条没有文字可复制',
  'index:toast_first_select': '先勾几条',
  'index:toast_selected_no_text': '选中的都没有文字',
  'index:toast_copied_n': '复制了 {n} 条',
  'index:export_done_title': '导出完成',
  'index:export_done_text': '共 {n} 条，已生成 {name}。',
  'index:export_done_share': '转发给「文件传输助手」即可在电脑上打开。',
  'index:export_done_saved': '已保存到电脑。',
  'index:toast_export_unsupported': '当前环境不支持导出',
  'index:toast_export_fail': '没导出成，再试一次',
  'index:sel_del_title': '删掉选中的 {n} 条？',
  'index:sel_del_text': '删了之后 5 秒内可以撤回。',
  'index:toast_voice_missing': '这条语音找不到了',
  'index:share_title': '收到一条分享',
  'index:share_cancel': '不用',
  'index:share_ok': '存下来',
  'index:share_saved': '存进你的灵感了',

  /* —— 记录页 —— */
  'record:nav_cancel': '取消',
  'record:nav_new': '记一条',
  'record:nav_edit': '改一改',
  /* 保存入口在底部主按钮上（顶部右侧已让给胶囊）。两句话分新建与编辑：
     新建对着标题「记一条」说「存下这条」，编辑对着「改一改」说「存下改动」，
     不然在编辑态说"存下这条"会让人以为要再存一条新的。 */
  'record:save_cta': '存下这条',
  'record:save_cta_edit': '存下改动',
  'record:ph_text': '想到什么，就说一句…',
  'record:tip_tag': '正文里写 #标签，会在这个标签下自动归好',
  'record:rec_hold': '按住说话',
  'record:rec_redo': '重录',
  'record:rec_release_cancel': '松开取消',
  'record:rec_release_save': '松手就存',
  'record:rec_tap_start': '点一下开始',
  'record:rec_swipe_cancel': '上滑可以取消',
  'record:voice_playing': '正在播放 · 点一下停',
  'record:voice_recorded': '已录 {n}″ · 点这里听',
  'record:voice_mode_hold': '换成按住说话',
  'record:voice_mode_click': '换成点击录音',
  'record:ph_asr': '转写出来的字会填在这里，可以改',
  'record:ph_voice_note': '补一句文字，这条录音就能被搜到',
  'record:add_photo': '再加',
  'record:pick_photo': '拍一张，或从相册选',
  'record:counter_photos': '{n} / {m} 张 · 点图上的 × 可以去掉',
  'record:ph_photo_note': '配一句话（可不填）',
  'record:tab_text': '写一句',
  'record:tab_voice': '说一段',
  'record:tab_photo': '拍一张',
  'record:toast_gone': '这条已经不在了',
  'record:leave_confirm': '这段还没存下，确定离开吗？',
  'record:toast_unfinished': '这段还没录完',
  'record:switch_title': '换一种？',
  'record:switch_text': '刚才的{type}会清掉',
  'record:switch_ok': '换',
  'record:toast_empty_text': '还没写呢',
  'record:toast_no_photo': '还没选照片',
  'record:toast_no_voice': '还没录',
  'record:toast_release_first': '先松开手',
  'record:discard_title': '这段还留着吗？',
  'record:discard_text': '还没存下，离开就没了',
  'record:discard_cancel': '继续写',
  'record:discard_ok': '丢掉',
  'record:toast_asr_break': '转写中断了，再试一次',
  'record:toast_rec_fail': '录音没能开始，检查一下麦克风权限',
  'record:perm_mic_title': '需要麦克风',
  'record:perm_mic_text': '录一句话需要麦克风权限，去设置里打开？',
  'record:perm_go': '去设置',
  'record:mic_title': '用麦克风',
  'record:mic_text': '录下你说的那句话，只存在这台手机上。',
  'record:mic_ok': '允许',
  'record:toast_no_recorder': '当前环境不支持录音',
  'record:hint_4min': '还能录 4 分钟',
  'record:hint_1min': '还剩 1 分钟',
  'record:toast_too_short': '太短了，再说一次',
  'record:toast_text_only': '只拿到文字，已按文字记录',
  'record:toast_end_rec_first': '先结束录音',
  'record:toast_no_camera': '当前环境不支持拍照',
  'record:toast_max_photos': '最多 {n} 张',
  'record:toast_privacy': '需先在后台配置隐私保护指引',
  'record:toast_no_perm': '没拿到相机或相册权限',
  'record:toast_pick_fail': '没选上：{msg}',
  'record:toast_space_full': '本机空间满了，先删几条带图的记录',
  'record:toast_media_fail': '这个文件没存下来，再试一次',
  'record:space_warn': '照片和录音已占 {size}，快满了。建议先导出一份备份，或删掉几条旧的带图记录。',
  'record:space_full': '本机空间满了，现在只能记文字。删掉几条带图的记录就能恢复拍照和录音。',

  /* —— 详情页 —— */
  'detail:star_on': '★ 已加星',
  'detail:star_off': '☆ 加星',
  'detail:playing': '正在播放',
  'detail:tap_listen': '点一下听',
  'detail:add_text': '+ 补一句文字，这条就能被搜到',
  'detail:meta_created': '记于 {t}',
  'detail:meta_updated': '改于 {t}',
  'detail:meta_archived': '已归档，不在主列表里',
  'detail:act_edit': '改一改',
  'detail:act_copy': '复制',
  'detail:act_poster': '做成图',
  'detail:act_archive': '归档',
  'detail:act_unarchive': '取消归档',
  'detail:act_delete': '删了',
  'detail:share': '发给朋友',
  'detail:prev': '‹ 上一条',
  'detail:next': '下一条 ›',
  'detail:flip_tip': '左右滑也能翻',
  'detail:missing': '这条已经不在了',
  'detail:back': '回列表',
  'detail:del_title': '删了？',
  'detail:del_text': '删掉之后回到列表，5 秒内还能撤回。',
  'detail:del_cancel': '留着',
  'detail:del_ok': '删',
  'detail:add_title': '补一句',
  'detail:add_placeholder': '这段讲的是什么？',
  'detail:add_ok': '存下',
  'detail:add_done': '补上了，现在能搜到',
  'detail:toast_no_prev': '已经是最早的一条了',
  'detail:toast_no_next': '没有别的灵感了',

  /* —— 重温页 —— */
  'review:head': '随便翻一条',
  'review:head_multi': '左右滑能翻 · 共 {n} 条',
  'review:head_one': '就这一条',
  'review:ago_today': '今天刚记的',
  'review:ago_yesterday': '昨天记的',
  'review:ago_days': '{n} 天前记的',
  'review:no_content': '这条没有留下内容',
  'review:audio_paused': '已暂停，点一下接着听',
  'review:audio_playing': '正在播放',
  'review:audio_tap': '点一下听',
  'review:op_next': '再来一条',
  'review:op_star': '加星',
  'review:op_unstar': '取消星标',
  'review:op_open': '看详情',
  'review:share': '把这条发给朋友',
  'review:empty': '还没有可重温的',
  'review:empty_sub': '先记几条，过几天再来抽',
  'review:empty_btn': '去记一条',
  'review:toast_only_one': '就这一条，没别的了',
  'review:toast_earliest': '已经是最早的一条了',

  /* —— 搜索页 —— */
  'search:ph': '搜正文，也搜 #标签',
  'search:empty_sub': '比如「播客」，或者直接点下面一个标签',
  'search:count': '共 {n} 条',
  'search:not_found': '没找到「{kw}」',
  'search:not_found_sub': '换个词试试，或者去标签里翻',

  /* —— 海报页 —— */
  'poster:hint': '长按图片也能保存，或者用下面的按钮',
  'poster:rendering': '正在排版…',
  'poster:save': '保存到相册',
  'poster:share': '发给朋友',
  'poster:copy': '复制文字',
  'poster:err_gone': '这条已经不在了',
  'poster:err_canvas': '当前环境不支持画布',
  'poster:err_fail': '生成失败了，再试一次',
  'poster:toast_saved': '存到相册了',
  'poster:perm_title': '需要相册权限',
  'poster:perm_text': '保存图片要写入相册，去设置里打开一下？',
  'poster:perm_go': '去设置',
  'poster:toast_save_fail': '没存上，试试「发给朋友」',
  'poster:toast_share_unsupported': '当前微信版本不支持直接分享图片',
  'poster:toast_share_fail': '没发出去，再试一次',
  'poster:toast_no_text': '这条没有文字可复制',
  'poster:voice_note': '（一段 {n} 秒的录音）',
  'poster:photo_note': '（{n} 张照片）',
  'poster:slogan': '想到什么，就记一句',

  /* —— 卡片组件 —— */
  'card:playing': '正在播放',
  'card:listen': '点一下听听',

  /* —— 数据层与传输层 —— */
  'transfer:err_empty': '还没有记录可以导出。',
  'transfer:err_serialize': '数据转换失败，再试一次。',
  'transfer:err_write': '写文件失败，可能是本机空间不足。',
  'transfer:err_save': '保存文件失败，换个方式再试一次。',
  'transfer:err_share': '分享失败，请确认微信已登录。',
  'transfer:err_unsupported': '当前环境不支持导出，请用手机微信打开。',
  'transfer:md_title': '# 灵感随时记 · 摘录',
  'transfer:md_time': '导出时间：{t}',
  'transfer:md_count': '共 {n} 条',
  'transfer:md_audio': '> 附一段录音',
  'transfer:md_images': '> 附 {n} 张图片',
  'transfer:md_prefix': '灵感摘录-',
  'transfer:from_file': '来自「{name}」',
  'media:not_supported': '当前环境不支持选图',
  'media:no_image': '没有拿到图片',
  'media:photo_missing': '照片不在了',
  'media:photo_lost': '丢失',
  'share:title': '灵感随时记 · 想到什么就记一句',
  'store:full_title': '满 {n} 条了',
  'store:full_text': '先清掉一些不再需要的灵感，再继续记。',
  'store:nomem_title': '存不下了',
  'store:nomem_text': '本机存储空间不足，先删掉几条旧灵感再试试。',
  'dialog:cancel': '算了',
  'dialog:ok': '好',
  'asr:not_enabled': '未接入转写服务',
  'asr:plugin': '微信同声传译',
  'asr:no_manager': '插件未提供识别能力',
  'asr:no_plugin': '未安装同声传译插件',
  'asr:cannot_retro': '已录好的音频不能事后转写，请改用「边说边转」重新录一次'
}

/* ------------------------------ 英文字典 ------------------------------ */

const EN_DICT = {
  /* —— common —— */
  'common:cancel': 'Cancel',
  'common:cancel_plain': 'Cancel',
  'common:edited': 'Edited',
  'common:ok': 'OK',
  'common:got_it': 'Got it',
  'common:delete': 'Delete',
  'common:copy': 'Copy',
  'common:retry': 'Try again.',
  'common:packing': 'Packing…',
  'common:processing': 'Working…',
  'common:reading': 'Reading…',
  'common:copy_ok': 'Copied',
  'common:contact_copied': 'Contact copied',
  'common:type_text': 'Text',
  'common:type_voice': 'Voice',
  'common:type_photo': 'Photo',
  'common:unit_item': 'entries',
  'common:unit_day': 'days',
  'common:not_found_voice': "Can't find this recording",

  /* —— navigation bar titles —— */
  'nav:detail': 'This entry',
  'nav:record': 'New entry',
  'nav:review': 'Look back',
  'nav:search': 'Search',
  'nav:poster': 'Image',
  'nav:me': 'Me',

  /* —— date —— */
  'date:week0': 'Sun',
  'date:week1': 'Mon',
  'date:week2': 'Tue',
  'date:week3': 'Wed',
  'date:week4': 'Thu',
  'date:week5': 'Fri',
  'date:week6': 'Sat',
  'date:just_now': 'Just now',
  'date:min_ago': '{n} min ago',
  'date:today_at': 'Today {t}',
  'date:yesterday_at': 'Yesterday {t}',
  'date:month_day': '{m}/{d}',
  'date:year_month_day': '{y}/{m}/{d}',
  'date:full': '{y}/{m}/{d} {t}',
  'date:today': 'Today',
  'date:yesterday': 'Yesterday',
  'date:before_yesterday': '2 days ago',
  'date:this_week': 'This week',
  'date:this_month': 'This month',
  'date:this_year': 'This year',
  'date:year': '{y}',
  'date:anni_last': 'A year ago today',
  'date:anni_n': '{n} years ago today',

  /* —— nudge —— */
  'nudge:label': 'Nothing yet today',
  'nudge:tip': 'Write one ›',
  'nudge:keep': '{n}d in a row — one line keeps it going',
  'nudge:yesterday': "Yesterday's line is still warm. Leave one today too",
  'nudge:gap_short': '{n}d since — one line picks it back up',
  'nudge:gap_long': '{n}d since. What is on your mind?',

  /* —— backup —— */
  'backup:only_local': 'only on this phone',
  'backup:first': '{n} entries · {s}',
  'backup:first_tip': 'Back one up ›',
  'backup:again': 'Backed up {n}d ago',
  'backup:again_tip': 'Back up again ›',

  /* —— me —— */
  'me:hero_unit': 'entries',
  'me:unit_item': 'entries',
  'me:unit_media': 'files',
  'me:streak_unit': 'days in a row',
  'me:heat_title': 'Last 14 weeks',
  'me:heat_sub': 'Busiest day: {n}',
  'me:heat_less': 'Less',
  'me:heat_more': 'More',
  'me:row_first': 'Started',
  'me:row_last': 'Latest',
  'me:row_types': 'Text / Voice / Photo',
  'me:row_flags': 'Starred / Archived / Tagged',
  'me:sec_organize': 'Organise',
  'me:row_archive': 'Archived',
  'me:row_archive_sub': 'Hidden from the list, still kept',
  'me:sec_move': 'New phone',
  'me:row_backup': 'Last backup',
  'me:row_backup_sub': 'Deleting the app or switching phones wipes it',
  'me:row_export': 'Export to file',
  'me:row_export_sub': 'Text, photos and audio in one file',
  'me:row_import': 'Import from file',
  'me:row_import_sub': 'Pick a .json backup from chat',
  'me:row_about': 'About',
  'me:row_about_sub': 'Author and contact',
  'me:row_index': 'Records index',
  'me:row_index_sub': 'Text and settings, {n}% used',
  'me:row_media': 'Photos and audio',
  'me:row_media_sub': 'Local files, separate quota',
  'me:sec_lang': 'Language',
  'me:row_lang': '语言 / Language',
  'me:row_lang_sub': 'Takes effect right away',
  'me:note':
    'Everything stays on this phone. Nothing is uploaded, nothing needs a network.\nDeleting the mini program, clearing WeChat storage or switching phones erases it all, with no way back.\nSo before switching phones, use "Export to file" and import it on the new one. Import only adds — it never overwrites what is already there.',
  'me:clear': 'Clear all records',
  'me:not_started': 'Not started',
  'me:never_backed': 'Never backed up',
  'me:today': 'Today',
  'me:days_ago': '{n}d ago',
  'me:backup_meta': '{t} · {n} entries',
  'me:warn_index': 'The records index is nearly full. Export a backup first, then clear some old entries.',
  'me:warn_media': 'Photos and audio are close to the local file quota. Export, then clean up.',
  'me:no_archive': 'Nothing archived yet',
  'me:no_records': 'No records yet',
  'me:export_title': 'Export complete',
  'me:export_count': '{n} entries',
  'me:export_media': 'Including {n} photos/recordings',
  'me:export_dropped': '{n} media files over 2MB were skipped',
  'me:export_share': 'File created. Forward it to File Transfer, then import it on the new phone.',
  'me:export_saved': 'Saved to your computer. Copy it to the new phone and import.',
  'me:export_fail': "Couldn't export",
  'me:import_title': 'Import complete',
  'me:import_ask_title': 'Import from a backup?',
  'me:import_ask_text': 'You will pick a .json backup from chat. Import only adds — existing records stay untouched.',
  'me:import_ask_cancel': 'Not now',
  'me:import_ask_ok': 'Pick file',
  'me:import_added': 'Imported {n}',
  'me:import_none': 'Nothing new to add',
  'me:import_skipped': '{n} already exist or exceeded the limit, skipped',
  'me:import_media': 'Restored {n} photos/recordings',
  'me:import_media_fail': '{n} media files failed to restore',
  'me:import_fail': "Couldn't import",
  'me:clear_ask_title': 'Clear all ideas?',
  'me:clear_ask_text': '{n} entries in all. This cannot be undone.',
  'me:clear_ask_cancel': 'Cancel',
  'me:clear_ask_ok': 'Clear',
  'me:clear_empty': 'Already empty',
  'me:clear_done': 'All clear',
  'me:about_title': 'About',
  'me:about_cancel': 'Got it',
  'me:about_confirm': 'Copy contact',
  'me:about_version': '灵感随时记 v{v}',
  'me:about_privacy': 'Everything stays on this phone. Nothing is uploaded, nothing needs a network, no login. Use "Export to file" above when switching phones.',
  'me:about_author': 'Author: {v}',
  'me:about_wechat': 'WeChat account: {v}',
  'me:about_email': 'Email: {v}',
  'me:storage_title': 'Where storage goes',
  'me:storage_index': 'Records index: {used} of {limit}.',
  'me:storage_index_sub': 'Text, tags and settings — no photos or audio.',
  'me:storage_media': 'Photos and audio: {size}, {n} files.',
  'me:storage_media_sub': 'Stored as files on the phone, outside the quota above.',
  'me:storage_full': 'A full index only blocks new records; existing ones never vanish. The safe move is to export a backup first, then clear what you no longer need.',
  'me:err_nofile': 'No file selected.',
  'me:err_choose': "Couldn't open the picker. Try again.",
  'me:err_read': "The file can't be read. It may be damaged.",
  'me:err_parse': 'This file is not valid JSON.',
  'me:err_format': 'This is not a backup exported by 灵感随时记.',
  'me:err_unsupported': "Import isn't supported here. Open it in WeChat on your phone.",

  /* —— index —— */
  'index:title': 'My ideas',
  'index:count': '{n}',
  'index:collect': 'From chat',
  'index:cancel': 'Cancel',
  'index:select': 'Select',
  'index:mine': 'Me',
  'index:composer': "What's on your mind?",
  'index:chip_all': 'All',
  'index:chip_star': 'Starred',
  'index:chip_archive': 'Archived',
  'index:anni_open': 'Take a look ›',
  'index:review_label': 'Shuffle one',
  'index:review_tip': 'Pick from {n} ›',
  'index:review_text': 'That line from six months ago may be exactly what you need',
  'index:grp_today': 'Today',
  'index:grp_count': '{n}',
  'index:collapse': 'Collapse',
  'index:expand': 'Expand',
  'index:group_delete': 'Delete group',
  'index:more_in_group': '{n} more',
  'index:more_hint': 'Keep scrolling',
  'index:end_hint': "That's all · swipe left to delete, long-press to edit",
  'index:empty_btn_first': 'Write the first one',
  'index:empty_btn_all': 'See all ideas',
  'index:empty_link': 'Or save one from chat →',
  'index:sel_count': '{n} selected',
  'index:sel_copy': 'Copy',
  'index:sel_export': 'Export',
  'index:sel_delete': 'Delete',
  'index:entry_text': 'Write',
  'index:entry_voice': 'Speak',
  'index:entry_photo': 'Shoot',
  'index:undo_text': '{label} · undo within {n}s',
  'index:undo_btn': 'Undo',
  'index:err_unsupported': "Chat files can't be opened here. Try on your phone.",
  'index:err_nofile': 'No file selected.',
  'index:err_choose': "Couldn't open the picker. Try again.",
  'index:err_read': "These files can't be read. Screenshots, or long-pressing to copy the text, work more reliably.",
  'index:err_empty': 'The clipboard is empty — long-press to copy something in chat first.',
  'index:err_denied': 'No clipboard permission. Allow it in Settings and try again.',
  'index:err_full': "You're at the limit — clear a few first.",
  'index:skip_type': 'Unknown file type',
  'index:skip_read': "Can't read it",
  'index:skip_save': "Couldn't save it — maybe out of space",
  'index:skip_unknown_name': 'An unrecognised file',
  'index:skip_line': '· {name} ({reason})',
  'index:skipped_etc': ' and {n} more',
  'index:skipped_unknown': '{n} unrecognisable files',
  'index:sum_voice': 'A {n}-second recording',
  'index:sum_photo': '{n} photos',
  'index:badge_text': 'Text',
  'index:badge_voice': 'Voice {n}″',
  'index:badge_photo': 'Photo × {n}',
  'index:badge_photo_one': 'Photo',
  'index:empty_default': "Say what's on your mind",
  'index:empty_sub': 'No title, no category to pick',
  'index:empty_star': 'Nothing starred yet',
  'index:empty_star_sub': 'Long-press an entry and choose Star to pin it here',
  'index:empty_archive': 'The archive is empty',
  'index:empty_archive_sub': 'Long-press an entry and choose Archive to file it here',
  'index:empty_tag': 'Nothing under #{tag} yet',
  'index:empty_tag_sub': 'Write #{tag} in the text and it files itself here',
  'index:toast_backup_done': 'Backup created — forward it to File Transfer',
  'index:dialog_export_fail': "Couldn't export",
  'index:toast_snooze': "Won't mention it for 7 days — the backup option stays under Me",
  'index:collect_title': 'Save from chat',
  'index:collect_file': 'Pick images / files',
  'index:collect_file_desc': 'Images, txt, md, csv — up to 9',
  'index:collect_paste': 'Paste copied text',
  'index:collect_paste_desc': 'Long-press to copy in chat, then tap here',
  'index:received_title': 'Got it',
  'index:received_first': 'Saved {n} — right at the top.',
  'index:received_compressed': '{n} photos shrunk under 300KB, saving {b}.',
  'index:received_shells': '{n} files kept only their names (PDF, Word and the like), so you can add a line yourself.',
  'index:received_skipped': '{n} could not be saved: {list}.',
  'index:received_partial': '{n} were not written — the limit of {m} may have been reached.',
  'index:all_failed_title': "Couldn't save this time",
  'index:all_failed_head': 'None of the {n} selected files could be saved.',
  'index:all_failed_tail': 'Screenshots, or long-pressing to copy the text in chat, are more reliable.',
  'index:fail_title': "Couldn't save",
  'index:clip_trunc_title': 'Took the first half',
  'index:clip_trunc_text': 'This one has {n} characters; a single entry holds {m}. Kept the first {k}. Copy the rest into another entry.',
  'index:clip_saved': "Saved — it's at the top",
  'index:clip_empty': 'No text in the clipboard',
  'index:clip_fail_title': "Couldn't read it",
  'index:undo_one': 'Deleted 1',
  'index:group_del_title': 'Delete the whole "{name}" group?',
  'index:group_del_text': '{n} entries. You have 5 seconds to undo.',
  'index:group_del_ok': 'Delete group',
  'index:del_fail': "Didn't delete — try again",
  'index:undo_group': 'Deleted {n} from "{name}"',
  'index:undo_group_plain': 'Deleted {n}',
  'index:back_count': '{n} are back',
  'index:back_one': "It's back",
  'index:menu_edit': 'Edit',
  'index:menu_edit_desc': 'Just fix this line',
  'index:menu_copy': 'Copy',
  'index:menu_copy_desc': 'Copy the text',
  'index:menu_star': 'Star',
  'index:menu_unstar': 'Unstar',
  'index:menu_star_desc': 'Pin it under Starred so it does not drift away',
  'index:menu_unstar_desc': 'Remove from Starred',
  'index:menu_archive': 'Archive',
  'index:menu_unarchive': 'Unarchive',
  'index:menu_archive_desc': 'Keep it, hide it from the main list',
  'index:menu_unarchive_desc': 'Back to the main list',
  'index:menu_poster': 'Make an image',
  'index:menu_poster_desc': 'Lay it out as an image you can save or send',
  'index:menu_select': 'Select',
  'index:menu_select_desc': 'Pick several to copy, export or delete',
  'index:menu_delete': 'Delete',
  'index:menu_delete_desc': 'Undo within 5 seconds',
  'index:toast_starred': 'Starred',
  'index:toast_unstarred': 'Removed from Starred',
  'index:toast_archived': 'Archived',
  'index:toast_unarchived': 'Back to the main list',
  'index:toast_no_text': 'Nothing to copy here',
  'index:toast_first_select': 'Pick a few first',
  'index:toast_selected_no_text': 'None of the selected entries has text',
  'index:toast_copied_n': 'Copied {n}',
  'index:export_done_title': 'Export complete',
  'index:export_done_text': '{n} entries, saved as {name}.',
  'index:export_done_share': 'Forward it to File Transfer to open it on your computer.',
  'index:export_done_saved': 'Saved to your computer.',
  'index:toast_export_unsupported': "Export isn't supported here",
  'index:toast_export_fail': "Couldn't export — try again",
  'index:sel_del_title': 'Delete the {n} selected?',
  'index:sel_del_text': 'You have 5 seconds to undo.',
  'index:toast_voice_missing': "Can't find this recording",
  'index:share_title': 'A shared entry',
  'index:share_cancel': 'No thanks',
  'index:share_ok': 'Save it',
  'index:share_saved': 'Saved to your ideas',

  /* —— record —— */
  'record:nav_cancel': 'Cancel',
  'record:nav_new': 'New',
  'record:nav_edit': 'Edit',
  /* Same split as Chinese: creating vs editing. */
  'record:save_cta': 'Save this',
  'record:save_cta_edit': 'Save changes',
  'record:ph_text': "Say what's on your mind…",
  'record:tip_tag': 'Add #tags inline and it files itself',
  'record:rec_hold': 'Hold to talk',
  'record:rec_redo': 'Record again',
  'record:rec_release_cancel': 'Release to cancel',
  'record:rec_release_save': 'Release to save',
  'record:rec_tap_start': 'Tap to start',
  'record:rec_swipe_cancel': 'Swipe up to cancel',
  'record:voice_playing': 'Playing · tap to stop',
  'record:voice_recorded': '{n}″ recorded · tap to listen',
  'record:voice_mode_hold': 'Switch to hold-to-talk',
  'record:voice_mode_click': 'Switch to tap-to-record',
  'record:ph_asr': 'The transcript lands here — you can edit it',
  'record:ph_voice_note': 'Add a line so this recording is searchable',
  'record:add_photo': 'Add',
  'record:pick_photo': 'Take a photo or pick from album',
  'record:counter_photos': '{n} / {m} · tap × to remove',
  'record:ph_photo_note': 'Add a line (optional)',
  'record:tab_text': 'Write',
  'record:tab_voice': 'Speak',
  'record:tab_photo': 'Shoot',
  'record:toast_gone': 'This one is gone',
  'record:leave_confirm': "This isn't saved. Leave anyway?",
  'record:toast_unfinished': "This recording isn't finished",
  'record:switch_title': 'Switch type?',
  'record:switch_text': 'The {type} you just made will be cleared',
  'record:switch_ok': 'Switch',
  'record:toast_empty_text': 'Nothing written yet',
  'record:toast_no_photo': 'No photo picked yet',
  'record:toast_no_voice': 'Nothing recorded yet',
  'record:toast_release_first': 'Lift your finger first',
  'record:discard_title': 'Keep this one?',
  'record:discard_text': "It isn't saved — leaving discards it",
  'record:discard_cancel': 'Keep writing',
  'record:discard_ok': 'Discard',
  'record:toast_asr_break': 'Transcription stopped — try again',
  'record:toast_rec_fail': "Recording couldn't start. Check microphone permission",
  'record:perm_mic_title': 'Microphone needed',
  'record:perm_mic_text': 'Recording a line needs microphone access. Open Settings?',
  'record:perm_go': 'Settings',
  'record:mic_title': 'Use the microphone',
  'record:mic_text': 'Records what you say, kept only on this phone.',
  'record:mic_ok': 'Allow',
  'record:toast_no_recorder': "Recording isn't supported here",
  'record:hint_4min': '4 minutes left',
  'record:hint_1min': '1 minute left',
  'record:toast_too_short': 'Too short — say it again',
  'record:toast_text_only': 'Captured text only, saved as a text entry',
  'record:toast_end_rec_first': 'Stop the recording first',
  'record:toast_no_camera': "The camera isn't supported here",
  'record:toast_max_photos': 'Up to {n} photos',
  'record:toast_privacy': 'Configure the privacy policy in the console first',
  'record:toast_no_perm': 'No camera or album permission',
  'record:toast_pick_fail': "Didn't pick: {msg}",
  'record:toast_space_full': 'Local storage is full — delete a few entries with photos',
  'record:toast_media_fail': "That file couldn't be saved. Try again",
  'record:space_warn': 'Photos and audio take {size}. Nearly full — export a backup, or delete a few old entries with photos.',
  'record:space_full': 'Local storage is full. Text only for now — delete a few entries with photos to bring camera and recording back.',

  /* —— detail —— */
  'detail:star_on': '★ Starred',
  'detail:star_off': '☆ Star',
  'detail:playing': 'Playing',
  'detail:tap_listen': 'Tap to listen',
  'detail:add_text': '+ Add a line so this is searchable',
  'detail:meta_created': 'Recorded {t}',
  'detail:meta_updated': 'Edited {t}',
  'detail:meta_archived': 'Archived — hidden from the main list',
  'detail:act_edit': 'Edit',
  'detail:act_copy': 'Copy',
  'detail:act_poster': 'Image',
  'detail:act_archive': 'Archive',
  'detail:act_unarchive': 'Unarchive',
  'detail:act_delete': 'Delete',
  'detail:share': 'Send to a friend',
  'detail:prev': '‹ Previous',
  'detail:next': 'Next ›',
  'detail:flip_tip': 'Swipe to flip',
  'detail:missing': 'This one is gone',
  'detail:back': 'Back to list',
  'detail:del_title': 'Delete it?',
  'detail:del_text': 'You go back to the list, and have 5 seconds to undo.',
  'detail:del_cancel': 'Keep',
  'detail:del_ok': 'Delete',
  'detail:add_title': 'Add a line',
  'detail:add_placeholder': "What's this about?",
  'detail:add_ok': 'Save',
  'detail:add_done': 'Added — now it can be found',
  'detail:toast_no_prev': 'This is the earliest one',
  'detail:toast_no_next': 'No other ideas',

  /* —— review —— */
  'review:head': 'Shuffle one',
  'review:head_multi': 'Swipe to flip · {n} in all',
  'review:head_one': 'Just this one',
  'review:ago_today': 'Written today',
  'review:ago_yesterday': 'Written yesterday',
  'review:ago_days': 'Written {n}d ago',
  'review:no_content': 'Nothing was written here',
  'review:audio_paused': 'Paused — tap to resume',
  'review:audio_playing': 'Playing',
  'review:audio_tap': 'Tap to listen',
  'review:op_next': 'Another one',
  'review:op_star': 'Star',
  'review:op_unstar': 'Unstar',
  'review:op_open': 'Details',
  'review:share': 'Send this to a friend',
  'review:empty': 'Nothing to revisit yet',
  'review:empty_sub': 'Write a few, then come back in a few days',
  'review:empty_btn': 'Write one',
  'review:toast_only_one': 'Just this one',
  'review:toast_earliest': 'This is the earliest one',

  /* —— search —— */
  'search:ph': 'Search text and #tags',
  'search:empty_sub': 'Try "podcast", or tap a tag below',
  'search:count': '{n} found',
  'search:not_found': 'Nothing for "{kw}"',
  'search:not_found_sub': 'Try another word, or browse the tags',

  /* —— poster —— */
  'poster:hint': 'Long-press to save, or use the buttons below',
  'poster:rendering': 'Laying out…',
  'poster:save': 'Save to album',
  'poster:share': 'Send to a friend',
  'poster:copy': 'Copy text',
  'poster:err_gone': 'This one is gone',
  'poster:err_canvas': "Canvas isn't supported here",
  'poster:err_fail': "Couldn't generate it — try again",
  'poster:toast_saved': 'Saved to your album',
  'poster:perm_title': 'Album permission needed',
  'poster:perm_text': 'Saving an image writes to your album. Open Settings?',
  'poster:perm_go': 'Settings',
  'poster:toast_save_fail': "Didn't save — try Send to a friend",
  'poster:toast_share_unsupported': 'This WeChat version cannot share images directly',
  'poster:toast_share_fail': "Didn't send — try again",
  'poster:toast_no_text': 'Nothing to copy here',
  'poster:voice_note': '(a {n}-second recording)',
  'poster:photo_note': '({n} photos)',
  'poster:slogan': "Say what's on your mind",

  /* —— card component —— */
  'card:playing': 'Playing',
  'card:listen': 'Tap to listen',

  /* —— data & transfer —— */
  'transfer:err_empty': 'Nothing to export yet.',
  'transfer:err_serialize': 'Data conversion failed. Try again.',
  'transfer:err_write': 'Writing the file failed — maybe the phone is out of space.',
  'transfer:err_save': 'Saving the file failed. Try another way.',
  'transfer:err_share': 'Sharing failed. Check that WeChat is signed in.',
  'transfer:err_unsupported': "Export isn't supported here. Open it in WeChat on your phone.",
  'transfer:md_title': '# 灵感随时记 · excerpts',
  'transfer:md_time': 'Exported: {t}',
  'transfer:md_count': '{n} entries',
  'transfer:md_audio': '> with a recording',
  'transfer:md_images': '> with {n} images',
  'transfer:md_prefix': 'ideas-',
  'transfer:from_file': 'From "{name}"',
  'media:not_supported': 'Image picking is not supported here',
  'media:no_image': 'No image returned',
  'media:photo_missing': 'Photo is gone',
  'media:photo_lost': 'Missing',
  'share:title': '灵感随时记 · Say what is on your mind',
  'store:full_title': 'Reached {n} entries',
  'store:full_text': 'Clear a few you no longer need, then keep going.',
  'store:nomem_title': "Can't save",
  'store:nomem_text': 'Local storage is full. Delete a few old entries and try again.',
  'dialog:cancel': 'Cancel',
  'dialog:ok': 'OK',
  'asr:not_enabled': 'Transcription not enabled',
  'asr:plugin': 'WeChat speech plugin',
  'asr:no_manager': 'The plugin offers no recognition',
  'asr:no_plugin': 'Speech plugin not installed',
  'asr:cannot_retro': 'An existing recording cannot be transcribed. Record again with live transcription.'
}

module.exports = {
  ZH,
  EN,
  FALLBACK,
  KEY_LANG,
  lang,
  systemLang,
  normalize,
  setLang,
  isEn,
  t,
  pack,
  table,
  title,
  reset
}
