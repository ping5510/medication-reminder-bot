/**
 * 吃藥提醒 LINE Bot - 數據存儲模組（JSON 文件存儲）
 * 兼容 Zeabur 無服務器環境
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// 數據庫路徑
const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'medication.json');

// 內存緩存
let data = {
  users: [],
  schedules: [],
  medicationLogs: []
};

/**
 * 初始化數據庫
 */
function initDatabase() {
  // 確保數據目錄存在
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 加載現有數據
  if (fs.existsSync(dbPath)) {
    try {
      const fileContent = fs.readFileSync(dbPath, 'utf8');
      data = JSON.parse(fileContent);
      console.log('✅ 數據庫加載成功:', dbPath);
    } catch (error) {
      console.error('❌ 數據庫加載失敗:', error.message);
      data = { users: [], schedules: [], medicationLogs: [] };
    }
  } else {
    // 創建新數據庫
    saveDatabase();
    console.log('✅ 新數據庫已創建:', dbPath);
  }

  console.log('✅ 數據存儲初始化完成');
  return getDb();
}

/**
 * 保存數據到文件
 */
function saveDatabase() {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('❌ 數據保存失敗:', error.message);
  }
}

/**
 * 取得數據庫實例
 */
function getDb() {
  return {
    // 用戶操作
    createUser: createUser,
    getUserByLineId: getUserByLineId,
    getAllUsers: getAllUsers,
    
    // 排程操作
    createSchedule: createSchedule,
    getScheduleById: getScheduleById,
    getSchedulesByUserId: getSchedulesByUserId,
    
    // 服藥記錄操作
    createMedicationLog: createMedicationLog,
    getMedicationLogById: getMedicationLogById,
    getMedicationLogByScheduleAndDate: getMedicationLogByScheduleAndDate,
    updateMedicationLogStatus: updateMedicationLogStatus,
    getPendingLogsForDate: getPendingLogsForDate,
    
    // 工具
    closeDatabase: closeDatabase
  };
}

/**
 * 建立新用戶
 */
function createUser(lineUserId, displayName = null) {
  const existingUser = data.users.find(u => u.line_user_id === lineUserId);
  if (existingUser) {
    return existingUser;
  }

  const user = {
    id: uuidv4(),
    line_user_id: lineUserId,
    display_name: displayName,
    created_at: new Date().toISOString()
  };

  data.users.push(user);
  saveDatabase();
  return user;
}

/**
 * 透過 LINE User ID 取得用戶
 */
function getUserByLineId(lineUserId) {
  return data.users.find(u => u.line_user_id === lineUserId) || null;
}

/**
 * 取得所有用戶
 */
function getAllUsers() {
  return data.users;
}

/**
 * 建立排程
 */
function createSchedule(userId, mealType, defaultTime, medicines, options = {}) {
  const schedule = {
    id: uuidv4(),
    user_id: userId,
    meal_type: mealType,
    default_time: defaultTime,
    medicines: JSON.stringify(medicines),
    is_second_dose: options.isSecondDose || 0,
    linked_schedule_id: options.linkedScheduleId || null,
    link_delay_minutes: options.linkDelayMinutes || 60,
    created_at: new Date().toISOString()
  };

  data.schedules.push(schedule);
  saveDatabase();
  return schedule;
}

/**
 * 透過 ID 取得排程
 */
function getScheduleById(scheduleId) {
  return data.schedules.find(s => s.id === scheduleId) || null;
}

/**
 * 取得用戶的所有排程
 */
function getSchedulesByUserId(userId) {
  return data.schedules.filter(s => s.user_id === userId);
}

/**
 * 建立服藥記錄
 */
function createMedicationLog(scheduleId, userId, date) {
  const existingLog = data.medicationLogs.find(
    log => log.schedule_id === scheduleId && log.date === date
  );
  
  if (existingLog) {
    return existingLog;
  }

  const log = {
    id: uuidv4(),
    schedule_id: scheduleId,
    user_id: userId,
    date: date,
    status: 'PENDING',
    retry_count: 0,
    last_reminded_at: null,
    taken_at: null,
    created_at: new Date().toISOString()
  };

  data.medicationLogs.push(log);
  saveDatabase();
  return log;
}

/**
 * 透過 ID 取得服藥記錄
 */
function getMedicationLogById(logId) {
  return data.medicationLogs.find(log => log.id === logId) || null;
}

/**
 * 透過排程 ID 和日期取得服藥記錄
 */
function getMedicationLogByScheduleAndDate(scheduleId, date) {
  return data.medicationLogs.find(
    log => log.schedule_id === scheduleId && log.date === date
  ) || null;
}

/**
 * 更新服藥記錄狀態
 */
function updateMedicationLogStatus(logId, status, additionalData = {}) {
  const logIndex = data.medicationLogs.findIndex(log => log.id === logId);
  if (logIndex === -1) return null;

  const log = data.medicationLogs[logIndex];
  log.status = status;

  if (status === 'TAKEN' && additionalData.takenAt) {
    log.taken_at = additionalData.takenAt;
  }

  if (additionalData.retryCount !== undefined) {
    log.retry_count = additionalData.retryCount;
  }

  if (additionalData.lastRemindedAt) {
    log.last_reminded_at = additionalData.lastRemindedAt;
  }

  data.medicationLogs[logIndex] = log;
  saveDatabase();
  return log;
}

/**
 * 取得當天的所有待提醒記錄
 */
function getPendingLogsForDate(date) {
  return data.medicationLogs
    .filter(log => log.date === date && (log.status === 'PENDING' || log.status === 'SNOOZED'))
    .map(log => {
      const schedule = data.schedules.find(s => s.id === log.schedule_id);
      const user = data.users.find(u => u.id === log.user_id);
      return {
        ...log,
        meal_type: schedule ? schedule.meal_type : '',
        default_time: schedule ? schedule.default_time : '',
        medicines: schedule ? schedule.medicines : '[]',
        is_second_dose: schedule ? schedule.is_second_dose : 0,
        linked_schedule_id: schedule ? schedule.linked_schedule_id : null,
        line_user_id: user ? user.line_user_id : ''
      };
    });
}

/**
 * 關閉數據庫連接
 */
function closeDatabase() {
  saveDatabase();
  console.log('✅ 數據已保存');
}

module.exports = {
  initDatabase,
  getDb
};
