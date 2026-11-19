# dsh-go MCP 管理器

面向 **dsh-go 原生界面**的 MCP 管理适配插件。添加自己的 MCP 服务，在手机里管理连接、工具和调用策略。

**支持范围仅限 dsh-go；不保证其他客户端、桌面端、网页版或操作系统可用。** 本项目是社区插件，不是 dsh-go 官方组件，也不是独立运行的通用 MCP 客户端。

当前版本：**0.5.4** · MIT License

## 功能

- 连接 Streamable HTTP、旧版 SSE，以及当前主机上的本地 stdio 服务。
- 添加、编辑、启停、移除服务器；等待工具与凭据服务就绪后自动连接。
- 自动发现工具，按名称或描述搜索、筛选、分页；支持逐工具启用和审批策略。
- 原生表单配置请求头或环境变量；新填写的值保存在 DSH 凭据库，服务器配置只保存引用。
- 测试连接并刷新工具目录；健康连接不因测试而中断在途调用。
- 活动页查看最近 20 次调用的耗时、结果类别，不记录参数、返回正文或凭据；重启后清空。
- 查看资源和提示词目录。

不内置服务商专用接口。普通 REST API 地址需要先由服务方提供 MCP 接口，才能添加。

## 兼容环境

已验证环境为 dsh-go **1.1.0**、DSH **0.2.2-rc.1**、Node.js **24.22.1**，Android 本机引擎。

- 原生清单最低 App 版本为 1.1.0。
- 包要求 Node.js >=22.19.0；宿主依赖按当前已验证的 DSH 版本固定。
- 需要宿主提供 `dshGo`、`tools` 和 `credentials` 服务。
- 不承诺未来 DSH/App 版本自动兼容。报告问题时请提供实际版本。

## 插件市场

市场提交使用 npm 精确版本 `local-mcp-manager@0.5.4`。条目通过市场检查并合并后，可在 dsh-go 插件市场搜索「MCP 管理器」安装。首次上架状态以市场仓库 PR 与实际目录为准；这不是官方插件，也不保证其他平台可用。

## 安装

在 **dsh-go 当前连接的主机终端**执行。以下命令安装到默认原生插件目录；已存在同名目录时请先检查自己的安装，不要覆盖用户配置。

```sh
DSH_DIR="${DSH_HOME:-$HOME/.dsh}"
PLUGIN_DIR="$DSH_DIR/dsh-go/plugins/local-mcp-manager"

git clone --branch v0.5.4 --depth 1 \
  https://github.com/Aouky7/dsh-go-mcp-manager.git "$PLUGIN_DIR"
cd "$PLUGIN_DIR"
npm ci --ignore-scripts
dsh plugin --profile web add "$PLUGIN_DIR"
```

入口：**输入框加号 → MCP**，或 **全部功能 / 对话详情的插件页 → MCP 管理器**。

这是指向安装目录的链接；使用期间不要删除或移动该目录。

### 更新已有安装

通过 Git 安装的用户可拉取指定版本，再在 App 的「引擎」页重启引擎：

```sh
DSH_DIR="${DSH_HOME:-$HOME/.dsh}"
cd "$DSH_DIR/dsh-go/plugins/local-mcp-manager"
git fetch --tags origin
git checkout v0.5.4
npm ci --ignore-scripts
```

非 Git 安装请先备份原插件目录，再按发布内容更新代码。**无需删除服务器配置或重新填写密钥。**

## 使用

1. 添加服务器，选择 HTTP、SSE 或本地 stdio。
2. 填写名称与 MCP 地址，或本地程序、参数及工作目录。参数每行一个，不额外加引号。
3. 到服务器的「设置 → 请求头 / 环境变量」配置鉴权或环境值。
4. 工具页的「测试连接」仅握手、读取目录，不执行工具。
5. 工具详情可以分别调整启用和审批；关闭插件额外审批仍遵守宿主权限策略。

请求头：`x-api-key` 通常填 Key 本身；`Authorization` 按提供方要求填写完整值。编辑时留空保留原值，输入新值才替换。**App 1.1.0 输入阶段文字可见，保存后不回显。**

0.5.2 的启动连接修复已由用户重启手机 App 后确认：已启用的 Exa 和 GitHub 服务自动恢复连接。0.5.3 延续该修复。

## 数据与行为边界

- 服务器文件：`$DSH_HOME/dsh-go/plugin-data/local-mcp-manager/servers.json`。
- 新保存的请求头/环境变量值交给宿主凭据库管理；本项目不宣称对凭据库做了独立加密。
- 本地 stdio 会在当前主机执行指定程序，请只添加可信程序。插件不是程序沙箱。
- 显式「重新连接」会中止旧连接上的在途调用；失败的工具调用不会自动重放。
- 不提供 OAuth 登录流程。资源与提示词目前只展示目录，不提供内容读取或执行入口。
- 最多 32 个服务器；每服务请求头与环境变量各最多 16 项；原生单次提交预算为 4 KiB。
- 工具参数定义最多预览 7000 个字符；较大页面通过原生数据刷新加载。
- 超大表单、服务端协议差异、网络和服务方限流仍可能导致失败；本项目不保证任意 MCP 服务兼容。

遇到凭据不可用时，先确认宿主凭据服务正常，再尝试该服务的「重新连接」。401/403 需要检查鉴权和权限，429 需要检查额度或稍后重试。

## 验证与开发

```sh
npm ci --ignore-scripts
npm run test:core
```

完整原生测试还需要 dsh-go 自带的 `dsh-go-plugin` 开发工具包。默认从 `${DSH_HOME:-$HOME/.dsh}/skills/dsh-go-plugin/kit` 查找，可用 `DSH_GO_PLUGIN_KIT` 指向其他 kit 目录。

```sh
npm test

DSH_DIR="${DSH_HOME:-$HOME/.dsh}"
node "$DSH_DIR/skills/dsh-go-plugin/kit/bin/check.mjs" \
  . --load --app 1.1.0
```

0.5.3 发布前在隔离的干净安装中通过 **70 项测试**，覆盖真实本地 HTTP MCP 握手/调用、凭据、工具权限、启动时序、分页搜索、原生桥接效果预算、设置版本和删除目标校验。完整自动检查不能替代所有 Android 设备的点击、键盘、滚动与视觉验收。

依赖锁定在 `package-lock.json`。升级兼容的 MCP SDK、Zod 和 Undici 修复版本后，发布前 `npm audit` 报告为 0 项已知漏洞；这不代表不存在未知漏洞，也不代表已审计整个宿主引擎。

## 反馈

请通过 [Issues](https://github.com/Aouky7/dsh-go-mcp-manager/issues) 提供 App/DSH/Node 版本、连接方式、复现步骤和脱敏错误提示。不要上传 Key、Token、完整凭据库或包含私人参数的配置。

功能与修复记录见 [CHANGELOG.md](CHANGELOG.md)。第三方依赖说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## License

[MIT](LICENSE)，Copyright (c) 2026 Aouky7。依赖遵守各自许可证。
