# Node.js 吃药提醒 Bot - 代码审查报告

**审查日期**: 2026-03-31  
**项目路径**: `C:\Users\chenp\.minimax-agent-cn\projects\4`  
**审查文件**: index.js, scheduler.js, lineBot.js, telegramBot.js, database.js, notifier.js

---

## 执行摘要

本次代码审查发现了多个严重程度不等的问题，包括1个致命错误（会导致运行时崩溃）、3个高优先级bug（可能导致重复发送提醒）、多个中等优先级的逻辑缺陷和安全问题，以及若干代码质量改进建议。系统整体架构合理，但在错误处理、竞态条件防护和中药提醒触发逻辑方面存在明显缺陷，需要进行系统性修复。

---

## 一、逻辑错误分析

### 1.1 致命错误：未定义变量 (CRITICAL)

**位置**: `src/scheduler.js` 第170行

```javascript
console.log(`   📊 間隔檢查: ${previousMealType} 在 ${previousTakenAt.toLocaleTimeString('zh-TW')}`);
console.log(`   📊 距離: ${intervalMinutes.toFixed(1)} 分鐘 (要求: ${requiredInterval} 分鐘)`);

if (intervalMinutes < requiredInterval) {
  return { 
    canSend: false, 
    reason: `${previousMealType} 間隔不足 ${requiredInterval} 分鐘（已過 ${intervalMinutes.toFixed(1)} 分鐘）`, 
    previousTakenAt 
  };
}
```

**问题描述**: 代码在第168行计算了 `intervalMinutes`，在第170-175行引用了 `requiredInterval` 变量，但该变量从未被声明或赋值。根据上下文推测，应该是 `INTERVAL_MINUTES`（第38行定义为120分钟），但这个变量也没有被正确使用。

**影响**: 当午餐或晚餐的间隔检查逻辑执行到这里时，会抛出 `ReferenceError: requiredInterval is not defined`，导致程序崩溃。

**建议修复**:
```javascript
// 将 INTERVAL_MINUTES 改为 requiredInterval
if (intervalMinutes < INTERVAL_MINUTES) {
  return { 
    canSend: false, 
    reason: `${previousMealType} 間隔不足 ${INTERVAL_MINUTES} 分鐘（已過 ${intervalMinutes.toFixed(1)} 分鐘）`, 
    previousTakenAt 
  };
}
```

---

### 1.2 高优先级：早餐中药提醒重复发送风险 (HIGH)

**问题描述**: 早餐中药提醒存在两条独立的触发路径，可能导致重复发送。

**路径一 - 用户点击"吃过"触发 (lineBot.js)**:
```javascript
// lineBot.js handleWebhookEvent 函数
if (schedule && schedule.meal_type === '早餐後（西藥）') {
  // 設置標記：中藥提醒已啟動
  updateMedicationLogStatus(log.id, 'TAKEN', {
    takenAt: now,
    retryCount: postback.retryCount,
    chineseMedicineTriggered: true  // 设置标记
  });
  
  // 發送中藥提醒（1小時後開始，每30分鐘一次）
  scheduleChineseMedicineReminder(bot, null, user, db, 1, 0);
}
```

**路径二 - Cron Job 固定时间触发 (scheduler.js)**:
```javascript
// scheduler.js 09:30 触发
cron.schedule('30 9 * * *', () => {
  sendChineseMedicineReminderBackup('早餐後（中藥）').catch(err => console.error('❌ 錯誤:', err));
});
```

**风险场景**: 如果用户在 08:00-09:30 之间点击了"吃过"西药，路径一会通过 `setTimeout` 在 1 小时后（09:00 左右）开始发送中药提醒。但 09:30 备份提醒仍然会执行，可能导致双重提醒。

**当前防护机制不足**: `sendChineseMedicineReminderBackup` 函数虽然检查了 `chineseLog.status === 'SNOOZED'` 或 `chineseLog.last_reminded_at`，但这个逻辑存在时序问题：用户点击"吃过"后，`scheduleChineseMedicineReminder` 是通过 `setTimeout` 在未来执行的，而不是立即执行。因此在 09:30 检查时，中药状态可能还是 `PENDING`，导致跳过检查仍然发送提醒。

**建议修复**: 在 `scheduleChineseMedicineReminder` 开始执行时立即设置一个标记，而不是等到发送后再设置：

```javascript
function scheduleChineseMedicineReminder(lineBot, telegramBot, user, db, delayHours = 1, reminderCount = 0) {
  const { getSchedulesByUserId, getMedicationLogByScheduleAndDate, updateMedicationLogStatus } = db;
  
  const delayMs = delayHours * 60 * 60 * 1000;
  
  console.log(`⏰ 設置中藥提醒，${delayHours}小時後發送 (次數: ${reminderCount})`);
  
  // 立即设置提醒已触发的标记，防止重复触发
  const setReminderTriggered = async () => {
    const today = new Date().toISOString().split('T')[0];
    const schedules = await getSchedulesByUserId(user.id);
    const chineseSchedule = schedules.find(s => s.meal_type === '早餐後（中藥）');
    if (chineseSchedule) {
      const log = await getMedicationLogByScheduleAndDate(chineseSchedule.id, today);
      if (log && log.status !== 'TAKEN') {
        await updateMedicationLogStatus(log.id, 'SNOOZED', {
          lastRemindedAt: new Date().toISOString()
        });
      }
    }
  };
  
  setTimeout(async () => {
    await setReminderTriggered(); // 先设置标记
    // ... 后续发送逻辑
  }, delayMs);
}
```

---

### 1.3 高优先级：餐次间隔检查逻辑不一致 (HIGH)

**位置**: `src/scheduler.js` checkMealInterval 函数

**问题描述**: 午餐和晚餐的间隔检查逻辑存在矛盾。

```javascript
// 午餐逻辑：固定时间，不等待
if (mealType === '午餐後') {
  return { canSend: true, reason: '固定時間發送', previousTakenAt: null };
}

// 晚餐逻辑：如果前一餐未服用则等待
if (mealType === '晚餐後') {
  previousMealType = '午餐後';
  // ... 但后面的逻辑又说午餐后可以发
}
```

实际上午餐的 Cron Job 设置为 13:00、13:30、14:00 三次，这与"固定时间"的说法存在逻辑不一致。如果早餐中药在 09:30 才开始（因为等待用户服用西药），那么午餐 13:00 发送时可能间隔不足 2 小时。

**建议**: 重新设计餐次间隔逻辑，明确各餐次之间的依赖关系和时间约束。

---

### 1.4 高优先级：未定义变量引用 (HIGH)

**位置**: `src/index.js` 第119行

```javascript
// 檢查是否為早餐西藥，啟動中藥提醒
if (schedule && schedule.meal_type === '早餐後（西藥）') {
  // 觸發中藥提醒（1小時後）
  const { triggerChineseMedicineReminder } = require('./lineBot');
  triggerChineseMedicineReminder(bot, telegramBot, user, dbOps);  // <-- user 未定义
  await sendTelegramText(chatId, '💡 提醒：1 小時後會發送中藥提醒，記得服用哦！');
}
```

**问题描述**: 变量 `user` 在回调函数内未定义。代码引用了 `dbOps.getScheduleById` 但没有获取用户对象。

**影响**: 当 Telegram 用户点击"吃过"早餐西药按钮时，会抛出 `ReferenceError: user is not defined` 错误。

**建议修复**:
```javascript
setCallbackHandler(async (chatId, action, scheduleId, retryCount) => {
  console.log(`📥 Telegram 回調: action=${action}, scheduleId=${scheduleId}, retryCount=${retryCount}`);
  
  const today = new Date().toISOString().split('T')[0];
  const log = await getMedicationLogByScheduleAndDate(scheduleId, today);
  
  if (!log) {
    await sendTelegramText(chatId, '⚠️ 找不到服藥記錄');
    return;
  }
  
  const schedule = await getScheduleById(scheduleId);
  
  // 获取用户对象（修复未定义变量问题）
  let user = await createOrGetTelegramUser(chatId.toString(), 'Telegram User');
  
  if (action === 'taken') {
    // ... 其余代码
  }
});
```

---

## 二、竞态条件分析

### 2.1 服务器重启导致定时器丢失 (MEDIUM)

**问题描述**: `scheduleChineseMedicineReminder` 使用 `setTimeout` 实现延迟提醒，但 Node.js 的 `setTimeout` 不会被持久化。当服务器重启时，所有待执行的定时提醒都会丢失。

**影响**: 用户在 08:00 点击"吃过"西药后，期望在 09:00 收到中药提醒。但如果在 09:00 之前服务器重启，09:00 的提醒将不会发送。

**当前缓解措施**: `scheduler.js` 中 09:30 有备份提醒 `sendChineseMedicineReminderBackup`，但如前所述，这个备份机制本身存在问题。

**建议改进**: 使用数据库持久化定时任务，而不是依赖内存中的 `setTimeout`：

```javascript
// 创建定时任务表
await pool.query(`
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    schedule_id UUID REFERENCES schedules(id),
    execute_at TIMESTAMP NOT NULL,
    task_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING',
    created_at TIMESTAMP DEFAULT NOW()
  )
`);

// 创建定时任务
async function scheduleTask(userId, scheduleId, executeAt, taskType) {
  await pool.query(
    'INSERT INTO scheduled_tasks (id, user_id, schedule_id, execute_at, task_type) VALUES ($1, $2, $3, $4, $5)',
    [uuidv4(), userId, scheduleId, executeAt, taskType]
  );
}

// 启动时恢复未执行的任务
async function recoverPendingTasks() {
  const now = new Date();
  const pendingTasks = await pool.query(
    'SELECT * FROM scheduled_tasks WHERE execute_at <= $1 AND status = PENDING',
    [now]
  );
  
  for (const task of pendingTasks.rows) {
    // 执行任务
    await executeTask(task);
    await pool.query(
      'UPDATE scheduled_tasks SET status = COMPLETED WHERE id = $1',
      [task.id]
    );
  }
}
```

---

### 2.2 异步回调与状态更新的时序问题 (MEDIUM)

**位置**: `src/lineBot.js` handleWebhookEvent

```javascript
if (postback.action === 'taken') {
  // ...
  if (schedule && schedule.meal_type === '早餐後（西藥）') {
    // 先更新状态
    updateMedicationLogStatus(log.id, 'TAKEN', {...});
    
    // 然后触发定时任务（异步）
    scheduleChineseMedicineReminder(bot, null, user, db, 1, 0);
    
    // 如果服务器在这之间崩溃，定时任务丢失
  }
}
```

**问题**: 如果 `scheduleChineseMedicineReminder` 中的数据库更新失败（或者在设置 `setTimeout` 之前服务器崩溃），中药提醒将永远不会发送，但用户已经点击了"吃过"。

**建议**: 将定时任务持久化到数据库后再响应用户。

---

## 三、变量作用域问题

### 3.1 回调函数内变量未声明 (HIGH)

已在 1.4 节详细描述 `user` 变量未定义问题。

### 3.2 createSchedule 参数解析混乱 (MEDIUM)

**位置**: `src/database.js` createSchedule 函数

```javascript
createSchedule: async (...args) => {
  // 兼容旧调用格式: (userId, mealType, defaultTime, medicines) 或 (userId, mealType, defaultTime, medicines, options)
  // 新格式: (userId, scheduleData)
  let userId, scheduleData;
  
  // 旧格式有 4 個或 5 個參數，第一個是 userId 字串
  if (typeof args[0] === 'string' && args[0].includes('-') && (args.length === 4 || args.length === 5)) {
    // 旧格式: (userId, mealType, defaultTime, medicines, options?)
    userId = args[0];
    scheduleData = {
      meal_type: args[1],
      default_time: args[2],
      medicines: args[3],
      is_second_dose: args[4]?.isSecondDose ? 1 : 0,
      linked_schedule_id: args[4]?.linkedScheduleId || null
    };
  } else {
    // 新格式: (userId, scheduleData)
    userId = args[0];
    scheduleData = args[1];
  }
```

**问题**: 这种兼容性解析方式脆弱且容易出错。判断 `args[0].includes('-')` 并不能可靠地区分 `userId`（UUID）和普通字符串。

**建议**: 统一调用格式，移除复杂的参数解析逻辑。

---

## 四、异步操作处理问题

### 4.1 同步调用缺少 await (MEDIUM)

**位置**: `src/index.js` setup-user 端点

```javascript
app.post('/setup-user', async (req, res) => {
  const { userId, displayName } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: '缺少 userId' });
  }
  
  const { createUser, getUserByLineId } = dbOps;
  let user = getUserByLineId(userId);  // <-- 缺少 await
  
  if (!user) {
    user = createUser(userId, displayName || userId);  // <-- 缺少 await
    console.log(`✅ 新用戶已建立: ${userId}`);
  }
  
  const { setupDefaultSchedules } = require('./lineBot');
  await setupDefaultSchedules(user.id);  // <-- 这里有 await，但前面的调用没有
```

**问题**: `getUserByLineId` 和 `createUser` 是异步函数（返回 Promise），但没有使用 `await`。这会导致 `user` 实际上是 Promise 对象而不是用户数据，后续操作会失败。

**建议修复**:
```javascript
const { createUser, getUserByLineId } = dbOps;
let user = await getUserByLineId(userId);  // 添加 await

if (!user) {
  user = await createUser(userId, displayName || userId);  // 添加 await
  console.log(`✅ 新用戶已建立: ${userId}`);
}
```

---

### 4.2 同样的问题出现在 user-status 端点

**位置**: `src/index.js` user-status 端点

```javascript
app.get('/user-status/:lineUserId', (req, res) => {  // <-- 缺少 async
  const { lineUserId } = req.params;
  const { getUserByLineId, getSchedulesByUserId, getMedicationLogByScheduleAndDate } = dbOps;
  
  const user = getUserByLineId(lineUserId);  // <-- 缺少 await
  
  if (!user) {  // <-- user 是 Promise，永远不会为 null
    return res.status(404).json({ error: '找不到用戶' });
  }
```

**建议修复**:
```javascript
app.get('/user-status/:lineUserId', async (req, res) => {  // 添加 async
  const { lineUserId } = req.params;
  const { getUserByLineId, getSchedulesByUserId, getMedicationLogByScheduleAndDate } = dbOps;
  
  const user = await getUserByLineId(lineUserId);  // 添加 await
```

---

### 4.3 setTimeout 内部异步操作缺乏错误处理 (MEDIUM)

**位置**: `src/lineBot.js` scheduleChineseMedicineReminder

```javascript
setTimeout(async () => {
  const today = new Date().toISOString().split('T')[0];
  const schedules = await getSchedulesByUserId(user.id);
  // ...
  // 如果这些数据库操作失败，没有任何错误处理
  // 会静默失败，用户不会收到提醒
}, delayMs);
```

**建议改进**: 在 setTimeout 回调中添加 try-catch 和重试机制。

---

## 五、错误处理评估

### 5.1 API 端点错误处理不一致 (MEDIUM)

**良好示例** (`/api/settings/:key`):
```javascript
try {
  const value = await dbOps.getSetting(key);
  if (value === null || value === undefined) {
    return res.status(404).json({ error: '設定不存在' });
  }
  res.json({ key, value: isSensitive ? value.substring(0, 10) + '***' : value, isSensitive });
} catch (error) {
  res.status(500).json({ error: error.message });
}
```

**问题示例** (`/trigger-reminder`):
```javascript
const { getScheduleById } = dbOps;
const schedule = getScheduleById(scheduleId);  // 缺少 await

if (!schedule) {  // 检查永远为 false
  return res.status(404).json({ error: '找不到排程' });
}
```

### 5.2 数据库操作缺少错误处理 (LOW)

多个数据库操作直接调用而没有 try-catch 包装：
```javascript
await pool.query('INSERT INTO schedules...');  // 如果失败会抛出未捕获的异常
```

**建议**: 为所有数据库操作添加错误处理。

---

## 六、代码质量和冗余问题

### 6.1 database.js 重复的 module.exports (LOW)

**位置**: `src/database.js` 结尾

```javascript
module.exports = {
  initDatabase,
  getDb
};

module.exports = {  // 重复声明
  initDatabase,
  getDb
};
```

**影响**: 第二个声明会覆盖第一个，但内容相同。这是冗余代码。

---

### 6.2 代码重复 - 提醒消息格式 (MEDIUM)

LINE 和 Telegram 的提醒消息格式几乎相同但分开实现：

**lineBot.js**:
```javascript
async function sendReminderMessage(bot, userId, scheduleInfo) {
  // 创建复杂的 Flex Message
}
```

**telegramBot.js**:
```javascript
async function sendReminderMessage(userId, scheduleInfo) {
  // 创建类似的 Inline Keyboard 消息
}
```

**建议**: 使用 `notifier.js` 中的统一适配器模式，或者创建一个共享的消息模板模块。

---

### 6.3 重复的 setTimeout 逻辑 (MEDIUM)

`lineBot.js` 和 `index.js` 中都有设置中药提醒的逻辑：

**lineBot.js**:
```javascript
scheduleChineseMedicineReminder(bot, null, user, db, 1, 0);
```

**index.js**:
```javascript
triggerChineseMedicineReminder(bot, telegramBot, user, dbOps);
```

虽然最终都调用 `scheduleChineseMedicineReminder`，但 `index.js` 中的 Telegram 回调处理也尝试触发这个函数，造成了逻辑混乱。

---

## 七、安全问题审查

### 7.1 API 端点缺少身份验证 (HIGH)

所有 API 端点都缺少身份验证：
- `/api/settings` - 可以读取和修改敏感配置
- `/api/telegram/init` - 可以重新初始化 Telegram Bot
- `/trigger-reminder` - 可以向任意用户发送提醒
- `/test-push` - 可以向任意用户推送消息
- `/setup-user` - 可以在服务器上创建用户和排程

**风险**: 任何人只要知道服务器地址，就可以修改配置、发送垃圾消息、耗尽 Bot 的 API 限额。

**建议**:
1. 添加 API 密钥验证
2. 使用 JWT 或 Session 进行身份验证
3. 限制敏感端点的访问 IP

```javascript
// 示例：添加简单的 API 密钥验证
const API_KEY = process.env.API_SECRET_KEY;

function requireAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/api/settings', requireAuth, async (req, res) => {
  // 处理请求
});
```

---

### 7.2 输入验证不足 (MEDIUM)

**trigger-reminder 端点**:
```javascript
app.post('/trigger-reminder', async (req, res) => {
  const { scheduleId, userId } = req.body;
  
  if (!scheduleId || !userId) {
    return res.status(400).json({ error: '缺少必要參數' });
  }
  
  // 没有验证 scheduleId 是否是有效的 UUID 格式
  // 没有验证 userId 是否属于当前系统的用户
  // 攻击者可以构造任意 scheduleId 和 userId
  
  const schedule = getScheduleById(scheduleId);
```

**建议**: 添加输入格式验证和业务逻辑验证。

---

### 7.3 SQL 注入风险 (LOW)

代码使用了参数化查询 `pool.query('SELECT * FROM users WHERE line_user_id = $1', [lineUserId])`，这部分是安全的。但 `schedule_medicationLog` 函数的参数解析逻辑可能存在问题。

---

### 7.4 敏感信息日志记录 (LOW)

```javascript
console.log(`📱 Telegram Token 已設定（來源：${await getSetting('TELEGRAM_BOT_TOKEN') ? '資料庫' : '環境變數'}）: ${token.substring(0, 10)}...`);
```

虽然只显示了 Token 的前 10 个字符，但在日志中记录 Token 仍然有风险。建议只记录 Token 的存在性，而不是部分内容：

```javascript
console.log(`📱 Telegram Token 已設定（來源：${await getSetting('TELEGRAM_BOT_TOKEN') ? '資料庫' : '環境變數'}）: ${token ? '已載入' : '未設定'}`);
```

---

## 八、改进建议汇总

### 8.1 高优先级改进（立即修复）

| 问题 | 位置 | 建议 |
|------|------|------|
| requiredInterval 未定义 | scheduler.js:170 | 改为 `INTERVAL_MINUTES` |
| user 变量未定义 | index.js:119 | 添加用户查询 |
| setup-user 缺少 await | index.js | 为 `getUserByLineId` 和 `createUser` 添加 await |
| user-status 缺少 async | index.js | 添加 async 关键字和 await |
| API 缺少认证 | 所有 /api/* 端点 | 添加 API 密钥验证 |
| 中药提醒重复发送 | scheduler.js + lineBot.js | 修复触发逻辑 |

### 8.2 中优先级改进

| 问题 | 位置 | 建议 |
|------|------|------|
| setTimeout 不可持久化 | lineBot.js | 改用数据库持久化定时任务 |
| createSchedule 参数混乱 | database.js | 统一调用格式 |
| 提醒消息格式重复 | lineBot.js + telegramBot.js | 提取为共享模块 |
| 缺少数据库事务 | 多个文件 | 为相关操作添加事务 |
| setTimeout 缺少错误处理 | lineBot.js | 添加 try-catch |

### 8.3 低优先级改进

| 问题 | 位置 | 建议 |
|------|------|------|
| module.exports 重复 | database.js | 删除重复声明 |
| 日志记录 Token | telegramBot.js | 改进日志格式 |
| 代码注释不一致 | 多个文件 | 统一注释风格 |

---

## 九、测试建议

建议在修复上述问题后，进行以下测试：

1. **早餐提醒完整流程测试**: 创建新用户 -> 设置排程 -> 模拟西药提醒 -> 点击"吃过" -> 等待 1 小时 -> 验证中药提醒只发送一次

2. **服务器重启测试**: 在 setTimeout 执行前重启服务器 -> 验证备份机制是否正常工作

3. **并发测试**: 多个用户同时点击"吃过" -> 验证没有竞态条件导致状态不一致

4. **API 安全测试**: 尝试不带 API 密钥访问敏感端点 -> 验证返回 401

---

## 十、结论

该项目的架构设计合理，功能模块划分清晰，但在错误处理、状态管理和安全性方面存在需要立即修复的问题。最紧迫的是 `requiredInterval` 未定义导致的运行时崩溃风险，以及 `user` 变量未定义导致的 Telegram 回调处理失败。建议团队按照本报告的优先级顺序进行修复，并在修复后进行系统性的回归测试。

---

**报告生成**: Matrix Agent  
**审查方法**: 静态代码分析 + 逻辑流程追踪
