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
 */
function createScheduler(bot, db) {
  const { getAllUsers, getSchedulesByUserId, createMedicationLog, getMedicationLogByScheduleAndDate, updateMedicationLogStatus } = db;
  
  console.log('✅ 排程器初始化完成');
  
  /**
   * 初始化當日排程
   * 每天 00:00 執行，為每個用戶建立當日的服藥記錄
   */
  const initDailySchedule = () => {
    const users = getAllUsers();
    const today = getTaiwanDateString();
    
    console.log(`📅 初始化 ${today} 的排程...`);
    
    for (const user of users) {
      const schedules = getSchedulesByUserId(user.id);
      
      for (const schedule of schedules) {
        // 檢查當日記錄是否已存在
        const existingLog = getMedicationLogByScheduleAndDate(schedule.id, today);
        
        if (!existingLog) {
          // 建立新的服藥記錄
          createMedicationLog(schedule.id, user.id, today);
          console.log(`✅ 建立記錄: ${user.line_user_id} - ${schedule.meal_type}`);
        }
      }
    }
    
    console.log(`📅 ${today} 排程初始化完成，共 ${users.length} 位用戶`);
  };
  
  /**
   * 發送用藥提醒（通用函數）
   * @param {string} mealType - 用藥類型（如「早餐後（西藥）」）
   */
  const sendReminderForMealType = async (mealType) => {
    const users = getAllUsers();
    const today = getTaiwanDateString();
    
    console.log(`🔔 檢查 ${mealType} 提醒...`);
    
    if (users.length === 0) {
      console.log('⚠️ 沒有找到任何用戶');
      return;
    }
    console.log(`   - 用戶數量: ${users.length}`);
    console.log(`   - 日期: ${today}`);
    
    if (users.length === 0) {
      console.log('⚠️ 沒有找到任何用戶');
      return;
    }
    
    for (const user of users) {
      // 查找對應的排程
      const schedules = getSchedulesByUserId(user.id);
      const schedule = schedules.find(s => s.meal_type === mealType);
      
      if (!schedule) {
        console.log(`⚠️ 找不到排程: ${mealType}`);
        continue;
      }
      
      // 取得服藥記錄
      const log = getMedicationLogByScheduleAndDate(schedule.id, today);
      
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
      
      // 忽略第一劑檢查：中藥可以獨立發送提醒
      // （用戶可能會選擇先吃中藥或西藥，不應該強制綁定）
      
      // 檢查重試次數
      const retryCount = log.retry_count || 0;
      
      // 動態獲取 lineBot 模組
      const { sendReminderMessage, sendTextMessage } = require('./lineBot');
      
      if (retryCount >= 3) {
        // 超過 3 次，發送最終提醒
        if (log.status !== 'MISSED') {
          updateMedicationLogStatus(log.id, 'MISSED', {
            lastRemindedAt: new Date().toISOString()
          });
          await sendTextMessage(bot, user.line_user_id, '⚠️ 已超過最大提醒次數（3次），請記得盡快服用藥物！');
          console.log(`❌ 標記為未服藥: ${user.line_user_id} - ${mealType}`);
        }
        continue;
      }
      
      // 發送提醒
      const scheduleInfo = {
        mealType: schedule.meal_type,
        medicines: JSON.parse(schedule.medicines),
        scheduleId: schedule.id,
        retryCount: retryCount,
        isSecondDose: schedule.is_second_dose
      };
      
      console.log(`📤 準備發送提醒: ${user.line_user_id} - ${mealType}`);
      
      await sendReminderMessage(bot, user.line_user_id, scheduleInfo);
      
      // 更新狀態為 SNOOZED（表示用戶暫時不想吃）
      const newRetryCount = retryCount + 1;
      updateMedicationLogStatus(log.id, 'SNOOZED', {
        retryCount: newRetryCount,
        lastRemindedAt: new Date().toISOString()
      });
      
      console.log(`✅ 提醒已發送: ${user.line_user_id} - ${mealType} (${newRetryCount}/3)`);
    }
  };
  
  /**
   * 發送中藥備用提醒（用戶都沒回覆時使用）
   * 檢查是否需要跳過（如果用戶已經點擊吃過西藥）
   */
  const sendChineseMedicineReminderBackup = () => {
    const users = getAllUsers();
    const today = getTaiwanDateString();
    
    for (const user of users) {
      const schedules = getSchedulesByUserId(user.id);
      const westernSchedule = schedules.find(s => s.meal_type === '早餐後（西藥）');
      
      if (!westernSchedule) continue;
      
      const westernLog = getMedicationLogByScheduleAndDate(westernSchedule.id, today);
      
      // 如果西藥的中藥提醒已經觸發過（用戶點擊吃過），則跳過
      if (westernLog && westernLog.chinese_medicine_triggered) {
        console.log(`⏭️ 跳過 ${user.line_user_id} 早餐中藥（已由用戶回覆觸發）`);
        continue;
      }
      
      // 發送中藥提醒
      console.log(`📤 備用發送 ${user.line_user_id} 早餐中藥提醒`);
      sendReminderForMealType('早餐後（中藥）').catch(err => console.error('❌ 錯誤:', err));
    }
  };
  
  /**
   * 啟動所有排程任務
   */
  const start = () => {
    // 每天 00:00 初始化當日排程
    cron.schedule('0 0 * * *', () => {
      initDailySchedule();
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
    
    // 09:30 - 第4次提醒（超過3次）
    cron.schedule('30 9 * * *', () => {
      sendReminderForMealType('早餐後（西藥）').catch(err => console.error('❌ 錯誤:', err));
    });
    
    // ==================== 早餐（中藥）===================
    // 10:30 - 備用提醒時間（西藥最後一次提醒後1小時）
    // 如果用戶已經點擊吃過，會由 lineBot.js 的 setTimeout 提前發送
    // 這裡作為備用：如果用戶都沒回覆，10:30 發送中藥提醒
    // 然後每30分鐘繼續提醒：11:00, 11:30, 12:00
    cron.schedule('30 10 * * *', () => {
      sendChineseMedicineReminderBackup();
    });
    
    // 11:00 - 第2次提醒
    cron.schedule('0 11 * * *', () => {
      sendChineseMedicineReminderBackup();
    });
    
    // 11:30 - 第3次提醒
    cron.schedule('30 11 * * *', () => {
      sendChineseMedicineReminderBackup();
    });
    
    // 12:00 - 第4次提醒（超過3次）
    cron.schedule('0 12 * * *', () => {
      sendChineseMedicineReminderBackup();
    });
    
    // ==================== 午餐（中藥）===================
    // 13:00 - 第1次提醒
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
    
    // 14:30 - 第4次提醒（超過3次）
    cron.schedule('30 14 * * *', () => {
      sendReminderForMealType('午餐後').catch(err => console.error('❌ 錯誤:', err));
    });
    
    // ==================== 晚餐（中藥）===================
    // 19:00 - 第1次提醒
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
    
    // 20:30 - 第4次提醒（超過3次）
    cron.schedule('30 20 * * *', () => {
      sendReminderForMealType('晚餐後').catch(err => console.error('❌ 錯誤:', err));
    });
    
    // ==================== 測試排程 ====================
    // 16:15 - 測試午餐提醒
    cron.schedule('15 16 * * *', () => {
      console.log('🔔 觸發 16:15 午餐提醒 cron');
      sendReminderForMealType('午餐後').catch(err => console.error('❌ 錯誤:', err));
    });
    
    console.log('✅ 所有排程任務已啟動');
    console.log('📅 排程任務：');
    console.log('   • 00:00 - 初始化當日排程');
    console.log('   • 08:00-09:30 早餐（西藥）提醒 × 4');
    console.log('   • 10:30-12:00 早餐（中藥）備用提醒 × 4');
    console.log('   • 13:00-14:30 午餐提醒 × 4');
    console.log('   • 19:00-20:30 晚餐提醒 × 4');
    console.log('   • 16:15 測試午餐提醒');
    
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
