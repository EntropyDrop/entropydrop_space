# 完整迁移清单

> UI update: [Rust offline UI and interactions](UI_MIGRATION.md) supersedes the
> UI/input/import/tutorial rows in the original baseline table below. Engine
> migration remains in progress; the Node physics and AssemblyScript boundary
> is still present. The original table is retained as the broader engine backlog.

当前目标是把 Space 的单机玩法与编辑功能迁到原生桌面端，并逐步把计算引擎迁到 Rust。按用户最新要求，本阶段不接入账号、多人、市场等在线服务。**当前尚未达到完整迁移完成条件。** “桥接”表示调用现有 TypeScript/AssemblyScript 引擎，不能计为 Rust 实现；“部分”表示已有可用路径，但没有覆盖 Web 版的全部操作与行为。

功能基线来自 `client/src/ui/react/store/UiPorts.ts`、`SpaceUiStore.ts`、`client/src/engine/controls/`、`engine/src/contraption/`、`engine/src/physics/`、`engine/src/scripting/` 和 `proto/`。本次只在 `native-space/` 中新增实现，未覆盖这些目录中的现有修改。

| 功能 | 当前状态 | 完成迁移还需要的工作 |
| --- | --- | --- |
| macOS 原生窗口、输入、剪贴板、截图 | Rust，可运行 | 系统文件对话框、输入法/无障碍、完整快捷键回归、多窗口 |
| Windows / Linux | 未实现 | 用户当前优先性能，后续决定是否增加后端 |
| Metal 体素与 UI 渲染 | Rust，可运行；32 面分组、16 字节面记录、16 面剔除、有序层级与父节点判断复用、4 线程筛选、粗剔除/排序结果复用、精确阴影缓存与三帧可见列表/UI 缓冲复用已默认启用 | GPU 剔除、间接绘制、完整游戏帧调度优化 |
| 环面世界和近场修正 | Rust，已对齐 Jacobian；20 个 Web 黄金坐标通过 | GPU 极端角度图像回归 |
| 近处地形、微方块流式加载 | Rust 数据/网格；生成器桥接 | 生成器纯 Rust、加载取消、缓存淘汰策略和负载测试 |
| Nature / Copper Metropolis / Aether Archipelago | 生产生成器桥接 | 全种子黄金数据与 Rust 生成器逐块对照 |
| 全世界远景、细 LOD、遮罩交接 | 生产体积算法桥接，Metal 绘制；已接入 128 区域、最高预算、遮罩与编辑覆盖 | 渐变交接、快速移动/重建/淘汰压力测试；纯 Rust 选择器 |
| 灯光、阴影、透明、特效 | 原生 Ultra 主链已实现，默认最高画质 | 完整 Ultra 黄金图像回归、复杂透明相交；见 RENDERING.md |
| 飞行、行走、跳跃 | Rust，部分 | 完整玩家碰撞、台阶、实体碰撞、FOV；第三人称已接入地形相机避障 |
| 标准/微格建造、擦除、取色、涂色 | Rust，部分 | 已支持连续笔刷、整笔撤销、取色、目标轮廓；仍需渐变和全部 Web 笔刷语义 |
| 矩形选区、复制/剪切/删除/填充/涂色 | Rust，部分 | 两角轮廓已接入；仍需全部选区形状、连通选择、全选、实体混合选区 |
| 地形撤销/重做 | Rust，可运行 | 统一实体、背包和复杂建模事务历史 |
| Hammer 放置工作流 | 部分（半透明几何预览、微格锚点、粘贴/方块旋转） | 任意实体/Item 旋转与世界约束完整回归 |
| Wrench 抓取、支点、吸附、合并、拆离 | 部分：真实面拾取、抓取、网格定位、旋转、取消、双击启停、右键检查 | 支点、组件合并/拆离、表面吸附和完整变换控件 |
| 实体放置、复制、位置/旋转、删除 | 部分；已接入场景真实面拾取 | 变换控件、编辑中的统一历史记录 |
| 组件树、名称、BodyConfig | 部分 | 装饰立方体添加已接入建模工具；仍需新增/删除/重父级、子树安装/复制和完整装饰编辑 |
| 点/铰链/焊接约束 | 引擎桥接，可读取并模拟 | 原生约束编辑 UI、世界锚点、完整车辆/铰链回归 |
| 物理、碰撞、CCD、睡眠 | 引擎桥接 | 共享测试迁为 Rust 对照测试，再替换求解器 |
| AssemblyScript 编辑与 Run/Stop | 引擎桥接，可运行 | 原生 SDK 编辑体验、全部 host API 对照、Rust Wasm 宿主 |
| 脚本错误、控制台 | 原生 UI + 引擎桥接 | 性能统计、精确源码定位与运行检查点恢复 |
| 本地实体消息 | 引擎桥接 | 端到端消息行为测试、原生点击事件、服务器路由 |
| 座位和驾驶输入 | 部分 | 完整上车距离、人物姿态、自由视角/固定朝向和下车碰撞 |
| 角色、皮肤、头像、动画 | 部分：本地默认皮肤、六部位人物、第一人称手臂、三视角、行走/乘坐姿态 | Web CuteCharacter 比例与覆盖层完全一致、自定义皮肤和头像编辑、持握工具模型 |
| 声音、音乐、粒子 | 未实现 | 原生音频、实体声音接口与特效渲染 |
| `.edpb` BlockSet / Entity / Item / ColorSet | Rust，代表性字节对照通过 | 扩大恶意输入、版本迁移和 canonical 编码的全量对照 |
| 本地背包 | Rust，部分 | 七槽工具栏与背包装备/预览已接通；仍需 v10 槽位、99/198 槽迁移、排序/命名、渐变编辑 |
| 原生保存/恢复 | Rust，部分 | 模拟姿态、脚本变量/邮箱检查点、旧浏览器数据迁移 |
| 模型导入/体素化、文字生成 | 未实现 | OBJ/STL/GLTF 等现有导入链路和字体生成 |
| 导航、地名、地图/小地图 | 未实现 | 原生世界索引与 UI |
| 新手教程和全部课程 | 未实现 | 课程状态机、引导、示例实体、操作验收 |
| 登录、账号、个人数据 | 未实现 | 原生认证、凭据存储、会话刷新与错误恢复 |
| 多人、在线地形/实体同步 | 未实现 | 连接协议、AOI、租约/权限、冲突、离线重连 |
| 市场、搜索、下载、发布 | 未实现 | API、预览、账号权限、上传交互 |
| 托管、额度/账单、密钥管理 | 未实现 | 原生 API 与 UI；不得用本地模拟冒充服务器托管 |
| AI 建造、行为 Agent、生成任务 | 未实现 | 现有任务协议、进度/取消、结果编辑和账号计费 |
| 发布与更新 | 开发包 | 独立资源打包、签名、公证、版本迁移、安装/更新 |

## 当前执行边界

```text
winit / egui
    │ 输入与编辑
    ▼
Rust World + Editor + Protobuf + Save
    ├── Rayon 网格任务 ──► Metal 常驻面缓冲 + shader ──► CAMetalLayer
    ├── 地形缓存请求 ────► Node 生产生成器（过渡）
    └── 有界模拟请求 ────► Node 共享物理 + AssemblyScript/Wasm（过渡）
                          │ 组件矩阵、变更几何、地形修改、日志
                          └──────────────────────────────► Rust / Metal
```

模拟接口最多一个请求在途，不把每帧完整几何重新发给 GPU。Node 仅承担过渡计算，没有渲染窗口或 WebView。停止实体、重新开始脚本、删除/重建定义均通过共享引擎执行；Rust 编辑状态与模拟检查点仍需要进一步统一，现阶段不能宣称完整保存正在运行的世界。

## 接下来的实施顺序

1. 优先完成渲染验收：Ultra 黄金图像、远近过渡、完整世界移动轨迹和性能采样。
2. 完成离线编辑闭环：精确实体拾取、完整选择/预览、实体历史、Wrench/Hammer、组件/约束/装饰编辑、角色与驾驶。
3. 达到渲染可比较条件：相同细 LOD、远景、遮罩、光照、抗锯齿和相机轨迹；采集 CPU/GPU 的 p50/p95/p99 与输入延迟。
4. 在线协议暂不纳入当前阶段；单机流程不依赖登录、同步、市场或托管。
5. 用黄金数据与共享引擎测试逐模块替换 Node：地形、实体图、动作协议、物理、Wasm 宿主；替换前后数据和行为必须一致。
6. 完成全部课程/导入/账号场景和长时间恢复测试，移除过渡依赖，制作可独立分发的应用包。

## 完成判定

完整单机迁移必须同时满足：表中离线用户操作均有可用原生入口；原有文件协议、存档与脚本行为经过对照；单机关键工作流可在新客户端完成；性能基准使用同一工作负载。在线功能暂不纳入该验收。当前原生窗口和自动测试通过，不代表这些完成条件已经满足。


## Web behavior sync, 2026-11-02

G now assembles terrain selections in place into stopped, kinematic entities,
without automatically opening a panel; C edits the aimed entity. Assembly has
atomic terrain/entity undo and redo. Gravity transitions, automatic mass and
imported body settings match the shared Web behavior. The tutorial system and
course-specific nameplates were subsequently added in the Rust UI migration.

Native now restores verified local coarse coverage before full refinement,
retains last-good geometry on adapter failures, and treats corrupt/missing
coverage as optional cache misses. Edited zones skip base coverage. The original
quality budgets and final LOD planner are unchanged. Near requests reuse demand
ordering; full-source loading no longer waits 500 ms between completed batches.
Details and measured limits: [native sync report](../client/docs/performance-native-sync-2026-11-02.md).
