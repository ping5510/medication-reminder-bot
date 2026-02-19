/**
 * 吃藥提醒 LINE Bot - 排程器模組
 * 負責處理定時提醒任務
 */

const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

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
  const { getAllUsers, getSchedulesByUserId, createMedicationLog, getMedicationLogByScheduleAndDate, updateMedicationLogStatus, getPendingLogsForDate } = db;
  
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
   * 檢查並發送定時提醒
   */
  const checkAndSendReminders = async () => {
    const now = getTaiwanTime();
    const currentHour = String(now.getHours()).padStart(2, '0');
    const currentMinute = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${currentHour}:${currentMinute}`;
    
    const users = getAllUsers();
    const today = getTaiwanDateString();
    
    console.log(`🔍 檢查 ${currentTime} 的提醒...`);
    
    for (const user of users) {
      const schedules = getSchedulesByUserId(user.id);
      
      for (const schedule of schedules) {
        // 檢查是否為提醒時間
        if (schedule.default_time === currentTime) {
          // 檢查服藥記錄
          const log = getMedicationLogByScheduleAndDate(schedule.id, today);
          
          // 只有 PENDING 或 SNOOZED 狀態才發送提醒
          if (log && (log.status === 'PENDING' || log.status === 'SNOOZED')) {
            // 如果是早餐第二劑，檢查第一劑是否已服用
            if (schedule.is_second_dose && schedule.linked_schedule_id) {
              const firstDoseLog = getMedicationLogByScheduleAndDate(schedule.linked_schedule_id, today);
              if (!firstDoseLog || firstDoseLog.status !== 'TAKEN') {
                console.log(`⏭️ 跳過 ${schedule.meal_type}（第一劑尚未服用）`);
                continue;
              }
            }
            
            // 發送提醒
            const { sendReminderMessage } = require('./lineBot');
            const scheduleInfo = {
              mealType: schedule.meal_type,
              medicines: JSON.parse(schedule.medicines),
              scheduleId: schedule.id,
              retryCount: log.retry_count || 0,
              isSecondDose: schedule.is_second_dose
            };
            
            // 使用 await 等待發送完成
            await sendReminderMessage(bot, user.line_user_id, scheduleInfo);
            
            // 更新提醒時間
            const taiwanTimeStr = getTaiwanTime().toISOString();
            updateMedicationLogStatus(log.id, log.status, {
              lastRemindedAt: taiwanTimeStr
            });
          }
        }
      }
    }
  };
  
  /**
   * 檢查超時未回覆的提醒並重新發送
   * 每 5 分鐘執行一次，檢查是否需要重試
   */
  const checkRetryNeeded = async () => {
    const now = getTaiwanTime();
    const today = getTaiwanDateString();
    
    // 取得所有 PENDING 或 SNOOZED 的記錄
    const pendingLogs = getPendingLogsForDate(today);
    
    console.log(`🔍 檢查需要重試的記錄，共 ${pendingLogs.length} 條...`);
    
    for (const log of pendingLogs) {
      if (!log.last_reminded_at) continue;
      
      const lastReminded = new Date(log.last_reminded_at);
      const minutesDiff = Math.floor((now - lastReminded) / (1000 * 60));
      
      // 如果超過 30 分鐘且重試次數少於 3 次
      if (minutesDiff >= 30 && log.retry_count < 3 && log.status === 'SNOOZED') {
        const { getScheduleById } = db;
        const schedule = getScheduleById(log.schedule_id);
        
        if (schedule) {
          const { sendReminderMessage } = require('./lineBot');
          const newRetryCount = log.retry_count + 1;
          
          const scheduleInfo = {
            mealType: schedule.meal_type,
            medicines: JSON.parse(schedule.medicines),
            scheduleId: schedule.id,
            retryCount: newRetryCount,
            isSecondDose: schedule.is_second_dose
          };
          
          // 更新重試次數
          updateMedicationLogStatus(log.id, 'PENDING', {
            retryCount: newRetryCount,
            lastRemindedAt: now.toISOString()
          });
          
          // 發送重試提醒
          await sendReminderMessage(bot, log.line_user_id, scheduleInfo);
          console.log(`🔔 重試提醒已發送: ${log.line_user_id} - ${schedule.meal_type} (${newRetryCount}/3)`);
        }
      }
      
      // 如果超過 90 分鐘（3 次重試後）且仍未回覆，標記為 MISSED
      if (minutesDiff >= 90 && log.retry_count >= 3 && log.status === 'PENDING') {
        updateMedicationLogStatus(log.id, 'MISSED', {
          lastRemindedAt: now.toISOString()
        });
        console.log(`❌ 標記為未服藥: ${log.line_user_id} - ${log.meal_type}`);
      }
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
    
    // 每分鐘檢查是否需要發送提醒
    cron.schedule('* * * * *', async () => {
      await checkAndSendReminders();
    });
    
    // 每 5 分鐘檢查是否需要重試
    cron.schedule('*/5 * * * *', async () => {
      await checkRetryNeeded();
    });
    
    console.log('✅ 所有排程任務已啟動');
    console.log('📅 排程任務：');
    console.log('   • 00:00 - 初始化當日排程');
    console.log('   • 每分鐘 - 檢查定時提醒');
    console.log('   • 每 5 分鐘 - 檢查重試提醒');
    
    // 啟動時初始化當日排程
    initDailySchedule();
  };
  
  return {
    start,
    initDailySchedule,
    checkAndSendReminders,
    checkRetryNeeded
  };
}

module.exports = {
  createScheduler
};
