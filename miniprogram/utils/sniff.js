/**
 * 认一个从聊天里拿到的临时文件到底是什么。
 *
 * 为什么需要单独一个模块：
 * `wx.chooseMessageFile` 给的 `tempFilePath` 经常**没有扩展名**
 * （iOS 上是 `wxfile://tmp_xxxx`，安卓上是 `http://tmp/xxx`，有的还带 `?size=`），
 * 只靠路径猜后缀，会把一张截图判成"未知二进制"，结果就是列表里多出一条
 * 正文为「来自「78a4bca0…」」的空壳记录——用户看不懂，也搜不到。
 *
 * 判断顺序，从可信到不可信：
 *   1. 文件名后缀（`f.name`，用户在聊天里看到的那个名字）
 *   2. 路径后缀
 *   3. 读开头 512 字节看魔数（jpg/png/gif/webp/bmp/pdf/zip）
 *   4. 还不是，就看这段字节像不像 UTF-8 文本
 *   5. 都不是 → 二进制，只留名字
 *
 * 另外管一件事：**文件名值不值得给用户看**。
 * 微信从聊天里拿出来的一些文件，`name` 是一串哈希（`78a4bca0…_26439`），
 * 那是机器标识，不是人能读的信息。这种名字既不进正文，也不进提示。
 */

/** 能被当成照片处理的（gif 保留动图，压缩层会单独跳过它） */
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']
/** 能被直接读成正文的 */
const TEXT_EXT = ['txt', 'md', 'markdown', 'json', 'csv', 'log', 'yaml', 'yml']
/** 明确是二进制、连头都不用读的后缀 */
const BINARY_EXT = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', 'rar', '7z', 'gz', 'tar', 'apk', 'ipa',
  'mp3', 'm4a', 'wav', 'aac', 'amr', 'mp4', 'mov', 'avi', 'mkv'
]

/** 单个文件最多读多少字节来判断内容 */
const HEAD = 512

function suffix(nameOrPath) {
  const s = String(nameOrPath || '')
  // 去掉 ?query 与 #hash，wxfile:// 与 http:// 都可能带
  const clean = s.split('?')[0].split('#')[0]
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(clean)
  return m ? m[1].toLowerCase() : ''
}

function baseName(nameOrPath) {
  const clean = String(nameOrPath || '').split('?')[0].split('#')[0]
  const parts = clean.split('/')
  return parts[parts.length - 1] || ''
}

/**
 * 名字是不是一串机器标识（哈希 / 编码 / 纯时间戳）。
 * 命中就不给用户看——「来自「78a4bca0…」」这种正文，等于把内部实现抛给了用户。
 */
function isMachineName(name) {
  const base = String(name || '')
    .replace(/\.[a-zA-Z0-9]{1,8}$/, '')
    .trim()
  if (!base) return true
  // 16 位以上连续十六进制：78a4bca059cff70d66e6b33621a75d18、a1b2c3d4e5f6a7b8
  if (/[0-9a-f]{16,}/i.test(base)) return true
  // 微信临时文件：tmp_xxx / tmp-xxx
  if (/^tmp[_-]/i.test(base)) return true
  // 纯数字（时间戳、消息 ID）
  if (/^\d{10,}$/.test(base)) return true
  // 只剩符号/下划线横线，没有任何可念的字符
  if (!/[a-zA-Z\u4e00-\u9fa5]/.test(base)) return true
  return false
}

/** 给人看的文件名：机器名返回空串，太长截断 */
function readableName(name, max) {
  const n = String(name || '').trim()
  if (!n || isMachineName(n)) return ''
  const limit = max || 24
  if (n.length <= limit) return n
  // 尽量保留后缀，方便用户认出"这是个 pdf"
  const ext = suffix(n)
  const keep = limit - (ext ? ext.length + 2 : 0)
  return n.slice(0, Math.max(4, keep)) + '…' + (ext ? '.' + ext : '')
}

function readHead(p, n) {
  try {
    const buf = wx.getFileSystemManager().readFileSync(p)
    const limit = n || HEAD
    if (typeof buf === 'string') {
      // 测试替身 / 极老环境会给字符串，按 latin1 取字节
      const out = []
      for (let i = 0; i < Math.min(limit, buf.length); i++) out.push(buf.charCodeAt(i) & 0xff)
      return out
    }
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    const out = []
    for (let i = 0; i < Math.min(limit, u8.length); i++) out.push(u8[i])
    return out
  } catch (e) {
    return null
  }
}

/** 魔数：只认常见几种，认不出就交给文本判断 */
function byMagic(b) {
  if (!b || b.length < 4) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', ext: 'jpg' }
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { kind: 'image', ext: 'png' }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { kind: 'image', ext: 'gif' }
  if (b[0] === 0x42 && b[1] === 0x4d) return { kind: 'image', ext: 'bmp' }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return { kind: 'image', ext: 'webp' }
  }
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return { kind: 'binary', ext: 'pdf' }
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return { kind: 'binary', ext: 'zip' }
  return null
}

/** 这段字节像不像 UTF-8 文本（有 0x00 或控制字符就不是） */
function looksText(b) {
  if (!b || !b.length) return false
  let i = 0
  while (i < b.length) {
    const x = b[i]
    if (x === 0) return false
    if (x < 0x09) return false
    if (x > 0x0d && x < 0x20) return false
    if (x < 0x80) {
      i++
      continue
    }
    let n = 0
    if (x >= 0xc2 && x <= 0xdf) n = 1
    else if (x >= 0xe0 && x <= 0xef) n = 2
    else if (x >= 0xf0 && x <= 0xf4) n = 3
    else return false
    for (let k = 1; k <= n; k++) {
      const y = b[i + k]
      if (y === undefined) return true // 头被切断，前面都合法，就当文本
      if (y < 0x80 || y > 0xbf) return false
    }
    i += n + 1
  }
  return true
}

/**
 * 判定一个聊天文件。
 * @param {{name?:string,path?:string,size?:number}} file chooseMessageFile 的一项
 * @returns {{kind:'image'|'text'|'binary', ext:string, name:string, label:string}}
 *   kind  怎么处理它
 *   ext   判断或嗅出来的后缀
 *   name  原始名字（可能是哈希）
 *   label 能给人看的那部分名字，哈希名是空串
 */
function classify(file) {
  const raw = (file && file.name) || ''
  const p = (file && file.path) || ''
  const name = raw || baseName(p)
  const label = readableName(name)

  const fromName = suffix(baseName(raw))
  const fromPath = suffix(baseName(p))

  // 1) 名字或路径给了可信后缀，直接采信（用户看到的名字比路径更可信）
  const ext = fromName || fromPath
  if (IMAGE_EXT.indexOf(ext) >= 0) return { kind: 'image', ext: ext, name: name, label: label }
  if (TEXT_EXT.indexOf(ext) >= 0) return { kind: 'text', ext: ext, name: name, label: label }
  if (BINARY_EXT.indexOf(ext) >= 0) return { kind: 'binary', ext: ext, name: name, label: label }

  // 2) 没有可信后缀：读头看内容
  const head = readHead(p, HEAD)
  const magic = byMagic(head)
  if (magic) return { kind: magic.kind, ext: magic.ext, name: name, label: label }
  if (looksText(head)) return { kind: 'text', ext: ext || 'txt', name: name, label: label }

  // 3) 认不出：如实说"认不出"，不要硬塞一个假后缀
  return { kind: 'binary', ext: ext || '', name: name, label: label }
}

module.exports = {
  IMAGE_EXT,
  TEXT_EXT,
  BINARY_EXT,
  HEAD,
  suffix,
  baseName,
  isMachineName,
  readableName,
  looksText,
  byMagic,
  classify
}
