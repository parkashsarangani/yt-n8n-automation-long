# Animator: blinks, plus mouth and hand motion for speaking characters, on
# the auto-edit's beat images (animate.py). CPU only.
FROM python:3.12-slim

# ffmpeg encodes the clips; libglib is OpenCV's one system dependency.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libglib2.0-0 curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.14.1 \
  && pip install --no-cache-dir -r requirements.txt

COPY *.py ./

# The detection models (~1 GB) download on first start into this volume.
ENV HF_HOME=/models PORT=4100 PYTHONUNBUFFERED=1
EXPOSE 4100
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -sf http://127.0.0.1:4100/health > /dev/null || exit 1
CMD ["python", "app.py"]
