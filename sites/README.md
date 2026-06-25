# Sites

所有复刻的网站统一存放在此目录，每个网站一个独立目录。

通过 `pnpm site:serve -- <site-name>` 启动本地 HTTP Server 访问。

```bash
pnpm site:serve -- example-site
pnpm site:serve -- example-site --port 3000
pnpm site:serve -- example-site --port 0
```

## 目录格式

```text
sites/<site-name>/
├── site.json                      # 网站元数据与状态
├── index.html                     # 入口页面（捕获阶段 = rendered.html 副本）
├── capture/                       # 原始捕获产物（只读）
│   ├── rendered.html              # JS 执行后的 DOM
│   ├── visible-text.txt           # 页面可见文本
│   ├── resources.json             # 资源清单
│   ├── console.json               # Console 日志
│   ├── network.json               # Network 请求记录
│   └── screenshots/
│       ├── initial.png            # 首屏截图
│       ├── full-page.png          # 完整页面截图
│       └── after-scroll.png       # 滚动后截图
├── assets/                        # 本地化后资源存放
│   ├── css/
│   ├── js/
│   ├── images/
│   ├── fonts/
│   ├── media/
│   └── other/
├── data/
│   └── responses/                 # 接口 Mock 响应
└── reports/
    └── capture-summary.md         # 捕获摘要报告
```

## 规则

- 一个目录只对应一个目标网页副本
- `capture/` 只读保留原始捕获结果
- `index.html` 捕获阶段为 `rendered.html` 副本，`site.json.localized` 为 `false`
- 目录之间不得共享业务资源
- 用户可以直接删除、移动、压缩或备份整个网站目录
- 本地引用使用相对路径（`./assets/css/` 等）
- 本地页面必须通过 HTTP Server 访问，不使用 `file://`
