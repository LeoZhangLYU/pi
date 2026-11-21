# SSH 命令超时最佳实践

## 问题
SSH 命令容易卡住，导致无法正常停止。

## 解决方案

### 1. 添加整体超时
```bash
timeout 300 ssh user@host 'command'
```

### 2. 添加 SSH 保活参数
```bash
ssh \
    -o BatchMode=yes \
    -o ConnectTimeout=8 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    user@host 'command'
```

**参数说明**：
- `ServerAliveInterval=15`：每 15 秒发送保活包
- `ServerAliveCountMax=3`：3 次无响应后断开（45 秒总超时）

### 3. 让远程命令自己超时
```bash
ssh user@host 'timeout 300 tar czf large-archive.tgz'
```

### 4. 添加输出避免看起来卡住
```bash
# 使用 tar -v 产生输出
ssh user@host 'tar -v czf archive.tgz files/ | pv -l'
```

### 5. 完整示例
```bash
timeout 600 ssh \
    -o BatchMode=yes \
    -o ConnectTimeout=8 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    user@host \
    'cd ~/project && timeout 300 tar -v czf backup.tgz files/'
```

这样有三层保护：
1. 外层 `timeout 600`：整体命令 10 分钟超时
2. SSH 保活：45 秒无响应断开
3. 内层 `timeout 300`：远程命令 5 分钟超时
