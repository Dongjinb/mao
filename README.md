# 喵屋日记 · 存档服务

两个文件：

| 文件 | 作用 |
|---|---|
| `index.html` | 整个游戏（单文件，双击也能玩，只是不能云同步） |
| `server.cjs` | 存档服务：账号密码 + 每账号一份存档（Node 内置模块，**零依赖**，Node 18+） |

玩家注册账号，存档跟着账号走：换电脑、换手机，登录同一个账号就能接着玩。账号数据全在你自己的服务器上。

---

## 一、本机先跑通

```bash
node server.cjs
# 页面：http://127.0.0.1:8787/
# 接口：http://127.0.0.1:8787/api/health
```

打开页面 → 顶栏 **☁ 云存档** → 注册一个账号 → 「上传存档」。

重启服务后账号和存档都还在（都写在 `data/` 下）。

可调环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（只给本机用就设 `127.0.0.1`） |
| `SAVE_DIR` | `./data/saves` | 存档目录，建议指向独立磁盘 |
| `USERS_DIR` | `./data/users` | 账号目录 |
| `SAVE_SECRET` | 自动生成 | 签发登录 token 的密钥；不填会生成 `data/secret.key` |
| `PUBLIC_DIR` | 有 `public/` 用它，否则用脚本同目录 | 静态页面目录 |

---

## 二、部署到自己的服务器（Linux）

### 1. 放文件

```bash
sudo mkdir -p /opt/meow/data
sudo cp index.html server.cjs /opt/meow/
sudo chown -R www-data:www-data /opt/meow
```

### 2. 交给 systemd 常驻

`/etc/systemd/system/meow-save.service`

```ini
[Unit]
Description=Meow Diary save service
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/meow
ExecStart=/usr/bin/node /opt/meow/server.cjs
Environment=PORT=8787
Environment=HOST=127.0.0.1
Environment=SAVE_DIR=/opt/meow/data/saves
Environment=USERS_DIR=/opt/meow/data/users
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now meow-save
curl http://127.0.0.1:8787/api/health   # {"ok":true,"saves":0,"users":0}
```

> `HOST=127.0.0.1` 表示只让 nginx 访问，不直接暴露 Node。

### 3. nginx 反代 + HTTPS

`/etc/nginx/sites-available/meow`

```nginx
server {
    listen 80;
    server_name meow.example.com;

    client_max_body_size 4m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/meow /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d meow.example.com
```

打开 `https://meow.example.com/` 就是完整游戏，页面和接口同源，什么都不用配。

**必须用 HTTPS**：密码和 token 都是明文头部，走 HTTP 会被中间人看到。

---

## 三、页面放别处（GitHub Pages / 对象存储）也能同步

接口带 `Access-Control-Allow-Origin: *`，所以游戏页面不必和存档服务同域：

1. 游戏照旧放 Pages；
2. 打开 **☁ 云存档** → 「服务地址」填 `https://meow.example.com`；
3. 注册/登录 → 上传。

---

## 四、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/register` | `{name,pass}` → `{token,name,uid}`；重名 409 |
| `POST` | `/api/login` | `{name,pass}` → `{token,name,uid}`；错误 401 |
| `GET` | `/api/me` | 需 `Authorization: Bearer <token>` → `{name,uid,updatedAt}` |
| `GET` | `/api/me/save` | 需 token → `{name,updatedAt,data}`；没有 404 |
| `PUT` | `/api/me/save` | 需 token，`{data:{...},updatedAt}` → 200；每次覆盖前留一份 `.bak` |
| `GET` | `/api/health` | `{"ok":true,"saves":2,"users":1}` |
| `GET/PUT` | `/api/save/<同步码>` | **旧版**无账号同步，仍可用，便于老存档迁移 |

规则：

- 用户名 2-20 位（中文/字母/数字/下划线/点/横线），大小写不敏感（`Ali` 和 `ali` 是同一个账号，登录返回注册时的大小写）；
- 密码 6-64 位，存的是 **scrypt(salt)** 哈希，不存明文；
- 登录 token 是 HMAC-SHA256 签名，有效期 30 天，服务端无状态；
- 同 IP 每 10 秒最多 60 次请求（429）；同一账号 10 分钟内错 10 次密码会被锁到下一窗口；
- 请求体上限 2 MB，`data.cats` 必须是数组；
- 写盘用「临时文件 + rename」，断电不会留半个文件。

---

## 五、数据长什么样

```
data/
├── secret.key                 # token 签名密钥（自动生成，别泄露、别丢）
├── users/
│   └── c6b438b0c071b087.json  # {uid,name,salt,hash,createdAt}，文件名 = sha256(小写用户名) 前 16 位
└── saves/
    ├── user-c6b438b0c071b087.json      # 该账号的存档
    ├── user-c6b438b0c071b087.bak.json  # 上一版（每次上传覆盖前留存）
    └── ABC123XYZ9.json                 # 旧版同步码存档（如果还在用）
```

备份整个 `data/` 就是全量备份：

```bash
tar czf /backup/meow-$(date +%F).tar.gz -C /opt/meow data
```

迁移到新机器：把 `data/` 整个拷过去，账号密码、存档、已登录 token 全都继续有效（`secret.key` 一起搬，否则所有人要重新登录）。

---

## 六、安全与运维提醒

- **没做邮箱验证、找回密码、注销**：忘了密码只能由服主删账号；
- 删账号但保留存档：删掉 `data/users/<uid>.json`，玩家用**同一用户名**重新注册即可——uid 由用户名哈希得出，存档文件还是那一个；
- 建议 nginx 再叠一层 `limit_req`，并把 `data/` 放在有快照的磁盘上；
- 没有内容审核：存档是玩家自己上传的 JSON，服务端只校验结构。

---

## 七、常见问题

**手机玩？** 服务和页面同机时，手机用 `http://<电脑局域网IP>:8787/`（`HOST` 要是 `0.0.0.0`）。

**换端口？** `PORT=9000 node server.cjs`。

**页面从别处打开后提示「不是从服务器打开的」？** 那是 `file://` 直开的情况，浏览器禁止联网；用服务器地址打开，或在「服务地址」里填服务器域名。

**之前用云开发的版本？** 已废弃。若 `public.cat_saves` 表还在，可以 `select data from cat_saves` 导出，再 `PUT /api/save/<码>` 灌进新服务，或用账号接口 `PUT /api/me/save`。
