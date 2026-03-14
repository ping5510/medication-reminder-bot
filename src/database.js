/**
/**
 * 吃藥提醒 LINE Bot - 數據存儲模組（PostgreSQL）
 */

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

// PostgreSQL 连接池
let pool = null;

/**
 * 初始化數據庫
 */
async function initDatabase() {
  const connectionString = process.env.DATABASE_URL;
  
  console.log('🔍 檢查環境變數...');
  console.log('   DATABASE_URL:', connectionString ? '已設定' : '未設定');
  
  if (!connectionString) {
    console.error('❌ DATABASE_URL 未設定！');
    console.error('   請在 Zeabur 環境變數中設定 DATABASE_URL');
    console.error('   格式: postgresql://user:password@host:port/database');
    throw new Error('DATABASE_URL 未設定');
  }
  
  pool = new Pool({
    connectionString: connectionString,
    ssl: {
      rejectUnauthorized: false
    }
  });
  
  // 測試連接
  try {
    const client = await pool.connect();
    console.log('✅ PostgreSQL 連接成功');
    client.release();
  } catch (error) {
    console.error('❌ PostgreSQL 連接失敗:', error.message);
    throw error;
  }
  
  // 創建表（如果不存在）
  await createTables();
  
  console.log('✅ 數據庫初始化完成');
  return getDb();
}

/**
 * 創建數據表
 */
async function createTables() {
  const usersTable = `
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      line_user_id VARCHAR(255) UNIQUE NOT NULL,
      display_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  
  const schedulesTable = `
    CREATE TABLE IF NOT EXISTS schedules (
      id UUID PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      meal_type VARCHAR(255) NOT NULL,
      default_time VARCHAR(10),
      medicines TEXT NOT NULL,
      is_second_dose INTEGER DEFAULT 0,
      linked_schedule_id UUID,
      link_delay_minutes INTEGER DEFAULT 60,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  
  const medicationLogsTable = `
    CREATE TABLE IF NOT EXISTS medication_logs (
      id UUID PRIMARY KEY,
      schedule_id UUID REFERENCES schedules(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      date VARCHAR(10) NOT NULL,
      status VARCHAR(20) DEFAULT 'PENDING',
      retry_count INTEGER DEFAULT 0,
      last_reminded_at TIMESTAMP,
      taken_at TIMESTAMP,
      chinese_medicine_triggered BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(schedule_id, date)
    );
  `;
  
  try {
    await pool.query(usersTable);
    await pool.query(schedulesTable);
    await pool.query(medicationLogsTable);
    console.log('✅ 數據表已創建/確認存在');
  } catch (error) {
    console.error('❌ 創建數據表失敗:', error.message);
    throw error;
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
async function createUser(lineUserId, displayName = null) {
  const existingUser = await getUserByLineId(lineUserId);
  if (existingUser) {
    return existingUser;
  }
  
  const id = uuidv4();
  const result = await pool.query(
    'INSERT INTO users (id, line_user_id, display_name) VALUES ($1, $2, $3) RETURNING *',
    [id, lineUserId, displayName]
  );
  return result.rows[0];
}

/**
 * 透過 LINE User ID 取得用戶
 */
async function getUserByLineId(lineUserId) {
  const result = await pool.query(
    'SELECT * FROM users WHERE line_user_id = $1',
    [lineUserId]
  );
  return result.rows[0] || null;
}

/**
 * 取得所有用戶
 */
async function getAllUsers() {
  const result = await pool.query('SELECT * FROM users');
  return result.rows;
}

/**
 * 建立排程
 */
async function createSchedule(userId, mealType, defaultTime, medicines, options = {}) {
  const id = uuidv4();
  const medicinesJson = JSON.stringify(medicines);
  
  const result = await pool.query(
    `INSERT INTO schedules (id, user_id, meal_type, default_time, medicines, is_second_dose, linked_schedule_id, link_delay_minutes) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [id, userId, mealType, defaultTime, medicinesJson, options.isSecondDose || 0, options.linkedScheduleId || null, options.linkDelayMinutes || 60]
  );
  return result.rows[0];
}

/**
 * 透過 ID 取得排程
 */
async function getScheduleById(scheduleId) {
  const result = await pool.query(
    'SELECT * FROM schedules WHERE id = $1',
    [scheduleId]
  );
  return result.rows[0] || null;
}

/**
 * 取得用戶的所有排程
 */
async function getSchedulesByUserId(userId) {
  const result = await pool.query(
    'SELECT * FROM schedules WHERE user_id = $1',
    [userId]
  );
  return result.rows;
}

/**
 * 建立服藥記錄
 */
async function createMedicationLog(scheduleId, userId, date) {
  // 檢查是否已存在
  const existing = await getMedicationLogByScheduleAndDate(scheduleId, date);
  if (existing) {
    return existing;
  }
  
  const id = uuidv4();
  const result = await pool.query(
    `INSERT INTO medication_logs (id, schedule_id, user_id, date) 
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, scheduleId, userId, date]
  );
  return result.rows[0];
}

/**
 * 透過 ID 取得服藥記錄
 */
async function getMedicationLogById(logId) {
  const result = await pool.query(
    'SELECT * FROM medication_logs WHERE id = $1',
    [logId]
  );
  return result.rows[0] || null;
}

/**
 * 透過排程 ID 和日期取得服藥記錄
 */
async function getMedicationLogByScheduleAndDate(scheduleId, date) {
  const result = await pool.query(
    'SELECT * FROM medication_logs WHERE schedule_id = $1 AND date = $2',
    [scheduleId, date]
  );
  return result.rows[0] || null;
}

/**
 * 更新服藥記錄狀態
 */
async function updateMedicationLogStatus(logId, status, additionalData = {}) {
  const updates = ['status = $1'];
  const values = [status];
  let paramIndex = 2;
  
  if (status === 'TAKEN' && additionalData.takenAt) {
    updates.push(`taken_at = $${paramIndex++}`);
    values.push(additionalData.takenAt);
  }
  
  if (additionalData.retryCount !== undefined) {
    updates.push(`retry_count = $${paramIndex++}`);
    values.push(additionalData.retryCount);
  }
  
  if (additionalData.lastRemindedAt) {
    updates.push(`last_reminded_at = $${paramIndex++}`);
    values.push(additionalData.lastRemindedAt);
  }
  
  if (additionalData.chineseMedicineTriggered !== undefined) {
    updates.push(`chinese_medicine_triggered = $${paramIndex++}`);
    values.push(additionalData.chineseMedicineTriggered);
  }
  
  values.push(logId);
  
  const result = await pool.query(
    `UPDATE medication_logs SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

/**
 * 取得當天的所有待提醒記錄
 */
async function getPendingLogsForDate(date) {
  const result = await pool.query(
    `SELECT ml.*, s.meal_type, s.default_time, s.medicines, s.is_second_dose, s.linked_schedule_id, u.line_user_id
     FROM medication_logs ml
     JOIN schedules s ON ml.schedule_id = s.id
     JOIN users u ON ml.user_id = u.id
     WHERE ml.date = $1 AND (ml.status = 'PENDING' OR ml.status = 'SNOOZED')`,
    [date]
  );
  
  return result.rows.map(row => ({
    ...row,
    is_second_dose: row.is_second_dose ? 1 : 0
  }));
}

/**
 * 關閉數據庫連接
 */
async function closeDatabase() {
  if (pool) {
    await pool.end();
    console.log('✅ PostgreSQL 連接已關閉');
  }
}

module.exports = {
  initDatabase,
  getDb
};
