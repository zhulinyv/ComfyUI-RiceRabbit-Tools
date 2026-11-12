# ComfyUI-RiceRabbit-Tools

ComfyUI 自定义节点：提示词编辑（自动补全 + 标签化窗口 + wildcard 卡片库 + 提示词库 + 在线翻译）、
图片对比（节点内手动切图预览 + 滑动分割线逐像素对比），以及分辨率 / 日期 / 文本拼接 / 任意类型选择等小工具。
卡片库与提示词库可直接复用 [Auto-NovelAI-Refactor](https://github.com/zhulinyv/Auto-NovelAI-Refactor) 的现有数据。

## 节点

**🍚 提示词 (RiceRabbit)** · `RiceRabbitPrompt`

| 方向 | 名称 | 说明 |
| --- | --- | --- |
| 输入 | `clip` | 可选。接上就把提示词编码成 conditioning；不接则只用 `text` 输出（conditioning 为空列表） |
| 输入 | `text` | 可选的上游文本，会用分隔符拼在节点提示词**前面** |
| 输入 | `prompt` | 节点自己的提示词（多行，带标签自动补全） |
| 输入 | `seed` | 随机/顺序的抽取种子，可接 KSampler 的 seed；**种子不变时不重新抽取**（保证同种子可复现） |
| 输入 | `format` | 是否格式化提示词（高级参数，折叠在节点底部） |
| 输入 | `separator` | 拼接上游 `text` 与节点提示词的分隔符，默认英文逗号 `,`（高级参数） |
| 输出 | `text` | 最终送进编码器的提示词（已拼接 / 展开 wildcard / 格式化） |
| 输出 | `conditioning` | 编码后的条件，可直接接 KSampler |

处理顺序（与 Auto-NovelAI-Refactor 一致）：

```
上游 text + separator + 节点提示词  ->  展开 <分类:卡片>  ->  格式化  ->  CLIP 编码
```

任意一侧为空时不会留下多余的分隔符。

### 节点上的控件

- **🃏 标签化提示词**：打开标签化编辑窗口
- **Show advanced inputs**：节点底部的折叠条，用的是 ComfyUI 官方的高级参数机制（与 `KSampler (Advanced)` 完全同一套），点一下才展开
  - **格式化提示词**：开关，等价于 `format` 参数
  - **分隔符**：等价于 `separator` 参数，默认英文逗号 `,`

## 分辨率节点

**🍚 分辨率 (RiceRabbit)** · `RiceRabbitResolution`

没有输入，输出 `width` + `height` 两个 INT。

| 控件 | 说明 |
| --- | --- |
| `preset` 预设 | 下拉选一个常用分辨率，会自动填进下面的宽高 |
| `width` / `height` | 实际输出的宽高；手动改完如果命中某个预设，下拉会自动切到那一项，没命中就是「自定义」 |

**每执行一次都会把手上的 `width × height` 收录进预设**：填了 800×600 跑一次，下次下拉里就有 `800x600`（存在插件 `data/resolutions.json`，不影响 ComfyUI 自己的设置）。执行结束后节点会自动刷新下拉选项，不用刷新页面。

## 日期节点

**🍚 日期 (RiceRabbit)** · `RiceRabbitDate`

没有任何输入（也没有参数），输出 `date`（STRING），格式 `YYYYMMDD`，例如 `20261030`。

带了 `IS_CHANGED`，跨天会自动重算，不会因为节点缓存给出昨天的日期。

## 整数转文本节点

**🍚 整数→文本 (RiceRabbit)** · `RiceRabbitIntToString`

输入一个 `value`（INT），输出 `text`（STRING）。可以接上游的 INT（比如分辨率节点的 `width`），也可以直接在节点上填数字——转成十进制文本后拼文件名 / 路径 / 提示词都行。

```
1024 → "1024"    0 → "0"    -7 → "-7"
```

## 文本拼接节点

**🍚 文本拼接 (RiceRabbit)** · `RiceRabbitConcat`

按顺序把多个 STRING 用分隔符连起来，输出 `text`（STRING）。

- 默认只有 `text1` / `text2` 两个输入点；**连上 text2 会自动冒出 text3**，连上 text3 冒出 text4，最多 20 个
- 断开某个输入，后面多余的输入点会自动收回
- `分隔符` 输入框默认为空（直接相连），填 `,` 就是 `a,b,c` 这种效果
- 空的输入不会跳过，会占一个分隔符位置（`a` + `""` + `c` 用 `,` 拼是 `a,,c`）

## 任意类型选择节点

**🍚 任意类型选择 (RiceRabbit)** · `RiceRabbitAnySwitch`

接多个**任意类型**的输入，只输出**第一个有内容**的那个，输出 `value`（类型跟随上游）。

- 默认只有 `input1` / `input2` 两个输入点；**连上 input2 会自动冒出 input3**，连上 input3 冒出 input4，最多 20 个
- 断开尾部输入，多余的输入点会自动收回；中间留空的槽会保留（不影响后面的连线）
- 空值会被跳过：`None`、空文本、空列表 / 空字典都算空；数字 `0` 和 `False` 算有内容
- 全部为空时输出 `None`（并在终端提示一句），所以「至少一个非空」时不用管顺序
- 输入槽是通配类型 `*`，IMAGE / LATENT / MODEL / STRING 都能接，断开后会恢复通配，可以改接别的类型

```
input1 = None        ┐
input2 = ""          ├─→  output = "best_quality"
input3 = "best_quality" ┘
```

## 存在性判断节点

**🍚 存在性判断 (RiceRabbit)** · `RiceRabbitExistential`

接任意类型，输出一个布尔值，判断"这个输入到底有没有东西"。

- 接了线且上游给出的值不是 `None` → `True`
- 没接线，或上游给的是 `None` → `False`
- **只认 `None`**：空文本 `""`、空列表 `[]`、`0`、`False` 都算"存在"（注意与「任意类型选择」的跳过规则不同，那边会把空文本/空容器也当空）

移植自 `custom_nodes/ModelSelector.py` 的 `ExistentialJudgement`，类名换成了 `RiceRabbitExistential`，避免和原插件注册的节点 key 撞车。

## 变量存取节点 (Set / Get)

参照 ComfyUI-Easy-Use 的 easy setNode / easy getNode 写的一对节点，都是纯前端虚拟节点，不进提交给后端的 prompt。

- **🍚 变量写入 Set (`RiceRabbitSetNode`)**：接任意上游，`变量名` 输入框定义变量；连线后类型自动传播给所有同名 Get
- **🍚 变量读取 Get (`RiceRabbitGetNode`)**：下拉选变量名（重名去重），只有一个输出；数据在序列化时直接穿透到 Set 的上游，执行顺序天然正确

这两个节点在 **RiceRabbit 分组**里（菜单显示为「变量写入 Set」「变量读取 Get」）。它们的实际逻辑仍然全在前端 `web/rr_setget.js`，`ricerabbit_nodes.py` 里只有一份占位定义 —— 纯前端节点没有 nodeDef，新版节点库会把它丢进搜索/未分类，有了同名定义才能正常归类；前端 `registerCustomNodes` 在后端定义之后执行，会用同名 type 覆盖回虚拟节点类。

与 Easy-Use 的差异：

1. **允许重名**：同一个变量名可以放多个 Set（Easy-Use 会强制把重名改成 `xxx_0`）
2. **Bypass 的 Set 不算数**：Get 取值时跳过 Bypass / Never 状态的 Set，按图上顺序取第一个有效的。3 个同名 Set bypass 掉 2 个，Get 输出的就是剩下那一个的值；全部 bypass 时 Get 输出悬空（`*`）
3. Get 的下拉列表对重名去重，只显示一项

只有一个同名 Set 时行为与 Easy-Use 完全一致。

## 格式化文本节点

**🍚 格式化文本 (RiceRabbit)** · `RiceRabbitFormatText`

输入 `text`（STRING，需连线），输出 `text`（STRING）。规则与 `ModelSelector.py` 的 Format_str 完全一致（已逐例对比验证）：

- 逗号两侧的空白、连续逗号统一成单个 `, `
- 连续空格压成一个，每行首尾去空白
- 换行与空行原样保留

```
"1girl ,  ,solo ,  best_quality,"  →  "1girl, solo, best_quality,"
"a,b,,c\n\nd , e"                  →  "a, b, c\n\nd, e"
```

## 图片对比节点

**🍚 图片对比 (RiceRabbit)** · `RiceRabbitImageCompare`

**没有输入接线点**，也没有输出（`OUTPUT_NODE`）——纯粹用来看图 / 对比图。

### 自动收集 Get

它会自己把图里**所有「图片类型」的 Get** 找来显示，不需要接线：

- 只收本插件的 **Get** 节点（`RiceRabbitGetNode`），且输出类型是 `IMAGE`（LATENT / MODEL 等一律跳过）
- Bypass / Never 状态的 Get 跳过
- 多个 Get 指向同一个 Set 时只取一次（那是同一张图）
- 顺序 = 画布上从上到下、从左到右
- 上限 20 张

采集发生在**提交队列时**：节点在 `app.graphToPrompt()` 之后把 `image1..N` 补进 API prompt，
所以上游节点会正常进执行图，图片也会落到后端临时目录。代价是**必须先执行一次队列**才有图。

节点和对比窗口里的图片由后端落成临时 PNG（`temp/ricerabbit_compare/<节点id>/`，**每次执行清空重建**），
看到的就是送进节点的原始像素，不做缩放或压缩。

### 节点内预览

整个节点内容区都归一块自绘面板（不占 widget 布局，所以输入多少都不影响观感）：

- 上方是当前图片（按原比例缩放，不拉伸）
- 中间一条 `◀ 3/8 · 正面 ▶`：**手动切换**，点箭头或把鼠标放到图上滚轮都能切（首尾循环）
- 最下面 `🔍 打开对比窗口`
- 图片名称就是 **Get 的变量名**（也就是 Set 那边起的名字），batch 多张时带 `#1` `#2`
- 手动拉伸节点时预览区跟着变

### 对比窗口

- 左侧一列是所有图片：缩略图 + 名称 + 尺寸；行尾 `A` / `B` 两个小按钮分别设为左图 / 右图（单击整行 = 设为右图，双击 = 设为左图）
- 右侧上方两个下拉框选左图 A、右图 B，中间的 `⇄` 交换左右
- 右侧大区域两张图重叠，**鼠标左右移动即移动分割线**：分割线左边是 A、右边是 B。点 `🖱 跟随鼠标` 可锁定分割线（变成 `📌 位置已锁定`）
- **滚轮缩放**：100% ~ 800%，以鼠标位置为锚点（放大时看细节不会跑偏），右下角显示当前比例
- 放大后**按住左键拖动可平移**；拖动时分割线不跟着动，松手恢复
- `↺ 重置视图` 按钮（或按 `R`）恢复 100% 并回到中心
- `Esc` 或右上角 `✖ 关闭`

### 说明

- 节点是输出节点，必须**执行一次**才有图；ComfyUI 缓存命中时不会重复执行，图片沿用上一次的
- 临时文件按节点 id 分开存放，多个对比节点互不干扰（每个都会各收一份，图多时注意磁盘）
- 保存 workflow 时会把图片记录一并存进节点属性，重开时只要临时文件还在就直接显示，否则提示重新执行
- 节点 UI 由前端主动扫描图的节点列表装配（这个前端版本里扩展的 `beforeRegisterNodeDef` 不一定回调），所以**新加 / 加载的节点都能正常工作**

## 标签化提示词窗口

- 提示词按 `,` / 换行 / `. ` 拆成标签块；括号内与 `数字::内容::` 权重块内的分隔符不拆
- 每个标签块悬停出现 `▼ ▲ ✎ ×`：减权重 / 加权重 / 编辑 / 删除，拖动可排序
- 权重有两种写法，点 `⚖️` 切换：通用权重 `(标签:1.5)`、NAI 新版权重 `1.5::标签::`
- 双击空白处切到文本输入（仍是同一份提示词），输入时带自动补全
- 标签块副标题显示中文译文；缺译文的点 `🌐 翻译` 在线补齐（多源免费接口，结果会缓存）
- 换行会显示成 `⏎ 换行` 块，拼回文本时还原成真正的换行
- 下方是卡片库与提示词库：
  - 卡片库：左侧分类，右侧卡片网格（有同名图片就显示封面）；点击选中/取消，**同时在下方的预览框里显示这张卡片写了什么**；可跨分类多选，双击编辑卡片名 / 内容 / 封面，也能直接拖进编辑器
  - 每个分类最前面是 🎲 **随机** / 🔢 **顺序** 两张虚拟卡片，选中添加后得到 `<分类:随机>` / `<分类:顺序>`
  - 提示词库：**ANR 的内置提示词库（9 组约 1900 个标签，带 `📚` 前缀）与自己的收藏分类一起展示**；点击多选后一次插入，内置库只读，收藏的分类可以增删
  - `➕ 添加选中` 批量加入提示词，`✖ 清除选择` 取消

## 设置

位置：ComfyUI 设置面板左侧列表最下面的 **OTHER** 分组里的 **RiceRabbit**，或在搜索框直接搜 `RiceRabbit`。

三项分别放在 `RiceRabbit` 下的三个小节里（**ANR 目录** / **卡片库** / **提示词库**）。
之所以不用同一个子分类，是因为 ComfyUI 1.58 的设置面板在同一个 subCategory 下有多项时只会渲染其中一项。

| 设置项 | 说明 |
| --- | --- |
| **Auto-NovelAI-Refactor 目录** | 填 ANR 项目根目录（如 `D:\GitClone\Auto-NovelAI-Refactor`）。配置后自动读取它的 `data/state/wildcards` 与 `data/state/prompt_library.json`，标签词典也一并复用。**默认空** |
| **Wildcards 卡片库目录** | 卡片库根目录，结构 `<分类>/<卡片名>.txt`。默认 `<插件目录>/wildcards` |
| **提示词库文件** | 提示词库 json 路径，格式 `[{"text": "...", "category": "..."}]`。默认 `<插件目录>/prompts/prompt_library.json` |

优先级：ANR 目录有效时以 ANR 的库为准；否则用后两项。后两项为空时回落到插件目录下的默认库。

卡片库结构（与 ANR 相同）：

```
wildcards/
├── 画质/
│   ├── 基础画质.txt          # 内容就是一段提示词
│   └── 基础画质.png          # 可选封面（同名 png/jpg/jpeg/webp/gif）
└── 风格/
    └── 水彩.txt
```

在提示词里写 `<画质:基础画质>` 就会展开成卡片内容；`<画质:随机>` 随机取一张，`<画质:顺序>` 按文件名依次取。

同一个提示词里可以写多个标记，**每个位置独立抽取/推进**（两个 `<画质:随机>` 各抽各的，两个 `<画质:顺序>` 各取下一张）；卡片内容里嵌套的 `<分类:卡片>` 会被继续展开。

**embedding 裸词自动识别**：展开与格式化之后，凡是与 `ComfyUI/models/embeddings/` 目录文件名匹配的独立词（大小写不敏感，支持中文文件名与带权重的括号写法），会自动加上 `embedding:` 前缀——包括递归展开出来的 wildcard 内容里的。已有 `embedding:` 前缀的不会重复添加，wildcard 标记内部的名字不受影响。这一步在提示词节点、格式化节点的输出前统一执行；ComfyUI 引用 embedding 时会自动尝试 `.safetensors` / `.pt` / `.bin` 扩展名。

**替换点末尾补逗号**：wildcard 替换后如果后面还有内容（紧接提示词 / 空格接提示词 / 换行接提示词），且替换内容不以逗号结尾，会在替换内容末尾自动补一个逗号，避免卡片内容与后面的提示词粘连；后面紧跟逗号或已到文本末尾时不补。ANR 项目（`utils/helpers.py::replace_wildcards`）也已同步该规则。

随机抽取与 `seed` 绑定：同一个 seed + 同一段文本，无论跑多少次展开结果都一致；种子变化（或提示词改动）才会重新抽取。把 KSampler 的 seed 连到节点的 `seed` 输入、并把它的 `control_after_generate` 设为 **fixed**，就能做到"同种子可复现"；顺序模式仍按游标轮换推进，但同种子下节点不重跑，游标不会多走。

## 格式化规则

照搬 ANR 的 `utils/helpers.py::format_str`：逐行处理（换行与空行保留），逗号两侧的空白与连续逗号统一成单个 `, `，
连续空格压成一个，每行首尾去空白。分隔符不是逗号时只做空白清理，不动正文里的逗号。

## 自动补全

`/ricerabbit/suggest` 用 Danbooru 词典（`assets/danbooru_tags_full_zh.csv`，32 万条）做建议，
匹配优先级：标签前缀 > 别名前缀 > 标签包含 > 别名包含 > 中文包含，同级按热度排序。
词典优先读 ANR 目录里的那份，读不到再用插件自带的。**都没有时会退化成卡片名索引**，补全仍可用。

节点提示词框里：`↑ ↓` 选择、`Enter` / `Tab` 确认、`Esc` 关闭、`Ctrl+Tab` 手动唤起。

## 目录结构

```
ComfyUI-RiceRabbit-Tools/
├── __init__.py                 # 注册节点 / WEB_DIRECTORY / API
├── ricerabbit_nodes.py         # 节点定义
├── ricerabbit_compare.py       # 图片对比节点 (图片落临时文件)
├── ricerabbit_routes.py        # HTTP 接口 (/ricerabbit/*)
├── ricerabbit_paths.py         # 设置读取与路径解析
├── ricerabbit_text.py          # 拼接 / 格式化 / wildcard 展开
├── ricerabbit_presets.py       # 分辨率预设读写
├── ricerabbit_library.py       # 卡片库与提示词库读写
├── ricerabbit_tags.py          # 标签词典 (补全)
├── ricerabbit_translate.py     # 在线翻译
├── web/
│   ├── rr_common.js            # DOM/接口/提示条/自动补全
│   ├── rr_modal.js             # 标签化提示词窗口
│   ├── rr_prompt_node.js       # 节点 UI 与设置项
│   ├── rr_setget.js            # 变量 Set / Get 虚拟节点
│   ├── rr_any_switch.js        # 任意类型选择的动态输入槽
│   ├── rr_compare.js           # 图片对比: 右侧预览 + 对比窗口
│   └── ricerabbit_style.css
├── wildcards/                  # 默认卡片库
├── prompts/prompt_library.json # 默认提示词库
├── assets/                     # 标签词典
└── data/                       # 运行时 (顺序游标 / 翻译缓存 / 回收站)
```

卡片与分类的删除都是**移动到 `data/trash/`**，不会真正删掉文件。

## 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/ricerabbit/config` | 当前库路径与词典状态 |
| GET | `/ricerabbit/wildcards` | 分类列表 |
| GET | `/ricerabbit/wildcards/{分类}` | 分类下的卡片 |
| GET | `/ricerabbit/wildcards/{分类}/{卡片}` | 卡片内容 |
| POST | `/ricerabbit/wildcards/save` | 保存卡片 |
| POST | `/ricerabbit/wildcards/delete` | 删除卡片（移入回收站） |
| POST | `/ricerabbit/wildcards/rename` | 重命名卡片（`.txt` 与封面图一起改名，目标重名则拒绝） |
| POST | `/ricerabbit/wildcards/cover` | 设置卡片封面（传 data URL，上限 8MB） |
| POST | `/ricerabbit/wildcards/cover/delete` | 移除卡片封面 |
| POST | `/ricerabbit/wildcards/create-type` | 新建分类 |
| POST | `/ricerabbit/wildcards/delete-type` | 删除分类（移入回收站） |
| GET | `/ricerabbit/cover?type=&name=` | 卡片封面图 |
| GET | `/ricerabbit/prompts` | 提示词库（分组 + 明细） |
| POST | `/ricerabbit/prompts/add` | 收藏提示词 |
| POST | `/ricerabbit/prompts/delete` | 删除提示词 |
| GET | `/ricerabbit/suggest?keyword=` | 补全建议 |
| POST | `/ricerabbit/translate` | 批量翻译 |
| POST | `/ricerabbit/expand` | 调试：看 wildcard 展开结果 |
| GET | `/ricerabbit/resolutions` | 分辨率预设列表 |
| POST | `/ricerabbit/refresh` | 改完设置后清缓存 |

## 说明

- 只依赖 ComfyUI 自带的 `requests`，没有额外 pip 依赖。
- 翻译走无 Key 的免费接口（Google / Bing / 百度 / MyMemory），先按系统代理请求，失败再直连；失败的源会冷却 60 秒。
- 标签词典在启动时由后台线程预热，第一次打开标签窗口不卡。
