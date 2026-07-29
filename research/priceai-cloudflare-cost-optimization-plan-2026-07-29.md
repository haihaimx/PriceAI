# PriceAI Cloudflare 成本优化方案

- 日期：2026-07-29
- 范围：Cloudflare Workers 请求与 CPU、R2 Class A/Class B、自动化抓取、`/api-transit/models` 热点
- 性质：基于账单、Cloudflare Dashboard、短时 Worker Tail 和当前代码的只读调研方案
- 本轮不包含：业务代码修改、Cloudflare 规则调整、R2 对象删除、服务器迁移或生产发布

## 一、结论摘要

当前成本不是单一接口或单一爬虫造成的，而是三条链路叠加：

1. 分布式自动化请求大量访问页面和 RSC，先推高 Worker Requests，再按每次执行的 CPU 放大 CPU 账单。
2. OpenNext 增量缓存以 R2 为持久层；当前 regional cache 命中后仍会后台读取 R2，导致 R2 Class B 基本跟随缓存访问量增长。
3. `/api-transit/models` 虽然有 5 分钟 ISR，但冷区域、缓存未命中和 ISR 重建时仍会读取并处理完整中转数据，在服务端和浏览器端重复计算模型汇总。

因此不建议第一步就迁移到独立应用服务器。迁移只能改变 CPU 账单归属，不能消除机器人流量、重复计算或 R2 读取；如果请求链路不先收敛，新服务器同样会被打满。

推荐顺序：

1. P0：消除站内自动预取和匿名账户探测等请求放大器。
2. P0：对异常 HTML/RSC 自动化请求做边缘治理，先观测、再挑战或阻断。
3. P1：调整 OpenNext regional cache 的 R2 回读行为，并用灰度验证确保 ISR/SWR 正确。
4. P1：把 API 中转模型汇总预计算进快照，页面不再现场遍历整套站点和报价。
5. P2：把高频匿名数据和资源移到不进入应用 Worker 的静态数据面。
6. P3：完成上述优化后仍有稳定的高 CPU 动态任务，再选择性迁移到应用服务器。

## 二、当前成本基线

### 2.1 账单窗口

本次截图对应账期的主要指标：

| 项目 | 用量 | 成本 |
| --- | ---: | ---: |
| Workers CPU | `1.95B ms` | `$38.34` |
| Worker requests | `76.52M` | `$20.10` |
| R2 Class B | `41.15M` | `$11.52` |
| R2 Class A | `1.09M` | `$4.50` |
| R2 storage | - | `$0.05` |
| 合计 | - | `$74.51` |

当前实时面板约为每天 `3M` 次 Worker invocation，面板显示的 CPU 指标约 `12.96 ms`。账单里 CPU 仍是第一成本，请求数第二，R2 操作第三。

### 2.2 R2 成本归属

R2 操作几乎全部来自 OpenNext 增量缓存 bucket：

| Bucket | 对象/容量 | Class A | Class B | 判断 |
| --- | ---: | ---: | ---: | --- |
| `priceai-cloudflare-poc-opennext-cache` | 约 `57.25k` 对象、`16.85 GB` | `1.11M` | `41.43M` | 主要成本源 |
| `priceai-price-radar` | `2.78k` 对象、`858.73 MB` | 可忽略 | 可忽略 | 不是本轮主因 |
| `priceai-feedback-evidence` | `500` 对象、`120.84 MB` | 可忽略 | 可忽略 | 不是本轮主因 |
| `image-anything` | `4` 对象、`2.99 MB` | 可忽略 | 可忽略 | 不是本轮主因 |

OpenNext bucket 中保留了多个历史 Git SHA 的 `incremental-cache/<sha>/` 目录。它们应建立保留策略，但当前 storage 仅 `$0.05`，历史对象主要是卫生问题，不是这次账单的核心矛盾。

## 三、R2 Class A / Class B 为什么突然升高

### 3.1 Class A 是写入和列举类操作

Class A 通常包括 `PutObject`、`ListObjects`、`DeleteObject` 等写入/管理操作。R2 Standard 每月前 `1M` 次免费，超额按每百万次 `$4.50` 计费，并按完整计费单位向上取整。

本账期总量约 `1.09M`，实际仅约 `94.48k` 次超过免费额度，但向上取整后形成 `$4.50`。所以图上“一天突然很高”不等于那一天写入了价值 `$4.50` 的数据，而是当月第一次越过免费线后，账单显示了一个完整计费单位。

已排除的假设：这次 Class A 不是部署时通过 `rclone` 批量预填增量缓存造成的。GitHub Actions 中 `R2_ACCESS_KEY_ID` 为空，部署日志明确显示没有预填远端 R2 incremental cache，实际只上传了少量静态资源。

仍需通过 R2 审计日志确认的来源包括：ISR/增量缓存写入、revalidation 产生的新对象、构建版本切换后的新 key，以及历史对象清理或列举。

### 3.2 Class B 是读取类操作

Class B 通常包括 `GetObject`、`HeadObject` 等读取。每月前 `10M` 次免费，本账期约 `41.15M`，超额约 `31.15M`，向上取整为 `32M × $0.36 = $11.52`。

当前 OpenNext 配置使用 R2 incremental cache，并包裹 `short-lived` regional cache：

- regional cache 最大年龄约 60 秒；
- Next.js 16 下，当前默认 `shouldLazilyUpdateOnCacheHit=true`；
- 即使区域 Cache API 命中，OpenNext 也会通过 `waitUntil()` 在后台执行持久层 `get()`，刷新区域缓存；
- 持久层是 R2，所以一次区域缓存命中仍可能产生一次 R2 Class B。

这能解释为什么主 bucket 的 Class B `41.43M` 与总请求 `42.54M` 几乎同量级。它不是简单的“完全没缓存”，而是“缓存命中仍回读 R2”。

## 四、请求与机器人流量

### 4.1 短时样本

一次约 3.5 分钟、10% 采样的 Worker Tail 捕获 `754` 个事件：

| 类型 | 请求数 | 占比 | 采样 CPU |
| --- | ---: | ---: | ---: |
| RSC | `510` | `68%` | `14,017 ms` |
| API | `203` | `27%` | `7,748 ms` |
| Page | `38` | `5%` | `2,597 ms` |
| Asset | `3` | `<1%` | - |

前三个精确 UA 合计 `508/754` 次请求，但分布在 `98` 个 IP，来源覆盖住宅、移动网络、AWS、Oracle、阿里云和代理/数据中心 ASN。这更符合分布式自动化，而不是单一高频 IP。

短时采样只能用于识别热点，不能当作长期平均或精确账单归因。

### 4.2 现有规则为什么挡不住

- 自定义 WAF 目前只封一个确认 IP，事件量约 `165`。
- Free 套餐只有一条 rate limiting rule；现规则为非 `/_next/` 路径每 IP 在 10 秒内超过 200 次才封 10 秒，事件量约 `104`。
- 分布式来源可以让每个 IP 保持低速，从而绕过按 IP 的高阈值。
- 现规则排除了 `/_next/`，但大量 RSC 请求不一定都表现为该静态路径，仍会进入应用 Worker。
- 当前 AI bot policy 允许搜索、agent 和训练机器人，无法覆盖伪装成普通 Chrome 的自动化客户端。

### 4.3 站内请求放大器

代码中还存在两类非恶意放大：

- 全局 Header 挂载账户状态逻辑时会请求 `/api/account/me`，匿名页面访问也会产生账户探测。
- Footer 使用普通 `next/link`，可能自动预取 `/guides`、`/commercial`、`/support`，产生用户尚未点击的 RSC 请求。
- 仓库已有 `IntentPrefetchLink`，可以复用为 hover/focus 后才预取的模式。

这些请求本身不是账单全部来源，但改动小、误伤风险低，应优先处理。

## 五、`/api-transit/models` 为什么单次 CPU 高

### 5.1 观测结论

短时样本中该路由有 `9` 次请求，合计 CPU `1,944 ms`，平均约 `216 ms`，最大约 `534 ms`。样本很小，只能确认它是值得进一步测量的热点，不能把 `216 ms` 当作长期平均。

直接回答：**它有缓存，但缓存层次不够深，且缓存命中仍可能进入 Worker 和读取 R2；真正发生页面生成时，计算路径又比较重。**

### 5.2 已有缓存

1. 页面设置了 `revalidate = 300`，即 5 分钟 ISR。
2. `getTransitStations()` 有 30 秒的单进程内存缓存。
3. 数据层优先读取 `public_api_snapshots(kind='api_transit', key='default')`，快照 10 分钟内视为新鲜。
4. 页面生成结果进入 OpenNext incremental cache，持久层是 R2，区域层约 60 秒。

所以问题不是“完全没有缓存”。问题在于这些缓存分别有以下边界：

- 请求仍先进入 Worker，因此 Worker Requests 不会消失；
- 区域缓存命中后仍可能后台回读 R2，因此 Class B 不会明显下降；
- 每个新区域、新版本、冷启动或 ISR 重建都可能触发完整服务端路径；
- 30 秒进程内存对无状态、多实例 Worker 的复用价值有限；
- 快照保存的是完整站点数据，没有保存页面直接需要的模型汇总结果。

### 5.3 页面重建时做了什么

服务端页面每次生成会：

1. 并行读取完整中转站数据和赞助设置。
2. 对完整站点数据做列表压缩。
3. 调用 `getTransitModelSummaries(listStations, "all")`。
4. 再排序一次所有模型的最低综合倍率以计算页面顶部的 `bestRate`。
5. 把完整 `listStations` 作为 Client Component props 序列化给 `TransitModelExplorer`。

浏览器端 `TransitModelExplorer` 随筛选条件变化，又会对收到的完整站点数据再次运行 `getTransitModelSummaries()`。也就是说，首屏的服务端汇总主要用于顶部统计，列表组件又在客户端重复汇总。

### 5.4 数据读取的最坏路径

当 10 分钟公共快照不可用或过期时，`getTransitStations()` 会回源 Supabase，并执行：

- 查询全部已发布站点；
- 查询全部 active offers；
- 查询站点增强字段；
- 查询近期可用性样本，列表路径最多 `24,000` 行；
- 建立多个 `Map`，把报价、增强信息和样本重新映射到每个站点。

这里网络等待主要计入 wall time，但大量 JSON 解析、对象构造、映射和序列化会消耗 Worker CPU。

### 5.5 汇总算法的 CPU 来源

`getTransitModelSummaries()` 会：

- 遍历每个站点的每条报价，按标准模型分组；
- 对每个模型再次按站点分组；
- 为可用性 rollup 反复创建 `Map`、`Set` 和中间数组；
- 分别对综合倍率、固定价格、站点报价进行排序；
- 计算加权可用率和样本数；
- 最后再对全部模型汇总排序。

复杂度本身未必失控，但数据量、对象分配、重复排序和 RSC 序列化叠加后，在 Worker V8 isolate 中会形成明显的单次 CPU 峰值。

### 5.6 CPU 贡献优先级

根据当前代码和短时样本，优先级判断如下：

1. ISR/冷区域未命中时执行完整页面渲染。
2. 完整站点、报价和可用性数据的解析、映射与序列化。
3. 模型汇总中的重复分组、集合创建和排序。
4. 把完整站点数据传给 Client Component，并在客户端重复汇总。
5. R2 incremental cache 读取带来的开销。
6. 赞助设置读取，预计只占很小一部分。

## 六、目标架构

```text
collector / snapshot refresh
        |
        +--> 完整站点快照（详情/后台消费者）
        |
        +--> 预计算 model-index.v1（模型页直接消费）
                   |
                   +--> 页面顶部统计
                   +--> 模型列表与筛选

匿名请求
        -> Cloudflare WAF / challenge
        -> 静态数据面或边缘缓存
        -> 仅缓存未命中时进入动态计算
```

`model-index.v1` 应只包含模型页必需字段，例如模型、family、站点展示信息、综合倍率、固定价、可用率、样本数和更新时间。不要继续把完整 `TransitStation` 和不参与展示的详情字段发送到浏览器。

## 七、分阶段实施方案

### P0：先减少无效 Worker 请求

1. 将全局 Footer 的普通预取链接改为已有的 intent prefetch 模式，默认不自动发起 RSC。
2. 调整匿名态 `/api/account/me`：优先从已有会话信号判断，没有登录线索时不请求；或在全局布局中只对需要账户状态的页面挂载。
3. 按路径拆分 Worker 请求和 CPU 报表，至少区分 HTML、RSC、API、静态资源、账户接口。
4. 针对伪装 Chrome 的分布式自动化建立组合规则，不依赖单个 UA 或 IP：请求头一致性、RSC 高频模式、ASN/国家、无 cookie、无正常导航链等信号组合。
5. 先用 managed challenge 或小范围规则观测 24–48 小时，再逐步 block，明确放行搜索引擎、健康检查和自有采集器。

验收：Worker requests 日均从约 `3M` 降到 `1–1.5M` 以下；真实用户核心页面错误率无明显上升。

### P1：降低 R2 Class B

1. 在测试环境显式设置 `shouldLazilyUpdateOnCacheHit: false`，验证 Next.js 16 下 ISR、SWR tag、`revalidatePath` / `revalidateTag` 和部署切换行为。
2. 灰度发布后对比 48 小时：Worker requests、R2 Class B、缓存命中率、旧内容持续时间、首次访问延迟。
3. 若行为正确，再推广到生产；若 tag/SWR 出现一致性问题，回滚配置并评估 `long-lived` + 明确 purge 的方案。
4. 为 OpenNext bucket 建立按 Git SHA/年龄的保留策略，但只删除已确认不再被当前版本引用的历史前缀。

验收：R2 Class B 降到每月 `10M` 以下；不出现长时间陈旧页面或 revalidation 失效。

### P1：优化 `/api-transit/models`

1. 增加分段计时：cache status、snapshot read、Supabase fallback、compact、summary、RSC serialize/render。
2. 在 API transit 快照刷新阶段生成版本化 `model-index.v1`，而不是页面请求时生成。
3. 页面只读取模型索引；顶部统计和列表共用同一份汇总结果。
4. Client Component 接收精简模型索引，不再接收完整站点对象，也不再重新执行全量汇总。
5. 稳定外壳与动态数据拆分；根据业务新鲜度把模型索引 TTL 从 5 分钟逐步提高，而不是直接盲目延长整页缓存。
6. 只有模型索引缺失时才回退到现有实时计算路径，并记录 fallback 次数。

验收：该路由 cache miss/revalidate 的 CPU p50 下降至少 `70%`，缓存命中 CPU 接近普通静态页面；模型数、站点数、最低倍率、可用率与现有结果一致。

### P2：把匿名高频内容移出应用 Worker

1. Sponsor 图片、版本化公开 JSON 等直接由 Workers Static Assets 或 R2 custom domain + CDN Cache Rule 提供。
2. 对固定版本对象使用不可变 URL 和长 TTL；易变 `latest.json` 指针保持小体积、短 TTL。
3. 不把逐请求鉴权和任意 query 参数放到匿名快照路径，避免 Worker 执行和 cache key 碎片化。
4. 通过 `robots.txt`、`llms.txt` 和 API 文档把合法机器访问引导到公开快照，HTML/RSC 路径继续施加边缘约束。

验收：候选匿名路径响应无 `x-opennext`，第二次请求达到 CDN HIT，且不增加主 Worker invocation。

### P3：再决定是否迁移应用服务器

适合迁移的任务：必须动态执行、CPU 稳定较高、难以预计算，并且需要 Node 原生能力或长执行时间的后台任务。

不适合直接迁移的任务：公开页面 SSR、可预计算聚合、被机器人放大的 RSC，以及简单 R2/数据库读取。它们迁移后只会把成本从 Cloudflare 转移到服务器带宽和 CPU。

决策门槛：P0–P2 完成后连续观察 7 天；若剩余 CPU 中某一动态任务仍占总量至少 20%，且已证明无法通过缓存/预计算消除，再评估独立应用服务器。Cloudflare 继续承担 WAF、CDN 和入口限流，源站只接受受保护的回源流量。

## 八、目标与观测指标

| 指标 | 当前参考 | 第一阶段目标 |
| --- | ---: | ---: |
| Worker requests | 约 `3M/day` | `<1–1.5M/day` |
| Workers CPU 总量 | 账期 `1.95B ms` | 下降 `50%–70%` |
| R2 Class B | 账期 `41.15M` | `<10M/month` |
| R2 Class A | 账期 `1.09M` | `<1M/month` |
| `/api-transit/models` 重建 CPU | 短样本均值 `216 ms` | p50 下降 `>=70%` |

必须同时观测：真实用户 4xx/5xx、搜索引擎抓取、RSC 导航成功率、ISR 陈旧时间、Supabase 请求量、R2 操作数和业务数据更新时间。

## 九、发布、回滚与验证

### 48 小时验证

- 固定变更前后同一时段比较 Worker requests、CPU 和 R2 A/B。
- 查看 Top paths、RSC 占比、`/api/account/me` 和预取路由是否下降。
- 记录 WAF challenge solve rate 和误伤反馈。
- 检查 API transit 模型页数据完整性与更新时间。
- 检查 OpenNext revalidation 是否仍能及时更新页面。

### 7 天验证

- 用自然周而不是单小时外推月账单。
- 按路径计算 CPU 总贡献，而不仅看单次 CPU。
- 确认 Class A 没有因新快照写入策略反弹。
- 清理历史增量缓存前，先验证当前部署 SHA 与对象前缀，再保留至少一个可回滚版本。

每个阶段应独立提交、独立发布、独立观察。缓存配置、WAF 规则和数据快照结构不要在同一次发布中同时切换，以便明确归因和快速回滚。

## 十、事实与待验证假设

### 已确认

- CPU、Worker requests、R2 B、R2 A 是本账期四项主要成本。
- R2 操作主要来自 OpenNext incremental cache bucket。
- 当前 regional cache 为 `short-lived`，约 60 秒。
- Next.js 16 当前默认行为会在区域缓存命中后后台读取持久层。
- `/api-transit/models` 有 5 分钟 ISR，并非完全没有缓存。
- 模型页生成会读取完整站点快照并现场计算模型汇总。
- 模型汇总在服务端和 Client Component 中存在重复执行。
- 现有按 IP 的高阈值限速无法覆盖分布式低速自动化。

### 需要实施前或灰度中验证

- 每条路由的长期 CPU p50/p95 和总 CPU 贡献。
- `/api-transit/models` 的 cache hit、miss、revalidate 各自耗时占比。
- 关闭 lazy R2 refresh 对 Next.js tag/SWR 一致性的影响。
- WAF challenge/block 在当前账户计费口径下减少 Worker billed requests 的实际比例。
- 预计算模型索引后的真实 payload、RSC 序列化和浏览器计算降幅。
- 机器人流量中搜索引擎、合法 agent、监控和恶意抓取的实际构成。

## 十一、代码证据索引

- `src/app/api-transit/models/page.tsx`：`revalidate = 300`；页面读取站点、计算汇总并传入完整列表数据。
- `src/lib/api-transit-db.ts`：30 秒内存缓存、10 分钟公共快照、最多 24,000 行近期可用性样本回源路径。
- `src/lib/api-transit.ts`：`getTransitModelSummaries()` 的分组、集合、排序和加权汇总。
- `src/components/TransitModelExplorer.tsx`：客户端按筛选条件再次计算模型汇总。
- `open-next.config.ts`：R2 incremental cache + regional cache。
- `src/lib/infrastructure-runtime-profile.ts`：`short-lived`、60 秒 regional cache 运行画像。
- `node_modules/@opennextjs/cloudflare/dist/api/overrides/incremental-cache/regional-cache.js`：Next.js 16 cache hit 后 lazy store refresh 的实际实现。

相关既有调研：

- `research/price-radar-cloudflare-cost-audit-2026-07-21.md`
- `research/price-radar-cloudflare-live-baseline-2026-07-21.md`
