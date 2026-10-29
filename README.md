# 喵屋日记 · 联机存档服务

只包含两个文件：

| 文件 | 作用 |
|---|---|
| `index.html` | 整个游戏（单文件，双击也能玩，只是不能云同步） |
| `server.cjs` | 存档服务（Node 内置模块实现，**零依赖**，Node 18+） |

云同步靠一个 **10 位同步码**：同一串码 + 同一个服务地址 = 同一份存档，换设备/换浏览器都行。

---

## 一、本机先跑通

```bash
node server.cjs
# 喵屋日记存档服务已启动
#   页面：http://127.0.0.1:8787/
#   接口：http://127.0.0.1:8787/api/health
#   存档目录：.../data/saves
```

浏览器打开 <http://127.0.0.1:8787/> → 顶栏 **☁ 云存档** → 点「上传存档」。

存档就是 `data/saves/<同步码>.json`，直接复制这个文件到新服务器就是迁移。

可调环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（只想本机用就设 `127.0.0.1`） |
| `SAVE_DIR` | `./data/saves` | 存档目录，建议指向独立磁盘/备份目录 |
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
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now meow-save
curl http://127.0.0.1:8787/api/health   # {"ok":true,"saves":0}
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

打开 `https://meow.example.com/` 就是完整游戏（页面和接口同源，什么都不用配）。

---

## 三、页面放别处（GitHub Pages / 对象存储）也能同步

接口带 `Access-Control-Allow-Origin: *`，所以游戏不必和存档服务同域：

1. 游戏页面照旧放 Pages；
2. 打开 **☁ 云存档** → 「服务地址」填 `https://meow.example.com`；
3. 填/生成同步码 → 上传。

> 明文 HTTP 会泄露同步码，请务必用 HTTPS。

---

## 四、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | `{"ok":true,"saves":3}` |
| `GET` | `/api/save/<CODE>` | 200 `{code,updatedAt,data}`；没有则 404 |
| `PUT` | `/api/save/<CODE>` | body `{"data":{...存档对象...},"updatedAt":毫秒}` → 200 |

限制与校验：

- 同步码 `^[A-Z0-9]{6,16}$`（页面生成的是 10 位，字母表去掉 `0O1I`）；
- body 上限 2 MB；`data.cats` 必须是数组，否则 400；
- 每 IP 每 10 秒最多 60 次请求，超出 429；
- 写入用「临时文件 + rename」，断电不会写出半个文件。

---

## 五、备份与迁移

```bash
# 备份（建议放 cron，每天一次）
tar czf /backup/meow-saves-$(date +%F).tar.gz -C /opt/meow data/saves

# 迁移到新机器：把 data/saves 整个拷过去即可，同步码不变就能继续用
```

---

## 六、安全提醒

- **同步码就是密码**：谁拿到码谁就能读写这份存档，别发到群里；
- 服务端没有用户体系，也不做内容审核，属于「自己的小服务器」用法；
- 想更稳可以加一层：nginx 里对 `/api/` 加 `limit_req`，或把 `SAVE_DIR` 放到有快照的磁盘上。

---

## 七、常见问题

**手机上玩？** 服务和页面在同一台机器上时，手机用 `http://<电脑局域网IP>:8787/`（此时 `HOST` 要是 `0.0.0.0`）。

**换端口？** `PORT=9000 node server.cjs`。

**同步码丢了？** 服务端只有 `data/saves/<码>.json`；知道码就能找回，不知道就只能翻文件名的码。

**之前用的是云开发版本？** 那个版本已废弃，存档在云开发 PG 里，`public.cat_saves` 表还在的话可以 `select * from cat_saves` 导出 `data` 字段，再调 `PUT /api/save/<码>` 灌回来。
