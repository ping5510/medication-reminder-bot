/**
 * 吃藥提醒 LINE Bot - LINE API 模組
 * 負責處理 LINE Messaging API 的操作
 */

const line = require('linebot');
const { v4: uuidv4 } = require('uuid');

// 用藥清單配置
const MEDICATIONS = {
  BREAKFAST_FIRST: {
    mealType: '早餐後',
    mealTypeEn: 'breakfast',
    medicines: ['高血壓（西藥）'],
    time: '08:00'
  },
  BREAKFAST_SECOND: {
    mealType: '早餐後（第2次）',
    mealTypeEn: 'breakfast',
    medicines: ['高血壓（中藥）'],
    time: '09:00',
    isSecondDose: true,
    linkDelayMinutes: 60
  },
  LUNCH: {
    mealType: '午餐後',
    mealTypeEn: 'lunch',
    medicines: ['高血壓（中藥）'],
    time: '13:00'
  },
  DINNER: {
    mealType: '晚餐後',
    mealTypeEn: 'dinner',
    medicines: ['高血壓（中藥）'],
    time: '19:00'
  }
};

/**
 * 建立 LINE Bot 實例
 */
function createBot() {
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;

  if (!channelAccessToken || !channelSecret) {
    throw new Error('LINE Bot 憑證未設定！請在 .env 文件中設定 LINE_CHANNEL_ACCESS_TOKEN 和 LINE_CHANNEL_SECRET');
  }

  const bot = line({
    channelAccessToken: channelAccessToken,
    channelSecret: channelSecret
  });

  console.log('✅ LINE Bot 初始化成功');
  return bot;
}

/**
 * 發送 Flex Message 吃藥提醒
 */
async function sendReminderMessage(bot, userId, scheduleInfo) {
  const { mealType, medicines, scheduleId, retryCount = 0, isSecondDose = false } = scheduleInfo;
  
  // 藥品清單文字
  const medicinesText = medicines.map((med, index) => `• ${med}`).join('\n');
  
  // 建立 body 內容
  const bodyContents = [
    {
      type: 'text',
      text: `請記得服用：`,
      weight: 'bold',
      size: 'md',
      margin: 'md'
    },
    {
      type: 'text',
      text: medicinesText,
      size: 'md',
      margin: 'sm',
      wrap: true
    }
  ];
  
  // 只有重試時才添加提醒文字
  if (retryCount > 0) {
    bodyContents.push({
      type: 'text',
      text: `⚠️ 這是第 ${retryCount} 次提醒`,
      size: 'sm',
      color: '#FF6B6B',
      margin: 'md'
    });
  }
  
  // 創建 Flex Message
  const flexMessage = {
    type: 'flex',
    altText: `吃藥提醒 - ${mealType}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: `⚕️ 吃藥提醒`,
            weight: 'bold',
            size: 'lg',
            color: '#FFFFFF'
          },
          {
            type: 'text',
            text: mealType,
            size: 'md',
            color: '#FFFFFF',
            margin: 'sm'
          }
        ],
        backgroundColor: '#FF6B6B',
        paddingAll: 'md'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: bodyContents,
        paddingAll: 'lg'
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        contents: [
          {
            type: 'button',
            style: 'primary',
            action: {
              type: 'postback',
              label: '✅ 吃過了',
              data: `action=taken&schedule_id=${scheduleId}&retry_count=${retryCount}`
            },
            color: '#4CAF50'
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: '⏰ 等一下吃',
              data: `action=snooze&schedule_id=${scheduleId}&retry_count=${retryCount}`
            },
            margin: 'md'
          }
        ],
        paddingAll: 'md'
      }
    }
  };

  try {
    console.log(`📤 正在發送提醒給 ${userId}...`);
    const result = await bot.push(userId, flexMessage);
    console.log(`📬 LINE API 回應:`, JSON.stringify(result));
    console.log(`✅ 提醒訊息已發送給 ${userId} - ${mealType}`);
    return true;
  } catch (error) {
    console.error('❌ 發送提醒訊息失敗:', error);
    console.error('錯誤詳情:', error.message);
    if (error.response) {
      console.error('LINE API 錯誤回應:', error.response.data);
    }
    return false;
  }
}

/**
 * 發送文字訊息
 */
async function sendTextMessage(bot, userId, text) {
  try {
    await bot.push(userId, {
      type: 'text',
      text: text
    });
    return true;
  } catch (error) {
    console.error('❌ 發送文字訊息失敗:', error);
    return false;
  }
}

/**
 * 處理 Postback Event (用戶點擊按鈕)
 */
function handlePostback(postbackData) {
  const params = new URLSearchParams(postbackData);
  return {
    action: params.get('action'),
    scheduleId: params.get('schedule_id'),
    retryCount: parseInt(params.get('retry_count') || '0', 10)
  };
}

/**
 * 處理 Webhook Event
 */
async function handleWebhookEvent(bot, event, db) {
  const { createUser, getUserByLineId, createSchedule, getScheduleById, getSchedulesByUserId, createMedicationLog, getMedicationLogById, getMedicationLogByScheduleAndDate, updateMedicationLogStatus, getPendingLogsForDate } = db;
  
  // 處理 Postback (用戶點擊按鈕)
  if (event.type === 'postback') {
    const postback = handlePostback(event.postback.data);
    console.log('📥 收到 Postback:', postback);
    
    const userId = event.source.userId;
    let user = getUserByLineId(userId);
    
    // 如果用戶不存在，建立新用戶
    if (!user) {
      user = createUser(userId, event.source.userId);
      console.log(`✅ 新用戶註冊: ${userId}`);
      
      // 為新用戶建立預設排程
      await setupDefaultSchedules(user.id);
    }
    
    // 處理「吃過了」
    if (postback.action === 'taken') {
      const today = new Date().toISOString().split('T')[0];
      const log = getMedicationLogByScheduleAndDate(postback.scheduleId, today);
      
      if (log) {
        const now = new Date().toISOString();
        const schedule = getScheduleById(postback.scheduleId);
        
        // 發送確認訊息
        await sendTextMessage(bot, userId, '✅ 已記錄！太棒了，記得按時服藥有助於健康！');
        
        // 檢查是否為早餐第一劑（西藥），啟動中藥提醒
        if (schedule && schedule.meal_type === '早餐後（西藥）') {
          // 設置標記：中藥提醒已啟動
          updateMedicationLogStatus(log.id, 'TAKEN', {
            takenAt: now,
            retryCount: postback.retryCount,
            chineseMedicineTriggered: true
          });
          
          // 發送中藥提醒（1小時後開始，每30分鐘一次）
          scheduleChineseMedicineReminder(bot, user, db, 1);  // 1小時後
          
          await sendTextMessage(bot, userId, '💡 提醒：1 小時後會發送中藥提醒，記得服用哦！');
        } else {
          // 一般情況（午餐、晚餐或中藥）
          updateMedicationLogStatus(log.id, 'TAKEN', {
            takenAt: now,
            retryCount: postback.retryCount
          });
        }
      }
    }
    
    // 處理「等一下吃」
    // 注意：不再使用 setTimeout，由 Cron Job 在 30 分鐘後自動發送提醒
    if (postback.action === 'snooze') {
      const today = new Date().toISOString().split('T')[0];
      const log = getMedicationLogByScheduleAndDate(postback.scheduleId, today);
      const schedule = getScheduleById(postback.scheduleId);
      
      if (log) {
        const newRetryCount = postback.retryCount + 1;
        
        // 更新狀態為 SNOOZED
        updateMedicationLogStatus(log.id, 'SNOOZED', {
          retryCount: newRetryCount,
          lastRemindedAt: new Date().toISOString()
        });
        
        if (newRetryCount < 3) {
          // 發送確認訊息，告知下次提醒時間
          await sendTextMessage(bot, userId, `⏰ 好的，下一次提醒將在 30 分鐘後發送（已提醒 ${newRetryCount}/3 次）`);
        } else {
          // 超過 3 次，標記為 MISSED
          updateMedicationLogStatus(log.id, 'MISSED', {
            retryCount: newRetryCount,
            lastRemindedAt: new Date().toISOString()
          });
          await sendTextMessage(bot, userId, '⚠️ 已超過最大提醒次數（3次），請記得盡快服用藥物！');
        }
      }
    }
    
    return { success: true, action: postback.action };
  }
  
  // 處理文字訊息
  if (event.type === 'message' && event.message.type === 'text') {
    const userId = event.source.userId;
    const messageText = event.message.text;
    
    let user = getUserByLineId(userId);
    
    // 如果用戶不存在，建立新用戶
    if (!user) {
      user = createUser(userId, userId);
      console.log(`✅ 新用戶註冊: ${userId}`);
      
      // 為新用戶建立預設排程
      await setupDefaultSchedules(user.id);
    }
    
    // 處理用戶命令
    if (messageText === '設定提醒' || messageText === '/setup') {
      await sendTextMessage(bot, userId, '🔧 正在為您設定吃藥提醒排程...');
      await setupDefaultSchedules(user.id);
      await sendTextMessage(bot, userId, '✅ 吃藥提醒排程已設定完成！\n\n📅 提醒時間：\n• 早餐後 08:00 - 高血壓（西藥）\n• 早餐後 09:00 - 高血壓（中藥）\n• 午餐後 13:00 - 高血壓（中藥）\n• 晚餐後 19:00 - 高血壓（中藥）\n\n您將在每次用藥時間收到提醒訊息！');
    }
    else if (messageText === '查詢提醒' || messageText === '/status') {
      const schedules = getSchedulesByUserId(user.id);
      const today = new Date().toISOString().split('T')[0];
      
      let statusText = '📋 今日服藥狀態：\n\n';
      
      for (const schedule of schedules) {
        const log = getMedicationLogByScheduleAndDate(schedule.id, today);
        const status = log ? log.status : 'N/A';
        const statusEmoji = status === 'TAKEN' ? '✅' : status === 'MISSED' ? '❌' : '⏳';
        statusText += `${statusEmoji} ${schedule.meal_type}: ${status}\n`;
      }
      
      await sendTextMessage(bot, userId, statusText);
    }
    else if (messageText === '測試' || messageText === '/test') {
      // 發送測試訊息
      await sendTextMessage(bot, userId, '🧪 正在發送測試訊息...');
      await sendReminderMessage(bot, userId, {
        mealType: '測試提醒',
        medicines: ['這是測試用藥'],
        scheduleId: 'test-' + Date.now(),
        retryCount: 0,
        isSecondDose: false
      });
      await sendTextMessage(bot, userId, '✅ 測試訊息已發送！請檢查是否有收到 Flex Message。');
    }
    else if (messageText === '說明' || messageText === '/help') {
      await sendTextMessage(bot, userId, `📖 吃藥提醒機器人使用說明：

🤖 可用指令：
• 測試 - 發送測試訊息
• 設定提醒 - 設定每日提醒排程
• 查詢提醒 - 查看今日服藥狀態
• 立即提醒 - 立即觸發午餐提醒（測試用）
• 說明 - 顯示此說明

💊 提醒規則：
• 早餐後提醒 2 次（間隔 1 小時）
• 午餐、晚餐後各提醒 1 次
• 選擇「等一下吃」會在 30 分鐘後再次提醒
• 最多提醒 3 次
`);
    }
    else if (messageText === '立即提醒') {
      // 手動觸發午餐提醒（測試用）
      const { createScheduler } = require('./scheduler');
      const schedulerModule = createScheduler(bot, db);
      await schedulerModule.sendReminderForMealType('午餐後');
      await sendTextMessage(bot, userId, '✅ 已觸發午餐提醒！請檢查是否有收到訊息。');
    }
    else {
      // 預設回覆
      await sendTextMessage(bot, userId, `您好！我是吃藥提醒機器人 🤖\n\n輸入「說明」查看更多功能！`);
    }
    
    return { success: true, action: 'text' };
  }
  
  return { success: false };
}

/**
 * 為新用戶建立預設排程
 */
async function setupDefaultSchedules(userId) {
  // 動態獲取數據庫模組
  const { getDb } = require('./database');
  const db = getDb();
  const { createSchedule, getSchedulesByUserId, createMedicationLog } = db;
  
  // 清除現有排程
  const existingSchedules = getSchedulesByUserId(userId);
  
  // 建立早餐第一劑（西藥）
  const breakfastFirst = createSchedule(
    userId,
    '早餐後（西藥）',
    '08:00',
    ['高血壓（西藥）'],
    { isSecondDose: false, linkDelayMinutes: 60 }
  );
  
  // 建立早餐第二劑（中藥）- 關聯到第一劑
  const breakfastSecond = createSchedule(
    userId,
    '早餐後（中藥）',
    '09:00',
    ['高血壓（中藥）'],
    { isSecondDose: true, linkedScheduleId: breakfastFirst.id, linkDelayMinutes: 60 }
  );
  
  // 建立午餐提醒（中藥）
  const lunchSchedule = createSchedule(
    userId,
    '午餐後',
    '13:00',
    ['高血壓（中藥）']
  );
  
  // 建立晚餐提醒（中藥）
  const dinnerSchedule = createSchedule(
    userId,
    '晚餐後',
    '19:00',
    ['高血壓（中藥）']
  );
  
  // 立即創建當天的服藥記錄
  const today = new Date().toISOString().split('T')[0];
  createMedicationLog(breakfastFirst.id, userId, today);
  createMedicationLog(breakfastSecond.id, userId, today);
  createMedicationLog(lunchSchedule.id, userId, today);
  createMedicationLog(dinnerSchedule.id, userId, today);
  
  console.log(`✅ 用戶 ${userId} 的排程已建立`);
}

/**
 * 發送中藥提醒（遞歸函數，實現多次提醒）
 * @param {object} bot - LINE Bot 實例
 * @param {object} user - 用戶對象
 * @param {object} db - 數據庫操作對象
 * @param {number} delayHours - 延時（小時）
 * @param {number} reminderCount - 已發送次數
 */
function scheduleChineseMedicineReminder(bot, user, db, delayHours = 1, reminderCount = 0) {
  const { getSchedulesByUserId, getMedicationLogByScheduleAndDate, updateMedicationLogStatus } = db;
  
  // 計算延時毫秒數
  const delayMs = delayHours * 60 * 60 * 1000;
  
  setTimeout(async () => {
    const today = new Date().toISOString().split('T')[0];
    const schedules = getSchedulesByUserId(user.id);
    const chineseSchedule = schedules.find(s => s.meal_type === '早餐後（中藥）');
    
    if (!chineseSchedule) {
      console.log('⚠️ 找不到早餐中藥排程');
      return;
    }
    
    const log = getMedicationLogByScheduleAndDate(chineseSchedule.id, today);
    
    // 如果中藥已經服用，跳過
    if (log && log.status === 'TAKEN') {
      console.log('⏭️ 跳過中藥提醒（已服用）');
      return;
    }
    
    // 從模組內部獲取 sendReminderMessage 函數
    const { sendReminderMessage: sendReminder } = require('./lineBot');
    
    // 發送中藥提醒
    const scheduleInfo = {
      mealType: chineseSchedule.meal_type,
      medicines: JSON.parse(chineseSchedule.medicines),
      scheduleId: chineseSchedule.id,
      retryCount: reminderCount,
      isSecondDose: chineseSchedule.is_second_dose
    };
    
    await sendReminder(bot, user.line_user_id, scheduleInfo);
    
    // 更新狀態
    if (log) {
      updateMedicationLogStatus(log.id, 'SNOOZED', {
        retryCount: reminderCount + 1,
        lastRemindedAt: new Date().toISOString()
      });
    }
    
    console.log(`✅ 中藥提醒已發送給 ${user.line_user_id} (${reminderCount + 1}/3)`);
    
    // 如果還沒超過3次，繼續設置下一次提醒（30分鐘後）
    if (reminderCount < 2) {
      scheduleChineseMedicineReminder(bot, user, db, 0.5, reminderCount + 1);  // 30分鐘 = 0.5小時
    }
  }, delayMs);
}

module.exports = {
  createBot,
  sendReminderMessage,
  sendTextMessage,
  handlePostback,
  handleWebhookEvent,
  setupDefaultSchedules,
  MEDICATIONS
};
