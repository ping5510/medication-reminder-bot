/**
 * 吃藥提醒 LINE Bot - 數據存儲模組（PostgreSQL + JSON 回退）
 */

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// PostgreSQL 连接池
let pool = null;

// JSON 文件存储路径
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'medication.json');

// 内存缓存
let users = [];
let schedules = [];
let medicationLogs = [];

// 确保数据目录存在
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// 从文件加载数据
function loadFromFile() {
  ensureDataDir();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      users = data.users || [];
      schedules = data.schedules || [];
      medicationLogs = data.medicationLogs || [];
      console.log('✅ 從 JSON 文件載入數據:', users.length, '用戶');
    }
  } catch (error) {
    console.error('❌ 載入數據失敗:', error.message);
  }
}

// 保存数据到文件
function saveToFile() {
  ensureDataDir();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users, schedules, medicationLogs }, null, 2));
  } catch (error) {
    console.error('❌ 保存數據失敗:', error.message);
  }
}

/**
 * 初始化數據庫
 */
async function initDatabase() {
  // 優先嘗試 PostgreSQL
  let connectionString = process.env.DATABASE_URL;
  
  // 檢查 Zeabur 提供的 PostgreSQL 環境變數
  const postgresUri = process.env.POSTGRES_URI || process.env.POSTGRES_CONNECTION_STRING;
  const postgresHost = process.env.POSTGRES_HOST || process.env.POSTGRESQL_HOST;
  const postgresPort = process.env.POSTGRES_PORT || process.env.POSTGRESQL_PORT || '5432';
  const postgresDb = process.env.POSTGRES_DATABASE || 'zeabur';
  const postgresUser = process.env.POSTGRES_USERNAME || 'root';
  const postgresPassword = process.env.POSTGRES_PASSWORD;
  
  console.log('🔍 檢查數據庫連接...');
  
  // 構造連接字串
  if (!connectionString && postgresUri) {
    connectionString = postgresUri;
  } else if (!connectionString && postgresHost && postgresPassword) {
    connectionString = `postgresql://${postgresUser}:${postgresPassword}@${postgresHost}:${postgresPort}/${postgresDb}`;
  }
  
  // 嘗試 PostgreSQL 連接
  if (connectionString) {
    console.log('   連接字串:', connectionString.substring(0, 50) + '...');
    
    // 嘗試帶 SSL 的連接
    try {
      pool = new Pool({
        connectionString: connectionString,
        ssl: { rejectUnauthorized: false, require: true }
      });
      
      const client = await pool.connect();
      console.log('✅ PostgreSQL 連接成功 (SSL)');
      client.release();
      
      // 創建表
      await createTables();
      console.log('✅ 數據庫初始化完成');
      return getDb();
    } catch (error) {
      console.log('⚠️ SSL 連接失敗:', error.message);
      
      // 嘗試不使用 SSL
      try {
        pool = new Pool({
          connectionString: connectionString,
          ssl: false
        });
        
        const client = await pool.connect();
        console.log('✅ PostgreSQL 連接成功 (非SSL)');
        client.release();
        
        // 創建表
        await createTables();
        console.log('✅ 數據庫初始化完成');
        return getDb();
      } catch (error2) {
        console.log('⚠️ 非SSL 連接也失敗:', error2.message);
        console.log('⚠️ 回退到 JSON 文件存儲');
        pool = null;
      }
    }
  } else {
    console.log('⚠️ 沒有 PostgreSQL 連接字串');
  }
  
  // 回退到 JSON 文件存儲
  console.log('📁 使用 JSON 文件存儲');
  loadFromFile();
  
  return getDb();
}

/**
 * 創建數據表（PostgreSQL 用）
 */
async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      line_user_id VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedules (
      id UUID PRIMARY KEY,
      user_id UUID REFERENCES users(id),
      meal_type VARCHAR(50) NOT NULL,
      default_time TIME NOT NULL,
      medicines JSONB NOT NULL,
      is_second_dose INTEGER DEFAULT 0,
      linked_schedule_id UUID,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS medication_logs (
      id UUID PRIMARY KEY,
      user_id UUID REFERENCES users(id),
      schedule_id UUID REFERENCES schedules(id),
      date DATE NOT NULL,
      status VARCHAR(20) DEFAULT 'PENDING',
      taken_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  // 添加中藥觸發標記
  try {
    await pool.query(`ALTER TABLE medication_logs ADD COLUMN IF NOT EXISTS chinese_medicine_triggered BOOLEAN DEFAULT false`);
  } catch (e) {
    // 忽略列已存在的錯誤
  }
}

/**
 * 關閉數據庫連接
 */
async function closeDatabase() {
  if (pool) {
    await pool.end();
    console.log('✅ PostgreSQL 連接已關閉');
  }
  // 保存 JSON 數據
  saveToFile();
}

/**
 * 獲取數據庫操作函數
 */
function getDb() {
  return {
    // 用戶操作
    createUser: async (lineUserId, name) => {
      if (pool) {
        const id = uuidv4();
        await pool.query(
          'INSERT INTO users (id, line_user_id, name) VALUES ($1, $2, $3)',
          [id, lineUserId, name]
        );
        return { id, line_user_id: lineUserId, name };
      } else {
        const user = { id: uuidv4(), line_user_id: lineUserId, name, created_at: new Date().toISOString() };
        users.push(user);
        saveToFile();
        return user;
      }
    },
    
    getUserByLineId: async (lineUserId) => {
      if (pool) {
        const result = await pool.query('SELECT * FROM users WHERE line_user_id = $1', [lineUserId]);
        return result.rows[0] || null;
      } else {
        return users.find(u => u.line_user_id === lineUserId) || null;
      }
    },
    
    getAllUsers: async () => {
      if (pool) {
        const result = await pool.query('SELECT * FROM users');
        return result.rows;
      } else {
        return users;
      }
    },
    
    // 排程操作
    createSchedule: async (userId, scheduleData) => {
      if (pool) {
        const id = uuidv4();
        await pool.query(
          'INSERT INTO schedules (id, user_id, meal_type, default_time, medicines, is_second_dose, linked_schedule_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [id, userId, scheduleData.meal_type, scheduleData.default_time, JSON.stringify(scheduleData.medicines), scheduleData.is_second_dose || 0, scheduleData.linked_schedule_id || null]
        );
        return { id, user_id: userId, ...scheduleData };
      } else {
        const schedule = { id: uuidv4(), user_id: userId, ...scheduleData, created_at: new Date().toISOString() };
        schedules.push(schedule);
        saveToFile();
        return schedule;
      }
    },
    
    getSchedulesByUserId: async (userId) => {
      if (pool) {
        const result = await pool.query('SELECT * FROM schedules WHERE user_id = $1', [userId]);
        return result.rows.map(row => ({
          ...row,
          medicines: typeof row.medicines === 'string' ? JSON.parse(row.medicines) : row.medicines,
          is_second_dose: row.is_second_dose ? 1 : 0
        }));
      } else {
        return schedules.filter(s => s.user_id === userId);
      }
    },
    
    getScheduleById: async (scheduleId) => {
      if (pool) {
        const result = await pool.query('SELECT * FROM schedules WHERE id = $1', [scheduleId]);
        if (result.rows[0]) {
          return {
            ...result.rows[0],
            medicines: typeof result.rows[0].medicines === 'string' ? JSON.parse(result.rows[0].medicines) : result.rows[0].medicines,
            is_second_dose: result.rows[0].is_second_dose ? 1 : 0
          };
        }
        return null;
      } else {
        return schedules.find(s => s.id === scheduleId) || null;
      }
    },
    
    // 用藥記錄操作
    createMedicationLog: async (userId, scheduleId, date) => {
      if (pool) {
        const id = uuidv4();
        await pool.query(
          'INSERT INTO medication_logs (id, user_id, schedule_id, date, status) VALUES ($1, $2, $3, $4, $5)',
          [id, userId, scheduleId, date, 'PENDING']
        );
        return { id, user_id: userId, schedule_id: scheduleId, date, status: 'PENDING' };
      } else {
        const log = { id: uuidv4(), user_id: userId, schedule_id: scheduleId, date, status: 'PENDING', chinese_medicine_triggered: false, created_at: new Date().toISOString() };
        medicationLogs.push(log);
        saveToFile();
        return log;
      }
    },
    
    getMedicationLogByScheduleAndDate: async (scheduleId, date) => {
      if (pool) {
        const result = await pool.query(
          'SELECT * FROM medication_logs WHERE schedule_id = $1 AND date = $2',
          [scheduleId, date]
        );
        return result.rows[0] || null;
      } else {
        return medicationLogs.find(l => l.schedule_id === scheduleId && l.date === date) || null;
      }
    },
    
    updateMedicationLogStatus: async (logId, status, takenAt = null) => {
      if (pool) {
        await pool.query(
          'UPDATE medication_logs SET status = $1, taken_at = $2 WHERE id = $3',
          [status, takenAt, logId]
        );
      } else {
        const log = medicationLogs.find(l => l.id === logId);
        if (log) {
          log.status = status;
          log.taken_at = takenAt;
          saveToFile();
        }
      }
    },
    
    // 更新中藥觸發標記
    updateChineseMedicineTriggered: async (logId, triggered) => {
      if (pool) {
        await pool.query(
          'UPDATE medication_logs SET chinese_medicine_triggered = $1 WHERE id = $2',
          [triggered, logId]
        );
      } else {
        const log = medicationLogs.find(l => l.id === logId);
        if (log) {
          log.chinese_medicine_triggered = triggered;
          saveToFile();
        }
      }
    },
    
    getPendingLogsForDate: async (date) => {
      if (pool) {
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
      } else {
        return medicationLogs
          .filter(l => l.date === date && (l.status === 'PENDING' || l.status === 'SNOOZED'))
          .map(l => {
            const schedule = schedules.find(s => s.id === l.schedule_id);
            const user = users.find(u => u.id === l.user_id);
            return { ...l, ...schedule, line_user_id: user?.line_user_id };
          });
      }
    },
    
    closeDatabase
  };
}

module.exports = {
  initDatabase,
  getDb
};
