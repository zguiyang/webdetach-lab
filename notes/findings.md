# Findings

## 实验目标

复刻 https://www.made-in-china.com/ 首页。

## 使用的工具

- **agent-browser** v0.27.3（首选）→ 被反爬拦截（Forbidden）
- **playwright-cli** v0.1.14（备用）→ 被反爬拦截（Forbidden）
- **curl**（获取服务器 HTML）→ 成功（200 OK，400KB）

## 成功步骤

- curl 成功获取服务器 HTML（SPA 外壳页面）
- 从 HTML 中提取了 1426 个资源引用
- 识别了 57 个源站域名
- 截图保存（虽然内容是 Forbidden 页面）
- site.json 正确记录了捕获状态

## 失败或遗漏

- **浏览器渲染被反爬拦截**：两个浏览器工具都无法获得渲染后的 DOM
- **Network 请求数为 0**：反爬拦截发生在资源加载之前
- **Console 日志无法捕获**：同上
- **动态资源无法发现**：无法执行滚动和交互
- **完整页面截图无效**：截取的是 Forbidden 页面

## 重复出现的问题

- made-in-china.com 使用 Focus Captcha (captcha.vemic.com) 检测 headless 浏览器
- 上次实验（2026-06-25 14:44）同样被拦截
- 纯 curl 可以获取服务器 HTML，但浏览器工具全部失败

## 是否需要增加脚本

暂不创建脚本。当前问题是工具级别的反爬拦截，script 无法解决。

## 下一步调整

- 项目已统一为 playwright-cli 连接本地 Chrome（不再使用 agent-browser）
- 用本地 Chrome 复用的方式绕过反爬（用户已在 Chrome 中正常打开页面）
- 选择无反爬保护的页面验证完整流程
