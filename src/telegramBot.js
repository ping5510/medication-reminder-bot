/**
 * 吃藥提醒 Telegram Bot - Telegram API 模組
 * 使用 Webhook 模式（適合雲端平台）
 * 
 * Token 優先從資料庫讀取，其次從環境變數
 */

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

// 令牌
let token = null;
let bot = null;
let expressApp = null;
let db = null;

/**
 * 設置資料庫實例
 */
function setDatabase(database) {
  db = database;
}

/**
 * 從資料庫獲取設定
 */
async function getSetting(key, defaultValue = null) {
  if (db && db.getSetting) {
    const value = await db.getSetting(key);
    return value || defaultValue;
  }
  return defaultValue;
}

/**
 * 保存設定到資料庫
 */
async function saveSetting(key, value) {
  if (db && db.setSetting) {
    await db.setSetting(key, value);
  }
}

/**
 * 建立 Telegram Bot 實例（Webhook 模式）
 * @param {object} expressAppInstance - Express app 實例
 * @param {object} database - 資料庫實例
 */
async function createBot(expressAppInstance, database) {
  expressApp = expressAppInstance;
  db = database;
  
  // 優先從資料庫讀取 Token
  token = await getSetting('TELEGRAM_BOT_TOKEN');
  
  // 如果資料庫沒有，從環境變數讀取（備用）
  if (!token) {
    token = process.env.TELEGRAM_BOT_TOKEN;
  }
  
  if (!token) {
    console.log('⚠️ TELEGRAM_BOT_TOKEN 未設定（資料庫和環境變數都沒有）');
    return null;
  }
  
  console.log(`📱 Telegram Token 已設定（來源：${await getSetting('TELEGRAM_BOT_TOKEN') ? '資料庫' : '環境變數'}）: ${token.substring(0, 10)}...`);
  
  try {
    // 使用 webhook 模式
    bot = new TelegramBot(token, {
      polling: false  // 關閉 polling
    });
    
    // 設置 webhook
    const webhookPath = '/telegram/webhook';
    // 優先從資料庫讀取 Webhook URL
    let webhookUrl = await getSetting('TELEGRAM_WEBHOOK_URL');
    if (!webhookUrl) {
      webhookUrl = process.env.TELEGRAM_WEBHOOK_URL || 'https://medication-reminder-bot.zeabur.app';
    }
    
    console.log(`📱 設置 Telegram Webhook: ${webhookUrl}${webhookPath}`);
    
    bot.setWebHook(`${webhookUrl}${webhookPath}`)
      .then(() => {
        console.log('✅ Telegram Webhook 設置成功');
      })
      .catch((err) => {
        console.error('❌ Telegram Webhook 設置失敗:', err.message);
        // 回退到 polling
        console.log('⚠️ 回退到 Polling 模式...');
        enablePolling();
      });
    
    // 測試 Bot 是否在線
    bot.getMe().then((info) => {
      console.log(`✅ Telegram Bot 已在線: @${info.username}`);
    }).catch((err) => {
      console.error('❌ Telegram Bot 連接測試失敗:', err.message);
    });
    
    // 返回包裝對象，包含 Bot 實例和輔助函數
    return {
      bot: bot,
      processUpdate: (update) => bot.processUpdate(update),
      sendMessage: (chatId, text, options) => bot.sendMessage(chatId, text, options),
      isInitialized: () => bot !== null,
      setWebhook: (url) => bot.setWebHook(url),
      getMe: () => bot.getMe()
    };
  } catch (error) {
    console.error('❌ Telegram Bot 初始化失敗:', error.message);
    return {
      bot: null,
      isInitialized: () => false
    };
  }
}

/**
 * 啟用 Polling 模式（備用）
 */
function enablePolling() {
  if (bot) {
    bot.startPolling({
      interval: 1000,
      timeout: 0
    });
    console.log('✅ Telegram Polling 模式已啟用');
  }
}

/**
 * 發送 Flex Message 吃藥提醒（轉換為 Telegram 格式）
 */
async function sendReminderMessage(userId, scheduleInfo) {
  const { mealType, medicines, scheduleId, retryCount = 0 } = scheduleInfo;
  
  if (!bot) {
    console.error('❌ Telegram Bot 未初始化');
    return false;
  }
  
  // 藥品清單文字
  const medicinesText = medicines.map((med, index) => `${index + 1}. ${med}`).join('\n');
  
  // 組裝訊息
  let message = `🏥 吃藥提醒\n`;
  message += `━━━━━━━━━━━━━━━\n`;
  message += `📋 ${mealType}\n\n`;
  message += `💊 請記得服用：\n${medicinesText}\n`;
  
  if (retryCount > 0) {
    message += `\n⚠️ 這是第 ${retryCount} 次提醒`;
  }
  
  message += `\n━━━━━━━━━━━━━━━`;
  
  const keyboard = {
    inline_keyboard: [
      [
        {
          text: '✅ 吃過了',
          callback_data: `taken_${scheduleId}_${retryCount}`
        },
        {
          text: '⏰ 等一下吃',
          callback_data: `snooze_${scheduleId}_${retryCount}`
        }
      ]
    ]
  };
  
  try {
    console.log(`📤 正在發送 Telegram 提醒給 ${userId}...`);
    await bot.sendMessage(userId, message, {
      reply_markup: keyboard,
      parse_mode: 'HTML'
    });
    console.log(`✅ Telegram 提醒訊息已發送給 ${userId}`);
    return true;
  } catch (error) {
    console.error('❌ 發送 Telegram 提醒失敗:', error.message);
    return false;
  }
}

/**
 * 發送文字訊息
 */
async function sendTextMessage(userId, text) {
  if (!bot) {
    console.error('❌ Telegram Bot 未初始化');
    return false;
  }
  
  try {
    await bot.sendMessage(userId, text, {
      parse_mode: 'HTML'
    });
    return true;
  } catch (error) {
    console.error('❌ 發送 Telegram 文字訊息失敗:', error.message);
    return false;
  }
}

/**
 * 設置回調處理
 */
function setCallbackHandler(callback) {
  if (!bot) {
    console.log('⚠️ Telegram Bot 未初始化，無法設置回調處理');
    return;
  }
  
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    
    console.log(`📥 收到 Telegram 回調: ${data}`);
    
    // 解析回調數據
    // 格式: taken_scheduleId_retryCount 或 snooze_scheduleId_retryCount
    const parts = data.split('_');
    if (parts.length >= 3) {
      const action = parts[0];
      const scheduleId = parts[1];
      const retryCount = parseInt(parts[2], 10);
      
      // 執行回調
      if (callback) {
        await callback(chatId, action, scheduleId, retryCount);
      }
      
      // 回應回調
      await bot.answerCallbackQuery(query.id);
    }
  });
}

/**
 * 設置文字訊息處理
 */
function setMessageHandler(callback) {
  if (!bot) {
    console.log('⚠️ Telegram Bot 未初始化，無法設置訊息處理');
    return;
  }
  
  // 處理所有訊息（回調和普通訊息分開處理）
  bot.on('message', (msg) => {
    // 忽略編輯過的訊息
    if (msg.edited_message) return;
    
    // 忽略回調按鈕的更新訊息
    if (msg.callback_query) return;
    
    const chatId = msg.chat.id;
    const text = msg.text;
    
    // 忽略非文字訊息
    if (!text) return;
    
    console.log(`📥 收到 Telegram 訊息: ${text} (from ${chatId})`);
    
    if (callback) {
      callback(chatId, text);
    }
  });
}

/**
 * 獲取 Bot 實例
 */
function getBot() {
  return bot;
}

/**
 * 檢查 Bot 是否已初始化
 */
function isInitialized() {
  return bot !== null;
}

module.exports = {
  createTelegramBot: createBot,  // 別名
  createBot,
  sendReminderMessage,
  sendTextMessage,
  setCallbackHandler,
  setMessageHandler,
  getBot,
  isInitialized
};
