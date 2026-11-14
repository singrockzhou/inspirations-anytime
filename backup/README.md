# 开发版备份（dev 分支）

这个目录只在 `dev` 分支上存在，`main` 没有——源码仓库不该长期扛二进制包。

| 文件 | 说明 |
|---|---|
| `inspirations-anytime-v1.8.3-20261114.zip` | 2026-11-14 的 v1.8.3 完整现场，1.56 MB，**含 `.git` 历史** |

## 为什么含 `.git`

源码 90 个文件丢了还能从 GitHub 拉回来，但"当初到底提交了什么、按什么顺序改的"
只有本地历史知道。多花 800 KB 换一个能完整还原的现场。

## 怎么还原

```bash
unzip inspirations-anytime-v1.8.3-20261114.zip
cd 灵感随时记-完整版
git log --oneline -5      # 历史、分支、tag 都在
```

解出来就是一个能直接 `git push` 回 GitHub 的完整仓库，不需要再做什么初始化。

## 与 tag 的关系

同名版本在 GitHub 上有对应的 annotated tag `v1.8.3`（指向 `fa82bdb`），
tag 里带着这次改了什么；zip 是"代码 + 历史"的离线副本。两者互为备份：
GitHub 挂了有 zip，本机挂了有 tag + `git clone`。
