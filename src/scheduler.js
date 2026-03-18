/**
/**
 * 吃藥提醒 LINE Bot - 排程器模組
 * 負責處理定時提醒任務
 * 
 * 設計思路：
 * - 每個用藥提醒有獨立的 Cron Job
 * - 每個提醒最多發送 3 次（相隔 30 分鐘）
 * - 通過檢查狀態決定是否發送（PENDING/SNOOZED 才發送）
 */

const cron = require('node-cron');

// 設定時區為台灣
process.env.TZ = 'Asia/Taipei';

// 取得台灣時間
function getTaiwanTime() {
  const now = new Date();
  const taiwanTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return taiwanTime;
}

// 取得台灣日期字串
function getTaiwanDateString() {
  const taiwanTime = getTaiwanTime();
  const year = taiwanTime.getFullYear();
  const month = String(taiwanTime.getMonth() + 1).padStart(2, '0');
  const day = String(taiwanTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 建立排程器
 * @param {object} lineBot - LINE Bot 實例
 * @param {object} telegramBot - Telegram Bot 實例
 * @param {object} db - 數據庫操作對象
 */
function createScheduler(lineBot, telegramBot, db) {
  const { getAllUsers, getSchedulesByUserId, createMedicationLog, getMedicationLogByScheduleAndDate, updateMedicationLogStatus, getUserByTelegramId } = db;
  
  console.log('✅ 排程器初始化完成');
  console.log('   - LINE Bot:', lineBot ? '已連接' : '未設定');
  console.log('   - Telegram Bot:', telegramBot && telegramBot.isInitialized() ? '已連接' : '未設定');
  
  /**
   * 初始化當日排程
   * 每天 00:00 執行，為每個用戶建立當日的服藥記錄
   * 同時檢查並補全缺失的排程
   */
  const initDailySchedule = async () => {
    const users = await getAllUsers();
    const today = getTaiwanDateString();
    
    console.log(`📅 初始化 ${today} 的排程...`);
    
    for (const user of users) {
      let schedules = await getSchedulesByUserId(user.id);
      
      // 檢查並補全缺失的排程
      const requiredMealTypes = ['早餐後（西藥）', '早餐後（中藥）', '午餐後', '晚餐後'];
      const existingMealTypes = schedules.map(s => s.meal_type);
      
      for (const mealType of requiredMealTypes) {
        if (!existingMealTypes.includes(mealType)) {
          console.log(`⚠️ 補全缺失排程: ${user.line_user_id} - ${mealType}`);
          
          let defaultTime = '08:00';
          if (mealType === '早餐後（中藥）') defaultTime = '09:00';
          if (mealType === '午餐後') defaultTime = '13:00';
          if (mealType === '晚餐後') defaultTime = '19:00';
          
          await db.createSchedule(
            user.id,
            mealType,
            defaultTime,
            ['高血壓（中藥）'],
            mealType === '早餐後（中藥）' ? { isSecondDose: true } : {}
          );
          
          // 重新獲取排程
          schedules = await getSchedulesByUserId(user.id);
        }
      }
      
      // 為每個排程創建當天的服藥記錄
      for (const schedule of schedules) {
        // 檢查當日記錄是否已存在
        const existingLog = await getMedicationLogByScheduleAndDate(schedule.id, today);
        
        if (!existingLog) {
          // 建立新的服藥記錄
          await createMedicationLog(schedule.id, user.id, today);
          console.log(`✅ 建立記錄: ${user.line_user_id} - ${schedule.meal_type}`);
        }
      }
    }
    
    console.log(`📅 ${today} 排程初始化完成，共 ${users.length} 位用戶`);
  };
  
  /**
   * 發送用藥提醒（通用函數）- 支持多通道
   * @param {string} mealType - 用藥類型（如「早餐後（西藥）」）
   * @param {string} channel - 通道类型：'line', 'telegram', 'both'
   */
  const sendReminderForMealType = async (mealType, channel = 'both') => {
    const users = await getAllUsers();
    const today = getTaiwanDateString();
    
    console.log(`🔔 檢查 ${mealType} 提醒... (通道: ${channel})`);
    
    if (users.length === 0) {
      console.log('⚠️ 沒有找到任何用戶');
      return;
    }
    console.log(`   - 用戶數量: ${users.length}`);
    console.log(`   - 日期: ${today}`);
    
    for (const user of users) {
      // 查找對應的排程
      const schedules = await getSchedulesByUserId(user.id);
      const schedule = schedules.find(s => s.meal_type === mealType);
      
      if (!schedule) {
        console.log(`⚠️ 找不到排程: ${mealType}`);
        continue;
      }
      
      // 取得服藥記錄
      const log = await getMedicationLogByScheduleAndDate(schedule.id, today);
      
      if (!log) {
        console.log(`⚠️ 找不到服藥記錄: ${mealType}`);
        continue;
      }
      
      // 檢查狀態
      if (log.status === 'TAKEN') {
        console.log(`⏭️ 跳過 ${mealType}（已服用）`);
        continue;
      }
      
      if (log.status === 'MISSED') {
        console.log(`⏭️ 跳過 ${mealType}（已標記為未服用）`);
        continue;
      }
      
      // 檢查重試次數
      const retryCount = log.retry_count || 0;
      
      // 準備排程信息
      const scheduleInfo = {
        mealType: schedule.meal_type,
        medicines: schedule.medicines,
        scheduleId: schedule.id,
        retryCount: retryCount,
        isSecondDose: schedule.is_second_dose
      };
      
      // 動態獲取發送函數
      const { sendReminderMessage: sendLineReminder, sendTextMessage: sendLineText } = require('./lineBot');
      const { sendReminderMessage: sendTelegramReminder, sendTextMessage: sendTelegramText } = require('./telegramBot');
      
      // 決定發送目標
      const lineUserId = user.line_user_id;
      const telegramUserId = user.telegram_user_id;
      
      console.log(`📤 準備發送提醒: ${mealType}`);
      console.log(`   - LINE: ${lineUserId || '未設定'}`);
      console.log(`   - Telegram: ${telegramUserId || '未設定'}`);
      
      // 發送 LINE 提醒
      if ((channel === 'both' || channel === 'line') && lineBot && lineUserId) {
        try {
          console.log(`   📱 發送 LINE 提醒...`);
          await sendLineReminder(lineBot, lineUserId, scheduleInfo);
          console.log(`   ✅ LINE 提醒已發送`);
        } catch (error) {
          console.error(`   ❌ LINE 提醒發送失敗:`, error.message);
        }
      }
      
      // 發送 Telegram 提醒
      if ((channel === 'both' || channel === 'telegram') && telegramBot && telegramBot.isInitialized() && telegramUserId) {
        try {
          console.log(`   📱 發送 Telegram 提醒...`);
          await sendTelegramReminder(telegramUserId, scheduleInfo);
          console.log(`   ✅ Telegram 提醒已發送`);
        } catch (error) {
          console.error(`   ❌ Telegram 提醒發送失敗:`, error.message);
        }
      }
      
      // 更新狀態為 SNOOZED
      const newRetryCount = retryCount + 1;
      await updateMedicationLogStatus(log.id, 'SNOOZED', {
        retryCount: newRetryCount,
        lastRemindedAt: new Date().toISOString()
      });
      
      console.log(`✅ ${mealType} 提醒流程完成 (${newRetryCount}/3)`);
    }
  };
  
  /**
   * 發送中藥備用提醒（用戶都沒回覆時使用）
   * 檢查是否需要跳過（如果用戶已經點擊吃過西藥）
   */
  const sendChineseMedicineReminderBackup = async () => {
    const users = await getAllUsers();
    const today = getTaiwanDateString();
    
    for (const user of users) {
      const schedules = await getSchedulesByUserId(user.id);
      const westernSchedule = schedules.find(s => s.meal_type === '早餐後（西藥）');
      
      if (!westernSchedule) continue;
      
      const westernLog = await getMedicationLogByScheduleAndDate(westernSchedule.id, today);
      
      // 如果西藥的中藥提醒已經觸發過（用戶點擊吃過），則跳過
      if (westernLog && westernLog.chinese_medicine_triggered) {
        console.log(`⏭️ 跳過 ${user.line_user_id} 早餐中藥（已由用戶回覆觸發）`);
        continue;
      }
      
      // 發送中藥提醒
      console.log(`📤 備用發送 ${user.line_user_id} 早餐中藥提醒`);
      await sendReminderForMealType('早餐後（中藥）');
    }
  };
  
  /**
   * 啟動所有排程任務
   */
  const start = () => {
    // 每天 00:00 初始化當日排程
    cron.schedule('0 0 * * *', () => {
      initDailySchedule().catch(err => console.error('❌ 錯誤:', err));
    });
    
    // ==================== 早餐（西藥）===================
    // 08:00 - 第1次提醒
    cron.schedule('0 8 * * *', () => {
      sendReminderForMealType('早餐後（西藥）').catch(err => console.error('❌ 錯誤:', err));
    });
    
    // 08:30 - 第2次提醒
    cron.schedule('30 8 * * *', () => {
      sendReminderForMealType('早餐後（西藥）').catch(err => console.error('❌ 錯誤:', err));
    });
    
    // 09:00 - 第3次提醒
    cron.schedule('0 9 * * *', () => {
      sendReminderForMealType('早餐後（西藥）').catch(err => console.error('❌ 錯誤:', err));
    });
    
    // ==================== 早餐（中藥）備用===================
    // 09:30 - 備用提醒（如果用戶沒回應）
    cron.schedule('30 9 * * *', () => {
      sendChineseMedicineReminderBackup().catch(err => console.error('❌ 錯誤:', err));
    });
    
    // ==================== 午餐（中藥）===================
    // 13:00 - 備用提醒（固定時間）
    cron.schedule('0 13 * * *', () => {
      sendReminderForMealType('午餐後').catch(err => console.error('❌ 錯誤:', err));
    });
    
    // 13:30 - 第2次提醒
    cron.schedule('30 13 * * *', () => {
      sendReminderForMealType('午餐後').catch(err => console.error('❌ 錯誤:', err));
    });
    
    // 14:00 - 第3次提醒
    cron.schedule('0 14 * * *', () => {
      sendReminderForMealType('午餐後').catch(err => console.error('❌ 錯誤:', err));
    });
    
    // ==================== 晚餐（中藥）===================
    // 19:00 - 備用提醒（固定時間）
    cron.schedule('0 19 * * *', () => {
      sendReminderForMealType('晚餐後').catch(err => console.error('❌ 錯誤:', err));
    });
    
    // 19:30 - 第2次提醒
    cron.schedule('30 19 * * *', () => {
      sendReminderForMealType('晚餐後').catch(err => console.error('❌ 錯誤:', err));
    });
    
    // 20:00 - 第3次提醒
    cron.schedule('0 20 * * *', () => {
      sendReminderForMealType('晚餐後').catch(err => console.error('❌ 錯誤:', err));
    });
    
    console.log('✅ 所有排程任務已啟動');
    console.log('📅 排程任務：');
    console.log('   • 00:00 - 初始化當日排程');
    console.log('   • 08:00-09:00 早餐（西藥）提醒 × 3');
    console.log('   • 09:30 早餐（中藥）備用提醒');
    console.log('   • 13:00-14:00 午餐（中藥）提醒 × 3');
    console.log('   • 19:00-20:00 晚餐（中藥）提醒 × 3');
    console.log('📱 通知通道：');
    console.log('   • LINE:', lineBot ? '✅ 已啟用' : '❌ 未設定');
    console.log('   • Telegram:', telegramBot && telegramBot.isInitialized() ? '✅ 已啟用' : '❌ 未設定');
    
    // 啟動時顯示時間
    const now = getTaiwanTime();
    console.log(`🔍 當前台灣時間: ${now.toISOString()}`);
    
    // 啟動時初始化當日排程
    initDailySchedule();
  };
  
  return {
    start,
    initDailySchedule,
    sendReminderForMealType
  };
}

module.exports = {
  createScheduler
};
