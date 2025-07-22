#!/bin/bash

# =================================
# 印尼雅加达冰柜配送地图展示系统
# GitHub自动推送脚本 v3.0
# =================================

echo "🚀 开始推送到GitHub..."

# 检查是否是git仓库
if [ ! -d ".git" ]; then
    echo "📝 初始化Git仓库..."
    git init
fi

# 添加所有文件到暂存区（删除的文件也会被记录）
echo "📦 添加文件到暂存区..."
git add -A

# 提交更改
echo "💾 提交更改..."
git commit -m "feat: 简化为地图展示系统 - 移除路线优化功能，专注数据可视化

✨ 新功能:
- 飞书数据同步和地图展示
- 按业务类型和状态的彩色标记显示
- 紧凑统计面板设计
- 本地测试环境配置

🗑️ 移除功能:
- Google Maps路线优化
- 订单状态管理
- 路线计算相关组件

🔧 技术优化:
- React + TypeScript前端
- Node.js + Express后端
- Leaflet地图组件
- 响应式UI设计"

# 检查是否已有远程仓库
if git remote get-url origin &>/dev/null; then
    echo "🌐 检测到现有远程仓库，直接推送..."
    git push -u origin main
else
    echo "❓ 未检测到远程仓库"
    echo ""
    echo "请按以下步骤在GitHub上创建新仓库："
    echo "1. 打开 https://github.com/new"
    echo "2. 仓库名称建议: jakarta-freezer-delivery-map"
    echo "3. 描述: 印尼雅加达冰柜配送地图展示系统"
    echo "4. 选择 Public 或 Private"
    echo "5. 不要初始化README、.gitignore或License（我们已经有了）"
    echo "6. 点击 'Create repository'"
    echo ""
    read -p "请输入GitHub仓库URL (如: https://github.com/username/repo-name.git): " repo_url
    
    if [ -n "$repo_url" ]; then
        echo "🔗 添加远程仓库..."
        git remote add origin "$repo_url"
        echo "📤 推送到GitHub..."
        git push -u origin main
        echo ""
        echo "✅ 成功推送到GitHub!"
        echo "🌐 仓库地址: $repo_url"
    else
        echo "❌ 未提供仓库URL，跳过推送"
        exit 1
    fi
fi

echo ""
echo "🎉 GitHub推送完成!"
echo ""
echo "📋 下一步部署清单:"
echo "1. ✅ GitHub仓库已创建"
echo "2. ⏳ 配置飞书API"
echo "3. ⏳ 部署后端到Render"
echo "4. ⏳ 部署前端到Netlify"
echo ""
echo "继续执行下一步配置..." 