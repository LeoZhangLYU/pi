# 监控长时间运行任务的最佳实践

## 问题
无法判断任务是：
1. 卡死在 PI 系统中
2. 正常运行但长时间无输出

## 立即可用的诊断方法

### 1. 使用进程状态检查工具

```bash
# 在任务运行时，打开新终端
./scripts/check-process-status.sh <PID>

# 查找 PID 的方法：
# 方法 1：在 PI UI 中查看任务详情（如果显示）
# 方法 2：使用 ps 查找
ps aux | grep "你的命令关键词"

# 方法 3：查找 SSH 进程
ps aux | grep ssh | grep -v grep
```

### 2. 实时监控进程活动

```bash
# 持续监控进程状态（每 2 秒更新）
watch -n 2 "ps -p <PID> -o pid,state,pcpu,pmem,etime,cmd"

# 监控 I/O 活动（证明进程在工作）
watch -n 2 "cat /proc/<PID>/io | grep -E 'read_bytes|write_bytes'"
```

### 3. 检查进程是否卡在系统调用

```bash
# 查看进程当前在做什么（需要 root）
sudo strace -p <PID> -s 0 -e trace=none

# 输出解释：
# - 如果看到持续的系统调用 = 进程在工作
# - 如果卡在某个调用（如 read、write、connect）= 可能卡住
# - 如果完全没有输出 = 进程可能真的卡死了
```

## 改进命令的监控性

### SSH 命令最佳实践

**问题命令**（无法判断状态）：
```bash
ssh user@host 'tar czf backup.tgz large-directory/'
```

**改进后**（有进度反馈）：
```bash
# 方案 1：使用 tar -v 显示每个文件
ssh user@host 'tar -czv backup.tgz large-directory/ 2>&1 | while read line; do echo $line; done'

# 方案 2：使用 pv 显示进度
ssh user@host 'tar czf - large-directory/ | pv | gzip > backup.tgz'

# 方案 3：定期输出心跳
ssh user@host 'while true; do 
    tar czf backup.tgz large-directory/ & 
    PID=$!
    while kill -0 $PID 2>/dev/null; do 
        echo "$(date): Still working..."
        sleep 30
    done
    wait $PID
    break
done'

# 方案 4：分步执行并输出状态
ssh user@host 'bash -x' << 'EOF'
echo "Step 1: Counting files..."
find large-directory/ -type f | wc -l
echo "Step 2: Creating archive..."
tar czf backup.tgz large-directory/
echo "Step 3: Done!"
EOF
```

### 本地长时间命令

```bash
# 使用 pv 显示进度
tar czf - /large/directory | pv -s $(du -sb /large/directory | cut -f1) > backup.tgz

# 使用进度文件
(tar czf backup.tgz /large/directory & PID=$!
while kill -0 $PID 2>/dev/null; do
    SIZE=$(du -b backup.tgz 2>/dev/null | cut -f1)
    echo "Archive size: $SIZE bytes"
    sleep 5
done) &
```

## 添加超时和心跳检测

```bash
# 超时保护
timeout 3600 ssh user@host 'long-command'

# 心跳检测：如果 30 秒无输出则认为卡住
ssh user@host 'long-command' | while IFS= read -r -t 30 line || [ $? -le 128 ]; do
    if [ $? -eq 128 ]; then
        echo "WARNING: No output for 30 seconds"
    else
        echo "$line"
    fi
done
```

## 判断标准

| 现象 | 进程状态 | CPU | I/O | 判断 | 操作 |
|------|---------|-----|-----|------|------|
| 无输出 | R (Running) | >0% | 增长 | ✅ 正常工作 | 继续等待 |
| 无输出 | S (Sleeping) | ~0% | 增长 | ✅ I/O 密集 | 继续等待 |
| 无输出 | D (Uninterruptible) | ~0% | 不变 | ⚠️ 等待 I/O | 等待或检查存储/网络 |
| 无输出 | S (Sleeping) | ~0% | 不变 | ❌ 可能卡死 | 考虑终止 |
| 无输出 | Z (Zombie) | 0% | - | ❌ 已死亡 | 需要清理 |

## 常见场景

### SSH 连接卡住
**症状**：进程状态 D，无 CPU，无 I/O 变化  
**原因**：网络问题、远程服务器无响应  
**解决**：
```bash
# 强制终止
kill -9 <PID>

# 下次使用超时参数
ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3
```

### tar 处理大文件
**症状**：进程状态 S/D，无 CPU，I/O 缓慢增长  
**原因**：正常，磁盘慢  
**判断**：等待并观察 I/O 统计是否增长

### 远程命令卡在输入
**症状**：进程状态 S，无任何活动  
**原因**：远程命令等待用户输入  
**解决**：使用 `ssh -o BatchMode=yes` 或 `-T`
