# Capture Prompt

## 浏览器启动

```bash
playwright-cli -s=webdetach open "<TARGET_URL>" \
  --browser=chrome --headed --persistent \
  --profile=.webdetach/browser-profile
```

启动前 MUST 执行 `playwright-cli open --help`。后续命令统一加 `-s=webdetach`。

## 页面检查

等待网络空闲后，获取 URL、title、body 内容。遇 Cookie 同意或验证码，提示用户在 Chrome 窗口处理。

## 站点名称

根据 URL 生成：主机名 + 路径关键部分，仅允许 `a-z`、`0-9`、`-`、`_`。目录已存在时追加 `-2`、`-3` 或时间戳。

## 目录创建

```bash
mkdir -p sites/<site-name>/capture/screenshots
mkdir -p sites/<site-name>/assets/{css,js,images,fonts,media,other}
mkdir -p sites/<site-name>/data/responses
mkdir -p sites/<site-name>/reports
```

## site.json

写入元数据，status `CAPTURING` → `CAPTURED` / `CAPTURED_WITH_GAPS` / `FAILED`。

## 截图

```bash
playwright-cli -s=webdetach screenshot --filename <path>        # 首屏
playwright-cli -s=webdetach screenshot --full-page --filename <path>  # 完整页面
```

## 渲染 HTML / 文本

```bash
playwright-cli -s=webdetach eval "document.documentElement.outerHTML"
playwright-cli -s=webdetach eval "document.body.innerText"
```

复制到 `index.html`，`localized: false`。

## Network / Console

```bash
playwright-cli -s=webdetach requests --json
playwright-cli -s=webdetach console --json
```

## 交互

滚动、hover 导航菜单、展开下拉、切换 Tab/Accordion/Carousel、打开展示型 Modal。观察新增请求与资源。保存 `after-interactions.png`。

## 结束

关闭 Playwright CLI 会话即可。Profile 保留在 `.webdetach/`。

## 禁止

- 使用 agent-browser 或其他浏览器工具
- 修改 HTML/CSS/JS
- 重写资源路径
- 导出 Cookie/Storage
- 访问用户日常 Chrome Profile
