# 学时自动化容器 —— 每天 cron 定时执行，跑完即退
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py .
COPY .env.example /app/.env.example

# 账密通过环境变量注入: MOOC_USER / MOOC_PWD（或挂载 .env 到 /app/.env）
ENV PYTHONUNBUFFERED=1

CMD ["python", "mooc_auto_study.py", "--todo", "--no-ws"]
