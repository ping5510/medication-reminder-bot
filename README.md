# 🏥 吃藥提醒 LINE Bot

一個智慧型的吃藥提醒系統，透過 LINE 訊息提醒您按時服藥。

## 📋 功能特色

- ✅ **定時提醒**：早餐、午餐、晚餐後自動提醒
- 🔔 **早餐特殊邏輯**：早餐後提醒 2 次（間隔 1 小時）
- 🔄 **重試機制**：未回覆或選擇「等一下」時，30 分鐘後再次提醒
- 📊 **最多 3 次提醒**：超過 3 次後標記為未服藥
- 🎯 **Inline Button**：方便的操作介面

## 🕐 提醒時間

| 餐次 | 時間 | 藥品 |
|------|------|------|
| 早餐後（第1次）| 08:00 | 高血壓（西藥） |
| 早餐後（第2次）| 09:00 | 高血壓（中藥） |
| 午餐後 | 13:00 | 高血壓（中藥） |
| 晚餐後 | 19:00 | 高血壓（中藥） |

## 🚀 部署教學

### 1. 環境準備

```bash
# 安裝 Node.js 依賴
npm install
```

### 2. LINE Bot 設定

1. 前往 [LINE Developers Console](https://developers.line.biz/)
2. 建立 Provider
3. 建立 Messaging API Channel
4. 取得以下資訊：
   - Channel ID
   - Channel Secret
   - Channel Access Token

5. 設定 Webhook URL：
   ```
   https://your-zeabur-project.zeabur.app/webhook
   ```

### 3. 本地測試

```bash
# 複製環境變數範例
cp .env.example .env

# 編輯 .env 填入 LINE Bot 憑證
# LINE_CHANNEL_ID=your_channel_id
# LINE_CHANNEL_SECRET=your_channel_secret
# LINE_CHANNEL_ACCESS_TOKEN=your_channel_access_token

# 啟動伺服器
npm start
```

### 4. 部署到 Zeabur

1. 將程式碼推送到 GitHub
2. 登入 [Zeabur](https://zeabur.com)
3. 建立新專案，連接 GitHub 倉庫
4. 設定環境變數：
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_CHANNEL_SECRET`
   - `TIMEZONE=Asia/Taipei`
5. 部署完成後，取得 Webhook URL

### 5. LINE Bot 設定

1. 在 LINE Developers Console 設定 Webhook URL
2. 將機器人加入 LINE Official Account Manager
3. 開啟「允許加入群組」（可選）

## 💬 使用指令

| 指令 | 功能 |
|------|------|
| `說明` | 顯示使用說明 |
| `設定提醒` | 設定每日提醒排程 |
| `查詢提醒` | 查看今日服藥狀態 |

## 🔧 開發 API

### 手動設定用戶

```
POST /setup-user
Body: { "userId": "LINE_USER_ID", "displayName": "名稱" }
```

### 手動觸發提醒

```
POST /trigger-reminder
Body: { "scheduleId": "排程ID", "userId": "LINE_USER_ID" }
```

### 查詢用戶狀態

```
GET /user-status/LINE_USER_ID
```

## 📁 專案結構

```
medication-reminder-bot/
├── src/
│   ├── index.js         # 主程式入口
│   ├── database.js      # 資料庫模組
│   ├── lineBot.js       # LINE Bot 模組
│   └── scheduler.js     # 排程器模組
├── data/                # SQLite 資料庫
├── .env.example         # 環境變數範例
├── package.json         # Node.js 依賴
└── README.md            # 說明文件
```

## 📝 授權

MIT License
