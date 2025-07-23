const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { Octokit } = require('@octokit/rest');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;

// 中间件配置
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // 添加静态文件服务

// 飞书API配置
const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const FEISHU_APP_TOKEN = process.env.FEISHU_APP_TOKEN;
const FEISHU_TABLE_ID = process.env.FEISHU_TABLE_ID;

// GitHub配置
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO_OWNER = process.env.GITHUB_REPO_OWNER;
const GITHUB_REPO_NAME = process.env.GITHUB_REPO_NAME;

const octokit = new Octokit({
  auth: GITHUB_TOKEN,
});

let accessToken = null;
let tokenExpiry = 0;

// 获取飞书访问令牌
async function getFeishuAccessToken() {
  try {
    if (accessToken && Date.now() < tokenExpiry) {
      return accessToken;
    }

    console.log('🔑 获取飞书访问令牌...');
    
    // 检查必要的环境变量
    if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
      throw new Error('飞书API配置不完整：缺少APP_ID或APP_SECRET');
    }

    const response = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET
    }, {
      timeout: 10000 // 10秒超时
    });

    if (response.data.code === 0) {
      accessToken = response.data.tenant_access_token;
      tokenExpiry = Date.now() + (response.data.expire - 300) * 1000; // 提前5分钟刷新
      console.log('✅ 飞书访问令牌获取成功');
      return accessToken;
    } else {
      throw new Error(`获取访问令牌失败 (code: ${response.data.code}): ${response.data.msg}`);
    }
  } catch (error) {
    if (error.response) {
      console.error('❌ 飞书API响应错误:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      });
      throw new Error(`飞书API错误 ${error.response.status}: ${error.response.statusText}`);
    } else if (error.request) {
      console.error('❌ 飞书API网络错误:', error.message);
      throw new Error(`网络连接失败: ${error.message}`);
    } else {
      console.error('❌ 获取飞书访问令牌失败:', error.message);
      throw error;
    }
  }
}

// 获取今天的日期字符串 (YYYY/MM/DD 格式)
function getTodayDateString() {
  // 使用Jakarta时区获取当前日期
  const today = new Date();
  const jakartaDate = new Date(today.toLocaleString("en-US", {timeZone: "Asia/Jakarta"}));
  const year = jakartaDate.getFullYear();
  const month = String(jakartaDate.getMonth() + 1).padStart(2, '0');
  const day = String(jakartaDate.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

// 从飞书多维表格获取数据
async function getFeishuData() {
  try {
    const token = await getFeishuAccessToken();
    const todayDate = getTodayDateString();
    
    console.log(`📅 获取今天的送货数据: ${todayDate}`);
    
    // 获取所有记录
    let allRecords = [];
    let hasMore = true;
    let pageToken = null;

    while (hasMore) {
      const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records`;
      const params = {
        page_size: 500
      };
      
      if (pageToken) {
        params.page_token = pageToken;
      }

      console.log('🔍 正在获取飞书数据...');
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        params,
        timeout: 15000 // 15秒超时
      });

      if (response.data.code === 0) {
        const records = response.data.data.items || [];
        allRecords = allRecords.concat(records);
        
        hasMore = response.data.data.has_more;
        pageToken = response.data.data.page_token;
        
        console.log(`📦 已获取 ${records.length} 条记录`);
      } else {
        console.error('❌ 飞书数据API错误:', {
          code: response.data.code,
          msg: response.data.msg,
          url: url
        });
        throw new Error(`获取数据失败 (code: ${response.data.code}): ${response.data.msg}`);
      }
    }

    console.log(`📊 总共获取 ${allRecords.length} 条记录`);

    // 添加调试：输出第一条记录的所有字段名
    if (allRecords.length > 0) {
      console.log('📋 飞书表格字段列表:', Object.keys(allRecords[0].fields));
    }

    // 过滤符合条件的数据：Outlet Status为Active且Tanggal Turun Freezer不为空
    const filteredRecords = allRecords.filter(record => {
      const outletStatus = getFieldText(record.fields['Outlet Status']);
      const tanggalTurunFreezer = getFieldText(record.fields['Tanggal Turun Freezer']);
      
      // 检查Outlet Status是否为Active
      if (outletStatus !== 'Active') {
        console.log(`⚠️ 跳过非Active状态的记录: ${record.fields['Outlet Code'] || 'Unknown'} - 状态: ${outletStatus}`);
        return false;
      }
      
      // 检查Tanggal Turun Freezer是否不为空
      if (!tanggalTurunFreezer || tanggalTurunFreezer.trim() === '') {
        console.log(`⚠️ 跳过没有冰柜投放日期的记录: ${record.fields['Outlet Code'] || 'Unknown'}`);
        return false;
      }
      
      console.log(`✅ 符合条件的记录: ${record.fields['Outlet Code']} - 状态: ${outletStatus}, 冰柜日期: ${tanggalTurunFreezer}`);
      return true;
    });
    
    // 辅助函数：提取飞书字段的文本值
    function getFieldText(field) {
      if (!field) return '';
      if (Array.isArray(field) && field.length > 0 && field[0].text) {
        return field[0].text;
      }
      if (typeof field === 'string') return field;
      if (typeof field === 'number') return field.toString();
      return '';
    }
    
    // 辅助函数：提取电话号码
    function getPhoneNumber(field) {
      if (!field) return '';
      if (Array.isArray(field) && field.length > 0 && field[0].fullPhoneNum) {
        return field[0].fullPhoneNum;
      }
      return getFieldText(field);
    }

    console.log(`🎯 筛选出符合条件的记录: ${filteredRecords.length} 条`);

    // 转换为CSV格式的数据
    const csvData = filteredRecords.map(record => {
      const fields = record.fields;
      
      // 提取新的字段结构 - 匹配新的数据格式
      const outletCode = getFieldText(fields['Outlet Code']);
      const namaPemilik = getFieldText(fields['Nama Pemilik']);
      const mingguIniServiceBy = getFieldText(fields['Minggu ini Service by']);
      const tanggalTurunFreezer = getFieldText(fields['Tanggal Turun Freezer']);
      const noTeleponPemilik = getPhoneNumber(fields['No Telepon Pemilik']);
      const visit = getFieldText(fields['Visit']);
      const po = getFieldText(fields['PO']);
      const buangEs = getFieldText(fields['BuangEs']);
      const outletStatus = getFieldText(fields['Outlet Status']);
      const longitude = parseFloat(getFieldText(fields['longitude']));
      const latitude = parseFloat(getFieldText(fields['latitude']));
      
      // 🔍 详细调试"minggu ini service by"字段
      console.log(`\n🔍 === 记录详情分析: ${outletCode} ===`);
      console.log(`📋 原始字段数据:`, JSON.stringify(fields['Minggu ini Service by'], null, 2));
      console.log(`🎯 处理后的值: "${mingguIniServiceBy}"`);
      console.log(`📏 字符串长度: ${mingguIniServiceBy.length}`);
      console.log(`🔤 字符串类型: ${typeof mingguIniServiceBy}`);
      
      // 检查是否为空或只包含空白字符
      if (!mingguIniServiceBy || mingguIniServiceBy.trim() === '') {
        console.log(`⚠️ 警告: "minggu ini service by"字段为空!`);
        console.log(`🔍 检查其他可能的字段名:`);
        const possibleFields = ['PIC', 'Service by', 'Minggu Service by', 'Service Person', 'Petugas'];
        possibleFields.forEach(fieldName => {
          if (fields[fieldName]) {
            console.log(`  - 找到字段 "${fieldName}": ${JSON.stringify(fields[fieldName])}`);
          }
        });
      } else {
        console.log(`✅ "minggu ini service by"字段有值: "${mingguIniServiceBy}"`);
      }
      
      // 详细调试输出
      console.log(`  - 经纬度: lat=${latitude}, lng=${longitude}`);
      console.log(`  - 店主: ${namaPemilik}, 服务人员: ${mingguIniServiceBy}`);
      console.log(`  - 电话: ${noTeleponPemilik}, 状态: ${outletStatus}`);
      console.log(`  - 冰柜日期: ${tanggalTurunFreezer}, 访问: ${visit}`);
      console.log(`  - PO: ${po}, 倒冰: ${buangEs}`);
      console.log(`=== 记录分析结束 ===\n`);
      
      // 如果经纬度无效，跳过此记录
      if (isNaN(latitude) || isNaN(longitude) || latitude === 0 || longitude === 0) {
        console.log(`⚠️ 跳过无效坐标的记录: ${outletCode}`);
        return null;
      }

      return {
        outletCode: outletCode || '',
        namaPemilik: namaPemilik || '',
        mingguIniServiceBy: mingguIniServiceBy || '',
        tanggalTurunFreezer: tanggalTurunFreezer || '',
        latitude: latitude,
        longitude: longitude,
        noTeleponPemilik: noTeleponPemilik || '',
        visit: visit || '',
        po: po || '',
        buangEs: buangEs || '',
        outletStatus: outletStatus || ''
      };
    }).filter(record => record !== null); // 过滤掉无效记录

    console.log(`✅ 有效的送货地点: ${csvData.length} 个`);
    return csvData;

  } catch (error) {
    console.error('❌ 获取飞书数据失败:', error.message);
    
    // 输出详细的错误信息
    if (error.response) {
      console.error('📄 错误状态码:', error.response.status);
      console.error('📄 错误响应头:', JSON.stringify(error.response.headers, null, 2));
      console.error('📄 错误响应数据:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('📄 请求错误:', error.request);
    } else {
      console.error('📄 其他错误:', error.message);
    }
    
    throw error;
  }
}

// 生成CSV内容 - 更新为新的数据格式
function generateCSV(data) {
  const headers = 'Outlet Code,Nama Pemilik,Minggu ini Service by,Tanggal Turun Freezer,latitude,longitude,No Telepon Pemilik,Visit,PO,BuangEs,Outlet Status';
  const rows = data.map(item => {
    return `"${item.outletCode}","${item.namaPemilik}","${item.mingguIniServiceBy}","${item.tanggalTurunFreezer}",${item.latitude},${item.longitude},"${item.noTeleponPemilik}","${item.visit}","${item.po}","${item.buangEs}","${item.outletStatus}"`;
  });
  return [headers, ...rows].join('\n');
}


// 更新GitHub仓库中的CSV文件
async function updateGitHubCSV(csvContent) {
  try {
    console.log('📤 更新GitHub仓库中的CSV文件...');
    
    // 检查必要的环境变量
    if (!GITHUB_TOKEN || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME) {
      throw new Error('GitHub配置不完整：缺少TOKEN、REPO_OWNER或REPO_NAME');
    }
    
    // 获取当前文件内容以获取SHA
    let sha = null;
    try {
      const { data: currentFile } = await octokit.rest.repos.getContent({
        owner: GITHUB_REPO_OWNER,
        repo: GITHUB_REPO_NAME,
        path: 'public/markers.csv',
      });
      sha = currentFile.sha;
    } catch (error) {
      if (error.status === 404) {
        console.log('📝 文件不存在，将创建新文件');
      } else {
        console.warn('⚠️ 获取文件SHA失败:', error.message);
      }
    }

    const today = getTodayDateString();
    const message = `🚚 更新送货数据 - ${today}`;

    // 更新或创建文件
    const updateResult = await octokit.rest.repos.createOrUpdateFileContents({
      owner: GITHUB_REPO_OWNER,
      repo: GITHUB_REPO_NAME,
      path: 'public/markers.csv',
      message: message,
      content: Buffer.from(csvContent).toString('base64'),
      sha: sha, // 如果文件存在则提供SHA，不存在则为null
    });

    console.log('✅ GitHub CSV文件更新成功');
    console.log(`📄 文件大小: ${csvContent.length} 字符`);
    return updateResult;
  } catch (error) {
    if (error.status === 403) {
      console.error('❌ GitHub API权限错误 (403):', {
        message: error.message,
        documentation_url: error.response?.data?.documentation_url,
        repo: `${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`
      });
      throw new Error(`GitHub权限不足：请检查Personal Access Token权限`);
    } else if (error.status === 401) {
      console.error('❌ GitHub API认证错误 (401):', error.message);
      throw new Error(`GitHub认证失败：请检查Personal Access Token是否有效`);
    } else if (error.status === 404) {
      console.error('❌ GitHub仓库不存在 (404):', `${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`);
      throw new Error(`GitHub仓库不存在或无权访问：${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`);
    } else {
      console.error('❌ 更新GitHub CSV文件失败:', {
        status: error.status,
        message: error.message,
        response: error.response?.data
      });
      throw new Error(`GitHub API错误 ${error.status || 'unknown'}: ${error.message}`);
    }
  }
}

// 执行同步任务
async function syncData() {
  try {
    console.log('\n🚀 开始执行飞书数据同步任务...');
    console.log(`⏰ 同步时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Jakarta' })}`);
    
    // 获取飞书数据
    const data = await getFeishuData();
    
    // 生成CSV内容
    const csvContent = generateCSV(data);
    
    if (data.length === 0) {
      console.log('📝 今天没有送货数据，清空地图标记');
    } else {
      console.log(`✅ 有效的送货地点: ${data.length} 个`);
    }
    
    // 更新GitHub仓库
    await updateGitHubCSV(csvContent);
    
    console.log('🎉 数据同步完成！');
    console.log('=' .repeat(60));
    
  } catch (error) {
    console.error('❌ 数据同步失败:', error.message);
    console.log('=' .repeat(60));
  }
}

// 健康检查端点
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        timezone: 'Asia/Jakarta',
        version: '3.0.0', // 简化版本
        features: ['data_sync', 'feishu_integration'] // 简化功能列表
    });
});

// 调试端点 - 查看飞书原始数据
app.get('/debug/feishu-raw', async (req, res) => {
  try {
    const token = await getFeishuAccessToken();
    
    // 直接获取飞书原始数据
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records`;
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      params: {
        page_size: 3  // 只获取3条记录用于调试
      },
      timeout: 15000
    });
    
    if (response.data.code === 0) {
      const records = response.data.data.items || [];
      
      // 分析前3条记录的原始结构
      const sampleRecords = records.map(record => ({
        recordId: record.record_id,
        outletCode: record.fields['Outlet Code'],
        tanggalKirimAmbil: record.fields['Tanggal Kirim/Ambil'],
        tanggalType: typeof record.fields['Tanggal Kirim/Ambil'],
        tanggalValue: record.fields['Tanggal Kirim/Ambil'],
        allFieldNames: Object.keys(record.fields),
        hasDateField: 'Tanggal Kirim/Ambil' in record.fields
      }));
      
      res.json({
        message: "飞书原始记录结构",
        totalRecords: records.length,
        sampleRecords: sampleRecords,
        todayDate: getTodayDateString(),
        explanation: "检查 tanggalValue 和 tanggalType 来了解时间戳格式"
      });
    } else {
      res.status(500).json({ error: `飞书API错误: ${response.data.msg}` });
    }
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// 调试端点 - 查看时间戳转换
app.get('/debug/timezone', async (req, res) => {
  try {
    const now = new Date();
    const utcTime = now.toISOString();
    const jakartaTime = now.toLocaleString("en-US", {timeZone: "Asia/Jakarta"});
    const jakartaDateObj = new Date(jakartaTime);
    const jakartaDateString = `${jakartaDateObj.getFullYear()}/${String(jakartaDateObj.getMonth() + 1).padStart(2, '0')}/${String(jakartaDateObj.getDate()).padStart(2, '0')}`;
    
    // 测试当前的转换逻辑
    const todayDate = getTodayDateString();
    
    res.json({
      currentTime: {
        utc: utcTime,
        jakarta: jakartaTime,
        jakartaDateObj: jakartaDateObj.toISOString(),
        jakartaDateString: jakartaDateString,
        todayDate: todayDate
      },
      note: "查看 /debug/feishu-raw 来看飞书实际返回的时间戳"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 手动同步端点
app.post('/sync', async (req, res) => {
  try {
    await syncData();
    res.json({ success: true, message: '数据同步完成' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 调试字段结构端点
app.post('/debug-fields', async (req, res) => {
  try {
    const token = await getFeishuAccessToken();
    const todayDate = getTodayDateString();
    
    console.log(`📅 调试今天的字段结构: ${todayDate}`);
    
    // 获取前10条记录
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records`;
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      params: { page_size: 100 }
    });

    if (response.data.code === 0) {
      const records = response.data.data.items || [];
      
      // 过滤今天的记录
      const todayRecords = records.filter(record => {
        const tanggalKirim = record.fields['Tanggal Kirim/Ambil'] || record.fields['Tanggal Kirim EsKrim'];
        if (!tanggalKirim) return false;
        
        let recordDate = new Date(tanggalKirim);
        if (typeof tanggalKirim === 'number') {
          const jakartaDateString = recordDate.toLocaleDateString("en-CA", {timeZone: "Asia/Jakarta"});
          recordDate = new Date(jakartaDateString);
        }
        
        const recordDateString = `${recordDate.getFullYear()}/${String(recordDate.getMonth() + 1).padStart(2, '0')}/${String(recordDate.getDate()).padStart(2, '0')}`;
        return recordDateString === todayDate;
      });

      console.log(`找到 ${todayRecords.length} 条今天的记录`);
      
      // 显示字段结构
      const fieldInfo = todayRecords.map((record, index) => {
        const fields = record.fields;
        return {
          recordIndex: index + 1,
          outletCode: fields['Outlet Code'],
          allFieldNames: Object.keys(fields),
          latitudeField: {
            value: fields['latitude'],
            type: typeof fields['latitude']
          },
          longitudeField: {
            value: fields['longitude'], 
            type: typeof fields['longitude']
          },
          // 检查可能的其他坐标字段名
          possibleLatFields: Object.keys(fields).filter(key => 
            key.toLowerCase().includes('lat') || 
            key.toLowerCase().includes('纬度')
          ),
          possibleLngFields: Object.keys(fields).filter(key => 
            key.toLowerCase().includes('lng') || 
            key.toLowerCase().includes('long') ||
            key.toLowerCase().includes('经度')
          )
        };
      });
      
      res.json({
        success: true,
        todayDate: todayDate,
        recordCount: todayRecords.length,
        fieldInfo: fieldInfo
      });
    } else {
      throw new Error(`获取数据失败: ${response.data.msg}`);
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 调试同步端点 - 返回详细的执行过程
app.post('/debug-sync', async (req, res) => {
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  
  // 捕获所有日志输出
  console.log = (...args) => {
    const message = args.join(' ');
    logs.push({ type: 'info', message, timestamp: new Date().toISOString() });
    originalLog(...args);
  };
  
  console.error = (...args) => {
    const message = args.join(' ');
    logs.push({ type: 'error', message, timestamp: new Date().toISOString() });
    originalError(...args);
  };
  
  try {
    // 检查环境变量
    logs.push({ 
      type: 'info', 
      message: `环境变量检查: FEISHU_APP_ID=${FEISHU_APP_ID ? '已设置' : '未设置'}`, 
      timestamp: new Date().toISOString() 
    });
    logs.push({ 
      type: 'info', 
      message: `环境变量检查: FEISHU_APP_SECRET=${FEISHU_APP_SECRET ? '已设置' : '未设置'}`, 
      timestamp: new Date().toISOString() 
    });
    logs.push({ 
      type: 'info', 
      message: `环境变量检查: FEISHU_APP_TOKEN=${FEISHU_APP_TOKEN ? '已设置' : '未设置'}`, 
      timestamp: new Date().toISOString() 
    });
    logs.push({ 
      type: 'info', 
      message: `环境变量检查: FEISHU_TABLE_ID=${FEISHU_TABLE_ID ? '已设置' : '未设置'}`, 
      timestamp: new Date().toISOString() 
    });
    logs.push({ 
      type: 'info', 
      message: `环境变量检查: GITHUB_TOKEN=${GITHUB_TOKEN ? '已设置' : '未设置'}`, 
      timestamp: new Date().toISOString() 
    });
    
    await syncData();
    
    // 恢复原始的日志函数
    console.log = originalLog;
    console.error = originalError;
    
    res.json({ 
      success: true, 
      message: '调试同步完成',
      logs: logs
    });
  } catch (error) {
    // 恢复原始的日志函数
    console.log = originalLog;
    console.error = originalError;
    
    logs.push({ 
      type: 'error', 
      message: `同步失败: ${error.message}`, 
      timestamp: new Date().toISOString() 
    });
    
    res.status(500).json({ 
      success: false, 
      error: error.message,
      logs: logs
    });
  }
});

// 显示所有字段名称的调试端点
app.get('/debug-all-fields', async (req, res) => {
  try {
    const token = await getFeishuAccessToken();
    
    console.log('🔍 获取字段列表...');
    
    // 获取第一页数据来查看字段结构
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records`;
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      params: {
        page_size: 10 // 获取10条记录用于调试
      },
      timeout: 15000
    });

    if (response.data.code === 0) {
      const records = response.data.data.items || [];
      
      // 辅助函数：提取飞书字段的文本值
      function getFieldText(field) {
        if (!field) return '';
        if (Array.isArray(field) && field.length > 0 && field[0].text) {
          return field[0].text;
        }
        if (typeof field === 'string') return field;
        if (typeof field === 'number') return field.toString();
        return '';
      }
      
      const debugInfo = {
        total_records: records.length,
        api_response_structure: {
          code: response.data.code,
          msg: response.data.msg,
          has_more: response.data.data.has_more
        },
        field_analysis: records.map((record, index) => {
          const fields = record.fields;
          const mingguIniServiceByRaw = fields['Minggu ini Service by'];
          const mingguIniServiceByProcessed = getFieldText(mingguIniServiceByRaw);
          
          return {
            record_index: index,
            outlet_code: getFieldText(fields['Outlet Code']),
            record_id: record.record_id,
            all_available_fields: Object.keys(fields).sort(),
            minggu_ini_service_by_analysis: {
              field_exists: 'Minggu ini Service by' in fields,
              raw_data: mingguIniServiceByRaw,
              raw_data_type: typeof mingguIniServiceByRaw,
              processed_value: mingguIniServiceByProcessed,
              processed_length: mingguIniServiceByProcessed.length,
              is_empty: !mingguIniServiceByProcessed || mingguIniServiceByProcessed.trim() === ''
            },
            alternative_service_fields: {
              'PIC': {
                exists: 'PIC' in fields,
                raw: fields['PIC'],
                processed: getFieldText(fields['PIC'])
              },
              'Service by': {
                exists: 'Service by' in fields,
                raw: fields['Service by'],
                processed: getFieldText(fields['Service by'])
              },
              'Minggu Service by': {
                exists: 'Minggu Service by' in fields,
                raw: fields['Minggu Service by'],
                processed: getFieldText(fields['Minggu Service by'])
              },
              'Service Person': {
                exists: 'Service Person' in fields,
                raw: fields['Service Person'],
                processed: getFieldText(fields['Service Person'])
              },
              'Petugas': {
                exists: 'Petugas' in fields,
                raw: fields['Petugas'],
                processed: getFieldText(fields['Petugas'])
              }
            },
            sample_other_fields: {
              'Nama Pemilik': getFieldText(fields['Nama Pemilik']),
              'Outlet Status': getFieldText(fields['Outlet Status']),
              'Tanggal Turun Freezer': getFieldText(fields['Tanggal Turun Freezer'])
            }
          };
        })
      };
      
      // 在服务器日志中也输出详细信息
      console.log('\n🔍 === DEBUG ALL FIELDS 调试信息 ===');
      console.log('📊 总记录数:', debugInfo.total_records);
      console.log('📋 所有可用字段:', debugInfo.field_analysis[0]?.all_available_fields || []);
      
      debugInfo.field_analysis.forEach((record, index) => {
        console.log(`\n📝 记录 ${index + 1} (${record.outlet_code}):`);
        console.log('  🎯 Minggu ini Service by 分析:');
        console.log('    - 字段存在:', record.minggu_ini_service_by_analysis.field_exists);
        console.log('    - 原始数据:', JSON.stringify(record.minggu_ini_service_by_analysis.raw_data));
        console.log('    - 处理后值:', `"${record.minggu_ini_service_by_analysis.processed_value}"`);
        console.log('    - 是否为空:', record.minggu_ini_service_by_analysis.is_empty);
        
        console.log('  🔍 替代字段检查:');
        Object.entries(record.alternative_service_fields).forEach(([fieldName, fieldInfo]) => {
          if (fieldInfo.exists && fieldInfo.processed) {
            console.log(`    - ${fieldName}: "${fieldInfo.processed}"`);
          }
        });
      });
      console.log('=== DEBUG 结束 ===\n');
      
      res.json(debugInfo);
    } else {
      res.status(500).json({ error: `飞书API错误: ${response.data.msg}` });
    }
  } catch (error) {
    console.error('❌ 获取字段列表失败:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取订单统计API（简化版本）
app.get('/api/order-status', async (req, res) => {
  try {
    console.log('📊 获取订单统计...');
    
    // 获取今天的飞书数据
    const allOrders = await getFeishuData();
    
    const totalDUS = allOrders.reduce((sum, order) => sum + (parseInt(order.totalDUS) || 0), 0);

    res.json({
      success: true,
      date: getTodayDateString(),
      total_orders: allOrders.length,
      total_dus: totalDUS,
      last_update: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ 获取订单统计失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 环境变量配置信息
// 提供CSV数据的API端点
app.get('/api/csv-data', async (req, res) => {
  try {
    // 获取最新的飞书数据
    const data = await getFeishuData();
    const csvContent = generateCSV(data);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(csvContent);
  } catch (error) {
    console.error('获取CSV数据失败:', error);
    
    // 返回空的CSV（只有表头）- 使用正确的格式
    const emptyCSV = 'Outlet Code,Nama Pemilik,Minggu ini Service by,Tanggal Turun Freezer,latitude,longitude,No Telepon Pemilik,Visit,PO,BuangEs,Outlet Status';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(emptyCSV);
  }
});

app.get('/api/config-status', (req, res) => {
  res.json({
    feishu_configured: !!(FEISHU_APP_ID && FEISHU_APP_SECRET && FEISHU_APP_TOKEN && FEISHU_TABLE_ID),
    feishu_details: {
      app_id_set: !!FEISHU_APP_ID,
      app_secret_set: !!FEISHU_APP_SECRET,
      app_token_set: !!FEISHU_APP_TOKEN,
      table_id_set: !!FEISHU_TABLE_ID
    },
    github_configured: !!(GITHUB_TOKEN && GITHUB_REPO_OWNER && GITHUB_REPO_NAME),
    github_details: {
      token_set: !!GITHUB_TOKEN,
      repo_owner_set: !!GITHUB_REPO_OWNER,
      repo_name_set: !!GITHUB_REPO_NAME,
      repo_path: GITHUB_REPO_OWNER && GITHUB_REPO_NAME ? `${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}` : 'not_configured'
    },
    environment: process.env.NODE_ENV || 'development',
    node_version: process.version,
    timestamp: new Date().toISOString()
  });
});

// 连接测试端点
app.post('/api/test-connections', async (req, res) => {
  const results = {
    feishu: { status: 'not_tested', message: '', details: null },
    github: { status: 'not_tested', message: '', details: null }
  };

  // 测试飞书API连接
  try {
    if (FEISHU_APP_ID && FEISHU_APP_SECRET) {
      console.log('🧪 测试飞书API连接...');
      const token = await getFeishuAccessToken();
      results.feishu = {
        status: 'success',
        message: '飞书API连接成功',
        details: { token_obtained: !!token }
      };
    } else {
      results.feishu = {
        status: 'failed',
        message: '飞书API配置不完整',
        details: null
      };
    }
  } catch (error) {
    results.feishu = {
      status: 'failed',
      message: error.message,
      details: { error_type: error.constructor.name }
    };
  }

  // 测试GitHub API连接
  try {
    if (GITHUB_TOKEN && GITHUB_REPO_OWNER && GITHUB_REPO_NAME) {
      console.log('🧪 测试GitHub API连接...');
      const { data: repo } = await octokit.rest.repos.get({
        owner: GITHUB_REPO_OWNER,
        repo: GITHUB_REPO_NAME
      });
      results.github = {
        status: 'success',
        message: 'GitHub API连接成功',
        details: { 
          repo_accessible: true,
          repo_name: repo.full_name,
          permissions: repo.permissions
        }
      };
    } else {
      results.github = {
        status: 'failed',
        message: 'GitHub API配置不完整',
        details: null
      };
    }
  } catch (error) {
    results.github = {
      status: 'failed',
      message: `GitHub API错误 ${error.status || 'unknown'}: ${error.message}`,
      details: { 
        error_type: error.constructor.name,
        status_code: error.status
      }
    };
  }

  res.json({
    success: true,
    test_results: results,
    summary: {
      total_tests: Object.keys(results).length,
      passed: Object.values(results).filter(r => r.status === 'success').length,
      failed: Object.values(results).filter(r => r.status === 'failed').length,
      skipped: Object.values(results).filter(r => r.status === 'skipped').length
    },
    timestamp: new Date().toISOString()
  });
});

// 服务信息端点
app.get('/', (req, res) => {
  const now = new Date();
  const jakartaTime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Jakarta' });
  
  res.json({
    service: '印尼送货数据同步服务',
    version: '3.0.0',
    description: '简化版数据展示系统',
    status: 'running',
    currentTime: jakartaTime,
    timezone: 'Asia/Jakarta (UTC+7)',
    schedule: '每日 09:00 和 14:00 自动同步',
    lastSync: '查看日志了解详情',
    features: {
      data_sync: '飞书数据同步',
      map_display: '地图标记显示'
    },
    endpoints: {
      health: '/health',
      manualSync: 'POST /sync',
      orderStatus: 'GET /api/order-status',
      configStatus: 'GET /api/config-status',
      testConnections: 'POST /api/test-connections'
    }
  });
});

console.log('🌟 印尼送货数据同步服务启动中...');
console.log('🔗 手动同步: POST /sync');
console.log('❤️ 健康检查: GET /health');
console.log('⚡ 自动定时同步已禁用，仅支持手动刷新');

app.listen(PORT, () => {
  console.log(`🚀 服务运行在端口 ${PORT}`);
  console.log(`🌍 服务地址: https://feishu-delivery-sync.onrender.com`);
  console.log('/' .repeat(60));
});