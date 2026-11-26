/**
 * 语音只录音、不转文字（14 条断言）
 * 用法：node tools/voice.test.js
 *
 * 产品已定：语音不转文字。这条决定有三层后果，任何一层单独失效都不会有人报错，
 * 所以全部做静态断言：
 *   1. 代码层：没有同声传译插件、没有识别器分支、没有"边录边转"的 UI。
 *      接回来就等于把"不联网"这句话变成假话，而这个产品唯一立得住的就是这句话。
 *   2. 文案层：指南里不能承诺"转成文字需要联网"——那是在卖一个不存在的功能。
 *   3. 引导层：既然录音不会被索引成文字，就得明确告诉人"补一句文字才搜得到"，
 *      否则他录了十条，回头一条都搜不出来。
 */
const path = require('path')
const fs = require('fs')

const B = path.resolve(__dirname, '..', 'miniprogram')
const read = p => fs.readFileSync(path.join(B, p), 'utf8')

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

/* ---------------- 1. 代码层：能力已经拿掉 ---------------- */

console.log('1) 代码里没有语音识别')

ok('asr 适配层已删除', !fs.existsSync(path.join(B, 'utils/asr.js')))
ok('app.json 没有声明同声传译插件', !/WechatSI|plugins/.test(read('app.json')))

const rJs = read('pages/record/record.js')
const rWxml = read('pages/record/record.wxml')
const rWxss = read('pages/record/record.wxss')

ok('记录页不再 require 识别层', !/require\(.*asr/.test(rJs))
ok('记录页没有识别器的实时回调', !/asrPartial|asrReady|createRealtime|onRealtimeStop/.test(rJs))
ok('模板里没有边录边转的实时文字块', !/asr-live/.test(rWxml) && !/asr-live/.test(rWxss))
ok('录音占位提示只有"补一句文字"这一种', /placeholder="\{\{t\.ph_voice_note\}\}"/.test(rWxml))
// 录音仍然要走系统录音器：删识别层不能顺手把录音也删掉
ok('录音仍调系统录音器', /getRecorderManager/.test(rJs) && /this\.rm\.start\(/.test(rJs))

/* ---------------- 2. 文案层：不再承诺转文字 ---------------- */

console.log('2) 文案不承诺不存在的功能')

const i18n = read('utils/i18n.js')
ok('i18n 里没有识别相关的键', !/'asr:/.test(i18n))
ok('没有残留的"转写"字样', !/转写/.test(i18n))

const zh = /'guide:a3': '([^']*)'/.exec(i18n)
const en = /'guide:a3': "([^"]*)"/.exec(i18n)
ok('指南明说不做语音转文字（中）', !!zh && /不(做|会).{0,4}转文字|不会转成文字/.test(zh[1]), zh && zh[1])
ok('指南明说不做语音转文字（英）', !!en && /not transcribed|isn't transcribed/i.test(en[1]), en && en[1])
ok('指南不再说"转成文字需要联网"', !!zh && !/转成文字需要联网/.test(zh[1]), zh && zh[1])

/* ---------------- 3. 引导层：录音得靠补文字才搜得到 ---------------- */

console.log('3) 搜不到录音这件事要说清')

ok('录音页占位说明"补一句文字才搜得到"', /'record:ph_voice_note': '[^']*搜到'/.test(i18n))
ok('指南同一段也给了这个办法', !!zh && /补一句文字/.test(zh[1]), zh && zh[1])

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
