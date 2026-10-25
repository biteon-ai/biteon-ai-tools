FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py entrypoint.sh ./
COPY static ./static
COPY skills ./skills
RUN chmod +x /app/entrypoint.sh

EXPOSE 8787
ENTRYPOINT ["/app/entrypoint.sh"]
