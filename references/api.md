# OAuth 接口与加密机制（2026-11-04 实测）

> 本篇只覆盖**登录**接口。登录成功后的学习任务 / 学时业务接口见 `task-api.md`。
> 二者认证头不同：业务接口是 `Authorization: Bearer__<token>`（**双下划线**），
> 写成标准的 `Bearer <token>` 会返回 401 Access is Denied。

平台后端为**知学云**（zhixueyun.com）的 OAuth 服务，前端是 drizzlejs + crypto-js 打包的单页应用。以下内容全部经真实抓包验证，不是推测。

## 登录入口

点击首页「登录」后跳转到独立的 OAuth 页：

```
https://mooc.ctt.cn/oauth/#login/cmVzcG9uc2VfdHlwZT10b2tlbiZjbGllbnRfaWQ9OTk5JnJlZGlyZWN0X3VyaT1odHRwcyUzQSUyRiUyRm1vb2MuY3R0LmNuJnN0YXRlPSUyRmhvbWUmbGFuZz1jbiZjYW5jZWxSZW1lbWJlclN0YXRlPTA=
```

路径段是 base64 编码的 OAuth 参数，解码后：

```
response_type=token&client_id=999&redirect_uri=https%3A%2F%2Fmooc.ctt.cn&state=%2Fhome&lang=cn&cancelRememberState=0
```

属于 **OAuth2 隐式流**，登录成功后跳回：

```
https://mooc.ctt.cn#access_token=<token>&token_type=Bearer&expires_in=...&state=/home
```

## 参数加密（关键）

前端 `oauth/scripts/main-*.js` 内含：

```js
"./config/key-config": aeskey = "d8cg8gVakEq9Agup"
"./app/util/aes": CryptoJS.AES.encrypt(Utf8.parse(v), Utf8.parse(aeskey),
                                        {mode: ECB, padding: Pkcs7})
```

- 算法：**AES-128-ECB + PKCS7 + Base64**，密钥硬编码 `d8cg8gVakEq9Agup`
- 空值不加密，原样传空
- 标记 `security: true` 的接口，其全部 `data` 字段逐个走上述加密

**验证方法**（日后怀疑变更时用）：`encrypt("1")` 必须等于 `N8XxZPBkHR4UcAuMtuMC4Q==`。若不相等，说明密钥或算法变了，需重新抓 `main-*.js` 的 `key-config` 段。

Python 实现见 `scripts/mooc_api.py` 的 `aes_encrypt()`。

## 接口清单

基址 `https://mooc.ctt.cn/oauth/api/v1/`

| 方法 | 路径 | 参数加密 | 说明 |
| --- | --- | --- | --- |
| GET | `/deriveQRCode` | 否 | 取 APP 扫码二维码，返回 `{data: <base64 PNG>, uuid}` |
| GET | `/loginCheck` | 是 | 轮询 APP 扫码结果，参数 `uuid`、`organizationId`、`key` |
| POST | `/createQRCode` | 否 | 登记微信扫码 uuid，返回 `{uuid}`（**不下发图片**） |
| POST | `/checkUUIDStatus` | 否 | 轮询微信扫码结果，参数 `uuid`（明文） |
| POST | `/weChat-auth` | 是 | 微信扫码后换 token，参数 `key`、`organization_id`、`openId` |
| POST | `/auth` | 是 | 账号密码登录 |
| GET | `/getWechatUrl` | 否 | 微信开放平台跳转链接（**本组织 appid 为空，不要用**） |
| GET | `/setting` | 否 | 登录页配置，参数 `key=<base64(OAuth参数)>` |
| GET | `/skin` | 否 | 皮肤，参数 `organizationId=1&clientType=1&language=1` |
| POST | `/verification-code` | 是 | 双因子验证码下发 |

### 微信扫码（公众号通道，可用）

**不要用 `getWechatUrl`** —— 那是微信开放平台 `qrconnect` 路径，本组织 `appid` 为空，微信直接报「AppID 参数错误」。真正的微信登录走的是知学云自己的公众号扫码服务 `wx.zhixueyun.com`。

流程三接口：

```http
POST /oauth/api/v1/createQRCode?uuid=<前端生成的 UUID v4>
→ 200 {"uuid":"a1094315-647a-4f48-b338-b9e60a2b0c2a"}

POST /oauth/api/v1/checkUUIDStatus?uuid=<同一个 uuid>     # 明文，不加密
→ 200 {}                                    未扫描
→ 200 {"status":true,"openId":"..."}        已扫描
→ 200 {"code":"0002"}                       二维码已失效，需重新生成

POST /oauth/api/v1/weChat-auth                            # security:true
key=<会话key>&organization_id=<AES(1)>&openId=<AES(openId)>
→ 200 {"redirect_uri":"https://mooc.ctt.cn","access_token":"...","token_type":"Bearer","expires_in":...,"state":"/home"}
```

**二维码图片不在响应里**，由前端 `qrcodejs2` 本地渲染，内容模板（`main-*.js` 的 `./app/ext/qr-code`）：

```js
var c = "https://wx.zhixueyun.com/mswx/wechat/tobaccoQR/login/" + uuid + "/v5/" + ds
```

`ds` 按访问域名取值：`moocdev9`→dev，`mooctest9`→test，`mooc5`→publicTest，`smooc`/`imooc`→gd，其余→**online**。`mooc.ctt.cn` 取 `online`。

已用 `zxing` 对页面真实二维码解码回验，内容示例：

```
https://wx.zhixueyun.com/mswx/wechat/tobaccoQR/login/a1094315-647a-4f48-b338-b9e60a2b0c2a/v5/online
```

### deriveQRCode（APP 扫码）

```http
GET /oauth/api/v1/deriveQRCode
→ 200 {"data":"iVBORw0KGgo...","uuid":"2c320a0b-8cb4-4bf9-ba43-a5ba57fc42e8"}
```

`data` 直接是一张完整 PNG（base64），无需再拼接口。实测 587 字节的 430×430 图片，微信/APP 均可正常识别。

### loginCheck

```http
GET /oauth/api/v1/loginCheck?uuid=<AES(uuid)>&organizationId=<AES(1)>&key=<会话key>
→ 200 {}                                    未扫码
→ 200 {...授权信息...}                       已扫码
→ 422 {"errorCode":900000,"message":"Invalid input."}   参数未加密
```

明文参数一定 422，可作为"加密是否正确"的快速判据。

### auth（表单登录）

```http
POST /oauth/api/v1/auth
Content-Type: application/x-www-form-urlencoded

key=<会话key>
&organization_id=<AES(1)>
&login_method=<AES("account")>
&username=<AES(账号)>
&pword=<AES(密码)>
&captcha=<验证码，无则空>
```

实测错误码：

| errorCode | 含义 |
| --- | --- |
| 900000 | 参数校验失败（未加密或字段缺失） |
| 90105 | 账号格式不合法 |
| 90908 | 账号/密码校验未通过 |

### app-login（APP 通道账密登录 · 方式三，推荐）

网页 `/auth` 的替代通道，**不需要会话 key，不需要验证码，token 有效期 30 天**。逆向自 APP 前端拦截器，已与实测可用脚本逐字节比对一致。

```http
POST https://mooc.ctt.cn/oauth/api/v1/app-login
Content-Type: application/x-www-form-urlencoded        ← 必须，发 JSON 直接 422/900000
Accept: application/json;charset=UTF-8
X-Requested-With: XMLHttpRequest
Origin: https://mooc.ctt.cn
Referer: https://mooc.ctt.cn/oauth/

username=<AES(账号)>
&pword=<AES(密码)>
&company_name=<AES("全行业")>
&login_method=<AES("login-by-user")>      ← login-by-user 账密 / login-by-mobile 手机动态码
&client_id=<AES(999)>
&displayDynamic=<AES("true")>
&terminal=<AES("Google Inc.")>
&system=<AES("Linux armv8l")>
&captcha=                                  ← 空字符串原样传，不加密
```

**加密粒度是最容易踩的坑**：是"每个字段值各自 AES-128-ECB(PKCS7) → Base64"，不是整体加密。布尔值要按 JS 语义产出小写 `true`/`false`（`str(True)` 会得到 `"True"`，是错的）。

成功响应（HTTP 200）：

```json
{"access_token":"...", "token_type":"Bearer", "expires_in":2592000,
 "userid":"...", "loginToken":"..."}
```

业务接口仍用 `Authorization: Bearer__<access_token>`（双下划线）。

实测（2026-11-04 20:45–20:52，故意用不存在的账号，观察服务端在哪一步拒绝）：

| 请求形态 | 响应 | 说明 |
| --- | --- | --- |
| 9 字段齐全 + `13800138000`（11 位手机号格式） | `422 {"errorCode":90908}` | **已进入密码校验**：说明每个字段的密文都被正确解出 |
| 9 字段齐全 + `test_not_exist_0001` | `422 {"errorCode":90105}` | 卡在账号格式校验 |
| 5 字段（username/pword/login_method/company_name/client_id） | `422 {"errorCode":90105}` | 五项即可，其余可省 |
| 仅 username+pword | `422 {"errorCode":900000}` | 缺必填项 |
| username 传空串 | `422 {"errorCode":900000}` | 空值未加密，被判缺失 |

`90908` 这条是关键证据：服务端能解出手机号格式的账号并去比对密码，证明 form-urlencoded + 逐字段 AES 的实现与 APP 客户端一致。**必填五项**是 username、pword、login_method、company_name、client_id；`terminal`/`system`/`displayDynamic`/`captcha` 可省。

### 端到端实测（2026-11-04 20:48，真实账号）

同一账号两次请求只差密码，结果对照明确：

| 账号 | 密码 | 响应 |
| --- | --- | --- |
| `<账号>` | `<密码，少一位>` | `422 {"errorCode":90908}` |
| `<账号>` | `<正确密码>` | `200 {"access_token":"…","token_type":"Bearer","expires_in":2592000,"userid":"707e08fe-…"}` |

因此 **`90908` 就是"密码不正确"**，不是"账号不存在"（后者在格式合法时同样落 90908，无法区分，但已知正确密码可直接登录）。

拿到 token 后立即串通后续链路，全部通过：

```
status  → valid=true, member=张××/XX烟草-->XX市局(分公司)-->XX部门
summary → 网络自学 116.10/50、集中培训 64.00/90
sync    → 平台 69 条，scope=active 选中 6 条，幂等复跑「新增 0 更新 6」
```

`Bearer__<token>` 头部与扫码 token 完全等价，无需任何额外步骤。

**HTTP 状态码不可用于判断成败**——凭据错误同样返回 422，且响应**不带 `Content-Type`**，只能直接 `r.json()`，不能按 content-type 判断。

`LoginError` 按 `errorCode` 归类：

| errorCode | 含义 | 归因 |
| --- | --- | --- |
| `90908` / `90904` | 账号或密码不正确 | 用户侧，请其核对密码 |
| `90907` | 校验未通过（多次失败后出现，疑似频率限制） | 立即停止重试，让用户稍后或改用扫码 |
| `90105` | 账号格式不合规（平台要求手机号/工号） | 用户侧，请其改用登录用的手机号或工号 |
| `900000` | 参数缺失或加密有误 | 脚本侧，不要归因给用户 |
| `900001` | 登录过于频繁 | 等 5–10 分钟再试 |

### getWechatUrl

```http
GET /oauth/api/v1/getWechatUrl?company_id=1&redirect_url=https://mooc.ctt.cn/oauth/#weixin-login
→ 200 {"url":"https://open.weixin.qq.com/connect/qrconnect?appid=&redirect_uri=...&scope=snsapi_login&state=1#wechat_redirect"}
```

**注意：当前返回的 `appid` 为空**，打开该链接微信报「AppID 参数错误」。原因是本组织没有配置微信开放平台网站应用。

但这**不等于**微信扫码不可用——本平台的微信登录走的是公众号扫码（见上节 `createQRCode`），与这个接口无关。`/setting` 里的 `weChatLogin: "0"` 只控制登录页是否显示那个切页按钮：UI 上被隐藏了，后端通道仍是通的（手动切 step 后二维码正常生成，`createQRCode` 正常返回）。

### setting（登录页配置）

`loginPageConfig` 字段（2026-11-04 实测值）：

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `accountValue` | "1" | 账号密码登录可用 |
| `mobileValue` | "1" | 手机号登录可用 |
| `weChatLogin` | **"0"** | 微信扫码**关闭** |
| `doubleValidate` | **"1"** | 双因子验证开启 |
| `doubleValidateStudent` | "1" | 学员双因子同样开启 |
| `graphicCode` | "0" | 图形验证码关闭 |
| `faceShow` / `faceValue` | true / "0" | 人脸登录未启用 |

## 会话 key

`auth`、`loginCheck` 等接口的 `key` 参数来自前端 `module.renderOptions.key`，服务端按登录会话下发，**同一会话内恒定**。获取方式：

1. 打开登录页后，抓任一 `security: true` 请求的查询参数；
2. 或从页面上下文中由前端自动带出（纯 API 场景下需先抓一次）。

实测：把 A 会话抓到的 key 用于新建的 requests 会话，`auth` 仍返回业务级错误码 `90908`（而非参数错误 `900000`），说明 key 不严格绑定 cookie，可跨会话复用。但**平台若调整策略，此项最先失效**——失败时优先重新抓 key。

## 两条链路的端到端实测记录（2026-11-04 19:26）

实测脚本 `scripts/flow_test.py`，用真实账号扫码跑通。

### 微信扫码：三阶段全通

```
STEP1_QR    uuid=defe97fe-a1e1-4c27-a542-fb457329a388  PNG 1607B
POLL1-4     200  null                                   ← 未扫
POLL5       200  {"code":"0000","openId":"oSOKTjm51VBRON65KKof71MXuQNI","status":true}
STEP3_TOKEN 200  {"access_token":"13ec7672...","token_type":"Bearer",
                  "redirect_uri":"https://mooc.ctt.cn","state":"/home","expires_in":14400}
```

**扫码后 8 秒即完成**。得到的 `access_token` 已验证可用：浏览器打开
`https://mooc.ctt.cn/#access_token=<token>&token_type=Bearer&expires_in=14400&state=/home`，
前端会把它写入 `localStorage.token` 并跳转 `#/home`，刷新后显示「学习中心 / 退出」及学时数据，即真实登录态。

### APP 扫码：取码与轮询正常，未完成扫码

```
STEP1_QR  uuid=756ec212-5efa-4bad-8023-f0dcd91ef75f  PNG 588B
POLL1-47  200  {}                                     ← 100 秒内无人扫码
TIMEOUT
```

注意一个**关键行为差异**，且比预想的更极端——实测 70 秒、35 次轮询，**两条通道都只返回空值，服务端从不主动告知"二维码已失效"**：

| | 微信 `checkUUIDStatus` | APP `loginCheck` |
| --- | --- | --- |
| 未扫码 | `null` | `{}` |
| 已扫码 | `{"code":"0000","openId":...,"status":true}` | 授权信息（含 access_token） |
| 过期 | **仍然 `null`**（`0002` 在 70 秒观测中一次都没出现） | **仍然 `{}`** |

所以「过期」这件事**只能靠本地计时判断**：

- 前端那句「二维码已失效」是它自己数到第 10 次（50 秒）后翻的 UI 文案，不是服务端返回的；
- `code:"0002"` 保留在前端代码里当兜底分支，但实测不可依赖；
- 客户端应在 **50–60 秒**无扫码时主动换新码，两个通道一视同仁。

### 自动重取实测（无人扫码场景）

`python scripts/flow_test.py watch --channel wechat|app --ttl 70 --cycles 2`

```
微信：QR#1 uuid=aa846b51… → 35 次 null → 70.2s 结束(poll_ttl) → QR#2 uuid=f8fe65a7… → 同样 70.1s
APP ：QR#1 uuid=270d1990… → 33 次 {}   → 70.1s 结束(ttl)      → QR#2 uuid=fc2b3bec… → 72.0s
```

两轮 uuid 均不同，PNG 均重新生成，说明重取链路正常。`wait_login()` 把这段逻辑固化为可复用方法。

同日 19:33–19:36 又做了一次 3 轮 × 55 秒的连续实测（`--ttl 55 --cycles 3`）：

```
QR#1 8848ea96… → 27 次 {} → 55.9s 换码
QR#2 77669bed… → 27 次 {} → 55.6s 换码
QR#3 0af596c9… → 27 次 {} → 55.8s 结束
```

三轮耗时稳定在 55.6–55.9 秒，说明定时换码准确、不会漂移；每轮都是新 uuid。

### 对话内联二维码 → 扫码 → 换 token（2026-11-04 19:46 全链路成功）

这一轮验证的是「码出现在对话里，用户直接扫」这条路，结果一次跑通：

```
19:46:34  QR_ISSUED#1  uuid=093fda88-3dff-4e18-87bc-2f3780d0800a  ttl=55s
19:47:07  CYCLE_END    ended=scanned  scanned_after=33.2s
          LOGIN_OK     {"access_token":"<access_token>",
                        "token_type":"Bearer","expires_in":14400,"state":"/home"}
```

关键点：**二维码以 `data:image/png;base64,...` 内嵌进对话消息**，用户直接扫即成功。
同一张图如果改用本地路径引用（相对路径 / `C:/...` / `file:///` 三种都试过）在对话内**全部显示为坏图**，只有内嵌 base64 能渲染。这条已验证，不要再走路径引用。

另外用 `--ttl 30 --cycles 2` 做了一次短周期演示，确认「过期即换码」：

```
QR#1 cc581d73… → 30.9s 结束(poll_ttl) → QR#2 db4da8c7… → 30.9s 结束(poll_ttl)
```

两轮都是本地计时到点换码，服务端全程未给任何过期信号。

### 双通道并列出码（2026-11-04 19:53）

用户只说「微信扫码用的二维码，还有 App 扫码用的二维码」，未指定用哪种时，**不替他选、不追问**，一次把两张码并排内联发在对话里。新增 `scripts/dual_login.py`：

```
DUAL_ISSUED#1  wechat_uuid=f8c2c2b9…  app_uuid=a978cf6d…  两张 PNG 同时输出
DUAL_EXPIRED#1 reason=ttl  elapsed=55.7s
DUAL_ISSUED#2  wechat_uuid=383003d6…  app_uuid=3600608a…  （两张同时换新 uuid）
```

实现要点：

- 微信与 APP 各用一个 `MoocAuth` 实例（独立 `requests.Session`），避免 cookie / uuid 串扰；
- 单个轮询循环内**交替**查 `checkUUIDStatus` 与 `loginCheck`（2 秒间隔），任一通道扫到立即换凭证并结束，不等另一条；
- 两条都无人扫、本地 55 秒到点 → **同时重取两张码**，输出新的 `WIDGET#n`，由 Agent 再发一条消息；
- `WIDGET#n|<html>` 内嵌两张 `data:image/png;base64,...`，用一个 widget 并排展示，倒计时用 `dualcd<n>` 作唯一 id，避免多轮 widget 同页时 id 冲突。

APP 通道的 `loginCheck` 返回空值时无法区分「未扫」与「已过期」，与微信通道同样按本地计时处理，这一点在双通道模式下更不能依赖服务端信号。

**同日 19:56 APP 通道首次换到凭证**（此前几轮只是没人扫，不是链路不通）：

```
19:56:00  DUAL_ISSUED#1  wechat_uuid=d6cb786e…  app_uuid=c83ec120…
19:56:5x  LOGIN_OK  channel=app
          token={"access_token":"<access_token>",
                 "token_type":"Bearer","expires_in":14400,
                 "state":"/home","redirect_uri":"https://mooc.ctt.cn"}
          RESULT  ok=True  channel=app  cycles=1
```

即 `loginCheck` 在真人扫码后直接返回完整授权信息，**不需要像微信那样再调 `weChat-auth` 换票**，且 token 结构与微信通道一致。至此两条通道的「取码 → 轮询 → 换凭证」都已闭环。

### 渲染性能教训（同日）

`WIDGET#n` 初版带 `<script>` 实现倒计时，用户反馈「正在渲染组件」太慢——带 JS 的 widget 需宿主起沙箱渲染管道，而二维码仅约 1 分钟有效，等渲染完就过期了。改为**纯静态 HTML**（有效期写死成「约 55 秒内有效」文字，无 script）后立即出现。PNG 本身仅 0.6–1.6 KB，体积不是瓶颈。**以后 widget 一律不放 JS**，换新码靠 Agent 再发一条消息。

APP 二维码 PNG 只有约 590 字节（430×430 纯黑白），微信码约 1600 字节（160×160），体积差异正常。

## 免登录直达链接（把 token 塞进 hash）

前端 `scripts/main-*.js` 的 OAuth 初始化逻辑（2026-11-04 抓源码确认）：

```js
// 伪代码，保留了原变量语义
a = function () {
  var t = location.hash;                      // "#access_token=..&token_type=..&state=.."
  if (t.indexOf("access_token") < 0) return null;
  n = 解析 t.slice(1).split("&") 成对象;        // {access_token, token_type, expires_in, state}
  // 特例：state 含 "/study/course/detail/" 且带 & 时，把尾部 & 之后的内容拼回 state
  e = decodeURIComponent(n.state || "demo/main");
  delete n.expires_in; delete n.state;
  localStorage.setItem("token", JSON.stringify(n));   // 只留 access_token + token_type
  setlocationHash(e);                                 // 跳到目标路由
  return n;
};
d = a() || i() || {};   // i() 读 localStorage.token
d.access_token && (OAuth = {token: d, tokenType: d.token_type}, ajaxSetup(Authorization: token_type + "__" + access_token));
```

所以一次性登录链接的稳定形态是：

```
https://mooc.ctt.cn/#access_token=<token>&token_type=Bearer&state=<encodeURIComponent(路由)>
```

要点：

- **`state` 整段 URL 编码**。前端会 `decodeURIComponent`，编码后能挡住路由里的 `&`
  （课程路由 `/study/course/detail/4&<bid>` 就带 `&`，明文拼接会被切成参数）；
- 可以省略 `expires_in`，前端本来就会删掉它；
- 落地后 hash 会被改写成目标路由，token 存进 `localStorage`，**同一浏览器后续访问自动登录**；
- 本质是把 access_token 写进 URL，等同于密码泄露面，文件权限要收窄、禁止外发。

实测（2026-11-04）：专题页与班级页两类链接均直接落在详情页，顶栏显示已登录账号，无登录框。

## 三种登录方式的实际可用性

| 方式 | 接口 | 状态 | 前提 |
| --- | --- | --- | --- |
| 方式一 微信扫码 | `createQRCode` + `checkUUIDStatus` + `weChat-auth` | 可用 | 用户已关注/绑定公众号 |
| 方式二 APP 扫码 | `deriveQRCode` + `loginCheck` | 可用 | 手机装烟草网络学院 APP |
| 方式三 账密登录 | **`app-login`** | 可用（协议已逐字节复验） | 只需账号密码，token 30 天 |
| 方式三备选 网页表单 | `auth` | 可用但繁琐 | 需 hashKey，`doubleValidate=1` 还要人工验证码 |
| 微信开放平台 | `getWechatUrl` | 不可用 | appid 为空；与本平台微信登录无关 |

**选型建议**：能用账密就用 `app-login`——无浏览器、无会话 key、无验证码、30 天长效，是三条链路里唯一不需要"等人配合"的。扫码只在用户不愿交密码、或密码未开通时使用。

## 二维码有效期

前端 `checkUUIDStatus` 的轮询节奏是 **10 次 × 5 秒**，第 10 次仍无结果就显示「二维码已失效」。因此：

- 两种二维码有效期均约 **50–60 秒**；
- 过期后必须重新生成（APP 码重取 `deriveQRCode`，微信码换新 uuid 重调 `createQRCode`）；
- 打印/截图后隔几分钟再扫必然失败，这不是脚本的问题。

## 版本变更时的重新抓取流程

1. Playwright 打开 `https://mooc.ctt.cn`，点击「登录」；
2. `browser_network_requests` 过滤 `oauth/api`，记录接口与参数名；
3. 下载 `oauth/scripts/main-*.js`，搜索 `key-config` 取新密钥，搜索 `util/aes` 确认算法；
4. 用 `encrypt("1") == "N8XxZPBkHR4UcAuMtuMC4Q=="` 校验（密钥变更后该值也会变，需同步更新本文档）；
5. 更新 `scripts/mooc_api.py` 中的 `AES_KEY` 与本文件。
