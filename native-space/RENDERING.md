# 原生渲染对齐与最高画质验证

默认进入 **Ultra、原生窗口物理分辨率、100% 渲染比例**，不启用动态降分辨率。渲染由 Rust/Metal 执行；生产体积地形生成与 LOD 选择暂时通过独立 Node 进程复用，属于引擎桥接。

成组绘制、细粒度剔除、紧凑面存储现已默认启用。文末记录优化后的同画质对照；前面的历史基准保留原始测量口径。

## 当前主路径

| 功能 | 原生实现与对照来源 |
| --- | --- |
| 环面与近场修正 | `TorusWorld.ts` 的 frame × inverse Jacobian、96–256 m 过渡；20 个 Web 黄金坐标覆盖接缝、不同高度与过渡带 |
| 标准/微体素、实体组件 | 每实例 32 面，四顶点索引复用；无损 16 字节面记录，非精确格点保留 32 字节；1/8 m 环面坐标查表，实体变换使用插值 |
| 提交前可见性 | 远景每 16 面的包围球、法线锥、近景/编辑覆盖剔除；主视角和阴影视锥分别计算，缓存有序可见块列表 |
| 全世界体积远景 | 128 个真实区域；复用 `generateVoxelSurfaceZone` / `VoxelLodPlanner`，保留岛屿底面、侧墙和洞穴；相机移动重新选择 LOD |
| 最高细节预算 | 1 px² 目标、2048 chunks 距离、1024 MiB 源数据、512 MiB 几何预算；有效细分受预算限制时在 Settings 显示 |
| 远近交接 | 近景完成 GPU 上传才更新 RG8 遮罩；连续平面坐标在片元阶段确定归属，颜色与阴影通道共同使用；地形编辑覆盖也输入远景生成器 |
| 光照 | Ultra 8.2 点日照、半球光、补光；GGX，roughness 0.65 / metalness 0.15；4096 深度阴影与 PCF |
| 材质 | 普通、发光、1–100% 透明度；透明网格由远至近排序，关闭深度写入；发光表面/泛光亮度分别为 0.65 / 1.5 |
| 天空与 HDR | 程序化云层、太阳光晕；RGBA16Float；接触阴影、光束、双边深度上采样、距离雾、五级泛光、AgX、调色与暗角 |
| 抗锯齿 | 4× MSAA，深度取最小值 resolve，最终 FXAA；UI 在后处理之后绘制 |

世界首次打开会在后台生成远景缓存，Settings 中的区域数达到 **128/128** 才表示全世界来源已就绪。生成期间帧率包含 CPU、磁盘与上传竞争，不能作为稳定性能。缓存位于 `data/worlds/<world>/distant/<source_hash>/`；临时瓦片按进程隔离，最多一批请求与响应在途。

## 可复现测试

```sh
sh native-space/tools/check.sh
sh native-space/tools/cargo.sh build --release --offline

# 相同 Web 最高细节快照：720p / 1440p / 4K，无光照基线 + 原生 Ultra
native-space/target/release/space-native --benchmark

# 真实 Aether 世界，完整 128 区域，原生实体、近景、动态远景和 Ultra
native-space/target/release/space-native --smoke --world=aether-archipelago --lod-zones=128
```

GPU 测试要求本机 Metal 访问。每组先预热 24 帧，再采样 120 帧；测量阶段复用纹理与几何，排除 PNG 编码/读回。报告同时给出 GPU 时间和串行提交到完成时间，二者都不是屏幕显示 FPS。

`results/render-benchmark.json` 使用仓库中 `godot-space/matched-lod-fine/data` 的固定快照，逐文件检查 SHA-256、顶点/索引范围、245 个 draw 和 4,206,058 个三角形。无光照基线直接渲染至 sRGB BGRA8 的 4× MSAA 目标，保留原来的遮罩、背面剔除与相机。快照几何是在 720p 选择的，升至 4K 时保持几何不变。

快照的 Ultra 测试在同一批几何上运行原生特效，**不等于已经和 Web Ultra 逐像素对齐**。原快照没有材质 ID，不能恢复发光/透明材质；实际游览与 Aether 测试保留这些信息。快照也不测动态 LOD、生成、物理、UI 或输入延迟。

## 实测记录

设备：Apple M1 Pro；最高画质保持 100% 分辨率。以下是窗口验收修正前保存的离屏 GPU 时间（ms），不是显示 FPS；接触阴影重建修正后尚未重新采样这组基准。

| 固定 Web 铜城场景 | 无光照 p50 / p95 | 原生 Ultra p50 / p95 |
| --- | --- | --- |
| 1280×720 | 5.79 / 6.00 | 9.02 / 12.79 |
| 2560×1440 | 6.56 / 7.06 | 10.93 / 11.91 |
| 3840×2160 | 7.24 / 7.64 | 14.54 / 16.54 |

真实 Aether 完整 **128/128 区域**，720p Ultra：GPU **p50 12.49 ms / p95 13.43 ms**；常驻 11,239,907 个近远景面，205 次主场景 draw。最高预算已达到：远景 11,184,574 面，源数据 1023.99 MiB；请求 1 px²，预算约束下有效 5.82812 px²。这是完整来源加载后的稳定离屏渲染，不包含正在飞行时的生成、上传与 UI 开销。

固定快照与已有 Web 720p 参考图比较：RGB 平均绝对误差 **0.0403/255**，**99.920%** 像素各通道误差不超过 8/255。该验收只证明无光照几何/相机/遮罩基线接近，不能替代 Ultra 光照验收。

当前验证通过：28 个 Rust 测试、4 个 Node 测试、TypeScript 严格检查、Clippy、Metal shader/pipeline 编译与实际 GPU 输出。构建产物为 `build/Space Native.app`。

同一 8 区域 Aether 负载在查表优化前后：720p Ultra GPU p50 **32.72 → 8.26 ms**，优化后 p95 **8.71 ms**。几何细分仍为 1 px²，约 362 万远景面；未通过降低画质换取结果。这里包含不同实现的顶点复用、背面剔除和阴影工作，不应视为单个算子的微基准。

## 优化前的窗口验收（2026-10-31）

已打开最终构建的 `build/Space Native.app`，验证飞行移动、Esc 返回设置、Home 返回出生点、保存反馈与 F12 截图。应用保持在 Aether 的 Settings 页面，Ultra、VSync、原生 **1788×2178** 物理像素、100% 渲染比例；全世界 **128/128 区域**已加载，149 个常驻近景 chunk，待加载与网格任务均为 0。

验收时修正了两处问题：FPS 改为实际提交帧数除以经过时间，避免平均瞬时帧率夸大结果；接触阴影改为直接使用逆投影矩阵重建视空间位置，减少大尺度世界坐标的浮点误差及平面噪点。Settings 也显示实际渲染分辨率。

[最终窗口截图](results/capture-3468097b-5bba-4e6b-886a-046cf967c462.png)记录了 **82 帧提交/秒、GPU 15.69 ms**，可见 2,777,065 个面、163 次主场景 draw。它是包含 UI 的一次人工观察，不是长期采样的平均值、p50/p95 或显示器呈现帧率。异步提交与 GPU 时间也不能简单互取倒数。该窗口比 720p 基准更大，LOD 选择不同：请求 1 px²、预算约束下有效 53.38 px²，29 个区域受源数据预算限制，因此不能与离屏结果直接比较。结构化记录见 [window-verification.json](results/window-verification.json)。

## 尚未完成的对齐

- 云噪声、PCF 采样核、FXAA 与 Three 的实现存在细节差别；光照和完整 Ultra 画面仍需同相机黄金图像验收。Web Ultra 内部有 2560 像素长边限制，原生最高画质保持实际分辨率，因此不能直接用两边窗口 FPS 比高低。
- 窗口截图中的平坦物体仍可见轻微条带；本次验收未完成所有天空角度与材质组合的视觉检查。
- 远近遮罩当前在完成时切换，尚未迁移 Web 的抖动渐变交接；复杂透明几何相交仍受网格排序限制。
- 全区域冷启动、快速飞行、编辑后区域重建、长时间缓存淘汰还需要持续测试。当前源数据预算统计不包括 JS 索引、临时构建和进程运行时内存。
- 角色、粒子、选择轮廓、操作预览及其他编辑工具视觉元素仍见 `MIGRATION.md`，不能把地形主路径完成说成全部渲染功能已完全一致。

## 优化前的性能原因调查（2026-10-31）

调查时原生版迁移了画面主路径，却没有完整迁移 Web 版已有的性能路径。以下表格与阶段实验描述优化前的版本。两边都是 GPU 渲染，Web 版明确使用 WebGPU，不能把它当作由 JavaScript 在 CPU 上逐像素绘制的基线。已有 Web 铜城记录的约 120 FPS 是浏览器帧间隔；原生的离屏 GPU 时间不能直接与它计算加速比。

代码审计发现：

| 项目 | 当前 Web 路径 | 原生窗口默认路径 |
| --- | --- | --- |
| 远景面存储 | `VoxelFaceArena` 的 16 字节记录、共享存储页 | `Face` 32 字节，逐 mesh 分配缓冲 |
| 实例分组 | 默认每实例 32 个面 | 每实例 1 个面 |
| 提交前剔除 | 每 16 个面的包围球、法线锥、近远景覆盖测试与可见列表缓存 | 远景 tile 包围球；光栅阶段背面剔除、片元阶段覆盖遮罩 |
| 可见性元数据 | 使用 `VoxelLodTile.visibility` | Node 生成后，`tools/distant.ts` 未传给 Rust |
| Ultra 场景抗锯齿 | `CinematicEffects.sceneTarget` 没有设置 samples，当前 Three 将默认 0 转为单采样；最终 FXAA | HDR 场景强制 4× MSAA，再做 FXAA |
| Ultra 分辨率 | 内部最长边限制 2560 | 原生物理像素 100% |

最后一项不影响之前的 1788×2178 窗口（最长边小于 2560），不能用来解释那次窗口表现。4× MSAA 是已确认的工作量差异，但本次没有单独测其耗时。近景和远景来源都已有 greedy meshing，不能把问题简单归结为“完全没有合并面”；远景合并还受逐面颜色和环面弦误差限制（细 LOD 平面跨度限制约 8 m）。

本次增加了默认关闭的离屏诊断开关。运行前关闭原生窗口，避免同一应用的两个实例争用 GPU；真实 Aether 的 128 个区域全部就绪，LOD 在 720p 选择后固定，11239907 个常驻面，主场景提交 3681452 面，阴影提交 1023074 面。每个案例先预热 24 帧、记录 96 帧，做两轮；阶段复用实验第二轮反转顺序，每个变体前都重新跑完整基线。没有运行或编译第三方 GitHub 项目。

### 阶段对照

以下选取第二轮各变体与紧邻基线的 GPU p50，单位 ms。完整原始采样见 [render-profile.json](results/aether-archipelago-render-profile.json)。

| 诊断 | 720p 基线 → 变体 | 1440p 基线 → 变体 | 含义 |
| --- | --- | --- | --- |
| 不提交远景 | 12.71 → 0.91 | 14.75 → 2.08 | 移除大量可见内容，只用于定位远景工作量 |
| 重用静止阴影图 | 12.92 → 10.28 | 14.72 → 12.45 | 保留阴影采样，跳过阴影图重画 |
| 跳过后处理 | 12.52 → 12.01 | 14.74 → 13.07 | HDR 场景直接复制，画面改变 |
| 重用 AO/光束结果 | 12.75 → 12.50 | 14.88 → 14.56 | 相机、几何、天空时间固定 |
| 重用泛光结果 | 12.56 → 12.22 | 14.71 → 14.16 | 跳过提取和模糊，仍正常合成 |

这些差值不是独立 pass 时间，不能相加；GPU 工作重叠、缓存和系统负载都会影响结果。首轮 720p 泛光变体出现反向波动（13.01 → 14.94 ms），因此微小差值不作精确瓶颈排名。远景工作量和阴影的影响在两轮都明显，后处理不是本场景最主要的成本。移除远景的收益不代表可以保留画面获得同样加速。

### 同画质绘制分组实验

仅把每实例 1 面改为 32 面；保留原始面顺序、每面四个索引顶点、全部材质/环面计算、相同面数、4× MSAA、4096 阴影和完整 Ultra。两轮 GPU p50 的算术平均如下（不是合并采样的 p50）：

| 分辨率 | 每实例 1 面 | 每实例 32 面 | GPU 时间减少 |
| --- | --- | --- | --- |
| 1280×720 | 12.604 ms | 8.998 ms | 28.6% |
| 2560×1440 | 14.765 ms | 11.459 ms | 22.4% |

两种分辨率的第二轮输出 PNG 均逐像素一致：不同像素为 0，最大通道误差为 0。见 [topology-profile.json](results/aether-archipelago-topology-profile.json) 和 [图像比较记录](results/topology-image-check.json)。这验证了实例粒度是实际性能问题，不能据此宣称所有相机和运行负载均获得同样提升，也没有测得硬件占用率来断定具体调度原因。该实验当时只在诊断模式启用；现在已推广至默认路径，结果见下节。

复现：

```sh
sh native-space/tools/cargo.sh build --release --offline
native-space/target/release/space-native --profile-render --world=aether-archipelago --lod-zones=128
native-space/target/release/space-native --profile-quads --world=aether-archipelago --lod-zones=128
```

### GitHub 项目的实际借鉴点

- [Horizon](https://github.com/horizon-rust/horizon)：项目自己的 [9800X3D + RTX 5080 对比报告](https://github.com/horizon-rust/horizon/blob/main/benchmarks/perf/windows-9800x3d-5080-2026-10-29.md) 在 720p、8/16 chunks 下报告平均 FPS 比原版高 18–42%，加载约快 3–4 倍；32 chunks 海洋场景的低帧反而更差。千帧绝对数字与“平均 FPS 提升十倍”是不同结论。这是作者自测，本次未独立复现。其 [图形文档](https://github.com/horizon-rust/horizon/blob/main/docs/graphics.md) 的默认配置为原版观感、HDR/抗锯齿/远景 LOD 关闭；另一组巨大提升是两个 Rust 修订之间的比较，不能归因于从 Java 换成 Rust。
- [Minerust](https://github.com/B4rtekk1/Minerust)：公开架构明确采用压缩面记录、共享 GPU arena、compute 可见列表、Hi-Z 遮挡剔除、间接批量绘制和异步网格工作线程。这些才是应当借鉴的机制。README 的 200+ FPS 不能作为与本机、本世界、完整 Ultra 同负载的基准。
- [RustCraft](https://github.com/RustCraftMC/RustCraft-Public)：GPU 本地静态资源、异步 staging 上传、邻近 chunk 批处理；同时仍将 shader pack 支持标为 WIP，不能把普通方块世界的高 FPS 当作 Space Ultra 的同画质比较。
- [jtbirdsell/voxelcraft](https://github.com/jtbirdsell/voxelcraft)：其 Apple Silicon 60 FPS 档位明确减少射线数量与距离，并降低渲染分辨率；项目也提供硬件光追、DLSS、插帧等其他路径。不同平台和画质的 FPS 不能直接互比。

优先顺序应是把成组绘制推广并验证多场景；补回现成的 16 面可见性元数据和提交前剔除（主相机、阴影相机分别判断）；把远景记录压回 16 字节并复用 GPU 缓冲；再评估 Hi-Z、间接绘制和静态阴影缓存。Node 地形/物理迁移可以改善加载与运行时调度，但本次已经排除它们的离屏测量仍然慢，所以不能优先把稳态渲染问题归咎于 Node。后续用同相机、同 LOD、同采样数、同分辨率分别测 Web/原生的 GPU 时间和窗口帧时间，才能给出可信的端到端加速比。

## 三项优化默认启用后的复测（2026-10-31）

`RenderProbe::default()` 已启用以下三项，正常窗口无需命令行开关：

- **成组绘制**：每实例 32 面，共享 32 个 quad 的索引；保留源面顺序与每面四个顶点，末尾不足一组的顶点直接裁掉。
- **细粒度剔除**：Node IPC 传递现有的每 16 面元数据；Rust 在顶点处理前做覆盖、包围球视锥和主视角法线锥测试。阴影单独使用光源视锥并保留背面；256 m 内涉及非线性近场修正的块保守保留，不用原始包围球/法线锥误删。覆盖结果仅在遮罩变化时更新，可见列表按相机/投影/遮罩版本缓存，列表内容不变时复用 GPU 缓冲。
- **紧凑存储**：面记录由 32 字节改为 16 字节，记录局部 1/8 m 坐标、尺寸、方向、标记和完整颜色/材质位；远景从 Node 到 GPU 不再展开成 32 字节。近景及实体逐项验证精确还原，不能无损打包的网格保留原格式。没有量化已有坐标。

Ultra 的 100% 渲染比例、4× MSAA、4096 阴影、全部后处理及 LOD 请求/预算均未调整。此次没有启用静态阴影缓存、降分辨率或减少可见细节。

复测设备为 Apple M1 Pro，Aether **128/128 区域**，11,239,907 个常驻面。720p 选择的同一批 LOD 固定用于全部变体和两种输出分辨率；有效细分仍为 5.828125 px²。每项预热 24 帧、采样 120 帧，共两轮，第二轮反转顺序；下表为合并 240 个样本的 GPU 中位数。旧路径保留原来的直接 `Face` 顶点入口和 32 字节数据，避免新增解码分支拖慢对照基线。诊断才分配旧格式副本，正常窗口不保留两份面缓冲。

| 输出分辨率 | 旧路径 | 仅成组 | 成组 + 紧凑 | 三项全部启用 | GPU 时间减少 |
| --- | --- | --- | --- | --- | --- |
| 1280×720 | 15.160 ms | 11.152 ms | 11.143 ms | **7.032 ms** | **53.6%** |
| 2560×1440 | 17.834 ms | 13.985 ms | 13.928 ms | **9.608 ms** | **46.1%** |

这些是本轮离屏 GPU 时间，不是显示 FPS，也不与上节较早运行的绝对时间混算。成组和剔除贡献明显；紧凑存储单独的时间差很小，不声称它单独带来明显帧率提升。完整原始采样见 [optimized-profile.json](results/aether-archipelago-optimized-profile.json)。

| 固定总览场景工作量 | 旧路径 | 默认优化 |
| --- | --- | --- |
| 主场景提交面数 | 3,681,452 | 1,370,915（减少 62.8%） |
| 阴影提交面数 | 1,023,074 | 297,084（减少 71.0%） |
| 主场景 / 阴影 draw | 205 / 72 | 171 / 60 |
| 主面缓冲 | 359,677,024 字节 | 179,838,512 字节（减半） |

面缓冲数字不含 CPU 可见性元数据、可见列表、源地形缓存和渲染目标，不能解读为应用总内存减半。每个远景块增加 48 字节 CPU 元数据，主视角与阴影可见列表按块存储 32 位索引。

另以 720p 连续移动/转向 120 帧，强制重建可见列表：GPU p50 **15.055 → 6.285 ms**，包含提交和等待完成的串行帧 p50 **16.253 → 9.715 ms**，减少 **40.2%**。CPU 编码 p50 从 **0.557 → 2.798 ms**：剔除仍有 CPU 成本，但该测试的总耗时明确降低。移动测试固定常驻几何，不包含生成、动态 LOD、UI、物理或显示呈现。

七组输出（720p/1440p 总览、转向、近景、过渡带、接缝、含旋转实体的发光/透明材质）优化前后 **不同像素为 0、最大通道误差为 0**。本轮旧路径总览也与优化前保存的历史图逐像素一致。记录见 [optimized-image-check.json](results/optimized-image-check.json)。这验证已测场景的原生画质保持，不代表所有相机都已穷尽，也不替代与 Web Ultra 的对齐验收。

复现前先关闭原生窗口，避免重复实例竞争 GPU：

```sh
sh native-space/tools/check.sh
sh native-space/tools/cargo.sh build --release --offline
native-space/target/release/space-native --profile-optimized --world=aether-archipelago --lod-zones=128
sh native-space/tools/bundle.sh
```

新版应用已重新构建并打开，在 Settings 验证 Ultra、100% 原生 **1908×2018**、4× MSAA、4096 阴影及全部特效。全世界 128/128 区域加载完成，返回出生点后可见列表与近景更新正常；最终 149 个常驻 chunk，待加载/网格任务为 0。应用保持打开。[窗口截图](results/optimized-window.png)与[结构化验收记录](results/optimized-window-verification.json)已保存。截图中的 GPU 6.68 ms / 97 帧提交每秒仅为一次观察；窗口 LOD、比例和视角不同，不能代替上述同条件性能比较。连续移动由离屏相机路径验证；本轮窗口鼠标自动化返回 `noWindowsAvailable`，窗口交互改用键盘完成。

## 移动时 CPU 剔除优化与单机交互（2026-10-31）

默认细粒度剔除现在使用保持原面顺序的二叉层级。层级包围球和合并法线锥只用于证明整段叶节点都可见或都不可见；不能证明的范围继续执行原来的 16 面测试。近场非线性修正仍采用保守规则，主视角和阴影独立判断。4 个固定工作线程只处理不可变可见性数据和各自的 CPU 输出列表；Metal 对象分配、上传、编码保留在渲染线程。CPU 列表交换复用，静止相机和未变化的 GPU 列表继续命中缓存。

先测层级单线程，再加入固定线程池；以下记录后者在角色近距离法线修正后的最终构建复测。与上一版已启用分组/紧凑/细粒度剔除的路径比较，**不是重新对比最初的每实例一面版本**。Apple M1 Pro，Aether 128 区域、相同 11,239,907 常驻面、相同 720p LOD，Ultra/100%/4× MSAA/4096 阴影全部保持。每案例预热 24 帧、采样 120 帧，正反顺序各一轮；表格合并 240 个样本取中位数。

| 连续移动/转向 | 上一版 CPU 编码 | 当前 CPU 编码 | 减少 | 上一版串行帧 | 当前串行帧 |
| --- | --- | --- | --- | --- | --- |
| 1280×720 | 2.465 ms | **1.460 ms** | **40.8%** | 9.919 ms | **8.787 ms** |
| 2560×1440 | 2.648 ms | **1.487 ms** | **43.8%** | 13.655 ms | **12.436 ms** |

CPU 编码指标是渲染线程从开始准备到完成编码的经过时间，包含等待工作线程；不是所有 CPU 核心累计消耗的时间。串行提交/完成耗时分别减少约 11.4% 和 8.9%。移动 GPU 中位耗时为 720p 6.902 → 6.946 ms、1440p 10.554 → 10.539 ms，基本不变。这轮优化主要缩短 CPU 准备时间，没有声称降低同等比例的 GPU 工作量。仍未计入 UI、流式生成、物理和显示呈现，不能直接换算窗口 FPS。

完整原始采样见 [culling-profile.json](results/aether-archipelago-culling-profile.json)。七组优化前后 PNG 仍逐像素一致，见 [culling-image-check.json](results/culling-image-check.json)；另在 144 帧相机路径上逐项断言主视角/阴影有序可见块列表与线性算法一致。单元测试覆盖随机包围球/法线锥、遮罩、近场范围、主视角与阴影，保留不能证明时的逐块判断。

单机 HUD 与角色作为独立功能接入，不加入上述冻结场景的性能比较。新工具栏包含七个工具、当前操作提示、网格/笔刷状态和本地保存入口；默认角色皮肤随二进制打包，无网络请求。单机交互测试覆盖两角选区、预览无副作用、放置/撤销、标准方块微雕、整笔撤销、取色、扳手移动取消/双击启停、装饰添加与视角存档。已在窗口检查快捷键、飞行、视角切换、本地背包装备预览和扳手右键拾取。工具的完整迁移边界见 README 与 MIGRATION。

复现（运行前关闭窗口）：

```sh
sh native-space/tools/check.sh
sh native-space/tools/cargo.sh build --release --offline
native-space/target/release/space-native --profile-culling --world=aether-archipelago --lod-zones=128
```

最终应用包已重新构建并打开。窗口验证 Ultra、1788×2178 物理分辨率、100% 比例、4× MSAA、4096 阴影和全部特效，128/128 区域、149 个近景 chunk、待加载/网格任务均为 0；未修改地形。角色使用独立的解析面法线标记，修复第一人称近距离世界坐标求导造成的光照颗粒。见 [Ultra 窗口](results/singleplayer-ultra-settings.png)、[第一人称](results/singleplayer-first-person.png)、[默认皮肤](results/singleplayer-default-skin.png) 和 [验收记录](results/singleplayer-validation.json)。

这里的七组逐像素一致指最终构建内的线性/层级剔除对照。另比较角色法线修改前后的两个构建，部分场景有少量像素差异（总览 720p 540/921600 像素、1440p 1730/3686400 像素）；未将跨构建输出描述为完全一致，原始统计见 [跨构建图像记录](results/avatar-normal-world-regression.json)。Ultra 参数、LOD 和地形光照公式没有降低或删减。


## 阴影与帧资源复用（2026-11-01）

本轮保持 Ultra、100% 原生分辨率、4× MSAA、4096 阴影、原有后处理和 LOD 不变，默认启用以下机制：

- 阴影缓存只在输入精确相同时复用；相机平移、投影、远近遮罩、投影物几何/姿态/增删都会失效。原地转头不改变光源相机，可以命中。场景版本由渲染器的上传、姿态更新和删除入口维护，避免每帧扫描全部常驻网格；网格容器不再允许外部直接修改。第一人称手臂、预览和原本不投影的透明面不会使阴影失效。
- 可见列表和 egui 顶点/索引使用三套持久 Metal 缓冲，容量不足才扩容。写入前等待对应在途帧完成；每个提交只引用自己的帧槽，不让缓存的列表跨槽引用旧位置。按网格版本、列表版本和范围判断是否需要复制，静止时不反复搬运相同数据。
- 公共帧参数和环面查找表按绘制通道绑定一次，逐 draw 只更新模型与面参数。
- Apple GPU 上将只在单个绘制通道内使用的 MSAA 颜色/深度附件改为 memoryless；颜色和深度仍按原采样数 resolve 到原格式目标，全部后处理继续使用相同输入。其余 GPU 保留 private 附件。实现依据 Apple 的 [动态数据三缓冲指南](https://developer.apple.com/library/archive/documentation/3DDrawing/Conceptual/MTLBestPracticesGuide/TripleBuffering.html) 与 [MSAA resolve 示例](https://developer.apple.com/documentation/metal/improving-edge-rendering-quality-with-multisample-antialiasing-msaa)。

对照基线保留上一轮的分组绘制、紧凑存储、四线程层级剔除，仅关闭本轮机制。128/128 区域、11,239,907 常驻面，固定同一批 720p LOD；每项预热 24 帧、采样 120 帧，正反顺序交替四轮。静止、原地转头、平移/转向、带固定 egui 界面的移动分别测量。数据来自渲染线程准备/编码、GPU 和串行提交至完成；没有流式生成、物理或显示呈现，UI 案例也不包含布局/细分时间，不能直接当作实际窗口 FPS。

复现前关闭原生窗口：

```sh
sh native-space/tools/check.sh
sh native-space/tools/cargo.sh build --release --offline
native-space/target/release/space-native --profile-frame-reuse --world=aether-archipelago --lod-zones=128
```

四轮共 480 个计时样本的中位数：

| 场景 | 分辨率 | CPU 编码：之前 → 当前 | CPU 减少 | GPU：之前 → 当前 | 串行帧：之前 → 当前 |
| --- | --- | --- | --- | --- | --- |
| 静止 | 720p | 0.540 → **0.441 ms** | **18.3%** | 7.199 → 7.230 ms | 8.673 → 8.637 ms |
| 原地转头 | 720p | 1.294 → **0.953 ms** | **26.3%** | 7.342 → 6.909 ms | 9.436 → 8.691 ms |
| 平移/转向 | 720p | 1.445 → **1.096 ms** | **24.2%** | 7.367 → 7.283 ms | 9.672 → 9.231 ms |
| 移动 + 固定 UI | 720p | 1.536 → **1.129 ms** | **26.5%** | 7.358 → 7.313 ms | 9.718 → 9.303 ms |
| 静止 | 1440p | 0.533 → **0.428 ms** | **19.8%** | 10.405 → 9.996 ms | 11.767 → 11.228 ms |
| 原地转头 | 1440p | 1.296 → **0.960 ms** | **25.9%** | 10.587 → 10.355 ms | 12.786 → 12.216 ms |
| 平移/转向 | 1440p | 1.438 → **1.119 ms** | **22.2%** | 10.620 → 10.498 ms | 12.827 → 12.741 ms |
| 移动 + 固定 UI | 1440p | 1.550 → **1.122 ms** | **27.6%** | 10.797 → 10.639 ms | 13.102 → 12.600 ms |

主要收益是 CPU 准备时间和资源分配，GPU 改善小得多。720p 静止 GPU 中位数略升 0.4%，不能声称所有场景的 GPU 都加速；带 UI 移动的串行帧中位数分别减少约 4.3% / 3.8%，也不能把 CPU 的约 27% 降幅当作帧率增幅。原始数据见 [frame-reuse-profile.json](results/aether-archipelago-frame-reuse-profile.json)。

预热后，平移/转向的动态 Metal 缓冲分配从平均每帧 67 次降为 0，带 UI 从 79 次降为 0；只有容量增长时才重新分配。静止/原地转头的测量帧阴影缓存命中率为 100%，移动为 0%，说明没有用陈旧阴影换取移动性能。实际游戏中实体动画、流式网格和编辑仍会触发更新。

Metal `allocatedSize` 报告的两个 MSAA 临时附件合计从 720p 45,088,768 字节、1440p 179,044,352 字节降为 0；它们在 Apple GPU 的片上 tile memory 中完成采样和 resolve。这只指这两个附件的持久内存，不代表整个程序或全部渲染目标占用为 0。颜色格式、深度格式及 4× MSAA 均未改变。

验收结果：

- 七组相同场景/材质/接缝的最终构建内 A/B 图像全部逐像素一致。
- 36 帧变化相机和 UI、最多三帧在途，共十二次环形缓冲轮换，与逐帧独立分配的参考输出逐像素一致。
- 20 项缓存命中/失效及图像断言通过，覆盖实体增删/姿态/几何替换、批量删除、预览和手臂、远景 tile 替换、遮罩、投影及窗口尺寸变化。
- 144 帧移动主相机/阴影可见列表与原线性参考一致；28 个 Rust 测试、4 个 Node 测试、格式、Clippy 和 TypeScript 检查通过。

结构化汇总见 [frame-reuse-validation.json](results/frame-reuse-validation.json)。

最终应用包已重新构建并打开，窗口验收保持 Ultra、1908×2018 物理分辨率、100% 比例、4× MSAA 和 4096 阴影。128/128 区域和 149 个近景 chunk 加载完成，待加载/网格任务为 0；飞行移动、第一/第三人称与正面视角、默认皮肤、工具栏和设置均显示正常，未编辑世界。应用保持打开并恢复第一人称。[窗口截图](results/frame-reuse-window.png)用于功能验收，窗口瞬时 FPS 不纳入上述性能对照。

## 移动时天空抖动修复（2026-11-01）

原天空着色器用完整 `inverse(投影 × 视图)` 反投影远处世界坐标，再减去相机位置得到方向。相机处于数千米坐标时，这条 f32 矩阵求逆、齐次除法和大数相减路径会产生随位置跳变的方向误差；云层噪声进一步放大误差。冻结云动画、只平移相机即可复现，排除了正常云层漂移。

现在在求逆前移除视图平移，天空直接使用旋转/投影生成单位方向，不再经过世界位置或齐次除法。雾效使用同一稳定方向，太阳屏幕投影使用 `w=0` 的方向向量。云层动画、天空材质、FOV、Ultra 参数和 LOD 均保持；转头仍正常改变天空视角。

新增 `--validate-sky`：1280×720、4× MSAA、完整 Ultra 后处理、冻结云动画，在平面、环面和两个周期接缝各平移 32 帧，并检查转头确实改变输出。修复前这项回归失败，修复后全部通过。下表是移动帧相对起点的最坏 RGB 通道平均误差（0–255），不是性能指标：

| 路径 | 修复前 | 修复后 |
| --- | --- | --- |
| 平面 | 2.809992 | **0，逐像素一致** |
| 环面 | 1.092782 | **0.000106** |
| 环面 X 接缝 | 1.581116 | **0.000105** |
| 环面 Z 接缝 | 1.393429 | **0.000203** |

修复后环面及接缝测试的任意单通道差异不超过 1/255，仅剩少量浮点和量化舍入误差；旧版最大差异为 101/255。转头对照仍产生约 7.982/255 的平均变化。新增 CPU 回归检查大坐标、接缝、横/竖屏和多种朝向的天空射线与解析相机方向一致；29 个 Rust 测试、4 个 Node 测试、格式、Clippy 和 TypeScript 检查通过。

原始记录：[修复前](results/sky-before-fix/sky-validation.json)、[修复后](results/sky-validation.json)。这次修正会改变旧版含精度误差的天空/雾效像素；前文七组逐像素一致结论属于当时的优化构建内 A/B 对照，不表示这次修复前后图像完全相同。

修复后的应用包已重新构建并打开，实际窗口检查飞行、云层动画与 Ultra 设置；物理分辨率 1908×2018、100% 比例、4× MSAA 和 4096 阴影保持。未编辑世界，应用保持打开。[窗口截图](results/sky-fixed-window.png)。

## 继承剔除判断与准备阶段复用（2026-11-01）

本轮最终默认启用的是 CPU 优化，着色器、32 面分组、分辨率、LOD、4× MSAA、4096 阴影和完整 Ultra 效果均保持：

- 层级节点使用位掩码向子节点传递已证明成立的视锥平面与朝向条件。父节点包围球包含全部带余量的叶节点；无法证明的条件仍继续测试，近场非线性修正和叶节点保守规则不变。子节点可以复用结论，但不会重排可见面。
- 粗剔除每帧预计算主视角/阴影的六个平面及法线长度，保留原有未归一化的运算与边界判定。每个网格的本帧可见性供层级筛选和最终提交共同使用，下一帧重新计算，不依赖可能过时的跨帧结果。
- 每个可见网格只计算一次环面距离。透明物仍从远到近、不透明物仍从近到远，距离相同仍按唯一网格名排序；使用原地排序避免额外的排序临时数组。

诊断中保留上一版完整的层级遍历、粗剔除和重复计算距离的稳定排序作为 A/B 基线。`--profile-submission` 使用完整 128 区域、相同常驻面与冻结的 720p LOD。静态诊断交替执行四轮，每例预热 24 帧、采样 120 帧；动作路径使用 20 个短批次，每次切换后预热 6 帧、采样 24 帧，通过确定性打乱的 ABBA/BAAB 顺序平衡前后位置，每个变体共 480 帧。两个变体测量完全相同的相机序列。

CPU 指标是渲染线程准备/编码的经过时间，含等待工作线程，不是各核心累计时间；GPU、串行帧均不包含显示呈现、流式生成和物理，UI 案例也不含布局/细分，不能直接换算窗口 FPS。之前的长批次测量中，720p 转头出现 CPU 中位数反向变化 7.1%，伴随 GPU 时间上升，因此追加短批次交错测量以减少系统负载和顺序影响；[长批次原始记录](results/aether-archipelago-submission-long-batches.json)也予以保留。

另测试了天空绘制次序、顶点计算分支与泛光权重复用；该组合没有稳定 GPU 收益且出现图像差异，已整体撤回。每实例 8–256 面的诊断图像全部一致，但较大分组没有稳定提速，保留默认 32 面。相关记录见 [阶段诊断](results/aether-archipelago-render-profile-post-sky.json) 与 [分组诊断](results/aether-archipelago-groups-profile.json)。

短批次配对结果（每项合并 480 帧取中位数），Apple M1 Pro、11,239,907 常驻面：

| 场景 | 分辨率 | CPU 编码：之前 → 当前 | CPU 减少 | GPU：之前 → 当前 | 串行帧：之前 → 当前 |
| --- | --- | --- | --- | --- | --- |
| 静止 | 720p | 0.305 → **0.275 ms** | **10.0%** | 4.982 → 4.976 ms | 5.651 → 5.614 ms |
| 原地转头 | 720p | 0.728 → **0.674 ms** | **7.4%** | 5.068 → 5.047 ms | 6.174 → 6.086 ms |
| 平移/转向 | 720p | 0.934 → **0.809 ms** | **13.3%** | 5.565 → 5.479 ms | 6.902 → 6.637 ms |
| 移动 + 固定 UI | 720p | 0.924 → **0.811 ms** | **12.2%** | 5.514 → 5.382 ms | 6.749 → 6.539 ms |
| 静止 | 1440p | 0.370 → **0.346 ms** | **6.5%** | 7.323 → 7.319 ms | 8.112 → 8.092 ms |
| 原地转头 | 1440p | 0.816 → **0.738 ms** | **9.5%** | 7.441 → 7.397 ms | 8.668 → 8.512 ms |
| 平移/转向 | 1440p | 0.935 → **0.838 ms** | **10.4%** | 7.852 → 7.847 ms | 9.235 → 9.104 ms |
| 移动 + 固定 UI | 1440p | 0.972 → **0.858 ms** | **11.8%** | 7.868 → 7.859 ms | 9.319 → 9.150 ms |

移动 CPU 准备时间减少约 10–13%，带 UI 时减少约 12%；相应串行帧中位数改善约 1–4%。GPU 工作量保持，时间接近，不能把小幅 GPU 差异归因于新的着色器优化。720p 转头的反向结果未在短批次复测中重现；保留长批次报告以展示测量波动，结论以交错配对结果为主。

七组 A/B 图像全部逐像素一致；144 帧移动的主视角/阴影有序可见列表与线性参考一致；36 帧三帧在途缓冲与 20 项阴影失效检查均通过且图像一致。30 个 Rust 测试、4 个 Node 测试、格式、Clippy、TypeScript 与 128 帧天空稳定性回归通过。原始采样见 [submission-profile.json](results/aether-archipelago-submission-profile.json)，结构化验收见 [submission-validation.json](results/submission-validation.json)。

最终应用包已构建并打开。窗口确认 1908×2018 原生分辨率、100% 比例、4× MSAA、4096 阴影和全部 Ultra 特效；检查飞行、视角切换、默认皮肤、天空、工具栏与后台区域加载，随后恢复第一人称。已有存档中的地形编辑数在验收前后均为 60，未新增地形编辑。应用保持打开；[窗口截图](results/submission-window.png)用于功能验收，不纳入性能对照。

## 2026-11-02: leaf and distance proofs

The ordered hierarchy now carries unresolved plane/facing bits into leaf tests.
An additional bit proves that every leaf is outside the camera-local nonlinear
blend. Nodes with that proof and no remaining facing test skip distance work.
Every unresolved test keeps the previous arithmetic and thresholds. Scene
quality, resolution, MSAA, shadow map, draw order, LOD and shaders are unchanged.
`RenderProbe.leaf_cull_proofs = false` retains the previous traversal.

`--profile-leaves --world=aether-archipelago --lod-zones=128` compares only this
change with the previous defaults. Final paired run: M1 Pro, Ultra 100%, 4x MSAA,
4096 shadows, 11,239,907 resident faces, frozen 720p LOD. Each variant has 480
samples per case, in 20 balanced short batches with six warmup frames per batch.
Builds and other GPU benchmarks were stopped before the final run.

| Case | Resolution | Previous CPU encode ms | Current CPU encode ms | Reduction |
|---|---|---:|---:|---:|
| Stationary | 1280x720 | 0.3072 | 0.3119 | -1.5% |
| Stationary | 2560x1440 | 0.3656 | 0.3614 | 1.1% |
| Turn | 1280x720 | 0.6995 | 0.6757 | 3.4% |
| Turn | 2560x1440 | 0.7412 | 0.7220 | 2.6% |
| Moving | 1280x720 | 0.8511 | 0.8534 | -0.3% |
| Moving | 2560x1440 | 0.8885 | 0.8807 | 0.9% |
| Moving with UI | 1280x720 | 0.8692 | 0.8386 | 3.5% |
| Moving with UI | 2560x1440 | 0.8833 | 0.8350 | 5.5% |

These are small CPU savings, not evidence of a large FPS gain. GPU times are
essentially unchanged; serial frame medians range from 2.6% slower to 1.2%
faster. The preliminary run is retained rather than selecting its larger gains.
Raw final results: `results/aether-archipelago-leaves-profile.json`.

Validation: seven paired images are pixel-identical; 144 moving main/shadow
selections match the linear oracle; 36 queued frames and 20 shadow mutation
cases have zero differing pixels. Rust's randomized hierarchy test also compares
the previous leaf traversal explicitly. The full check script passes (30 Rust
and four Node tests), and the sky regression is retained.
