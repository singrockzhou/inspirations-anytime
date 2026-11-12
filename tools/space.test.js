/**
 * 本机空间行为测试（钉住"落盘失败必须出声"）
 * 用法：node tools/space.test.js
 *
 * 覆盖三件事：
 *   1. media.persist 落盘失败时返回空串，绝不退回临时路径（临时路径会被微信清掉）
 *   2. 失败原因能区分"空间满"和"其它错"（两者要给不同的提示）
 *   3. 页面侧真的拦住了：空间满时不唤起相机、不开始录音、语音不写空路径
 */
const path = require('path')
const fs = require('fs')

const B = path.resolve(__dirname, '..', 'miniprogram')
const read = rel => fs.readFileSync(path.join(B, rel), 'utf8')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''))
  }
}

/* ---------- 假微信：saveFile 的行为由 failMode / failAt 控制 ---------- */

let failMode = '' // '' 成功 / 'space' 配额满 / 'other' 其它
let failAt = [] // 第几次调用（1 起）失败
let callIndex = 0
let writeCount = 0

global.wx = { env: { USER_DATA_PATH: 'wxfile://usr' } }

function installFs() {
  global.wx.getFileSystemManager = function () {
    return {
      saveFile(opts) {
        callIndex++
        if (failAt.indexOf(callIndex) >= 0) {
          return opts.fail({ errMsg: 'saveFile:fail no space left on device' })
        }
        if (failMode === 'space') {
          return opts.fail({
            errMsg: 'saveFile:fail the maximum size of the file storage limit is exceeded'
          })
        }
        if (failMode === 'other') {
          return opts.fail({ errMsg: 'saveFile:fail permission denied' })
        }
        writeCount++
        opts.success({ savedFilePath: opts.filePath })
      },
      statSync(p) {
        return { size: p ? 2048 : 0 }
      },
      unlink() {}
    }
  }
}

function reset() {
  failMode = ''
  failAt = []
  callIndex = 0
  writeCount = 0
  installFs()
  media.clearFail()
}

// 预期内的失败日志不要刷屏
const realError = console.error
const realWarn = console.warn
const quiet = a => String(a[0] || '').indexOf('[media]') === 0
console.error = function (...a) {
  if (quiet(a)) return
  realError.apply(console, a)
}
console.warn = function (...a) {
  if (quiet(a)) return
  realWarn.apply(console, a)
}

const media = require(path.join(B, 'utils/media.js'))
reset()

;(async function () {
  /* ---------- 1. persist 的返回语义 ---------- */

  console.log('\n[1] 落盘成功')
  reset()
  const p1 = await media.persist('wxfile://tmp/a.jpg', 'img', 'jpg')
  ok('返回的是用户目录下的路径', p1.indexOf('wxfile://usr/img_') === 0, p1)
  ok('真的写了一次盘', writeCount === 1, writeCount)
  ok('成功后失败原因是空', media.lastFailReason() === '', media.lastFailReason())

  console.log('\n[2] 落盘失败 —— 空间满')
  reset()
  failMode = 'space'
  const p2 = await media.persist('wxfile://tmp/b.jpg', 'img', 'jpg')
  ok('返回空串，不再退回临时路径', p2 === '', p2)
  ok('临时路径没有被当成结果返回', p2.indexOf('tmp') < 0, p2)
  ok('失败原因是 space', media.lastFailReason() === 'space', media.lastFailReason())

  console.log('\n[3] 落盘失败 —— 其它原因')
  reset()
  failMode = 'other'
  const p3 = await media.persist('wxfile://tmp/c.jpg', 'img', 'jpg')
  ok('同样返回空串', p3 === '', p3)
  ok('失败原因是 other（不能误报成"空间满了"）', media.lastFailReason() === 'other', media.lastFailReason())

  console.log('\n[4] 失败后成功一次会清掉上一次的结论')
  reset()
  failMode = 'space'
  await media.persist('wxfile://tmp/d.jpg', 'img', 'jpg')
  failMode = ''
  await media.persist('wxfile://tmp/e.jpg', 'img', 'jpg')
  ok('原因被清空', media.lastFailReason() === '', media.lastFailReason())

  console.log('\n[5] 已经在用户目录里的路径不重复写盘')
  reset()
  const p5 = await media.persist('wxfile://usr/img_old.jpg', 'img', 'jpg')
  ok('原样返回', p5 === 'wxfile://usr/img_old.jpg', p5)
  ok('没有多余写入', writeCount === 0, writeCount)

  /* ---------- 2. 上层封装：失败项必须被过滤/置空 ---------- */

  console.log('\n[6] saveImages：三张里坏两张')
  reset()
  failAt = [2, 3]
  const list = await media.saveImages([
    'wxfile://tmp/1.jpg',
    'wxfile://tmp/2.jpg',
    'wxfile://tmp/3.jpg'
  ])
  ok('只返回落盘成功的那一张', list.length === 1, list.length)
  ok('返回项带真实路径', list.every(x => x.path.indexOf('wxfile://usr') === 0), list.map(x => x.path))
  ok('最后失败的是 space', media.lastFailReason() === 'space', media.lastFailReason())

  console.log('\n[7] saveVoice：失败时 path 为空、size 为 0')
  reset()
  failMode = 'space'
  const v = await media.saveVoice('wxfile://tmp/v.aac')
  ok('path 为空串', v.path === '', v.path)
  ok('size 归零（不会假装 2KB）', v.size === 0, v.size)

  console.log('\n[8] saveChatImage：失败时不能交给调用方一个临时路径')
  reset()
  failMode = 'space'
  const c = await media.saveChatImage('wxfile://tmp/c.png', 'png', 4096)
  ok('path 为空串', c.path === '', c.path)

  /* ---------- 3. 页面侧的拦截（静态检查，跑不到真机就先钉在源码上） ---------- */

  console.log('\n[9] record.js：三个入口都拦了')
  const rec = read('pages/record/record.js')
  const mediaSrc = read('utils/media.js')
  ok(
    'persist 的 fail 分支不再退回临时路径',
    !/fail:[\s\S]{0,240}?resolve\(tempFilePath\)/.test(mediaSrc)
  )
  ok('onMediaFail 存在', /onMediaFail\(\)\s*\{/.test(rec))
  ok('拍照前检查空间', /pickPhoto\(opts\)\s*\{[\s\S]{0,220}spaceFull/.test(rec))
  ok('录音前检查空间', /startRecord\(\)\s*\{[\s\S]{0,160}spaceFull/.test(rec))
  ok('切到语音/拍照 tab 时检查空间', /onTab\(e\)\s*\{[\s\S]{0,260}spaceFull/.test(rec))
  ok('语音没落盘就不写记录', /if \(!path\) \{[\s\S]{0,160}onMediaFail/.test(rec))
  ok(
    '照片有失败就提示（对比期望张数）',
    /this\.expectPhotos && saved\.length < this\.expectPhotos/.test(rec)
  )
  ok('重拍失败保留原图，不会清空', /cameraOnly \? \(saved\.length \? saved : this\.data\.photos\)/.test(rec))
  ok('只有真的换上了新图才删旧图', /cameraOnly && saved\.length && this\.data\.mode === 'create'/.test(rec))
  ok('阈值取自 store，不写魔法数字', /store\.MEDIA_FULL_BYTES/.test(rec) && !/150 \* 1024 \* 1024/.test(rec))

  console.log('\n[10] store / 页面 / 样式')
  const store = read('utils/store.js')
  ok('store 导出 MEDIA_LIMIT_BYTES', /MEDIA_LIMIT_BYTES,/.test(store))
  ok('store 导出 MEDIA_FULL_BYTES', /MEDIA_FULL_BYTES,/.test(store))
  ok('store 导出 MEDIA_WARN_BYTES', /MEDIA_WARN_BYTES,/.test(store))
  ok('我的页也用同一个常量', /store\.MEDIA_WARN_BYTES/.test(read('pages/me/me.js')))

  const wxml = read('pages/record/record.wxml')
  ok('wxml 有空间提示条', /class="space-tip \{\{spaceFull \? 'full' : ''\}\}"/.test(wxml))
  const offHits = (wxml.match(/spaceFull \? 'off'/g) || []).length
  ok('wxml 的语音/拍照 tab 有置灰态', offHits === 2, offHits)

  const wxss = read('pages/record/record.wxss')
  ok('样式有 .space-tip', /\.space-tip\s*\{/.test(wxss))
  ok('样式有 .tool.off', /\.tool\.off\s*\{/.test(wxss))

  console.log('\n[11] 文案两种语言都在')
  const i18nSrc = read('utils/i18n.js')
  ;['record:space_warn', 'record:space_full', 'record:toast_space_full', 'record:toast_media_fail'].forEach(k => {
    const hits = (i18nSrc.match(new RegExp("'" + k + "'", 'g')) || []).length
    ok(k + ' 有中英两份', hits === 2, hits)
  })

  console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
})()
