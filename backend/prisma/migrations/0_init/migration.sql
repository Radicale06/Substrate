-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "reader_crawl_cache" (
    "cache_key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reader_crawl_cache_pkey" PRIMARY KEY ("cache_key")
);

-- CreateIndex
CREATE INDEX "reader_crawl_cache_expires_at_idx" ON "reader_crawl_cache"("expires_at");

-- CreateIndex
CREATE INDEX "reader_crawl_cache_url_idx" ON "reader_crawl_cache"("url");
