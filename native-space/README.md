# Space Native

Space 的 Rust 桌面客户端，当前使用 **winit + egui + 直接 Metal 渲染**，先面向 Apple Silicon macOS。当前按单机游戏运行：无需登录，世界、背包和编辑保存在本地；本阶段不接入联网服务。

**这是可以运行、编辑和执行实体的第一阶段实现，尚未完成所有功能移植，也还不是纯 Rust 引擎。** 完整功能范围和缺口见 [MIGRATION.md](MIGRATION.md)。地形生成、实体物理和 AssemblyScript 执行目前通过独立 Node 进程复用现有引擎；窗口、GPU 渲染、网格生成、地形编辑、文件协议和本地存档由 Rust 实现。

## 启动

从仓库根目录执行，或双击 `launch.command`：

```sh
./native-space/launch.command
```

默认以 **Ultra 最高画质**打开 Aether Archipelago：100% 原生分辨率、4× MSAA、4096 阴影、HDR、云层、接触阴影、光束、泛光、AgX 与 FXAA。全世界远景在后台生成；Settings 显示加载区域和实际 LOD，达到 128/128 后再观察稳定性能。详见 [渲染验证](RENDERING.md)。也可以指定世界：

```sh
./native-space/launch.command --world=nature
./native-space/launch.command --world=copper-metropolis
```

默认启用每实例 32 面成组绘制、远景每 16 面的保守剔除和无损 16 字节面记录；移动时使用有序层级筛选、4 个固定工作线程和复用的 CPU 可见列表。主视角与阴影分别计算可见列表，不改变分辨率、LOD 或 Ultra 特效；无法无损打包的几何保留原格式。

脚本会安装隔离在 `.toolchain/` 中的 Rust 工具链、下载锁定的 Cargo 依赖、准备出生点地形，再构建和打开 `build/Space Native.app`。已有构建时可以直接打开该应用。

依赖：Apple Silicon macOS、Xcode Command Line Tools、仓库已安装的 npm 依赖、Node（与 engine 要求一致：24.22.1 或 26.12.1 系列）、`protoc`。本机已用 Rust 1.99.1 和 Apple M1 Pro 构建验证。Metal 着色器在运行时编译，不需要完整 Xcode 的离线 Metal 编译器。

这是开发应用包，仍依赖当前仓库中的 `engine/`、Node 和生成数据，**不能把 `.app` 单独拷走当作发行包**。构建时记录 Node 的绝对位置，解决 Finder 缺少 shell PATH 的问题；运行时可通过 `SPACE_NODE` 覆盖。

## 可以操作的功能

- 三个现有世界的近处地形按需加载；标准方块、0.125 m 微方块、精确环面近场修正、体积远景、Ultra 灯光和材质。
- 建造、擦除、涂色、取色、两角点矩形选区，复制、剪切、填充、删除、旋转复制的方块、地形撤销/重做。
- 导入和导出 inventory v8 `.edpb`：BlockSet、Entity、Item、ColorSet；本地背包。
- 从选区创建实体模板；放置、复制、移动、旋转、删除实体；查看组件层级、编辑名称、BodyConfig 和脚本。
- Run/Stop、共享引擎的地形/实体物理与约束、AssemblyScript 沙箱、编译错误和脚本日志、座位驾驶输入。几何在变化时上传，运行中更新组件矩阵。
- 独立原生存档、自动保存、PNG 截图。保存的是地形编辑、构造态实体、背包和相机；尚未保存脚本变量和完整模拟检查点。

简单体验：Backpack → **Load example entity** → 点击背包条目装备 → Enter 进入控制 → 左键放置 → Esc → Entities → 选择实体 → **Run physics & scripts**。示例含两个组件、铰链、座位、发光装饰和脚本。

默认 HUD 使用深色青绿主题，底部是与 Web 顺序一致的七槽工具栏。默认角色皮肤随程序打包，复用 `client/skin_D2A9EB7A.png`，支持第一人称手臂、第三人称背面/正面、简单行走摆动和乘坐姿态。F5/F3 切换视角，视角写入本地存档；人物比例/覆盖层仍是原生简化实现。

点击场景或按 Enter 进入控制，Esc 释放鼠标并取消正在抓取的实体。WASD 移动，Space/Q 升降，Shift 加速，F 切换飞行/简化行走，Home 返回出生点。B/E 打开背包，O 打开设置；顶部 Tools 打开工具参数。

| 按键 / 工具 | 当前单机操作 |
| --- | --- |
| 1 选择器 | 左键定两个角，显示轮廓；Ctrl/Cmd+C/X 复制/剪切，Delete 删除选区 |
| 2 锤子 | 装备背包内容或 Ctrl/Cmd+V 进入预览；左键放置，右键取消；R 旋转复制的方块 |
| 3 扳手 | 对实际实体面拾取；按住左键抓取、滚轮调距离、R 旋转；松开提交、Esc 取消；双击启停，右键检查 |
| 4 铲子 | 按住左键移除、右键建造标准方块；连续笔刷合并为一次撤销 |
| 5 微雕 | 0.125 m 雕刻/建造；雕刻标准方块时先展开为微体素，撤销恢复原方块 |
| 6 画笔 | 按住左键涂色，右键取色与材质 |
| 7 建模 | 向已选中的停止实体添加装饰立方体；Tools 调尺寸、颜色和材质，右键打开实体属性 |

Tab（控制中）切换 1 m / 0.125 m 网格，Ctrl/Cmd+Z / Shift+Ctrl/Cmd+Z 撤销/重做地形，Ctrl/Cmd+S 保存，F12 截图。V 在 5 m 内进入座位，再按 V 下车。松开鼠标或切换工具会结束连续笔刷，失去窗口焦点会释放控制。

工具栏已经接通基本编辑闭环，仍未完成 Web 全部工具语义：扳手的组件合并/拆离、支点编辑与完整变换控件、实体编辑统一撤销、任意实体模板旋转、复杂建模及选区形状仍待迁移。当前行走碰撞不等同于 Web 玩家控制器；完整 Ultra 对齐与复杂透明排序仍以迁移表为准。

## 验证

```sh
sh native-space/tools/bootstrap-rust.sh --checks
sh native-space/tools/check.sh
```

检查包含 Rust 格式、Clippy、单元/集成测试、适配器 TypeScript 严格类型检查以及真实共享引擎的 Node 集成测试。测试覆盖跨语言 protobuf 字节、微格覆盖/撤销、接缝选区、原子粘贴、存档、Rust/Node IPC、刚体落地、脚本执行/错误和组件座位。

GPU 验证需要本机 Metal 访问权限：

```sh
sh native-space/tools/cargo.sh build --release --offline
native-space/target/release/space-native --smoke --world=aether-archipelago
```

输出在 `results/aether-archipelago-smoke.{png,json}`，包含实际 GPU、面数、draw calls 和 GPU 时间。这是运行正确性验证，**不能用于声称比 Web/Godot 快**：不带 `--lod-zones=128` 的 smoke 只渲染近景，且未与 Web 统一完整游戏工作负载。性能比较必须统一相机、分辨率、LOD、材质、抗锯齿和工作负载。

三项优化的同画质对照（运行前关闭原生窗口）：

```sh
native-space/target/release/space-native --profile-optimized --world=aether-archipelago --lod-zones=128
```

输出 `results/aether-archipelago-optimized-profile.json` 及七组优化前后 PNG；包含 720p / 1440p 静态采样、连续移动和材质/接缝/过渡区域检查。

本轮 CPU 剔除优化单独复现：

```sh
native-space/target/release/space-native --profile-culling --world=aether-archipelago --lod-zones=128
```

输出 `results/aether-archipelago-culling-profile.json`；对比上一版线性细粒度剔除和当前层级/并行路径，包含两轮移动采样及逐帧有序可见列表断言。

## 目录与数据边界

| 路径 | 用途 |
| --- | --- |
| `src/metal_renderer.rs`, `shaders/space.metal` | 直接 Metal 绘制、GPU 缓冲、UI、读回截图 |
| `src/world.rs`, `geometry.rs`, `streaming.rs` | Rust 体素数据、贪心网格、接缝、流式加载 |
| `src/editor.rs`, `camera.rs`, `app.rs` | 原生编辑、输入、窗口和界面 |
| `src/protocol.rs`, `build.rs` | 从仓库规范 `.proto` 生成并验证 Rust 协议 |
| `src/storage.rs` | 原子写入、压缩存档和世界来源验证 |
| `src/runtime.rs`, `tools/runtime-*.ts` | 临时独立进程模拟接口 |
| `src/distant.rs`, `tools/distant*.ts` | 生产体积 LOD、源缓存预算、编辑覆盖与有界跨进程传输 |
| `tools/terrain.ts` | 复用生产生成器导出和按需补充地形 |
| `tests/`, `examples/` | 跨语言固定样例和集成测试 |

`data/`、`saves/`、`exports/`、`results/`、`build/`、`target/` 和 `.toolchain/` 均为本目录内的生成内容。原生存档不覆盖浏览器或 Godot 数据。更换生成器源码会触发来源校验，不能直接把旧存档套到新地形上。

实体脚本仍由现有 AssemblyScript/Wasm 沙箱执行，没有给脚本添加文件、进程或网络能力。适配器不监听 HTTP 端口；主进程通过有界 stdin/stdout 通道通信，脚本和物理不会阻塞 Metal 主线程。联网、账号和市场尚未接入。
