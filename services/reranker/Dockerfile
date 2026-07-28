FROM python:3.12-slim

# Install the CPU-only torch build first and from its own index. The default PyPI wheel
# pulls in ~2GB of CUDA libraries that a CPU deployment never uses.
RUN pip install --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cpu \
    torch==2.9.1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Weights live on a mounted volume so restarts do not re-download them.
ENV HF_HOME=/models
ENV PYTHONUNBUFFERED=1
RUN mkdir -p /models

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health').status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
