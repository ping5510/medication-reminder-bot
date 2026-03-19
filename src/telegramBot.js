/**
 * 吃藥提醒 Telegram Bot - Telegram API 模組
 * 負責處理 Telegram Bot API 的操作
 */

const TelegramBot = require('node-telegram-bot-api');

// 令牌
let token = null;
let bot = null;

/**
 * 建立 Telegram Bot 實例
 */
function createBot() {
  token = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!token) {
    console.log('⚠️ TELEGRAM_BOT_TOKEN 未設定');
    return null;
  }
  
  console.log(`📱 Telegram Token 已設定: ${token.substring(0, 10)}...`);
  
  try {
    // 使用 polling 模式（適用於長期運行的服務）
    bot = new TelegramBot(token, {
      polling: {
        interval: 300,
        autoStart: true,
        params: {
          timeout: 10
        }
      }
    });
    
    console.log('✅ Telegram Bot 初始化成功');
    
    // 設定錯誤處理
    bot.on('polling_error', (error) => {
      console.error('❌ Telegram Polling Error:', error.message);
    });
    
    // 測試 Bot 是否真的在運行
    bot.getMe().then((info) => {
      console.log(`✅ Telegram Bot 已在線: @${info.username}`);
    }).catch((err) => {
      console.error('❌ Telegram Bot 連接測試失敗:', err.message);
    });
    
    return bot;
  } catch (error) {
    console.error('❌ Telegram Bot 初始化失敗:', error.message);
    return null;
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
  createBot,
  sendReminderMessage,
  sendTextMessage,
  setCallbackHandler,
  setMessageHandler,
  getBot,
  isInitialized
};
