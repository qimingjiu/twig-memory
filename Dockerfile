# 雾尼 Muninn 记忆后端（server/only，前端 demo 不参与部署）
# Zeabur 检测到 Dockerfile 后会自动构建；平台注入的 PORT 环境变量会被 http.ts 读取。
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# 服务端只依赖 visualizer/engine（类型 + LLM 判定函数），不拷贝整个前端
COPY visualizer/engine ./visualizer/engine
COPY shared ./shared
COPY server ./server

ENV NODE_ENV=production
ENV MUNINN_DATA_DIR=/data

# 创建数据目录并授权给 node 用户（Railway volume 挂载到 /data 时也需要 node 可写）
RUN mkdir -p /data && chown node:node /data

# P2-12：不以 root 运行
USER node

EXPOSE 7300

CMD ["node", "--import", "tsx", "server/http.ts"]
