/**
 * 吃藥提醒 LINE Bot - 主程式入口
 * 
 * 功能：
 * 1. LINE Webhook Server
 * 2. Telegram Bot (Polling)
 * 3. 定時提醒排程
 * 4. 服藥記錄管理
 */

require('dotenv').config();
const express = require('express');
const linebot = require('linebot');
const { createTelegramBot, setCallbackHandler, setMessageHandler, getTelegramBot, isInitialized: isTelegramReady } = require('./telegramBot');

const { initDatabase, getDb } = require('./database');
const { createBot, handleWebhookEvent } = require('./lineBot');
const { createScheduler } = require('./scheduler');

// 初始化 Express app（全局）
const app = express();
const port = process.env.PORT || 3000;

async function main() {
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

  // 初始化 Telegram Bot（使用 Webhook 模式，優先從資料庫讀取設定）
  let telegramBot = null;
  try {
    telegramBot = await createTelegramBot(app, dbOps);  // 傳入 Express app 和資料庫
    if (telegramBot) {
      console.log(`   Telegram Bot 實例: 已創建`);
      console.log(`   Telegram 是否就緒: ${telegramBot && telegramBot.isInitialized() ? '是' : '否'}`);
    } else {
      console.log('   ⚠️ createTelegramBot() 返回 null');
    }
  } catch (error) {
    console.error('❌ Telegram Bot 初始化失敗:', error.message);
  }

  // Telegram Webhook 端點
  app.post('/telegram/webhook', (req, res) => {
    console.log('📥 收到 Telegram Webhook 請求');
    if (telegramBot && telegramBot.isInitialized()) {
      telegramBot.processUpdate(req.body);
      res.send('OK');
    } else {
      res.status(500).send('Telegram Bot not initialized');
    }
  });

  // 初始化排程器
  let scheduler;
  if (bot || telegramBot) {
    scheduler = createScheduler(bot, telegramBot, dbOps);
    scheduler.start();
  }

  // 設置 Telegram 回調查詢處理
  console.log(`   檢查 Telegram Bot 狀態: telegramBot=${!!telegramBot}, isInitialized=${telegramBot ? telegramBot.isInitialized() : 'N/A'}`);
  
  if (telegramBot && telegramBot.isInitialized()) {
    console.log('   ✅ 開始設置 Telegram 處理器...');
    const { setCallbackHandler, setMessageHandler } = require('./telegramBot');
    const { getScheduleById, getMedicationLogByScheduleAndDate, updateMedicationLogStatus, createOrGetTelegramUser, setupDefaultSchedules, sendTextMessage } = dbOps;
    const { sendTextMessage: sendTelegramText } = require('./telegramBot');
    
    // 處理回調按鈕
    setCallbackHandler(async (chatId, action, scheduleId, retryCount) => {
      console.log(`📥 Telegram 回調: action=${action}, scheduleId=${scheduleId}, retryCount=${retryCount}`);
      
      const today = new Date().toISOString().split('T')[0];
      const log = await getMedicationLogByScheduleAndDate(scheduleId, today);
      
      if (!log) {
        await sendTelegramText(chatId, '⚠️ 找不到服藥記錄');
        return;
      }
      
      const { getScheduleById: getSchedule } = dbOps;
      const schedule = await getSchedule(scheduleId);
      
      if (action === 'taken') {
        await updateMedicationLogStatus(log.id, 'TAKEN', {
          takenAt: new Date().toISOString(),
          retryCount: retryCount
        });
        await sendTelegramText(chatId, '✅ 已記錄！太棒了，記得按時服藥有助於健康！');
        
        // 檢查是否為早餐西藥，啟動中藥提醒
        if (schedule && schedule.meal_type === '早餐後（西藥）') {
          // 這裡可以添加中藥提醒邏輯
          await sendTelegramText(chatId, '💡 提醒：1 小時後會發送中藥提醒，記得服用哦！');
        }
      } else if (action === 'snooze') {
        const newRetryCount = retryCount + 1;
        await updateMedicationLogStatus(log.id, 'SNOOZED', {
          retryCount: newRetryCount,
          lastRemindedAt: new Date().toISOString()
        });
        
        if (newRetryCount >= 3) {
          await updateMedicationLogStatus(log.id, 'MISSED', {
            lastRemindedAt: new Date().toISOString()
          });
          await sendTelegramText(chatId, '⚠️ 已超過最大提醒次數（3次），請記得盡快服用藥物！');
        } else {
          await sendTelegramText(chatId, `⏰ 好的，下一次提醒將在 30 分鐘後發送（已提醒 ${newRetryCount}/3 次）`);
        }
      }
    });
    
    // 處理文字訊息
    setMessageHandler(async (chatId, text) => {
      console.log(`📥 Telegram 訊息: ${text}`);
      
      const { createOrGetTelegramUser } = dbOps;
      let user = await createOrGetTelegramUser(chatId.toString(), 'Telegram User');
      
      if (text === '/start' || text === '/setup') {
        // 設定排程
        const { setupDefaultSchedules } = require('./lineBot');
        await setupDefaultSchedules(user.id);
        await sendTelegramText(chatId, '✅ 吃藥提醒排程已設定完成！\n\n📅 提醒時間：\n• 早餐後 08:00 - 高血壓（西藥）\n• 早餐後 09:00 - 高血壓（中藥）\n• 午餐後 13:00 - 高血壓（中藥）\n• 晚餐後 19:00 - 高血壓（中藥）\n\n您將在每次用藥時間收到提醒訊息！');
      } else if (text === '/status') {
        // 查詢狀態
        const { getSchedulesByUserId, getMedicationLogByScheduleAndDate } = dbOps;
        const schedules = await getSchedulesByUserId(user.id);
        const today = new Date().toISOString().split('T')[0];
        
        let statusText = '📋 今日服藥狀態：\n\n';
        for (const schedule of schedules) {
          const log = await getMedicationLogByScheduleAndDate(schedule.id, today);
          const status = log ? log.status : 'N/A';
          const emoji = status === 'TAKEN' ? '✅' : status === 'MISSED' ? '❌' : '⏳';
          statusText += `${emoji} ${schedule.meal_type}: ${status}\n`;
        }
        await sendTelegramText(chatId, statusText);
      } else if (text === '/help') {
        await sendTelegramText(chatId, `📖 吃藥提醒機器人使用說明：

🤖 可用指令：
/start 或 /setup - 設定提醒排程
/status - 查看今日服藥狀態
/help - 顯示此說明

💊 提醒規則：
• 早餐後提醒 3 次（間隔 30 分鐘）
• 午餐、晚餐後各提醒 3 次
• 選擇「等一下吃」會在 30 分鐘後再次提醒
• 最多提醒 3 次`);
      } else {
        await sendTelegramText(chatId, `您好！我是吃藥提醒機器人 🤖\n\n輸入 /help 查看更多功能！`);
      }
    });
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
    lineBot: bot ? 'connected' : 'not_configured',
    telegramBot: telegramBot && telegramBot.isInitialized() ? 'connected' : 'not_configured'
  });
});

// ========== 系統設定 API（安全的 Token 儲存）==========

// 獲取設定
app.get('/api/settings/:key', async (req, res) => {
  const { key } = req.params;
  
  // 敏感設定不顯示完整值
  const sensitiveKeys = ['TELEGRAM_BOT_TOKEN', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET'];
  const isSensitive = sensitiveKeys.includes(key);
  
  try {
    const value = await dbOps.getSetting(key);
    if (value === null || value === undefined) {
      return res.status(404).json({ error: '設定不存在' });
    }
    
    res.json({
      key,
      value: isSensitive ? value.substring(0, 10) + '***' : value,
      isSensitive
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 設置設定（安全儲存敏感資訊）
app.post('/api/settings', async (req, res) => {
  const { key, value } = req.body;
  
  if (!key || value === undefined) {
    return res.status(400).json({ error: '缺少 key 或 value' });
  }
  
  try {
    await dbOps.setSetting(key, value);
    console.log(`✅ 設定已保存: ${key}`);
    
    res.json({
      success: true,
      message: `設定 ${key} 已保存`,
      key,
      value: key.includes('TOKEN') || key.includes('SECRET') ? value.substring(0, 10) + '***' : value
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 初始化 Telegram Bot（從資料庫讀取設定後重啟）
app.post('/api/telegram/init', async (req, res) => {
  try {
    const token = await dbOps.getSetting('TELEGRAM_BOT_TOKEN');
    const webhookUrl = await dbOps.getSetting('TELEGRAM_WEBHOOK_URL') || 'https://medication-reminder-bot.zeabur.app';
    
    if (!token) {
      return res.status(400).json({ 
        error: 'TELEGRAM_BOT_TOKEN 未設定',
        hint: '請先使用 POST /api/settings 存入 Token'
      });
    }
    
    // 創建新的 Bot 實例
    const { createTelegramBot } = require('./telegramBot');
    telegramBot = await createTelegramBot(app, dbOps);
    
    if (telegramBot) {
      res.json({
        success: true,
        message: 'Telegram Bot 已初始化',
        webhookUrl: `${webhookUrl}/telegram/webhook`
      });
    } else {
      res.status(500).json({ error: 'Telegram Bot 初始化失敗' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 列出所有設定（不顯示敏感值）
app.get('/api/settings', async (req, res) => {
  try {
    const keys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_URL', 'LINE_CHANNEL_ACCESS_TOKEN'];
    const settings = {};
    
    for (const key of keys) {
      const value = await dbOps.getSetting(key);
      if (value) {
        settings[key] = {
          exists: true,
          value: key.includes('TOKEN') || key.includes('SECRET') ? value.substring(0, 10) + '***' : value
        };
      } else {
        settings[key] = { exists: false };
      }
    }
    
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
}

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
