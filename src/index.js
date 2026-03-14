/**
 * 吃藥提醒 LINE Bot - 主程式入口
 * 
 * 功能：
 * 1. LINE Webhook Server
 * 2. 定時提醒排程
 * 3. 服藥記錄管理
 */

require('dotenv').config();
const express = require('express');
const linebot = require('linebot');

const { initDatabase, getDb } = require('./database');
const { createBot, handleWebhookEvent } = require('./lineBot');
const { createScheduler } = require('./scheduler');

async function main() {
  // 初始化
  const app = express();
  const port = process.env.PORT || 3000;

  // 中間件
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // 初始化資料庫
  let db;
  try {
    db = await initDatabase();
  } catch (error) {
    console.error('❌ 資料庫初始化失敗:', error.message);
    process.exit(1);
  }

  // 獲取數據庫操作函數
  const dbOps = db;

  // 初始化 LINE Bot
  let bot;
  try {
    bot = linebot({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      channelSecret: process.env.LINE_CHANNEL_SECRET
    });
    console.log('✅ LINE Bot 初始化成功');
  } catch (error) {
    console.error('❌ LINE Bot 初始化失敗:', error.message);
    console.log('⚠️ 伺服器將以有限功能啟動（Webhook 接收模式）');
  }

  // 初始化排程器
  let scheduler;
  if (bot) {
    scheduler = createScheduler(bot, dbOps);
    scheduler.start();
  }

// LINE Webhook 端點
app.post('/webhook', (req, res) => {
  // 必須回傳 200 OK
  res.status(200).send('OK');
  
  if (!bot) {
    console.error('❌ Bot 未初始化');
    return;
  }
  
  // 使用 linebot 的 parser 處理事件
  bot.parse(req.body);
  
  // 處理每個事件
  if (req.body && req.body.events) {
    Promise.all(req.body.events.map(event => {
      return handleWebhookEvent(bot, event, dbOps);
    }))
    .then(results => {
      console.log('📥 事件處理完成:', results.length, '個事件');
    })
    .catch(err => {
      console.error('❌ 事件處理錯誤:', err);
    });
  }
});

// 健康檢查端點
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: '吃藥提醒 LINE Bot 運行中',
    timestamp: new Date().toISOString(),
    timezone: process.env.TIMEZONE || 'Asia/Taipei'
  });
});

// 健康檢查端點
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    database: 'connected',
    lineBot: bot ? 'connected' : 'not_configured'
  });
});

// 手動觸發提醒（開發/測試用）
app.post('/trigger-reminder', async (req, res) => {
  if (!bot) {
    return res.status(503).json({ error: 'LINE Bot 未設定' });
  }
  
  const { scheduleId, userId } = req.body;
  
  if (!scheduleId || !userId) {
    return res.status(400).json({ error: '缺少必要參數' });
  }
  
  const { getScheduleById } = dbOps;
  const schedule = getScheduleById(scheduleId);
  
  if (!schedule) {
    return res.status(404).json({ error: '找不到排程' });
  }
  
  const { sendReminderMessage } = require('./lineBot');
  const scheduleInfo = {
    mealType: schedule.meal_type,
    medicines: JSON.parse(schedule.medicines),
    scheduleId: schedule.id,
    retryCount: 0,
    isSecondDose: schedule.is_second_dose
  };
  
  await sendReminderMessage(bot, userId, scheduleInfo);
  
  res.json({ success: true, message: '提醒已發送' });
});

// 簡單測試推播訊息
app.post('/test-push', async (req, res) => {
  if (!bot) {
    return res.status(503).json({ error: 'LINE Bot 未設定' });
  }
  
  const { userId, message } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: '缺少 userId' });
  }
  
  const testMessage = message || '這是測試訊息！';
  
  try {
    console.log(`🧪 測試推播給 ${userId}: ${testMessage}`);
    await bot.push(userId, {
      type: 'text',
      text: testMessage
    });
    console.log(`✅ 測試推播成功`);
    res.json({ success: true, message: '測試訊息已發送' });
  } catch (error) {
    console.error(`❌ 測試推播失敗:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 設定用戶排程（開發/測試用）
app.post('/setup-user', async (req, res) => {
  const { userId, displayName } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: '缺少 userId' });
  }
  
  const { createUser, getUserByLineId } = dbOps;
  let user = getUserByLineId(userId);
  
  if (!user) {
    user = createUser(userId, displayName || userId);
    console.log(`✅ 新用戶已建立: ${userId}`);
  }
  
  // 設定排程
  const { setupDefaultSchedules } = require('./lineBot');
  await setupDefaultSchedules(user.id);
  
  res.json({ 
    success: true, 
    message: '用戶排程已設定',
    userId: user.line_user_id
  });
});

// 查詢用戶狀態（開發/測試用）
app.get('/user-status/:lineUserId', (req, res) => {
  const { lineUserId } = req.params;
  const { getUserByLineId, getSchedulesByUserId, getMedicationLogByScheduleAndDate } = dbOps;
  
  const user = getUserByLineId(lineUserId);
  
  if (!user) {
    return res.status(404).json({ error: '找不到用戶' });
  }
  
  const schedules = getSchedulesByUserId(user.id);
  const today = new Date().toISOString().split('T')[0];
  
  const status = schedules.map(schedule =>{
    const log = getMedicationLogByScheduleAndDate(schedule.id, today);
    return {
      scheduleId: schedule.id,
      mealType: schedule.meal_type,
      time: schedule.default_time,
      medicines: JSON.parse(schedule.medicines),
      status: log ? log.status : 'N/A',
      retryCount: log ? log.retry_count : 0
    };
  });
  
  res.json({
    userId: user.line_user_id,
    displayName: user.display_name,
    today: today,
    schedules: status
  });
});

// 啟動伺服器
app.listen(port, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║     🏥 吃藥提醒 LINE Bot 伺服器啟動中...          ║
╠═══════════════════════════════════════════════════╣
║  Port: ${port}                                       ║
║  Timezone: ${process.env.TIMEZONE || 'Asia/Taipei'}                        ║
║  Database: PostgreSQL                                 ║
╠═══════════════════════════════════════════════════╣
║  Webhook URL: /webhook                            ║
║  Health Check: /health                            ║
╚═══════════════════════════════════════════════════╝
  `);
});

// 啟動服務
main();

// 優雅關閉
process.on('SIGTERM', async () => {
  console.log('📴 收到 SIGTERM，正在關閉...');
  if (dbOps.closeDatabase) {
    await dbOps.closeDatabase();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('📴 收到 SIGINT，正在關閉...');
  if (dbOps.closeDatabase) {
    await dbOps.closeDatabase();
  }
  process.exit(0);
});

module.exports = app;
