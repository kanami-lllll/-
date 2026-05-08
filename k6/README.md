# k6 压测脚本说明

本目录存放大营销平台的 k6 压测脚本。所有脚本默认请求本地 `http://localhost:8098`，实际压测云服务器时必须先设置 `BASE_URL`。

推荐在项目根目录执行命令：

```powershell
cd "F:\my XM\big-market"
$env:BASE_URL="http://111.230.95.111:8098"
```

## 1. 脚本总览

| 脚本 | 用途 | 是否有业务副作用 |
| --- | --- | --- |
| `query-smoke.js` | 查询接口冒烟测试，确认 k6 能访问后端 | 无副作用 |
| `query-load.js` | 查询接口阶梯压测，观察查询接口 RPS、p95、错误率 | 无副作用 |
| `query-peak.js` | 查询接口恒定 RPS 峰值压测，用于测试查询接口更高吞吐 | 无副作用 |
| `draw-smoke.js` | 抽奖链路小规模冒烟测试，验证签到、发放额度、抽奖是否跑通 | 会创建测试用户、发放抽奖次数、执行抽奖 |
| `draw-load.js` | 抽奖接口突发并发压测，用 VU/迭代数观察抽奖链路表现 | 会消耗 SKU 9901 和抽奖次数 |
| `draw-rps.js` | 抽奖接口恒定 RPS 压测，用于判断稳定承载能力 | 会大量消耗 SKU 9901 和抽奖次数 |

注意：

- 抽奖类脚本会生成 `guest_k6_...` 测试用户。
- 抽奖类脚本会消耗 `sku=9901`，该 SKU 表示“抽奖次数商品”，不是奖品库存。
- 如果出现 `ERR_BIZ_006 账户总额度不足`，说明测试用户没有准备好抽奖次数。
- 如果出现 `ERR_BIZ_005 活动库存不足`，说明 `sku=9901` 抽奖次数商品库存不足或 Redis 库存缓存异常。

## 2. 通用参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:8098` | 后端接口地址，压测服务器时必须修改 |
| `ACTIVITY_ID` | `100401` | 活动 ID |
| `RUN_ID` | 当前时间戳 | 本轮测试用户批次标识，一般不需要手动设置 |
| `DEBUG` | `false` | 是否打印失败请求详情 |

PowerShell 设置参数示例：

```powershell
$env:BASE_URL="http://111.230.95.111:8098"
$env:ACTIVITY_ID="100401"
$env:DEBUG="false"
```

## 3. 查询接口冒烟测试：query-smoke.js

用途：低风险验证后端接口是否可访问，适合第一次部署后先跑。

测试接口：

```text
POST /api/v1/raffle/strategy/query_raffle_award_list
```

默认配置：

| 配置 | 值 |
| --- | --- |
| VU | 5 |
| 持续时间 | 30s |
| 阈值 | `http_req_failed < 1%`，`p95 < 1000ms` |

运行命令：

```powershell
cd "F:\my XM\big-market"
$env:BASE_URL="http://111.230.95.111:8098"
k6 run .\performance\k6\query-smoke.js
```

需要修改的参数：

| 参数 | 什么时候修改 |
| --- | --- |
| `BASE_URL` | 换服务器地址时修改 |
| `ACTIVITY_ID` | 换活动 ID 时修改 |

## 4. 查询接口阶梯压测：query-load.js

用途：压测查询接口在不同 VU 下的吞吐量和延迟。该脚本没有业务副作用，不消耗库存，不创建订单。

测试接口：

```text
POST /api/v1/raffle/strategy/query_raffle_award_list
```

默认压测阶段：

| 阶段 | VU | 时间 |
| --- | ---: | --- |
| 预热 | 10 | 30s 爬升 + 1m 保持 |
| 阶段 1 | 30 | 30s 爬升 + 1m 保持 |
| 阶段 2 | 50 | 30s 爬升 + 1m 保持 |
| 阶段 3 | 100 | 30s 爬升 + 1m 保持 |
| 收尾 | 0 | 30s 下降 |

运行命令：

```powershell
cd "F:\my XM\big-market"
$env:BASE_URL="http://111.230.95.111:8098"
k6 run .\performance\k6\query-load.js
```

如果想提高查询压力，可以减少 sleep：

```powershell
cd "F:\my XM\big-market"
$env:BASE_URL="http://111.230.95.111:8098"
$env:SLEEP_SECONDS="0"
k6 run .\performance\k6\query-load.js
```

可修改参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:8098` | 后端地址 |
| `ACTIVITY_ID` | `100401` | 活动 ID |
| `SLEEP_SECONDS` | `0.2` | 每轮查询后的等待时间，越小压力越大 |

重点观察：

- `http_reqs`：总请求数和平均 RPS。
- `http_req_failed`：HTTP 失败率。
- `http_req_duration p(95)`：95% 请求响应时间。
- `checks`：业务断言是否通过。

## 5. 查询接口峰值压测：query-peak.js

用途：测试查询接口在更高目标 RPS 下是否还能稳定通过。这个脚本不使用 sleep，并使用 `constant-arrival-rate` 模式按指定 RPS 发请求，比 `query-load.js` 更适合冲查询接口吞吐上限。

测试接口：

```text
POST /api/v1/raffle/strategy/query_raffle_award_list
```

### 5.1 运行 200 RPS

```powershell
cd "F:\my XM\big-market"

$env:BASE_URL="http://111.230.95.111:8098"
$env:TARGET_RPS="200"
$env:DURATION="1m"
$env:PRE_ALLOCATED_VUS="200"
$env:MAX_VUS="400"
$env:DEBUG="false"

k6 run .\performance\k6\query-peak.js
```

### 5.2 运行 500 RPS 并保存结果

```powershell
cd "F:\my XM\big-market"

New-Item -ItemType Directory -Force .\performance\results | Out-Null

$env:BASE_URL="http://111.230.95.111:8098"
$env:TARGET_RPS="500"
$env:DURATION="1m"
$env:PRE_ALLOCATED_VUS="500"
$env:MAX_VUS="1000"
$env:DEBUG="false"

k6 run --summary-export .\performance\results\query-peak-500.json .\performance\k6\query-peak.js
```

### 5.3 参数说明

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `TARGET_RPS` | `200` | 目标每秒查询请求数 |
| `DURATION` | `1m` | 压测持续时间 |
| `PRE_ALLOCATED_VUS` | `max(50, TARGET_RPS)` | k6 预分配 VU 数 |
| `MAX_VUS` | `max(PRE_ALLOCATED_VUS, TARGET_RPS * 2)` | k6 最大 VU 数 |
| `DEBUG` | `false` | 是否打印失败响应 |

### 5.4 判断是否通过

| 指标 | 通过标准 |
| --- | --- |
| `query_success_rate` | 大于 99% |
| `http_req_failed` | 小于 1% |
| `query_req_duration p95` | 小于 1500ms |

如果 `dropped_iterations` 明显增加，说明 k6 或被测服务已经无法按目标 RPS 发满请求，该档位不应视为稳定吞吐。

## 6. 抽奖链路冒烟测试：draw-smoke.js

用途：小规模验证完整抽奖链路是否能跑通。该脚本适合在正式抽奖压测前执行。

执行流程：

```text
生成测试用户
-> 调用 calendar_sign_rebate 签到返利
-> 等待 MQ 异步处理
-> 查询用户抽奖账户
-> 每个用户执行一次 draw
```

默认配置：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `USER_COUNT` | `20` | 测试用户数 |
| `DRAW_VUS` | `10` | 抽奖阶段 VU 数 |
| `PREP_WAIT_SECONDS` | `10` | 签到后等待异步发放额度的时间 |
| `VERIFY_ACCOUNT` | `true` | 是否查询账户额度 |
| `DEBUG` | `false` | 是否打印详细失败信息 |

运行命令：

```powershell
cd "F:\my XM\big-market"
$env:BASE_URL="http://111.230.95.111:8098"
$env:USER_COUNT="20"
$env:DRAW_VUS="10"
$env:PREP_WAIT_SECONDS="10"
$env:VERIFY_ACCOUNT="true"
$env:DEBUG="true"
k6 run .\performance\k6\draw-smoke.js
```

什么时候调整参数：

| 参数 | 建议 |
| --- | --- |
| `USER_COUNT` | 冒烟测试建议 3、10、20，不要太大 |
| `DRAW_VUS` | 一般小于等于 `USER_COUNT` |
| `PREP_WAIT_SECONDS` | 如果账户额度还没到账，可以改成 `20` 或 `30` |
| `DEBUG` | 排查失败原因时改成 `true` |

## 7. 抽奖突发并发压测：draw-load.js

用途：用固定 VU 和固定迭代数观察抽奖链路表现。它适合做“突发并发验证”，但不适合作为最终稳定 QPS 结论，因为 setup 阶段耗时会摊薄整体统计。

执行流程：

```text
setup 阶段：
生成测试用户 -> 签到返利 -> 积分兑换 SKU 9901 -> 等待额度到账

load 阶段：
只调用 draw 抽奖接口
```

默认参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `USER_COUNT` | `200` | 准备的测试用户数 |
| `DRAW_ITERATIONS` | 等于 `USER_COUNT` | 抽奖总次数 |
| `DRAW_VUS` | `50` | 抽奖阶段 VU 数 |
| `SKU` | `9901` | 兑换抽奖次数的 SKU |
| `SIGN_WAIT_SECONDS` | `5` | 签到后等待时间 |
| `EXCHANGE_WAIT_SECONDS` | `5` | 兑换后等待时间 |
| `DEBUG` | `false` | 是否打印失败详情 |

小规模运行命令：

```powershell
cd "F:\my XM\big-market"
$env:BASE_URL="http://111.230.95.111:8098"
$env:USER_COUNT="20"
$env:DRAW_ITERATIONS="20"
$env:DRAW_VUS="5"
$env:SIGN_WAIT_SECONDS="10"
$env:EXCHANGE_WAIT_SECONDS="10"
$env:DEBUG="true"
k6 run .\performance\k6\draw-load.js
```

中等并发运行命令：

```powershell
cd "F:\my XM\big-market"
$env:BASE_URL="http://111.230.95.111:8098"
$env:USER_COUNT="200"
$env:DRAW_ITERATIONS="200"
$env:DRAW_VUS="50"
$env:SIGN_WAIT_SECONDS="10"
$env:EXCHANGE_WAIT_SECONDS="10"
$env:DEBUG="false"
k6 run .\performance\k6\draw-load.js
```

需要注意：

- `DRAW_ITERATIONS` 不要大于 `USER_COUNT`，除非你确认每个用户有多次抽奖额度。
- 这个脚本会消耗 SKU 9901 和抽奖次数。
- 最终判断 draw 接口稳定 RPS，优先使用 `draw-rps.js`。

重点看自定义指标：

| 指标 | 含义 |
| --- | --- |
| `draw_requests` | draw 请求数量 |
| `draw_success_rate` | draw 业务成功率 |
| `draw_req_duration` | draw 请求耗时 |
| `draw_business_failures` | draw 业务失败次数 |

## 8. 抽奖恒定 RPS 压测：draw-rps.js

用途：固定每秒请求数，判断 draw 抽奖接口在指定 RPS 下是否稳定。这是本轮压测用来判断稳定承载能力的核心脚本。

执行流程：

```text
setup 阶段：
生成测试用户
-> 签到返利
-> 积分兑换 SKU 9901
-> 查询用户抽奖账户
-> 只保留有抽奖次数的 readyUsers

load 阶段：
按 TARGET_RPS 恒定速率调用 draw 接口
```

关键规则：

```text
USER_COUNT 必须大于 TARGET_RPS * 持续秒数
```

原因：脚本默认每个测试用户只抽一次，避免同一个用户抽奖次数不够。

例如：

| 目标 | 计算 | 建议 USER_COUNT |
| --- | --- | ---: |
| 50 RPS，1 分钟 | 50 * 60 = 3000 | 4000 |
| 100 RPS，1 分钟 | 100 * 60 = 6000 | 8000 |
| 150 RPS，1 分钟 | 150 * 60 = 9000 | 12000 |
| 200 RPS，1 分钟 | 200 * 60 = 12000 | 13000 或更多 |

### 8.1 运行 100 RPS

```powershell
cd "F:\my XM\big-market"

$env:BASE_URL="http://111.230.95.111:8098"
$env:TARGET_RPS="100"
$env:DURATION="1m"
$env:USER_COUNT="8000"
$env:PRE_ALLOCATED_VUS="100"
$env:MAX_VUS="200"

$env:SIGN_WAIT_SECONDS="20"
$env:EXCHANGE_WAIT_SECONDS="30"
$env:READY_CHECK_RETRIES="5"
$env:READY_CHECK_INTERVAL_SECONDS="10"
$env:EXCHANGE_RETRIES="3"
$env:EXCHANGE_RETRY_WAIT_SECONDS="15"
$env:DEBUG="false"

k6 run .\performance\k6\draw-rps.js
```

### 8.2 运行 200 RPS 并保存结果

```powershell
cd "F:\my XM\big-market"

New-Item -ItemType Directory -Force .\performance\results | Out-Null

$env:BASE_URL="http://111.230.95.111:8098"
$env:TARGET_RPS="200"
$env:DURATION="1m"
$env:USER_COUNT="13000"
$env:PRE_ALLOCATED_VUS="300"
$env:MAX_VUS="600"

$env:SIGN_WAIT_SECONDS="20"
$env:EXCHANGE_WAIT_SECONDS="30"
$env:READY_CHECK_RETRIES="5"
$env:READY_CHECK_INTERVAL_SECONDS="10"
$env:EXCHANGE_RETRIES="3"
$env:EXCHANGE_RETRY_WAIT_SECONDS="15"
$env:DEBUG="false"

k6 run --summary-export .\performance\results\draw-rps-200.json .\performance\k6\draw-rps.js
```

### 8.3 draw-rps.js 参数说明

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `TARGET_RPS` | `50` | 目标每秒 draw 请求数 |
| `DURATION` | `1m` | 压测持续时间 |
| `USER_COUNT` | `1000` | 准备的测试用户数，必须大于目标抽奖请求数 |
| `PRE_ALLOCATED_VUS` | `TARGET_RPS` | k6 预分配 VU 数 |
| `MAX_VUS` | `max(TARGET_RPS * 2, PRE_ALLOCATED_VUS)` | k6 最大 VU 数 |
| `SKU` | `9901` | 用于兑换抽奖次数的 SKU |
| `SIGN_WAIT_SECONDS` | `15` | 签到后等待 MQ 返利到账的时间 |
| `EXCHANGE_WAIT_SECONDS` | `15` | 兑换后等待账户额度到账的时间 |
| `READY_CHECK_RETRIES` | `3` | 检查用户抽奖额度的重试次数 |
| `READY_CHECK_INTERVAL_SECONDS` | `10` | 每次检查额度之间的等待时间 |
| `EXCHANGE_RETRIES` | `2` | 额度不足时补充兑换的重试次数 |
| `EXCHANGE_RETRY_WAIT_SECONDS` | `10` | 每次补充兑换后的等待时间 |
| `DEBUG` | `false` | 是否打印失败用户和响应体 |

### 8.4 判断是否通过

本轮压测采用以下通过标准：

| 指标 | 通过标准 |
| --- | --- |
| `draw_success_rate` | 大于等于 99% |
| `http_req_failed` | 小于 1% |
| `draw_req_duration p95` | 小于 1500ms |

只要其中一项不满足，就不算稳定通过。

## 9. 常见问题

### 9.1 报错连接 localhost

现象：

```text
Post "http://localhost:8098/..."
```

原因：没有设置 `BASE_URL`，脚本使用了默认本地地址。

解决：

```powershell
$env:BASE_URL="http://111.230.95.111:8098"
```

### 9.2 账户总额度不足

现象：

```text
ERR_BIZ_006 账户总额度不足
```

原因：测试用户没有可用抽奖次数，通常是签到返利、积分兑换或 MQ 异步处理还没完成。

解决方式：

- 增大 `SIGN_WAIT_SECONDS`。
- 增大 `EXCHANGE_WAIT_SECONDS`。
- 增大 `READY_CHECK_RETRIES`。
- 打开 `$env:DEBUG="true"` 查看具体失败用户。

### 9.3 活动库存不足

现象：

```text
ERR_BIZ_005 活动库存不足
```

含义：`sku=9901` 抽奖次数商品库存不足，不是奖品库存不足。

处理方向：

- 查询活动 SKU 库存接口，确认 `sku=9901` 是否还有剩余库存。
- 检查 Redis 中 `activity_sku_stock_count_key_9901` 是否被压测消耗到 0。
- 必要时恢复测试环境库存后重新调用 `armory` 预热。

### 9.4 200 RPS 输出太长

建议使用 `--summary-export` 保存结果：

```powershell
New-Item -ItemType Directory -Force .\performance\results | Out-Null
k6 run --summary-export .\performance\results\draw-rps-200.json .\performance\k6\draw-rps.js
```

## 10. 服务器观察命令

压测时建议在服务器上观察资源：

```bash
sudo docker stats
watch -n 1 free -h
sudo docker logs --tail=200 big-market-lite-backend
```

重点关注：

- backend CPU 和内存。
- MySQL CPU、内存、慢查询。
- Redis 是否有库存 key 异常。
- RabbitMQ 是否有消息堆积。
- 系统 `available` 内存是否过低。

## 11. 推荐执行顺序

第一次完整压测建议按以下顺序执行：

```text
1. query-smoke.js
2. query-load.js
3. query-peak.js
4. draw-smoke.js
5. draw-load.js 小规模
6. draw-rps.js 50 RPS
7. draw-rps.js 100 RPS
8. draw-rps.js 150 RPS 或 200 RPS
```

当前项目已经完成压测，结论是：

```text
查询接口 100 VU 阶梯压测通过；
draw 抽奖接口 100 RPS 稳定通过；
150 RPS 和 200 RPS 未通过；
当前环境稳定承载能力按 100 RPS 记录。
```
