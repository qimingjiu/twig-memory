#!/bin/sh
# 启动前修复 volume 权限（Railway volume 运行时挂载，owner 为 root）
chown -R node:node /data
# 切回 node 用户执行原命令
exec su-exec node "$@"