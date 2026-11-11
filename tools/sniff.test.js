/**
 * 文件识别：判断从聊天里拿到的临时文件到底是什么（19 条断言）
 * 用法：node tools/sniff.test.js
 *
 * 为什么这个模块值得单独测：
 * 微信给的 tempFilePath 经常没有扩展名（iOS 是 wxfile://tmp_xxxx），
 * 只按路径猜后缀，会把一张截图判成"未知二进制"，
 * 结果就是列表里多出一条正文为「来自「78a4bca0…」」的空壳记录。
 * 这类 bug 在真机上只能"看出来"，看不出是哪一步判错了，所以在这里逐条钉住。
 */
const path = require('path')
const B = path.resolve(__dirname, '..', 'miniprogram')

/** 假文件系统：路径 → Buffer（模拟真实字节，包括魔数） */
const files = {}

global.wx = {
  getFileSystemManager() {
    return {
      readFileSync(p) {
        if (!(p in files)) throw new Error('no such file')
        const v = files[p]
        return Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8')
      }
    }
  }
}

const sniff = require(path.join(B, 'utils', 'sniff.js'))

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

/* 常见文件的真实开头几个字节 */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00])
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBP')])
const RANDOM = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x10])

console.log('1) 后缀可信：名字比路径更可信')
files['/tmp/u1'] = JPEG
let c = sniff.classify({ path: '/tmp/u1', name: '海边.JPG' })
ok('大写后缀也认', c.kind === 'image' && c.ext === 'jpg', c)

files['/tmp/u2'] = 'x'
c = sniff.classify({ path: '/tmp/u2.gif', name: '动图.gif' })
ok('gif 认成图片（压缩层会单独跳过它）', c.kind === 'image' && c.ext === 'gif', c)

// 名字说 png、路径说 txt 时信名字：用户看到的是名字
files['/tmp/u3.png'] = PNG
c = sniff.classify({ path: '/tmp/u3.png', name: '截图.png' })
ok('名字与路径一致时按 png', c.kind === 'image' && c.ext === 'png', c)

c = sniff.classify({ path: '/tmp/x.dat', name: '笔记.md' })
ok('文本后缀直接认成 text', c.kind === 'text' && c.ext === 'md', c)

c = sniff.classify({ path: '/tmp/x.dat', name: '报告.docx' })
ok('已知二进制后缀不读内容就判 binary', c.kind === 'binary' && c.ext === 'docx', c)

console.log('2) 没有后缀：靠内容开头几个字节')
files['/tmp/t1'] = JPEG
c = sniff.classify({ path: '/tmp/t1', name: 'tmp_a1b2c3' })
ok('无后缀的 JPEG 认成图片', c.kind === 'image' && c.ext === 'jpg', c)

files['/tmp/t2'] = PNG
c = sniff.classify({ path: '/tmp/t2' })
ok('连名字都没有，靠路径读字节也能认出 PNG', c.kind === 'image' && c.ext === 'png', c)

files['/tmp/t3'] = WEBP
c = sniff.classify({ path: '/tmp/t3', name: 'image' })
ok('WEBP 靠 RIFF…WEBP 认出来', c.kind === 'image' && c.ext === 'webp', c)

files['/tmp/t4'] = GIF
c = sniff.classify({ path: '/tmp/t4', name: '表情' })
ok('GIF 认出来', c.kind === 'image' && c.ext === 'gif', c)

files['/tmp/t5'] = PDF
c = sniff.classify({ path: '/tmp/t5', name: 'tmp_9f8e7d' })
ok('无后缀的 PDF 认成二进制', c.kind === 'binary' && c.ext === 'pdf', c)

files['/tmp/t6'] = ZIP
c = sniff.classify({ path: '/tmp/t6', name: 'tmp_1' })
ok('zip/docx/xlsx 的 PK 头认成二进制', c.kind === 'binary' && c.ext === 'zip', c)

files['/tmp/t7'] = Buffer.from('在电梯里想到：把提醒做成一句反问', 'utf8')
c = sniff.classify({ path: '/tmp/t7', name: 'tmp_中文' })
ok('无后缀但内容是中文，判成文本', c.kind === 'text', c)

files['/tmp/t8'] = RANDOM
c = sniff.classify({ path: '/tmp/t8', name: 'tmp_bin' })
ok('带 0x00 的字节流不当文本', c.kind === 'binary', c)

console.log('3) 文件名值不值得给用户看')
ok('32 位哈希名不给用户看', sniff.readableName('78a4bca059cff70d66e6b33621a75d18_26439') === '')
ok('tmp_ 前缀不给用户看', sniff.readableName('tmp_abc123') === '')
ok('纯数字名不给用户看', sniff.readableName('1699999999999') === '')
ok('中文名照原样', sniff.readableName('会议纪要.txt') === '会议纪要.txt')

const longName = sniff.readableName('关于第三季度市场部预算调整的说明.docx')
ok('超长名字截断但保留后缀', longName.length <= 26 && longName.endsWith('.docx'), longName)

const withQuery = sniff.suffix('wxfile://tmp_abc.jpg?size=1024')
ok('带 query 的路径也能取到后缀', withQuery === 'jpg', withQuery)

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
