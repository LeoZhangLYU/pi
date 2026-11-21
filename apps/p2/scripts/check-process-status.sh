#!/bin/bash
# 检查进程状态 - 判断是卡死还是正常运行

if [ -z "$1" ]; then
    echo "用法: $0 <PID>"
    echo "检查指定进程的详细状态"
    exit 1
fi

PID=$1

echo "=== 进程 $PID 状态检查 ==="
echo

# 1. 检查进程是否存在
if ! ps -p $PID > /dev/null 2>&1; then
    echo "❌ 进程不存在（已终止或从未存在）"
    exit 1
fi

echo "✅ 进程存在"
echo

# 2. 显示进程详细信息
echo "--- 进程详情 ---"
ps -p $PID -o pid,ppid,state,pcpu,pmem,etime,cmd
echo

# 3. 进程状态解释
STATE=$(ps -p $PID -o state= | tr -d ' ')
echo "--- 进程状态: $STATE ---"
case $STATE in
    R*) echo "✅ Running - 进程正在运行（正常）" ;;
    S*) echo "✅ Sleeping - 进程在睡眠（等待事件，正常）" ;;
    D*) echo "⚠️  Uninterruptible Sleep - 不可中断睡眠（等待 I/O）"
        echo "   这通常是正常的，但如果持续很久可能表示 I/O 问题" ;;
    Z*) echo "❌ Zombie - 僵尸进程（进程已死但未被清理）" ;;
    T*) echo "⏸️  Stopped - 进程已停止（被信号暂停）" ;;
    *) echo "❓ 未知状态: $STATE" ;;
esac
echo

# 4. CPU 活动
CPU=$(ps -p $PID -o pcpu= | tr -d ' ')
echo "--- CPU 使用率 ---"
echo "当前: ${CPU}%"
if (( $(echo "$CPU > 0.1" | bc -l) )); then
    echo "✅ 进程有 CPU 活动（正在工作）"
else
    echo "⚠️  进程��乎无 CPU 活动（可能在等待 I/O 或已卡死）"
fi
echo

# 5. 检查 I/O 活动（需要 root）
if [ -d "/proc/$PID" ]; then
    echo "--- I/O 统计 ---"
    if [ -r "/proc/$PID/io" ]; then
        echo "读取字节数:"
        grep "^read_bytes:" /proc/$PID/io
        echo "写入字节数:"
        grep "^write_bytes:" /proc/$PID/io
        echo
        echo "💡 提示: 再次运行此脚本，比较这些数字是否增长"
        echo "   如果数字增长 = 进程有 I/O 活动（正在工作）"
        echo "   如果数字不变 = 进程可能卡死或等待"
    else
        echo "⚠️  需要 root 权限查看 I/O 统计"
    fi
    echo
fi

# 6. 进程树（查看子进程）
echo "--- 进程树 ---"
pstree -p $PID 2>/dev/null || ps --forest -o pid,cmd -g $(ps -p $PID -o pgid=)
echo

# 7. 打开的文件描述符（查看在等待什么）
echo "--- 打开的连接和文件 ---"
if command -v lsof > /dev/null 2>&1; then
    lsof -p $PID 2>/dev/null | grep -E "PIPE|sock|tcp|udp|REG" | head -10
    echo "   (仅显示前 10 个)"
else
    echo "⚠️  lsof 未安装，无法查看详细信息"
fi
echo

# 8. 综合判断
echo "=== 综合判断 ==="
if [ "$STATE" = "D" ]; then
    echo "⚠️  进程在不可中断睡眠（D state），通常在等待 I/O"
    echo "   - 如果是网络操作（SSH/rsync），可能在等待网络响应"
    echo "   - 如果是磁盘操作（tar/cp），可能在等待慢速磁盘"
    echo "   - 通常会自动恢复，但如果持续很久可能需要重启服务器"
elif [ "$STATE" = "Z" ]; then
    echo "❌ 僵尸进程，父进程应该清理它"
elif [ "$STATE" = "T" ]; then
    echo "⏸️  进程被暂停，使用 'kill -CONT $PID' 恢复"
else
    if (( $(echo "$CPU > 0.1" | bc -l) )); then
        echo "✅ 进程正常运行，有 CPU 活动"
    else
        echo "⚠️  进程无 CPU 活动"
        echo "   可能原因："
        echo "   1. 正在等待 I/O（正常）"
        echo "   2. 睡眠等待某个事件（正常）"
        echo "   3. 卡在某个系统调用（可能有问题）"
        echo
        echo "   建议: 等待 30-60 秒后再次检查，看 I/O 统计是否变化"
    fi
fi
