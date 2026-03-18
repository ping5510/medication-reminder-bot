/**
 * 吃藥提醒 - 統一通知適配器
 * 
 * 這個模組提供統一的發送接口，支持 LINE 和 Telegram
 * 根據用戶的 channel 設定選擇合適的發送方式
 */

/**
 * 通知適配器工廠
 * @param {object} lineBot - LINE Bot 實例
 * @param {object} telegramBot - Telegram Bot 實例
 * @param {object} db - 數據庫操作對象
 */
function createNotifier(lineBot, telegramBot, db) {
  const { getUserByLineId, updateUserChannel } = db;
  
  /**
   * 發送提醒訊息（自動選擇通道）
   * @param {string} userId - LINE User ID
   * @param {string} channel - 通道类型：'line', 'telegram', 'auto'
   * @param {object} scheduleInfo - 排程信息
   */
  async function sendReminder(userId, channel, scheduleInfo) {
    // 自動選擇通道
    if (channel === 'auto') {
      channel = await getPreferredChannel(userId);
    }
    
    switch (channel) {
      case 'telegram':
        if (telegramBot && telegramBot.isInitialized()) {
          return await telegramBot.sendReminderMessage(userId, scheduleInfo);
        }
        console.error('❌ Telegram 通道未設定');
        return false;
        
      case 'line':
      default:
        if (lineBot) {
          const { sendReminderMessage } = require('./lineBot');
          return await sendReminderMessage(lineBot, userId, scheduleInfo);
        }
        console.error('❌ LINE 通道未設定');
        return false;
    }
  }
  
  /**
   * 發送文字訊息
   */
  async function sendText(userId, channel, text) {
    if (channel === 'auto') {
      channel = await getPreferredChannel(userId);
    }
    
    switch (channel) {
      case 'telegram':
        if (telegramBot && telegramBot.isInitialized()) {
          return await telegramBot.sendTextMessage(userId, text);
        }
        return false;
        
      case 'line':
      default:
        if (lineBot) {
          const { sendTextMessage } = require('./lineBot');
          return await sendTextMessage(lineBot, userId, text);
        }
        return false;
    }
  }
  
  /**
   * 獲取用戶偏好的通道
   */
  async function getPreferredChannel(userId) {
    // 檢查用戶是否有設定 Telegram ID
    if (db.getUserByTelegramId) {
      const tgUser = await db.getUserByTelegramId(userId);
      if (tgUser) {
        return 'telegram';
      }
    }
    
    // 預設為 LINE
    return 'line';
  }
  
  /**
   * 設置用戶的通道偏好
   */
  async function setChannel(userId, channel) {
    if (db.updateUserChannel) {
      await db.updateUserChannel(userId, channel);
    }
  }
  
  /**
   * 獲取 LINE Bot 實例
   */
  function getLineBot() {
    return lineBot;
  }
  
  /**
   * 獲取 Telegram Bot 實例
   */
  function getTelegramBot() {
    return telegramBot;
  }
  
  return {
    sendReminder,
    sendText,
    getPreferredChannel,
    setChannel,
    getLineBot,
    getTelegramBot
  };
}

module.exports = {
  createNotifier
};
