#!/usr/bin/env node
/**
 * 里程碑版本发布：代码打包备份 + GitHub tag
 *
 * 用法：
 *   node tools/release.js 1.8.0                 # 说明默认取最近一次提交的标题
 *   node tools/release.js 1.8.0 "一句话说明"      # 自定义 tag 说明
 *   node tools/release.js 1.8.0 --dry-run        # 只做检查，不打包不打 tag
 *
 * 做四件事：
 *   1. 前置检查：工作区必须干净、tag 不能已存在、版本号必须和界面里的一致
 *   2. 打包：<工作区>/备份/<仓库名>-v<版本>-<日期>.zip，含 .git（历史可完整还原）
 *   3. 打 annotated tag（不是轻量 tag，说明会一起推到 GitHub）
 *   4. 推 tag 到 origin，并回读远端确认
 *
 * 为什么含 .git：源码 90 个文件丢了还能从 GitHub 拉回来，但"当初到底提交了什么"
 * 只有本地历史知道；多花 800KB 换一个能完整还原的现场，值。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const REPO = path.resolve(__dirname, '..')
const WORKSPACE = path.resolve(REPO, '..')
const REPO_NAME = path.basename(REPO)
const BACKUP_DIR = path.join(WORKSPACE, '备份')
const ME_JS = path.join(REPO, 'miniprogram/pages/me/me.js')

const args = process.argv.slice(2)
const flags = args.filter(a => a.indexOf('--') === 0)
const plain = args.filter(a => a.indexOf('--') !== 0)
const version = plain[0]
const note = plain[1] || ''
const DRY = flags.indexOf('--dry-run') >= 0

function die(msg) {
  console.error('\n✗ ' + msg)
  process.exit(1)
}

function git(...a) {
  return execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim()
}

function stamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return {
    date: d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()),
    time: p(d.getHours()) + p(d.getMinutes())
  }
}

/* ---------- 0. 参数 ---------- */

if (!version) {
  die(
    '缺少版本号。用法：node tools/release.js 1.8.0 "这次改了什么"\n' +
    '   加 --dry-run 只检查不动手。'
  )
}
if (!/^\d+\.\d+\.\d+$/.test(version)) die('版本号要写成 1.8.0 这样（三段数字），收到的是：' + version)

/* ---------- 1. 前置检查 ---------- */

console.log('检查中…')

const dirty = git('status', '--porcelain')
if (dirty) {
  die(
    '工作区还有未提交的改动，先提交再来：\n' +
    dirty.split('\n').map(l => '   ' + l).join('\n')
  )
}
console.log('  ✓ 工作区干净')

let tags = []
try {
  tags = git('tag', '-l').split('\n').filter(Boolean)
} catch (e) {
  tags = []
}
if (tags.indexOf('v' + version) >= 0) {
  die('tag v' + version + ' 已经存在了。要么换个版本号，要么先删掉它：git tag -d v' + version)
}
console.log('  ✓ tag v' + version + ' 没被占用')

// 界面里显示的版本号必须和 tag 一致，否则用户反馈问题时对不上号
const meSrc = fs.readFileSync(ME_JS, 'utf8')
const m = meSrc.match(/version:\s*'([\d.]+)'/)
if (!m) die('没在 me.js 里找到 version 字段，先确认文件结构没变。')
if (m[1] !== version) {
  die(
    '版本号对不上：me.js 里是 ' + m[1] + '，你要打的是 ' + version + '。\n' +
    '   先改 miniprogram/pages/me/me.js 的 version 字段并提交，再发布。'
  )
}
console.log('  ✓ 界面版本号一致（' + version + '）')

const head = git('log', '-1', '--format=%h %s')
const headFull = git('rev-parse', 'HEAD')
console.log('  ✓ HEAD ' + head)

/* ---------- 2. 打包 ---------- */

const { date, time } = stamp()
let zipName = '灵感随时记-v' + version + '-' + date + '.zip'
let zipPath = path.join(BACKUP_DIR, zipName)
if (fs.existsSync(zipPath)) {
  zipName = '灵感随时记-v' + version + '-' + date + '-' + time + '.zip'
  zipPath = path.join(BACKUP_DIR, zipName)
}

function pack() {
  // Compress-Archive 会漏掉 .git（点开头的目录），所以先整套复制到临时目录再压
  const ps = [
    "$ProgressPreference='SilentlyContinue';",
    "New-Item -ItemType Directory -Path '" + BACKUP_DIR + "' -Force | Out-Null;",
    "$t = Join-Path $env:TEMP ('lg_pack_' + [guid]::NewGuid().ToString('N').Substring(0,8));",
    'New-Item -ItemType Directory -Path $t | Out-Null;',
    "Copy-Item -LiteralPath '" + REPO + "' -Destination $t -Recurse -Force;",
    "Compress-Archive -Path (Join-Path $t '" + REPO_NAME + "') -DestinationPath '" + zipPath + "' -CompressionLevel Optimal -Force;",
    "Remove-Item -LiteralPath $t -Recurse -Force;",
    "Write-Output ('SIZE=' + (Get-Item -LiteralPath '" + zipPath + "').Length)"
  ].join(' ')

  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8'
  })
  if (r.status !== 0) die('打包失败：\n' + (r.stderr || r.stdout || ''))
  const sm = /SIZE=(\d+)/.exec(r.stdout || '')
  return sm ? Number(sm[1]) : 0
}

let size = 0
if (DRY) {
  console.log('\n[dry-run] 会打包到：' + zipPath)
} else {
  process.stdout.write('\n打包中…')
  size = pack()
  if (!fs.existsSync(zipPath)) die('打包命令跑完了，但文件不在：' + zipPath)
  console.log('\r  ✓ ' + zipName + '（' + (size / 1024).toFixed(1) + ' KB）')
}

/* ---------- 3. tag ---------- */

const title = 'v' + version + ' ' + (note || head.replace(/^\S+\s/, ''))
const body = [
  '提交：' + head,
  '',
  note || head.replace(/^\S+\s/, ''),
  '',
  '打包备份：备份/' + zipName
]

if (DRY) {
  console.log('\n[dry-run] 会打 tag：' + title)
  body.forEach(l => console.log('   ' + l))
  console.log('\n[dry-run] 结束，什么都没改。')
  process.exit(0)
}

const tagArgs = ['tag', '-a', 'v' + version, '-m', title]
body.forEach(l => tagArgs.push('-m', l))
git.apply(null, tagArgs)
console.log('  ✓ 本地 tag 已建： v' + version)

/* ---------- 4. 推送 ---------- */

process.stdout.write('推送到 GitHub…')
try {
  git('push', 'origin', 'v' + version)
} catch (e) {
  die('推送失败，tag 已在本地建好，修好网络后手动推：git push origin v' + version + '\n' + (e.message || ''))
}

// 回读远端，确认推上去的是这一版
const remote = git('ls-remote', '--tags', 'origin')
const okTag = remote.indexOf('refs/tags/v' + version + '^{}') >= 0
console.log('\r  ✓ 远端已确认： refs/tags/v' + version)
if (!okTag) die('远端找不到 v' + version + '^{}，可能是轻量 tag，检查一下。')

/* ---------- 汇报 ---------- */

console.log(
  [
    '',
    '完成。',
    '  备份  ' + zipPath,
    '        ' + (size / 1024).toFixed(1) + ' KB，含 .git 历史',
    '  tag   v' + version + ' → ' + head,
    '        说明：' + title,
    '  远端  github.com/singrockzhou/inspirations-anytime  (refs/tags/v' + version + ')'
  ].join('\n')
)
