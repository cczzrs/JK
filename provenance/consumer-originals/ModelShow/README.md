# ModelShow

ModelShow 是自定义 JK 节点网络的执行与 3D 展示工具。支持 FIFO 执行追踪、节点详情、六种布局、图片像素输入、RGB 输出画板和共享模型池。前端使用原生 HTML/CSS、JavaScript ES modules、Three.js WebGPU 与 Vite。

## 本地运行

需要 Node.js 22.12+、pnpm，以及支持 WebGPU 的浏览器。浏览器无法初始化WebGPU时显示提示，不切换到WebGL。

```sh
pnpm install
./dev.sh
```

默认打开终端输出的 `http://127.0.0.1:5173/`。需要共享模型池时，在另一终端运行 `./dev.sh api`；未连接后端仍可进行本页导入、模型切换和下载。

```sh
./dev.sh build
./dev.sh preview
```

构建后也可运行 `./dev.sh serve`，在本地提供前端及持久模型池。命令区别和文件位置见[开发维护](docs/development.md)，线上Worker与R2说明见[模型池与托管](docs/hosting.md)。本地命令不公开发布网站。

## 使用入口

- **模型管理**：导入、切换、编辑和下载；无效JSON 保留当前有效模型。共享临时模型公开管理，永久模型入池/删除需管理员口令。
- **发送与播放**：输入Xi JSON后发送，支持暂停、单步、倍速和跳过动画；查看完整虚拟队列、最近60条历史及节点求值步骤。
- **图片输入**：基础图片或本地PNG/JPEG/WebP提取像素并填入Xi，填入后需单独发送。
- **输出渲染**：将Yi组合为RGB灯通道；灯编辑为草稿，点击“应用到此灯”保存，导出只包含已应用配置。

默认图片选区3×3；新画板3×3、关闭、缩放3倍；布局5D、播放1倍且跳过动画。旧画板缺少scale时保持1倍兼容规则。

## 项目结构

```text
index.html              固定界面与模板
src/
  main.js config.js style.css
  core/ input/ output/ models/ scene/
server/                 本地服务、Sites Worker与R2
assets/                 图片与图标（Vite 构建资源）
public/                 模型池种子
scripts/                构建与维护脚本
tests/                  分组测试、fixtures、helpers和bench
docs/                   使用、契约、维护与验证记录
```

| 要修改什么 | 入口 |
| --- | --- |
| 界面结构、固定选项、变长行模板 | `index.html` |
| 样式、颜色、尺寸与窄屏适配 | `src/style.css` |
| 默认值与限制 | `src/config.js` 的只读 `APP_CONFIG` |
| 交互与数据更新 | `src/main.js` 及对应功能目录 |
| 模型执行语义 | `src/core/` |
| 模型池服务和R2协议 | `server/` 与 `src/models/model-pool.js` |

JS只克隆HTML模板、填值和绑定事件；选中/异常通过class，固定外观归CSS。具体动态变量、控制器生命周期、配置兼容规则见[开发维护](docs/development.md#界面维护边界)。

## 文档与验证

- [模型格式与执行语义](docs/model-format.md)：顺序J/K、FIFO、状态、标签与异常隔离。
- [操作说明](docs/usage.md)：播放、图片输入和画板配置格式。
- [场景与布局](docs/rendering.md)：1D～5D/自动、相机、全屏与渲染边界。
- [逐文件清理记录](docs/project-file-audit.md)：每个项目文件的保留、移动或移出理由。
- [开发维护](docs/development.md)：目录职责、构建预览、定向测试与性能入口。
- [模型池与托管](docs/hosting.md)：共享管理、离线恢复、HTTP版本和Sites R2存储。
- [JK 空间对齐记录](docs/jk-space-alignment-2026-10-02.md)：2026-10-02 的改动、199 项相关功能测试及 Chrome 检查范围。

按改动范围运行相关测试，前端验收使用外部 **Chrome**。不默认跑全流程回归，不自动提交Git或公开发布。历史验证记录保留执行日期与证明范围，不代表当前工作区全量验收。
